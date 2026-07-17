import { describe, expect, it } from "vitest";
import { escapeAction, shouldDismissOnBlur, type QuickInteractionState } from "../machine";

const idle: QuickInteractionState = { phase: "idle", dictating: false, menuOpen: false };

describe("Juno Quick interaction state", () => {
  it("closes nested interaction before hiding", () => {
    expect(escapeAction({ ...idle, menuOpen: true })).toBe("close-menu");
    expect(escapeAction({ ...idle, dictating: true })).toBe("stop-dictation");
    expect(escapeAction({ ...idle, phase: "clarifying" })).toBe("cancel-clarification");
    expect(escapeAction(idle)).toBe("hide");
  });

  it("stops generation before a later Escape can hide the surface", () => {
    expect(escapeAction({ ...idle, phase: "submitting" })).toBe("stop-generation");
    expect(escapeAction({ ...idle, phase: "streaming" })).toBe("stop-generation");
    expect(escapeAction({ ...idle, phase: "stopping" })).toBe("wait");
  });

  it("does not dismiss while a picker or menu owns focus", () => {
    expect(shouldDismissOnBlur(idle, true, false)).toBe(true);
    expect(shouldDismissOnBlur(idle, true, true)).toBe(false);
    expect(shouldDismissOnBlur({ ...idle, menuOpen: true }, true, false)).toBe(false);
    expect(shouldDismissOnBlur(idle, false, false)).toBe(false);
    expect(shouldDismissOnBlur({ ...idle, phase: "checking" }, true, false)).toBe(false);
    expect(shouldDismissOnBlur({ ...idle, phase: "streaming" }, true, false)).toBe(false);
    expect(shouldDismissOnBlur({ ...idle, phase: "error" }, true, false)).toBe(false);
    expect(shouldDismissOnBlur({ ...idle, dictating: true }, true, false)).toBe(false);
    expect(shouldDismissOnBlur(idle, true, false, true)).toBe(false);
    expect(shouldDismissOnBlur(idle, true, false, false, true)).toBe(false);
  });
});
