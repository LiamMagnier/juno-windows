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
import type { PreflightClarificationContext } from "./clarification";
import {
  durableReceiptFailureMessage,
  durableReceiptPath,
  parseDurableReceipt,
  type DurableReceiptStatus,
} from "./receipt";

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
  /** Pre-answer clarification context persisted with the first user turn. */
  preflightClarification?: PreflightClarificationContext;
  /** Durable creation metadata for Juno Quick's first saved submission. */
  origin?: "quick_windows";
  clientRequestId?: string;
  clientMessageId?: string;
}

interface ActiveGeneration {
  generationId: string;
  conversationId: string;
  clientRequestId: string | null;
  optimisticUserMessageId: string | null;
  assistantMessageId: string;
  controller: AbortController;
  sequence: number;
  sawMeta: boolean;
  userMessageId: string | null;
  /** ids of assistant rows we removed locally for regenerate: id -> createdAt */
  removedIds: Map<string, string>;
  done: boolean;
  stopRequested: boolean;
  serverCancelConfirmed: boolean;
  recovering: boolean;
  recoveryPromise: Promise<void> | null;
  options: SendOptions;
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
  if (!gen || gen.stopRequested) return;
  gen.stopRequested = true;
  const store = useThreadStore.getState();
  store.patchThread(conversationId, { status: "stopping" });

  // Durable Quick generations use a server-generated generation id. Recovery
  // resolves it from the account-scoped receipt even when Stop wins the race
  // against the first meta frame, then keeps polling until terminal truth.
  if (gen.clientRequestId) {
    scheduleDroppedRecovery(null, gen);
    gen.controller.abort();
    return;
  }

  // Legacy/main generations own the id they sent and can cancel immediately.
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
  if (active.get(conversationId) === gen) active.delete(conversationId);
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
    clientRequestId: options.clientRequestId ?? null,
    optimisticUserMessageId: userRow?.id ?? null,
    assistantMessageId: assistantRow.id,
    controller,
    sequence,
    sawMeta: false,
    userMessageId: null,
    removedIds,
    done: false,
    stopRequested: false,
    serverCancelConfirmed: false,
    recovering: false,
    recoveryPromise: null,
    options,
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
  if (options.preflightClarification) {
    body.preflightClarification = options.preflightClarification;
  }
  if (
    !privateMode &&
    !options.conversationId &&
    options.origin === "quick_windows" &&
    options.clientRequestId &&
    options.clientMessageId
  ) {
    body.origin = options.origin;
    body.clientRequestId = options.clientRequestId;
    body.clientMessageId = options.clientMessageId;
  }

