/**
 * Open-thread state: messages + artifacts per conversation, streaming
 * placeholders, and generation status. The chat engine is the only writer
 * during a generation; the sync engine invalidates stale threads.
 */
import { create } from "zustand";
import type {
  ClientArtifact,
  ClientMessage,
  ClientQuota,
} from "@/lib/data/entities";
import { api } from "@/lib/backend/http";
import { setThreadInvalidator } from "@/lib/data/syncEngine";
import { useDataStore } from "./dataStore";
import type { ClientConversation } from "@/lib/data/entities";

export type GenerationStatus =
  | "idle"
  | "checking"
  | "submitting"
  | "thinking"
  | "writing"
  | "stopping";

export interface ThreadState {
  messages: ClientMessage[];
  artifacts: ClientArtifact[];
  loading: boolean;
  loadError: string | null;
  status: GenerationStatus;
  followUps: string[];
}

interface ThreadsState {
  threads: Record<string, ThreadState>;
  /** Which conversation each pane shows; "new" = unsent draft chat. */
  activeConversationId: string | null;
  privateMode: boolean;

  openThread(conversationId: string): Promise<void>;
  setActive(conversationId: string | null): void;
  setPrivateMode(privateMode: boolean): void;
  patchThread(conversationId: string, patch: Partial<ThreadState>): void;
  updateMessages(
    conversationId: string,
    updater: (messages: ClientMessage[]) => ClientMessage[],
  ): void;
  mergeArtifacts(conversationId: string, artifacts: ClientArtifact[]): void;
  invalidate(conversationId: string): void;
  reset(): void;
}

export const emptyThread: ThreadState = {
  messages: [],
  artifacts: [],
  loading: false,
  loadError: null,
  status: "idle",
  followUps: [],
};

export const useThreadStore = create<ThreadsState>((set, get) => ({
  threads: {},
  activeConversationId: null,
  privateMode: false,

  setActive: (activeConversationId) => set({ activeConversationId }),
  setPrivateMode: (privateMode) => set({ privateMode }),

  patchThread: (id, patch) =>
    set((s) => ({
      threads: { ...s.threads, [id]: { ...(s.threads[id] ?? emptyThread), ...patch } },
    })),

  updateMessages: (id, updater) =>
    set((s) => {
      const thread = s.threads[id] ?? emptyThread;
      return {
        threads: { ...s.threads, [id]: { ...thread, messages: updater(thread.messages) } },
      };
    }),

  mergeArtifacts: (id, incoming) =>
    set((s) => {
      const thread = s.threads[id] ?? emptyThread;
      const byIdentifier = new Map(thread.artifacts.map((a) => [a.identifier, a]));
      for (const artifact of incoming) byIdentifier.set(artifact.identifier, artifact);
      return {
        threads: {
          ...s.threads,
          [id]: { ...thread, artifacts: [...byIdentifier.values()] },
        },
      };
    }),

  async openThread(conversationId) {
    const existing = get().threads[conversationId];
    if (existing?.loading) return;
    get().patchThread(conversationId, { loading: true, loadError: null });
    try {
      const data = await api<{
        conversation: ClientConversation;
        messages: ClientMessage[];
        artifacts: ClientArtifact[];
      }>(`/conversations/${encodeURIComponent(conversationId)}`);
      useDataStore.getState().upsertConversation(data.conversation);
      const current = get().threads[conversationId] ?? emptyThread;
      // Never clobber an in-flight stream with a reload.
      if (current.status !== "idle" && current.status !== "checking") {
        get().patchThread(conversationId, { loading: false });
        return;
      }
      get().patchThread(conversationId, {
        messages: data.messages,
        artifacts: data.artifacts,
        loading: false,
        loadError: null,
      });
    } catch (err) {
      get().patchThread(conversationId, {
        loading: false,
        loadError: err instanceof Error ? err.message : "Couldn't load this conversation.",
      });
    }
  },

  invalidate(conversationId) {
    const thread = get().threads[conversationId];
    if (!thread) return;
    // Streaming threads self-heal via done/recovery; reload idle ones only.
    if (thread.status === "idle") void get().openThread(conversationId);
  },

  reset: () => set({ threads: {}, activeConversationId: null, privateMode: false }),
}));

setThreadInvalidator((conversationId) => useThreadStore.getState().invalidate(conversationId));

export function applyQuota(quota: ClientQuota | undefined): void {
  if (quota) useDataStore.getState().setQuota(quota);
}
