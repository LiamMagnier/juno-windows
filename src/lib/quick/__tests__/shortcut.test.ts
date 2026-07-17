import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "../shortcut";

function event(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: " ",
    code: "Space",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("Quick shortcut recorder", () => {
  it("records the Windows default", () => {
    expect(shortcutFromKeyboardEvent(event({ ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+Space",
    );
  });

  it("uses physical letter codes across keyboard layouts", () => {
    expect(
      shortcutFromKeyboardEvent(event({ key: "q", code: "KeyA", ctrlKey: true, altKey: true })),
    ).toBe("Ctrl+Alt+A");
  });

  it("rejects unmodified and modifier-only input", () => {
    expect(shortcutFromKeyboardEvent(event({}))).toBeNull();
    expect(
      shortcutFromKeyboardEvent(event({ key: "Control", code: "ControlLeft", ctrlKey: true })),
    ).toBeNull();
  });
});

