/**
 * Chat generation engine — the client-side behaviors of POST /api/chat
 * (see juno/src/app/api/chat/route.ts and the web client's hooks):
 * optimistic send, SSE frame folding, cancel-with-fallback, regenerate
 * in-place, edit-and-resend, drop recovery, client-driven auto-title.
 */
import { api, apiStream } from "../backend/http";
import { readSseJson } from "../backend/sse";
import { BackendError } from "../backend/types";
import type {
  ChatFinishReason,
  ClientArtifact,
  ClientAttachment,
  ClientMessage,
  ClientConversation,
  ReasoningEffort,
  StreamChunk,
} from "../data/entities";
import { useDataStore } from "@/state/dataStore";
import { applyQuota, emptyThread, useThreadStore } from "@/state/threadStore";

export interface SendOptions {
  conversationId: string | null; // null = new conversation
  message: string;
  model: string;
  projectId?: string | null;
  attachmentIds?: string[];
  attachments?: ClientAttachment[]; // for the optimistic bubble
  webSearch?: boolean;
  /** Canvas/artifact behavior; defaults to on for saved chats. */
  canvasEnabled?: boolean;
  /** Deep-research mode (plan → search → read → cited report). Saved chats only. */
  deepResearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  connectors?: string[];
  privateMode?: boolean;
  privateHistory?: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
  regenerate?: boolean;
}

interface ActiveGeneration {
  generationId: string;
  conversationId: string;
  controller: AbortController;
  sequence: number;
  sawMeta: boolean;
  userMessageId: string | null;
  /** ids of assistant rows we removed locally for regenerate: id -> createdAt */
  removedIds: Map<string, string>;
  done: boolean;
}

const PRIVATE_ID = "private";
const RECOVERY_WINDOW_MS = 3_600_000 + 60_000;

let sequenceCounter = 0;
const active = new Map<string, ActiveGeneration>();
/** Latest generation sequence per conversation — recovery loops check THIS,
 * so a new generation in another conversation doesn't abort them. */
const latestSequence = new Map<string, number>();

function threadKey(conversationId: string | null, privateMode: boolean): string {
  return privateMode ? PRIVATE_ID : (conversationId ?? "new");
}

