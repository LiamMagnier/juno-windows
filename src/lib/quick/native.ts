import { invoke } from "@tauri-apps/api/core";

export interface QuickSettings {
  enabled: boolean;
  shortcut: string;
  launchAtLogin: boolean;
  dismissOnBlur: boolean;
  shortcutStatus: "registered" | "conflict" | "disabled" | string;
  shortcutError: string | null;
}

export type QuickSettingsPatch = Partial<
  Pick<QuickSettings, "enabled" | "shortcut" | "launchAtLogin" | "dismissOnBlur">
>;

export function getQuickSettings(): Promise<QuickSettings> {
  return invoke<QuickSettings>("quick_get_settings");
}

export function updateQuickSettings(patch: QuickSettingsPatch): Promise<QuickSettings> {
  return invoke<QuickSettings>("quick_update_settings", { patch });
}

export function hideQuick(): Promise<void> {
  return invoke("quick_hide");
}

export function openInJuno(conversationId?: string | null): Promise<void> {
  return invoke("quick_open_main", { conversationId: conversationId ?? null });
}

export function setQuickRuntimeState(
  busy: boolean,
  composerFocused: boolean,
  expanded: boolean,
): Promise<void> {
  return invoke("quick_set_runtime_state", { busy, composerFocused, expanded });
}
