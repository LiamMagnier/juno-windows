/**
 * Native device-token lifecycle.
 *
 * Access tokens live ~10 minutes and stay in memory only. The rotating
 * refresh token is the device credential and lives in the OS vault
 * (Windows Credential Manager). Refresh is single-flight: concurrent 401s
 * share one rotation, because the server treats a reused refresh token as
 * theft and revokes the whole device session.
 */
import { apiUrl } from "./config";
import { secretDelete, secretGet, secretSet } from "../host";
import { BackendError, type ApiErrorEnvelope, type RefreshResponse, type TokenResponse } from "./types";

interface AccessState {
  accessToken: string;
  accessTokenExpiresAt: number; // epoch ms
}

/** Refresh this many ms before the server-declared expiry. */
const REFRESH_SKEW_MS = 60_000;

let access: AccessState | null = null;
let refreshInFlight: Promise<string> | null = null;
let onSessionRevoked: (() => void) | null = null;

export function setSessionRevokedHandler(handler: () => void): void {
  onSessionRevoked = handler;
}

export async function parseErrorEnvelope(res: Response): Promise<BackendError> {
  let code = "http_error";
  let message = `Request failed (${res.status})`;
  let retryable = res.status >= 500;
  let retryAfterMs: number | null = null;
  try {
    const body = (await res.json()) as Partial<ApiErrorEnvelope> & { error?: unknown };
    if (typeof body.error === "string") {
      message = body.error;
      const machine = (body as { code?: string }).code;
      if (machine) code = machine;
    } else if (body.error && typeof body.error === "object") {
      const env = body.error as ApiErrorEnvelope["error"];
      code = env.code ?? code;
      message = env.message ?? message;
      retryable = env.retryable ?? retryable;
      retryAfterMs = env.retryAfterMs ?? null;
    }
  } catch {
    // non-JSON body; keep defaults
  }
  return new BackendError(res.status, code, message, retryable, retryAfterMs);
}

export function adoptTokens(tokens: RefreshResponse | TokenResponse): Promise<void> {
  access = {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.parse(tokens.accessTokenExpiresAt),
  };
  return secretSet("refresh-token", tokens.refreshToken);
}

export async function clearTokens(): Promise<void> {
  access = null;
  refreshInFlight = null;
  await secretDelete("refresh-token");
}

export async function hasStoredSession(): Promise<boolean> {
  return (await secretGet("refresh-token")) !== null;
}

async function rotateRefreshToken(): Promise<string> {
  const refreshToken = await secretGet("refresh-token");
  if (!refreshToken) {
    throw new BackendError(401, "no_device_session", "Not signed in on this device.");
  }
  const res = await fetch(apiUrl("/v1/auth/refresh"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    const error = await parseErrorEnvelope(res);
    if (res.status === 400 || res.status === 401) {
      // Grant is invalid, expired, reused, or the device was revoked:
      // this device session is dead. Wipe it and surface sign-in.
      await clearTokens();
      onSessionRevoked?.();
    }
    throw error;
  }
  const tokens = (await res.json()) as RefreshResponse;
  await adoptTokens(tokens);
  return tokens.accessToken;
}

/**
 * Returns a bearer token, rotating the refresh token if the cached access
 * token is missing or near expiry. Throws BackendError(401) when the device
 * has no session.
 */
export function getAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
  if (
    !options?.forceRefresh &&
    access &&
    access.accessTokenExpiresAt - Date.now() > REFRESH_SKEW_MS
  ) {
    return Promise.resolve(access.accessToken);
  }
  refreshInFlight ??= rotateRefreshToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
