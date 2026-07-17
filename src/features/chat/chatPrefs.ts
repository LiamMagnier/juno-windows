/**
 * Composer preferences local to the chat feature (NOT account data):
 * per-thread model overrides, per-model reasoning effort, web-search toggle,
 * and per-thread connector selections. The last picked model persists so new
 * chats reopen with it.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ReasoningEffort } from "@/lib/data/entities";

/** Sentinel for an explicit "Instant" pick on a model whose reasoning can be disabled. */
export const EFFORT_NONE = "none" as const;
export type StoredEffort = ReasoningEffort | typeof EFFORT_NONE;

interface ChatPrefsState {
  /** Last model the user picked anywhere; seeds new chats. */
  lastModel: string | null;
  /** threadKey -> explicit model pick for that thread this session. */
  modelByThread: Record<string, string>;
  /** model id -> explicit effort pick ("none" = instant). Absent = model default. */
  effortByModel: Record<string, StoredEffort>;
  webSearch: boolean;
  /** threadKey -> connector ids selected for the next send. */
  connectorsByThread: Record<string, string[]>;

  setModel(threadKey: string, modelId: string): void;
  setEffort(modelId: string, effort: ReasoningEffort | null): void;
  setWebSearch(on: boolean): void;
  setConnectors(threadKey: string, ids: string[]): void;
}

export const useChatPrefs = create<ChatPrefsState>()(
  persist(
    (set) => ({
      lastModel: null,
      modelByThread: {},
      effortByModel: {},
      webSearch: false,
      connectorsByThread: {},

      setModel: (threadKey, modelId) =>
        set((s) => ({
          lastModel: modelId,
          modelByThread: { ...s.modelByThread, [threadKey]: modelId },
        })),
      setEffort: (modelId, effort) =>
        set((s) => ({
          effortByModel: { ...s.effortByModel, [modelId]: effort ?? EFFORT_NONE },
        })),
      setWebSearch: (webSearch) => set({ webSearch }),
      setConnectors: (threadKey, ids) =>
        set((s) => ({
          connectorsByThread: { ...s.connectorsByThread, [threadKey]: ids },
        })),
    }),
    {
      name: "juno.chat.prefs",
      partialize: (s) => ({ lastModel: s.lastModel, webSearch: s.webSearch }),
    },
  ),
);
