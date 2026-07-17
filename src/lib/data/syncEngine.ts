/**
 * Cursor-based account synchronization over the v1 protocol.
 *
 * bootstrap -> full list fetch -> page /api/v1/changes -> refetch bodies from
 * the paired REST endpoints -> persist cursor. The stream endpoint is a
 * poll-shaped probe (it answers and closes), so cadence is: interval poll +
 * window focus + after local writes.
 */
import { api } from "../backend/http";
import { dbGet, dbPut, dbReplaceAll, dbWipe } from "./db";
import { flushQueue, onQueueDrained } from "./mutationQueue";
import { useDataStore } from "@/state/dataStore";
import type {
  BootstrapResponse,
  ChangesResponse,
  ClientConversation,
  ClientFolder,
  MemoryEntry,
  MemorySummary,
  ModelManifest,
  ProjectSummary,
  SavedPrompt,
} from "./entities";

const POLL_INTERVAL_MS = 20_000;
const CHANGE_PAGE_LIMIT = 500;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pulling = false;
let started = false;
let disposers: Array<() => void> = [];

async function saveCursor(cursor: string): Promise<void> {
  await dbPut("meta", "changeCursor", cursor);
}

async function loadCursor(): Promise<string> {
  return (await dbGet<string>("meta", "changeCursor")) ?? "0";
}

/** Hydrate the in-memory store from IndexedDB so the UI paints instantly. */
export async function hydrateFromDisk(): Promise<void> {
  const store = useDataStore.getState();
  store.setSyncPhase("hydrating");
  const [conversations, folders, projects, memories, prompts, meta] = await Promise.all([
    dbGet<ClientConversation[]>("conversations", "all"),
    dbGet<ClientFolder[]>("folders", "all"),
    dbGet<ProjectSummary[]>("projects", "all"),
    dbGet<{ entries: MemoryEntry[]; summary: MemorySummary | null }>("memories", "all"),
    dbGet<SavedPrompt[]>("prompts", "all"),
    dbGet<{ bootstrap?: BootstrapResponse; manifest?: ModelManifest }>("meta", "snapshot"),
  ]);
  if (conversations) store.replaceConversations(conversations);
  if (folders) store.replaceFolders(folders);
  if (projects) store.replaceProjects(projects);
  if (memories) store.replaceMemories(memories.entries, memories.summary);
  if (prompts) store.replacePrompts(prompts);
  if (meta?.bootstrap) {
    store.setSettings(meta.bootstrap.settings);
    store.setSubscription(meta.bootstrap.subscription);
  }
  if (meta?.manifest) store.setManifest(meta.manifest);
  store.hydrate({});
}

async function persistLists(): Promise<void> {
  const s = useDataStore.getState();
  await Promise.all([
    dbPut("conversations", "all", Object.values(s.conversations)),
    dbPut("folders", "all", Object.values(s.folders)),
    dbPut("projects", "all", Object.values(s.projects)),
    dbPut("memories", "all", { entries: Object.values(s.memories), summary: s.memorySummary }),
    dbPut("prompts", "all", Object.values(s.prompts)),
  ]);
}

async function fetchConversations(): Promise<void> {
  const { conversations } = await api<{ conversations: ClientConversation[] }>("/conversations");
  useDataStore.getState().replaceConversations(conversations);
}

async function fetchFolders(): Promise<void> {
  const { folders } = await api<{ folders: ClientFolder[] }>("/folders");
  useDataStore.getState().replaceFolders(folders);
}

async function fetchProjects(): Promise<void> {
  const { projects } = await api<{ projects: ProjectSummary[] }>("/projects");
  useDataStore.getState().replaceProjects(projects);
}

async function fetchMemories(): Promise<void> {
  const { memories, summary } = await api<{
    memories: MemoryEntry[];
    summary: MemorySummary | null;
  }>("/memory");
  useDataStore.getState().replaceMemories(memories, summary);
}

async function fetchPrompts(): Promise<void> {
  try {
    const { prompts } = await api<{ prompts: SavedPrompt[] }>("/prompts");
    useDataStore.getState().replacePrompts(prompts);
  } catch {
    // Saved prompts are non-critical; tolerate absence.
  }
}

async function fetchManifest(): Promise<void> {
  const manifest = await api<ModelManifest>("/v1/models");
  useDataStore.getState().setManifest(manifest);
  const snapshot = (await dbGet<Record<string, unknown>>("meta", "snapshot")) ?? {};
  await dbPut("meta", "snapshot", { ...snapshot, manifest });
}

async function applyBootstrap(bootstrap: BootstrapResponse): Promise<void> {
  const store = useDataStore.getState();
  store.setSettings(bootstrap.settings);
  store.setSubscription(bootstrap.subscription);
  const snapshot = (await dbGet<Record<string, unknown>>("meta", "snapshot")) ?? {};
  await dbPut("meta", "snapshot", { ...snapshot, bootstrap });
}

/**
 * Full resync: bootstrap + all lists. Used at startup and when the saved
 * cursor falls below the compaction floor.
 */