function tempId(prefix: string): string {
  return `temp-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function isGenerating(conversationId: string): boolean {
  return active.has(conversationId);
}

/** Emergency stop for a conversation's generation. */
export async function stopGeneration(conversationId: string): Promise<void> {
  const gen = active.get(conversationId);
  if (!gen) return;
  const store = useThreadStore.getState();
  store.patchThread(conversationId, { status: "stopping" });

  // Arm a fallback: if the server doesn't wrap up in 5s, abort locally.
  const fallback = setTimeout(() => {
    if (!gen.done) {
      gen.controller.abort();
      finalizeLocalStop(conversationId, gen);
    }
  }, 5_000);

  try {
    const res = await api<{ ok: boolean; cancelled: boolean }>("/chat/cancel", {
      method: "POST",
      body: { generationId: gen.generationId },
    });
    if (!res.cancelled) {
      gen.controller.abort();
      finalizeLocalStop(conversationId, gen);
    }
    // On cancelled:true, let the stream deliver its terminal frame.
  } catch {
    gen.controller.abort();
    finalizeLocalStop(conversationId, gen);
  } finally {
    setTimeout(() => clearTimeout(fallback), 6_000);
  }
}

function finalizeLocalStop(conversationId: string, gen: ActiveGeneration): void {
  if (gen.done) return;
  gen.done = true;
  active.delete(conversationId);
  const store = useThreadStore.getState();
  store.updateMessages(conversationId, (messages) =>
    messages.map((m) =>
      m.id.startsWith("temp-assistant") || (m.role === "ASSISTANT" && isStreamingRow(m))
        ? { ...stripStreaming(m), finishReason: "user_stopped" as ChatFinishReason }
        : m,
    ),
  );
  store.patchThread(conversationId, { status: "idle" });
}

const streamingRows = new WeakSet<ClientMessage>();
function markStreaming(m: ClientMessage): ClientMessage {
  streamingRows.add(m);
  return m;
}
function isStreamingRow(m: ClientMessage): boolean {
  return streamingRows.has(m);
}
function stripStreaming(m: ClientMessage): ClientMessage {
  return { ...m };
}

export async function sendMessage(options: SendOptions): Promise<string | null> {
  const privateMode = options.privateMode ?? false;
  const key = threadKey(options.conversationId, privateMode);
  const threads = useThreadStore.getState();
  const current = threads.threads[key] ?? emptyThread;
  if (current.status !== "idle") return null;

  const generationId = crypto.randomUUID();
  const controller = new AbortController();
  const sequence = ++sequenceCounter;
  latestSequence.set(key, sequence);

  // ---- optimistic rows ----
  const now = new Date().toISOString();
  const userRow: ClientMessage | null = options.regenerate
    ? null
    : {
        id: tempId("user"),
        role: "USER",
        content: options.message,
        feedback: null,
        createdAt: now,
        attachments: options.attachments ?? [],
      };
  const assistantRow: ClientMessage = markStreaming({
    id: tempId("assistant"),
    role: "ASSISTANT",
    content: "",
    feedback: null,
    createdAt: now,
    attachments: [],
  });

  const removedIds = new Map<string, string>();
  threads.updateMessages(key, (messages) => {
    let next = messages;
    if (options.regenerate) {
      // Pop trailing assistant rows, remembering id -> createdAt for recovery.
      next = [...messages];
      while (next.length > 0 && next[next.length - 1]!.role === "ASSISTANT") {
        const popped = next.pop()!;
        removedIds.set(popped.id, popped.createdAt);
      }
    }
    return [...next, ...(userRow ? [userRow] : []), assistantRow];
  });
  threads.patchThread(key, { status: "submitting", followUps: [] });

  const gen: ActiveGeneration = {
    generationId,
    conversationId: key,
    controller,
    sequence,
    sawMeta: false,
    userMessageId: null,
    removedIds,
    done: false,
  };
  active.set(key, gen);

  // ---- request body (shape mirrors the web + Swift clients) ----
  const body: Record<string, unknown> = {
    model: options.model,
    client: "app",
    canvasEnabled: privateMode ? false : (options.canvasEnabled ?? true),
    generationId,
  };
  if (options.regenerate) body.regenerate = true;
  else body.message = options.message;
  if (!privateMode && options.conversationId) body.conversationId = options.conversationId;
  if (!privateMode && !options.conversationId && options.projectId) {
    body.projectId = options.projectId;
  }
  if (options.attachmentIds?.length) body.attachmentIds = options.attachmentIds;
  if (options.webSearch !== undefined) body.webSearch = options.webSearch;
  // Deep research is a saved-chat capability; never send it in private mode.
  if (!privateMode && options.deepResearch) body.deepResearch = true;
  if (options.reasoningEffort) body.reasoningEffort = options.reasoningEffort;
  if (!privateMode && options.connectors) body.connectors = options.connectors;
  if (privateMode) {
    body.privateMode = true;
    body.privateHistory = options.privateHistory ?? [];
  }

  let resolvedConversationId: string | null = options.conversationId;

  try {
    const res = await apiStream("/chat", body, controller.signal);
    let sawTerminal = false;
    let reasoningAcc = "";
    let reasoningParts: string[] = [];
    let lastPart = 0;

    for await (const chunk of readSseJson<StreamChunk>(res)) {
      if (gen.done) break;
      switch (chunk.type) {
        case "meta": {
          gen.sawMeta = true;
          gen.userMessageId = chunk.userMessageId;
          if (!privateMode && chunk.conversationId !== PRIVATE_ID) {
            resolvedConversationId = chunk.conversationId;
            if (key === "new") {
              migrateThread("new", chunk.conversationId, gen);
            }
            upsertConversationStub(chunk.conversationId, chunk.title, options, chunk.titleSource);
          }
          // Swap the optimistic user row to its server id.
          if (userRow && chunk.userMessageId) {
            useThreadStore.getState().updateMessages(gen.conversationId, (messages) =>
              messages.map((m) => (m.id === userRow.id ? { ...m, id: chunk.userMessageId! } : m)),
            );
          }
          break;
        }
        case "activity": {
          const store = useThreadStore.getState();
          const thread = store.threads[gen.conversationId];
          const status = thread?.status;
          if (status === "submitting") {
            store.patchThread(gen.conversationId, { status: "thinking" });
          }
          if (chunk.event.kind === "write" && status !== "writing") {
            store.patchThread(gen.conversationId, { status: "writing" });
          }
          store.updateMessages(gen.conversationId, (messages) =>
            messages.map((m) => {
              if (!isStreamingRow(m)) return m;
              const existing = m.activity ?? [];
              if (existing.some((e) => e.id === chunk.event.id)) return m;
              return markStreaming({ ...m, activity: [...existing, chunk.event] });
            }),
          );
          break;
        }
        case "reasoning": {
          const store = useThreadStore.getState();
          if (store.threads[gen.conversationId]?.status === "submitting") {
            store.patchThread(gen.conversationId, { status: "thinking" });
          }
          if (chunk.part !== undefined && chunk.part !== lastPart && reasoningAcc) {
            reasoningParts = [...reasoningParts, reasoningAcc];
            reasoningAcc = "";
          }
          if (chunk.part !== undefined) lastPart = chunk.part;
          reasoningAcc += chunk.text;
          const fullReasoning = [...reasoningParts, reasoningAcc].join("\n\n");
          const partsCopy =
            reasoningParts.length > 0 ? [...reasoningParts, reasoningAcc] : null;
          store.updateMessages(gen.conversationId, (messages) =>
            messages.map((m) =>
              isStreamingRow(m)
                ? markStreaming({ ...m, reasoning: fullReasoning, reasoningParts: partsCopy })
                : m,
            ),
          );
          break;
        }
        case "delta": {
          const store = useThreadStore.getState();
          if (store.threads[gen.conversationId]?.status !== "writing") {
            store.patchThread(gen.conversationId, { status: "writing" });
          }
          store.updateMessages(gen.conversationId, (messages) =>
            messages.map((m) =>
              isStreamingRow(m) ? markStreaming({ ...m, content: m.content + chunk.text }) : m,
            ),
          );
          break;
        }
        case "sources": {
          useThreadStore.getState().updateMessages(gen.conversationId, (messages) =>
            messages.map((m) =>
              isStreamingRow(m) ? markStreaming({ ...m, sources: chunk.sources }) : m,
            ),
          );
          break;
        }
        case "done": {
          sawTerminal = true;
          gen.done = true;
          const store = useThreadStore.getState();
          store.updateMessages(gen.conversationId, (messages) =>
            messages.map((m) => {
              if (!isStreamingRow(m)) return m;
              const finishReason = chunk.finishReason ?? chunk.message.finishReason;
              return finishReason
                ? { ...chunk.message, finishReason }
                : { ...chunk.message };
            }),
          );
          store.mergeArtifacts(gen.conversationId, chunk.artifacts);
          store.patchThread(gen.conversationId, { status: "idle" });
          applyQuota(chunk.quota);
          if (!privateMode && resolvedConversationId) {
            void scheduleAutoTitle(resolvedConversationId, "completed");
            void loadFollowUps(resolvedConversationId);
          }
          break;
        }
        case "error": {
          sawTerminal = true;
          gen.done = true;
          const store = useThreadStore.getState();
          store.updateMessages(gen.conversationId, (messages) =>
            messages.map((m) => {
              if (!isStreamingRow(m)) return m;
              const keepPartial = chunk.preservePartial && (m.content || m.reasoning);
              return {
                ...stripStreaming(m),
                content: keepPartial ? m.content : chunk.message,
                errorMessage: chunk.message,
                finishReason: chunk.finishReason ?? "error",
              };
            }),
          );
          store.patchThread(gen.conversationId, { status: "idle" });
          applyQuota(chunk.quota);
          break;
        }
        case "ping":
        case "title":
        case "progress":
          break;
      }
    }

    if (!sawTerminal && !gen.done) {
      // Stream dropped mid-generation. The server keeps working; recover by
      // polling the thread (persisted chats only).
      if (!privateMode && resolvedConversationId && gen.sawMeta) {
        markInterrupted(gen.conversationId);
        void recoverDroppedGeneration(resolvedConversationId, gen);
      } else {
        finalizeLocalStop(gen.conversationId, gen);
      }
    }
  } catch (err) {
    if (!gen.done) {
      gen.done = true;
      const store = useThreadStore.getState();
      const message =
        err instanceof BackendError
          ? err.message
          : err instanceof DOMException && err.name === "AbortError"
            ? null
            : "The connection failed. Check your network and try again.";
      if (message === null) {
        finalizeLocalStop(gen.conversationId, gen);
      } else {
        store.updateMessages(gen.conversationId, (messages) =>
          messages.map((m) =>
            isStreamingRow(m)
              ? {
                  ...stripStreaming(m),
                  content: m.content || message,
                  errorMessage: message,
                  finishReason: (err instanceof BackendError && err.isQuotaError
                    ? "error"
                    : "network_error") as ChatFinishReason,
                }
              : m,
          ),
        );
        store.patchThread(gen.conversationId, { status: "idle" });
      }
    }
  } finally {
    if (active.get(gen.conversationId) === gen) active.delete(gen.conversationId);
    const store = useThreadStore.getState();
    if (store.threads[gen.conversationId]?.status !== "idle") {
      store.patchThread(gen.conversationId, { status: "idle" });
    }
  }

  if (!privateMode && resolvedConversationId && userRow) {
    void scheduleAutoTitle(resolvedConversationId, "first_user");
  }
  return resolvedConversationId;
}

function migrateThread(fromKey: string, toKey: string, gen: ActiveGeneration): void {
  const store = useThreadStore.getState();
  const thread = store.threads[fromKey];
  if (!thread) return;
  store.patchThread(toKey, { ...thread });
  store.patchThread(fromKey, { ...emptyThread });
  if (store.activeConversationId === fromKey || store.activeConversationId === "new") {
    store.setActive(toKey);
  }
  active.delete(fromKey);
  active.set(toKey, gen);
  gen.conversationId = toKey;
}

function upsertConversationStub(
  id: string,
  title: string,
  options: SendOptions,
  titleSource?: "default" | "ai" | "manual",
): void {
  const data = useDataStore.getState();
  const existing = data.conversations[id];
  const now = new Date().toISOString();
  data.upsertConversation({
    id,
    title,
    titleSource: titleSource ?? existing?.titleSource ?? "default",
    model: options.model,
    kind: existing?.kind ?? "chat",
    codeWorkspaceName: existing?.codeWorkspaceName ?? null,
    codeWorkspacePath: existing?.codeWorkspacePath ?? null,
    pinned: existing?.pinned ?? false,
    folderId: existing?.folderId ?? null,
    projectId: existing?.projectId ?? options.projectId ?? null,
    activeConnectors: options.connectors ?? existing?.activeConnectors ?? [],
    archivedAt: existing?.archivedAt ?? null,
    lastMessageAt: now,
    createdAt: existing?.createdAt ?? now,
  } as ClientConversation);
}

function markInterrupted(conversationId: string): void {
  useThreadStore.getState().updateMessages(conversationId, (messages) =>
    messages.map((m) =>
      isStreamingRow(m)
        ? markStreaming({
            ...m,
            errorMessage: "Connection interrupted — Juno keeps working in the background…",
          })
        : m,
    ),
  );
}

async function recoverDroppedGeneration(
  conversationId: string,
  gen: ActiveGeneration,
): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < RECOVERY_WINDOW_MS) {
    if (latestSequence.get(gen.conversationId) !== gen.sequence) return; // superseded in THIS conversation
    await new Promise((r) => setTimeout(r, attempt < 8 ? 5_000 : 15_000));
    attempt++;
    try {
      const data = await api<{ messages: ClientMessage[]; artifacts: ClientArtifact[] }>(
        `/conversations/${encodeURIComponent(conversationId)}`,
      );
      const anchorIndex = gen.userMessageId
        ? data.messages.findIndex((m) => m.id === gen.userMessageId)
        : -1;
      const candidates = data.messages.slice(anchorIndex + 1);
      const store = useThreadStore.getState();
      const knownIds = new Set(
        (store.threads[conversationId]?.messages ?? []).map((m) => m.id),
      );
      const recovered = candidates.find((m) => {
        if (m.role !== "ASSISTANT") return false;
        const removedCreatedAt = gen.removedIds.get(m.id);
        if (removedCreatedAt !== undefined) return m.createdAt !== removedCreatedAt;
        return !knownIds.has(m.id);
      });
      if (recovered) {
        gen.done = true;
        active.delete(conversationId);
        store.updateMessages(conversationId, (messages) =>
          messages.map((m) => (isStreamingRow(m) ? recovered : m)),
        );
        store.mergeArtifacts(conversationId, data.artifacts);
        store.patchThread(conversationId, { status: "idle" });
        return;
      }
    } catch {
      // keep polling
    }
  }
  finalizeLocalStop(conversationId, gen);
}

/** Edit a user message, truncate the branch, regenerate. */
export async function editAndResend(
  conversationId: string,
  messageId: string,
  content: string,
  model: string,
): Promise<void> {
  const res = await api<{ ok: boolean; version?: { id: string; model: string | null; createdAt: string } }>(
    `/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: { content } },
  );
  const store = useThreadStore.getState();
  store.updateMessages(conversationId, (messages) => {
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1) return messages;
    const edited: ClientMessage = {
      ...messages[index]!,
      content,
      versions: res.version
        ? [...(messages[index]!.versions ?? []), res.version]
        : messages[index]!.versions ?? [],
    };
    return [...messages.slice(0, index), edited];
  });
  await sendMessage({ conversationId, message: "", model, regenerate: true });
}

