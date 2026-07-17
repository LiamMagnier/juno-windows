/**
 * Authenticated transport to the Juno backend.
 *
 * Every app route accepts `Authorization: Bearer <native access token>`
 * (juno/src/lib/session.ts) — this client never touches cookies. A 401 gets
 * one forced token rotation + retry; a second 401 bubbles up as a real
 * auth failure.
 */
import { apiUrl } from "./config";
import { getAccessToken, parseErrorEnvelope } from "./tokens";
import { BackendError } from "./types";

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Total attempts for transient (network / 5xx / 429) failures on idempotent requests. */
  retries?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

async function rawRequest(path: string, options: ApiRequestOptions, forceRefresh: boolean): Promise<Response> {
  const token = await getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(apiUrl(path), {
    method: options.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    });
  });
}

/** JSON request/response against /api/<path>. Throws BackendError on non-2xx. */
export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const isIdempotent = (options.method ?? "GET") === "GET";
  const maxAttempts = isIdempotent ? (options.retries ?? 3) : 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let res = await rawRequest(path, options, false);
      if (res.status === 401) {
        res = await rawRequest(path, options, true);
      }
      if (!res.ok) {
        const error = await parseErrorEnvelope(res);
        const transient = error.status === 429 || error.status >= 500;
        if (transient && attempt < maxAttempts - 1) {
          lastError = error;
          await sleep(error.retryAfterMs ?? 500 * 2 ** attempt, options.signal);
          continue;
        }
        throw error;
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Network-level failure: retry idempotent requests.
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(500 * 2 ** attempt, options.signal);
        continue;
      }
      throw new BackendError(0, "network_error", err instanceof Error ? err.message : "Network error", true);
    }
  }
  throw lastError instanceof Error ? lastError : new BackendError(0, "network_error", "Network error", true);
}

/**
 * Authenticated streaming POST returning the raw Response (SSE bodies).
 * The caller owns parsing and cancellation via `signal`.
 */
export async function apiStream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  let res = await streamOnce(path, body, signal, false);
  if (res.status === 401) {
    res = await streamOnce(path, body, signal, true);
  }
  if (!res.ok || !res.body) {
    throw await parseErrorEnvelope(res);
  }
  return res;
}

async function streamOnce(path: string, body: unknown, signal: AbortSignal, forceRefresh: boolean): Promise<Response> {
  const token = await getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
  return fetch(apiUrl(path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
}
