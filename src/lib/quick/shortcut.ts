const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function normalizedKey(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (event.code === "Space" || event.key === " ") return "Space";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return event.key;
  const named: Record<string, string> = {
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return named[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : null);
}

/** Convert a physical keyboard chord to the official plugin's parser format. */
export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): string | null {
  const key = normalizedKey(event);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Super");
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}

