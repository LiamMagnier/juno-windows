/**
 * Session-credential glue. The actual token lifecycle (rotating refresh
 * token in the OS vault, in-memory access token, single-flight rotation)
 * lives in Rust (src-tauri/src/net/auth.rs) — the webview never sees a
 * credential. This module only asks "is there a session?" and reacts to
 * revocation events.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function hasStoredSession(): Promise<boolean> {
  return invoke<boolean>("auth_has_session");
}

/** Sign out this device: server-side revocation + local wipe (Rust-owned). */
export function clearTokens(): Promise<void> {
  return invoke("auth_sign_out");
}

/**
 * Fires when the Rust transport discovers the device session is dead
 * (refresh rejected / reuse detected). The auth store flips to signed-out.
 */
export function onSessionRevoked(handler: () => void): Promise<() => void> {
  return listen("juno://auth-revoked", handler);
}
