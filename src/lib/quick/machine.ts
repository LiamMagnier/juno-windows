export type QuickPhase =
  | "idle"
  | "checking"
  | "clarifying"
  | "submitting"
  | "streaming"
  | "stopping"
  | "error";

export interface QuickInteractionState {
  phase: QuickPhase;
  dictating: boolean;
  menuOpen: boolean;
}

export type EscapeAction =
  | "close-menu"
  | "stop-dictation"
  | "cancel-clarification"
  | "stop-generation"
  | "wait"
  | "hide";

/** Deterministic Escape priority shared by UI behavior and tests. */
export function escapeAction(state: QuickInteractionState): EscapeAction {
  if (state.menuOpen) return "close-menu";
  if (state.dictating) return "stop-dictation";
  if (state.phase === "clarifying") return "cancel-clarification";
  if (state.phase === "submitting" || state.phase === "streaming") return "stop-generation";
  if (state.phase === "stopping") return "wait";
  return "hide";
}

export function shouldDismissOnBlur(
  state: QuickInteractionState,
  dismissOnBlur: boolean,
  nativeDialogOpen: boolean,
  uploading = false,
  hasDraftOrAttachments = false,
): boolean {
  if (
    !dismissOnBlur ||
    nativeDialogOpen ||
    state.menuOpen ||
    state.dictating ||
    uploading ||
    hasDraftOrAttachments
  ) {
    return false;
  }
  return state.phase === "idle";
}