  let resolvedConversationId: string | null = options.conversationId;
  let recoveryScheduled = false;

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
          if (chunk.generationId) gen.generationId = chunk.generationId;
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
          if (chunk.generationId) gen.generationId = chunk.generationId;
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
        recoveryScheduled = true;
        scheduleDroppedRecovery(resolvedConversationId, gen);
      } else {
        finalizeLocalStop(gen.conversationId, gen);
      }
    }
  } catch (err) {
    if (
      !gen.done &&
      err instanceof BackendError &&
      err.status === 409 &&
      err.code === "REQUEST_ALREADY_SUBMITTED" &&
      typeof err.details?.conversationId === "string"
    ) {
      // The backend already accepted this stable Quick request. Adopt its
      // canonical conversation instead of showing a false failure or sending
      // a duplicate first turn.
      const canonicalId = err.details.conversationId;
      resolvedConversationId = canonicalId;
      gen.sawMeta = true;
      gen.userMessageId =
        typeof err.details.userMessageId === "string" ? err.details.userMessageId : null;
      if (typeof err.details.generationId === "string") {
        gen.generationId = err.details.generationId;
      }
      if (key === "new") migrateThread("new", canonicalId, gen);
      upsertConversationStub(canonicalId, "New conversation", options);
      if (err.details.receiptState === "failed") {
        gen.done = true;
        const failureMessage = durableReceiptFailureMessage({
          conversationId: canonicalId,
          userMessageId: gen.userMessageId ?? "unknown-message",
          generationId: gen.generationId,
          receiptState: "failed",
          finishReason: (typeof err.details.finishReason === "string"
            ? err.details.finishReason
            : "error") as ChatFinishReason,
          failureCode: typeof err.details.failureCode === "string" ? err.details.failureCode : null,
        });
        useThreadStore.getState().updateMessages(canonicalId, (messages) =>
          messages.map((message) =>
            isStreamingRow(message)
              ? {
                  ...stripStreaming(message),
                  content: message.content || failureMessage,
                  errorMessage: failureMessage,
                  finishReason: (typeof err.details?.finishReason === "string"
                    ? err.details.finishReason
                    : "error") as ChatFinishReason,
                }
              : message,
          ),
        );
        useThreadStore.getState().patchThread(canonicalId, { status: "idle" });
      } else {
        markInterrupted(canonicalId);
        // The accepted generation may still be running. Keep the assistant
        // row recoverable and poll from the canonical user-message anchor.
        recoveryScheduled = true;
        scheduleDroppedRecovery(canonicalId, gen);
      }
    } else if (
      !gen.done &&
      err instanceof DOMException &&
      err.name === "AbortError" &&
      gen.clientRequestId &&
      gen.recovering
    ) {
      // Durable Stop/drop recovery owns terminalization. Do not manufacture a
      // local user_stopped result before the canonical receipt is known.
      recoveryScheduled = true;
    } else if (
      !gen.done &&
      gen.clientRequestId &&
      err instanceof BackendError &&
      (err.status === 0 || err.status >= 500 || err.code === "REQUEST_IN_PROGRESS")
    ) {
      // The transport can fail after the backend has committed acceptance but
      // before the first SSE meta frame reaches this process. The stable key is
      // the only safe authority in that window.
      markInterrupted(gen.conversationId);
      recoveryScheduled = true;
      scheduleDroppedRecovery(null, gen);
    } else if (!gen.done) {
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
        gen.done = true;
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
    if (!recoveryScheduled && !gen.recovering) {
      if (active.get(gen.conversationId) === gen) active.delete(gen.conversationId);
      const store = useThreadStore.getState();
      if (store.threads[gen.conversationId]?.status !== "idle") {
        store.patchThread(gen.conversationId, { status: "idle" });
      }
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
  latestSequence.delete(fromKey);
  latestSequence.set(toKey, gen.sequence);
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

function scheduleDroppedRecovery(conversationId: string | null, gen: ActiveGeneration): void {
  if (gen.recoveryPromise) return;
  gen.recovering = true;
  gen.recoveryPromise = recoverDroppedGeneration(conversationId, gen).finally(() => {
    gen.recovering = false;
    gen.recoveryPromise = null;
  });
  void gen.recoveryPromise;
}

async function fetchDurableReceipt(gen: ActiveGeneration): Promise<DurableReceiptStatus> {
  const selector = gen.clientRequestId
    ? { clientRequestId: gen.clientRequestId }
    : { generationId: gen.generationId };
  const raw = await api<unknown>(durableReceiptPath(selector));
  const receipt = parseDurableReceipt(raw);
  if (!receipt) {
    throw new BackendError(0, "invalid_receipt", "Juno returned an invalid generation receipt.", true);
  }
  return receipt;
}

function adoptDurableReceipt(gen: ActiveGeneration, receipt: DurableReceiptStatus): boolean {
  const previousKey = gen.conversationId;
  if (previousKey !== "new" && previousKey !== receipt.conversationId) return false;
  gen.generationId = receipt.generationId;
  gen.userMessageId = receipt.userMessageId;
  gen.sawMeta = true;
  if (previousKey === "new") migrateThread("new", receipt.conversationId, gen);
  upsertConversationStub(receipt.conversationId, "New conversation", gen.options);
  if (gen.optimisticUserMessageId) {
    useThreadStore.getState().updateMessages(gen.conversationId, (messages) =>
      messages.map((message) =>
        message.id === gen.optimisticUserMessageId
          ? { ...message, id: receipt.userMessageId }
          : message,
      ),
    );
    gen.optimisticUserMessageId = null;
  }
  return true;
}

function finishReceiptFailure(gen: ActiveGeneration, receipt: DurableReceiptStatus): void {
  if (gen.done) return;
  gen.done = true;
  const message = durableReceiptFailureMessage(receipt);
  const conversationId = gen.conversationId;
  const store = useThreadStore.getState();
  store.updateMessages(conversationId, (messages) =>
    messages.map((row) =>
      row.id === gen.assistantMessageId || isStreamingRow(row)
        ? {
            ...stripStreaming(row),
            content: row.content || message,
            errorMessage: message,
            finishReason: receipt.finishReason ?? "error",
          }
        : row,
    ),
  );
  store.patchThread(conversationId, { status: "idle" });
  if (active.get(conversationId) === gen) active.delete(conversationId);
}

function finishUnconfirmedRecovery(gen: ActiveGeneration): void {
  if (gen.done) return;
  gen.done = true;
  const message = gen.stopRequested
    ? "Juno could not confirm that the response stopped. Reconnect and retry this turn safely."
    : "Juno could not confirm how the interrupted response ended. Reconnect and retry this turn.";
  const conversationId = gen.conversationId;
  const store = useThreadStore.getState();
  store.updateMessages(conversationId, (messages) =>
    messages.map((row) =>
      row.id === gen.assistantMessageId || isStreamingRow(row)
        ? {
            ...stripStreaming(row),
            content: row.content || message,
            errorMessage: message,
            finishReason: "network_error" as ChatFinishReason,
          }
        : row,
    ),
  );
  store.patchThread(conversationId, { status: "idle" });
  if (active.get(conversationId) === gen) active.delete(conversationId);
}

async function recoverConversationResult(
  conversationId: string,
  gen: ActiveGeneration,
): Promise<boolean> {
  const data = await api<{ messages: ClientMessage[]; artifacts: ClientArtifact[] }>(
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
  const anchorIndex = gen.userMessageId
    ? data.messages.findIndex((message) => message.id === gen.userMessageId)
    : -1;
  const candidates = data.messages.slice(anchorIndex + 1);
  const store = useThreadStore.getState();
  const knownIds = new Set(
    (store.threads[conversationId]?.messages ?? []).map((message) => message.id),
  );
  const recovered = candidates.find((message) => {
    if (message.role !== "ASSISTANT") return false;
    const removedCreatedAt = gen.removedIds.get(message.id);
    if (removedCreatedAt !== undefined) return message.createdAt !== removedCreatedAt;
    return !knownIds.has(message.id);
  });
  if (!recovered) return false;
  gen.done = true;
  store.updateMessages(conversationId, (messages) =>
    messages.map((message) =>
      message.id === gen.assistantMessageId || isStreamingRow(message) ? recovered : message,
    ),
  );
  store.mergeArtifacts(conversationId, data.artifacts);
  store.patchThread(conversationId, { status: "idle" });
  if (active.get(conversationId) === gen) active.delete(conversationId);
  return true;
}

async function recoverDroppedGeneration(
  initialConversationId: string | null,
  gen: ActiveGeneration,
): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  let conversationId = initialConversationId;
  try {
    while (Date.now() - startedAt < RECOVERY_WINDOW_MS) {
      if (gen.done || latestSequence.get(gen.conversationId) !== gen.sequence) return;

      let receipt: DurableReceiptStatus | null = null;
      if (gen.clientRequestId) {
        try {
          receipt = await fetchDurableReceipt(gen);
          if (!adoptDurableReceipt(gen, receipt)) {
            finishUnconfirmedRecovery(gen);
            return;
          }
          conversationId = receipt.conversationId;
          if (receipt.receiptState === "failed") {
            finishReceiptFailure(gen, receipt);
            return;
          }
          if (gen.stopRequested && !gen.serverCancelConfirmed) {
            try {
              const cancellation = await api<{ ok: boolean; cancelled: boolean }>("/chat/cancel", {
                method: "POST",
                body: { generationId: receipt.generationId },
              });
              gen.serverCancelConfirmed = cancellation.cancelled;
            } catch {
              // The receipt loop retries; never claim user_stopped without a
              // canonical cancellation or terminal receipt.
            }
          }
        } catch {
          // A 404 can race acceptance and network failures are recoverable.
        }
      }

      if (conversationId) {
        try {
          if (await recoverConversationResult(conversationId, gen)) return;
        } catch {
          // Keep checking the account-scoped receipt and canonical thread.
        }
      }

      if (receipt?.receiptState === "completed") {
        // Completion is authoritative even if the conversation refresh raced
        // replication. End the spinner and immediately reload the full thread.
        gen.done = true;
        const store = useThreadStore.getState();
        store.patchThread(gen.conversationId, { status: "idle" });
        if (active.get(gen.conversationId) === gen) active.delete(gen.conversationId);
        void store.openThread(gen.conversationId);
        return;
      }

      const delay = gen.stopRequested ? 500 : attempt < 8 ? 5_000 : 15_000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
    finishUnconfirmedRecovery(gen);
  } finally {
    if (gen.done && active.get(gen.conversationId) === gen) active.delete(gen.conversationId);
    if (gen.done && useThreadStore.getState().threads[gen.conversationId]?.status !== "idle") {
      useThreadStore.getState().patchThread(gen.conversationId, { status: "idle" });
    }
  }
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
