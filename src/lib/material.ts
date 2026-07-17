/**
 * Window backdrop material orchestration.
 *
 * Win11 layering: a translucent chrome (titlebar + sidebar + flyouts) floats
 * over the window's Mica backdrop, while the content pane is a solid card.
 * The Rust command reports whether a *native* backdrop was actually installed;
 * we only let chrome go see-through (`has-native-material`) when it was, so an
 * OS/theme without Mica keeps an opaque in-app material and never shows desktop.
 *
 * Transparency is suppressed when the user turns it off or the OS requests
 * reduced transparency (`prefers-reduced-transparency`), matching the Windows
 * "Transparency effects" system setting.
 */
import { invoke } from "@tauri-apps/api/core";

let reducedTransparency: MediaQueryList | null = null;

function transparencyAllowed(userEnabled: boolean): boolean {
  if (!userEnabled) return false;
  reducedTransparency ??= window.matchMedia("(prefers-reduced-transparency: reduce)");
  return !reducedTransparency.matches;
}

/**
 * Apply the backdrop for the resolved theme and toggle the document classes the
 * stylesheet keys off:
 *   .has-native-material — a real OS backdrop is live; chrome may be see-through
 *   .no-transparency     — force fully opaque surfaces everywhere
 */
let materialSeq = 0;

export async function applyWindowMaterial(dark: boolean, userEnabled: boolean): Promise<void> {
  const root = document.documentElement;
  const enabled = transparencyAllowed(userEnabled);
  root.classList.toggle("no-transparency", !enabled);
  // Drop the see-through class synchronously when transparency is off: Rust
  // clears Mica immediately, so leaving `.app-frame` transparent across the IPC
  // round-trip would flash the desktop through the (transparent:true) window.
  if (!enabled) root.classList.remove("has-native-material");
  // Guard against out-of-order resolutions when theme/transparency toggle fast.
  const seq = ++materialSeq;
  try {
    const res = await invoke<{ native: boolean }>("set_window_material", { dark, enabled });
    if (seq !== materialSeq) return;
    root.classList.toggle("has-native-material", enabled && res.native);
  } catch {
    // Command unavailable (non-Tauri context / older shell): stay opaque-safe.
    if (seq === materialSeq) root.classList.remove("has-native-material");
  }
}

/** Subscribe to OS reduced-transparency changes; re-applies via `onChange`. */
export function watchReducedTransparency(onChange: () => void): () => void {
  reducedTransparency ??= window.matchMedia("(prefers-reduced-transparency: reduce)");
  reducedTransparency.addEventListener("change", onChange);
  return () => reducedTransparency?.removeEventListener("change", onChange);
}
