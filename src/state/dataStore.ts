/**
 * Synced account data. One store, hydrated from IndexedDB at startup,
 * kept authoritative by the sync engine and written optimistically by
 * the mutation queue.
 */
import { create } from "zustand";
import type {
  AccountSettings,
  ClientConversation,
  ClientFolder,
  ClientQuota,
  MemoryEntry,
  MemorySummary,
  ModelManifest,
  ProjectSummary,
  SavedPrompt,
  Subscription,
} from "@/lib/data/entities";

export type SyncPhase = "idle" | "hydrating" | "syncing" | "offline" | "error";

interface DataState {
  hydrated: boolean;
  syncPhase: SyncPhase;
  syncError: string | null;
  lastSyncedAt: number | null;

  conversations: Record<string, ClientConversation>;
  folders: Record<string, ClientFolder>;
  projects: Record<string, ProjectSummary>;
  memories: Record<string, MemoryEntry>;
  memorySummary: MemorySummary | null;
  prompts: Record<string, SavedPrompt>;
  settings: AccountSettings | null;
  subscription: Subscription | null;
  manifest: ModelManifest | null;
  quota: ClientQuota | null;

  /** entityType:entityId -> last known server revision (baseRevision source). */
  revisions: Record<string, number>;
}

interface DataActions {
  setSyncPhase(phase: SyncPhase, error?: string | null): void;
  markSynced(): void;
  hydrate(snapshot: Partial<DataState>): void;
  upsertConversation(conversation: ClientConversation): void;
  removeConversation(id: string): void;
  replaceConversations(conversations: ClientConversation[]): void;
  upsertFolder(folder: ClientFolder): void;
  removeFolder(id: string): void;
  replaceFolders(folders: ClientFolder[]): void;
  upsertProject(project: ProjectSummary): void;
  removeProject(id: string): void;
  replaceProjects(projects: ProjectSummary[]): void;
  upsertMemory(memory: MemoryEntry): void;
  removeMemory(id: string): void;
  replaceMemories(memories: MemoryEntry[], summary: MemorySummary | null): void;
  replacePrompts(prompts: SavedPrompt[]): void;
  setSettings(settings: AccountSettings | null): void;
  setSubscription(subscription: Subscription | null): void;
  setManifest(manifest: ModelManifest | null): void;
  setQuota(quota: ClientQuota | null): void;
  setRevision(entityType: string, entityId: string, revision: number): void;
  /** Move optimistic local-id rows to their adopted server id. */
  adoptEntityId(entityType: string, localId: string, serverId: string): void;
  clearAll(): void;
}

const emptyState: DataState = {
  hydrated: false,
  syncPhase: "idle",
  syncError: null,
  lastSyncedAt: null,
  conversations: {},
  folders: {},
  projects: {},
  memories: {},
  memorySummary: null,
  prompts: {},
  settings: null,
  subscription: null,
  manifest: null,
  quota: null,
  revisions: {},
};

function keyed<T extends { id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

export const useDataStore = create<DataState & DataActions>((set) => ({
  ...emptyState,

  setSyncPhase: (syncPhase, error = null) => set({ syncPhase, syncError: error }),
  markSynced: () => set({ syncPhase: "idle", syncError: null, lastSyncedAt: Date.now() }),
  hydrate: (snapshot) => set({ ...snapshot, hydrated: true }),

  upsertConversation: (c) =>
    set((s) => ({ conversations: { ...s.conversations, [c.id]: c } })),
  removeConversation: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.conversations;
      return { conversations: rest };
    }),
  replaceConversations: (list) => set({ conversations: keyed(list) }),

  upsertFolder: (f) => set((s) => ({ folders: { ...s.folders, [f.id]: f } })),
  removeFolder: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.folders;
      return { folders: rest };
    }),
  replaceFolders: (list) => set({ folders: keyed(list) }),

  upsertProject: (p) => set((s) => ({ projects: { ...s.projects, [p.id]: p } })),
  removeProject: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.projects;
      return { projects: rest };
    }),
  replaceProjects: (list) => set({ projects: keyed(list) }),

  upsertMemory: (m) => set((s) => ({ memories: { ...s.memories, [m.id]: m } })),
  removeMemory: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.memories;
      return { memories: rest };
    }),
  replaceMemories: (list, memorySummary) => set({ memories: keyed(list), memorySummary }),

  replacePrompts: (list) => set({ prompts: keyed(list) }),
  setSettings: (settings) => set({ settings }),
  setSubscription: (subscription) => set({ subscription }),
  setManifest: (manifest) => set({ manifest }),
  setQuota: (quota) => set({ quota }),

  setRevision: (entityType, entityId, revision) =>
    set((s) => ({ revisions: { ...s.revisions, [`${entityType}:${entityId}`]: revision } })),

  adoptEntityId: (entityType, localId, serverId) =>
    set((s) => {
      const next: Partial<DataState> = {};
      if (entityType === "conversation" && s.conversations[localId]) {
        const { [localId]: row, ...rest } = s.conversations;
        next.conversations = { ...rest, [serverId]: { ...row!, id: serverId } };
      } else if (entityType === "project" && s.projects[localId]) {
        const { [localId]: row, ...rest } = s.projects;
        next.projects = { ...rest, [serverId]: { ...row!, id: serverId } };
      } else if (entityType === "memory" && s.memories[localId]) {
        const { [localId]: row, ...rest } = s.memories;
        next.memories = { ...rest, [serverId]: { ...row!, id: serverId } };
      }
      const { [`${entityType}:${localId}`]: localRev, ...restRev } = s.revisions;
      next.revisions =
        localRev === undefined
          ? restRev
          : { ...restRev, [`${entityType}:${serverId}`]: localRev };
      return next;
    }),

  clearAll: () => set({ ...emptyState, hydrated: true }),
}));

export function revisionOf(entityType: string, entityId: string): number {
  return useDataStore.getState().revisions[`${entityType}:${entityId}`] ?? 0;
}