export function sendFeedback(messageId: string, feedback: "UP" | "DOWN" | null): void {
  void api(`/messages/${encodeURIComponent(messageId)}/feedback`, {
    method: "POST",
    body: { feedback },
  }).catch(() => {});
}

// ---- client-driven auto-title ----

const titledPhases = new Map<string, Set<string>>();

export async function scheduleAutoTitle(
  conversationId: string,
  phase: "first_user" | "thinking" | "writing" | "completed" | "stopped",
): Promise<void> {
  const conversation = useDataStore.getState().conversations[conversationId];
  if (conversation && (conversation.titleSource === "manual" || conversation.titleSource === "user")) {
    return;
  }
  const phases = titledPhases.get(conversationId) ?? new Set();
  if (phases.has(phase)) return;
  phases.add(phase);
  titledPhases.set(conversationId, phases);
  const delay = { first_user: 160, thinking: 240, writing: 360, completed: 420, stopped: 80 }[phase];
  await new Promise((r) => setTimeout(r, delay));
  try {
    const res = await api<{
      title: string;
      titleSource: "default" | "ai" | "manual";
      renamed: boolean;
    }>(`/conversations/${encodeURIComponent(conversationId)}/title`, {
      method: "POST",
      body: { phase },
    });
    if (res.renamed) {
      const data = useDataStore.getState();
      const existing = data.conversations[conversationId];
      if (existing && existing.titleSource !== "manual") {
        data.upsertConversation({ ...existing, title: res.title, titleSource: res.titleSource });
      }
    }
  } catch {
    // Titling is decoration; never surface failures.
  }
}

async function loadFollowUps(conversationId: string): Promise<void> {
  try {
    const res = await api<{ suggestions: string[] }>("/chat/follow-ups", {
      method: "POST",
      body: { conversationId },
    });
    useThreadStore.getState().patchThread(conversationId, { followUps: res.suggestions });
  } catch {
    // Optional decoration.
  }
}
