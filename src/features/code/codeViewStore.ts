/**
 * Code-mode view state that is local to the code surface (not synced, not
 * part of the codeStore contract): which pane the main area shows, the
 * new-session composer's draft pickers, and inspector layout state.
 */
import { create } from "zustand";
import { useCodeStore } from "@/state/codeStore";
import type { PermissionMode } from "@/lib/code/types";

export type CodeMainView =
  | { kind: "session" }
  | { kind: "pulls" }
  /** A synced code conversation from another device (read-only notice). */
  | { kind: "remote"; conversationId: string };

export type InspectorTab = "changes" | "diff" | "terminal" | "git" | "context";

interface CodeViewState {
  view: CodeMainView;
  /** New-session composer drafts (null = follow defaults). */
  draftWorkspaceId: string | null;
  draftModelId: string | null;
  draftMode: PermissionMode | null;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  /** File selected in Changes -> shown in the Diff tab (null = whole diff). */
  diffPath: string | null;
  /** Sessions whose inspector already auto-opened once on files_changed. */
  autoOpened: Record<string, boolean>;

  setView(view: CodeMainView): void;
  setDraftWorkspaceId(id: string | null): void;
  setDraftModelId(id: string | null): void;
  setDraftMode(mode: PermissionMode | null): void;
  setInspectorOpen(open: boolean): void;
  setInspectorTab(tab: InspectorTab): void;
  setDiffPath(path: string | null): void;
  markAutoOpened(sessionId: string): void;
}

export const useCodeViewStore = create<CodeViewState>((set) => ({
  view: { kind: "session" },
  draftWorkspaceId: null,
  draftModelId: null,
  draftMode: null,
  inspectorOpen: false,
  inspectorTab: "changes",
  diffPath: null,
  autoOpened: {},

  setView: (view) => set({ view }),
  setDraftWorkspaceId: (draftWorkspaceId) => set({ draftWorkspaceId }),
  setDraftModelId: (draftModelId) => set({ draftModelId }),
  setDraftMode: (draftMode) => set({ draftMode }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setDiffPath: (diffPath) => set({ diffPath }),
  markAutoOpened: (sessionId) =>
    set((s) => ({ autoOpened: { ...s.autoOpened, [sessionId]: true } })),
}));

/**
 * Route to the new-session composer: the code surface treats
 * activeSessionId === null as "composing a new session". openSession()
 * requires an id, so the null is written through zustand's store-level
 * setState (no codeStore change).
 */
export function startNewCodeSession(): void {
  useCodeStore.setState({ activeSessionId: null });
  useCodeViewStore.getState().setView({ kind: "session" });
}

/** Open a local session and make sure the session pane is showing. */
export function openCodeSession(sessionId: string): void {
  useCodeStore.getState().openSession(sessionId);
  useCodeViewStore.getState().setView({ kind: "session" });
}