export async function fullSync(): Promise<void> {
  const store = useDataStore.getState();
  store.setSyncPhase("syncing");
  const bootstrap = await api<BootstrapResponse>("/v1/bootstrap");
  await applyBootstrap(bootstrap);
  await Promise.all([
    fetchConversations(),
    fetchFolders(),
    fetchProjects(),
    fetchMemories(),
    fetchPrompts(),
  ]);
  const storedManifestVersion = (
    await dbGet<{ manifest?: ModelManifest }>("meta", "snapshot")
  )?.manifest?.manifestVersion;
  if (storedManifestVersion !== bootstrap.modelManifestVersion) {
    await fetchManifest();
  }
  await saveCursor(bootstrap.currentChangeCursor);
  await persistLists();
  store.markSynced();
}

/** Entity types whose bodies we refetch via list endpoints. */
const LIST_REFRESHERS: Record<string, () => Promise<void>> = {
  conversation: fetchConversations,
  folder: fetchFolders,
  project: fetchProjects,
  memory: fetchMemories,
  saved_prompt: fetchPrompts,
};

/** Types satisfied by re-reading bootstrap. */
const BOOTSTRAP_TYPES = new Set(["settings", "profile", "subscription", "usage"]);

type ThreadInvalidation = (conversationId: string) => void;
let threadInvalidator: ThreadInvalidation | null = null;

/** The thread store registers here to be told when open threads went stale. */
export function setThreadInvalidator(fn: ThreadInvalidation): void {
  threadInvalidator = fn;
}

/** Pull and apply all pending changes. Returns the number applied. */
export async function pullChanges(): Promise<number> {
  if (pulling) return 0;
  pulling = true;
  try {
    let cursor = await loadCursor();
    let applied = 0;
    for (;;) {
      const page = await api<ChangesResponse>(
        `/v1/changes?after=${cursor}&limit=${CHANGE_PAGE_LIMIT}`,
      );
      if (BigInt(cursor) < BigInt(page.compactionFloorCursor)) {
        await fullSync();
        return applied;
      }
      if (page.changes.length > 0) {
        applied += page.changes.length;
        const listTypes = new Set<string>();
        const staleThreads = new Set<string>();
        let needBootstrap = false;
        for (const change of page.changes) {
          useDataStore
            .getState()
            .setRevision(change.entityType, change.entityId, change.revision);
          if (LIST_REFRESHERS[change.entityType]) listTypes.add(change.entityType);
          else if (BOOTSTRAP_TYPES.has(change.entityType)) needBootstrap = true;
          else if (change.entityType === "message" || change.entityType === "artifact") {
            if (change.parentEntityId) staleThreads.add(change.parentEntityId);
          } else if (
            change.entityType === "message_version" ||
            change.entityType === "artifact_version"
          ) {
            // Parent is the message/artifact; the thread refetch covers it.
            if (change.parentEntityId) staleThreads.add(change.parentEntityId);
          }
        }
        for (const type of listTypes) {
          await LIST_REFRESHERS[type]!();
        }
        // Message changes also bump the conversation list ordering.
        if (staleThreads.size > 0 && !listTypes.has("conversation")) {
          await fetchConversations();
        }
        if (needBootstrap) {
          const bootstrap = await api<BootstrapResponse>("/v1/bootstrap");
          await applyBootstrap(bootstrap);
        }
        for (const conversationId of staleThreads) threadInvalidator?.(conversationId);
        await persistLists();
      }
      cursor = page.nextCursor;
      await saveCursor(cursor);
      if (!page.hasMore) break;
    }
    useDataStore.getState().markSynced();
    return applied;
  } finally {
    pulling = false;
  }
}

async function pollOnce(): Promise<void> {
  try {
    await flushQueue();
    await pullChanges();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    const offline = !navigator.onLine;
    useDataStore.getState().setSyncPhase(offline ? "offline" : "error", message);
  }
}

/** Start the sync lifecycle. Idempotent; returns a stop function. */
export async function startSync(): Promise<() => void> {
  if (started) return stopSync;
  started = true;

  await hydrateFromDisk();
  try {
    await fullSync();
    await flushQueue();
  } catch (err) {
    const offline = !navigator.onLine;
    useDataStore
      .getState()
      .setSyncPhase(offline ? "offline" : "error", err instanceof Error ? err.message : null);
  }

  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  const onFocus = () => void pollOnce();
  const onOnline = () => void pollOnce();
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  const offDrained = onQueueDrained(() => void pullChanges().catch(() => {}));
  disposers = [
    () => window.removeEventListener("focus", onFocus),
    () => window.removeEventListener("online", onOnline),
    offDrained,
  ];
  return stopSync;
}

export function stopSync(): void {
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (const dispose of disposers) dispose();
  disposers = [];
}

/** Sign-out teardown: stop syncing and destroy every local trace. */
export async function purgeLocalData(): Promise<void> {
  stopSync();
  await dbWipe();
  useDataStore.getState().clearAll();
}
