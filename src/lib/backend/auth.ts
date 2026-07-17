/**
 * Native device sign-in.
 *
 * Flow (juno/src/app/app-auth/page.tsx + api/v1/auth/token):
 *  1. generate state / nonce / PKCE verifier+challenge (webview)
 *  2. open the system browser at <backend>/app-auth?... (user signs in there)
 *  3. the handoff page redirects to com.liammagnier.juno://auth/callback?code&state&nonce
 *  4. the deep link lands here; validate state+nonce, then Rust exchanges the
 *     code (PKCE + installationId) and keeps the credentials.
 */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { backendBaseUrl } from "./config";
import { createHandshake, randomSecret, type AuthHandshake } from "./pkce";
import { hostInfo, secretGet, secretSet } from "../host";
import { clearTokens } from "./tokens";
import { api } from "./http";
import { BackendError, type DeviceSession, type SessionResponse } from "./types";

export const REDIRECT_URI = "com.liammagnier.juno://auth/callback";

/** Sign-in attempts expire alongside the server's short auth-code TTL. */
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

interface PendingSignIn extends AuthHandshake {
  startedAt: number;
}

let pending: PendingSignIn | null = null;

async function installationId(): Promise<string> {
  const existing = await secretGet("installation-id");
  if (existing && /^[A-Za-z0-9._:-]{16,200}$/.test(existing)) return existing;
  const fresh = `win.${randomSecret()}`;
  await secretSet("installation-id", fresh);
  return fresh;
}

/** Point the Rust transport at the configured backend. Call at startup and on env switch. */
export function configureTransport(): Promise<void> {
  return invoke("auth_configure", { baseUrl: backendBaseUrl() });
}

/** Opens the browser handoff. Resolves once the browser has been launched. */
export async function beginSignIn(): Promise<void> {
  const handshake = await createHandshake();
  pending = { ...handshake, startedAt: Date.now() };
  const query = new URLSearchParams({
    state: handshake.state,
    nonce: handshake.nonce,
    code_challenge: handshake.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    installation_id: await installationId(),
  });
  await openUrl(`${backendBaseUrl()}/app-auth?${query}`);
}

export function cancelSignIn(): void {
  pending = null;
}

export interface SignInResult {
  deviceSession: DeviceSession | null;
}

/**
 * Handles an incoming juno auth deep link. Returns null when the URL is not
 * an auth callback (callers may route other deep links elsewhere).
 */
export async function completeSignIn(url: string): Promise<SignInResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isAuthCallback =
    (parsed.protocol === "com.liammagnier.juno:" || parsed.protocol === "juno:") &&
    `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "") === "auth/callback";
  if (!isAuthCallback) return null;

  const handshake = pending;
  pending = null;
  if (!handshake || Date.now() - handshake.startedAt > HANDSHAKE_TTL_MS) {
    throw new BackendError(400, "stale_sign_in", "This sign-in attempt expired. Please try again.");
  }
  const code = parsed.searchParams.get("code") ?? "";
  const state = parsed.searchParams.get("state") ?? "";
  const nonce = parsed.searchParams.get("nonce") ?? "";
  if (!code || state !== handshake.state || nonce !== handshake.nonce) {
    throw new BackendError(
      400,
      "handshake_mismatch",
      "Sign-in was rejected: the callback did not match this app's request.",
    );
  }

  const host = await hostInfo();
  try {
    const result = await invoke<{ deviceSession: DeviceSession | null }>("auth_exchange", {
      code,
      codeVerifier: handshake.codeVerifier,
      redirectUri: REDIRECT_URI,
      installationId: await installationId(),
      deviceName: host.deviceName,
      platform: `windows-${host.arch}`,
      appVersion: host.appVersion,
    });
    return { deviceSession: result.deviceSession };
  } catch (err) {
    const commandError = err as { code?: string; message?: string };
    throw new BackendError(
      400,
      commandError.code ?? "invalid_grant",
      commandError.message ?? "Sign-in failed.",
    );
  }
}

export function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return api<SessionResponse>("/v1/auth/session", signal ? { signal } : {});
}

export async function signOut(): Promise<void> {
  await clearTokens();
}

export function listDevices(): Promise<{ devices: DeviceSession[] }> {
  return api<{ devices: DeviceSession[] }>("/v1/auth/devices");
}

export function revokeDevice(id: string): Promise<void> {
  return api(`/v1/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}
