/**
 * Authenticated transport to the Juno backend, proxied through Rust.
 *
 * Why not fetch(): the backend middleware rejects any mutating request whose
 * Origin header doesn't match the site, and serves no CORS headers — native
 * clients are expected to send no Origin at all. The Rust proxy also owns the
 * token lifecycle, so bearer credentials never enter the webview.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { BackendError } from "./types";

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Total attempts for transient (network / 5xx / 429) failures on idempotent requests. */
  retries?: number;
  timeoutMs?: number;
}

interface RustApiResponse {
  status: number;
  body: string;
}

export function errorFromBody(status: number, body: string): BackendError {
  let code = "http_error";
  let message = `Request failed (${status})`;
  let retryable = status >= 500;
  let retryAfterMs: number | null = null;
  let details: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: string; message?: string };
    if (typeof parsed.error === "string") {
      message = parsed.message ?? parsed.error;
      if (parsed.code) code = parsed.code;
    } else if (parsed.error && typeof parsed.error === "object") {
      const env = parsed.error as {
        code?: string;
        message?: string;
        retryable?: boolean;
        retryAfterMs?: number | null;
        details?: Record<string, unknown>;
      };
      code = env.code ?? code;
      message = env.message ?? message;
      retryable = env.retryable ?? retryable;
      retryAfterMs = env.retryAfterMs ?? null;
      details = env.details;
    }
  } catch {
    // non-JSON body
  }
  const error = new BackendError(status, code, message, retryable, retryAfterMs);
  error.details = details;
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

interface RawRequest extends Record<string, unknown> {
  method: string;
  path: string;
  bodyJson?: string;
  timeoutMs?: number;
}

async function rustRequest(req: RawRequest): Promise<RustApiResponse> {
  try {
    return await invoke<RustApiResponse>("api_request", req);
  } catch (err) {
    const commandError = err as { code?: string; message?: string };
    if (commandError.code === "device_revoked" || commandError.code === "no_device_session") {
      throw new BackendError(401, commandError.code, commandError.message ?? "Signed out.");
    }
    if (commandError.code === "timeout") {
      throw new BackendError(0, "timeout", "The request timed out.", true);
    }
    throw new BackendError(0, "network_error", commandError.message ?? "Network error", true);
  }
}

/**
 * JSON request/response against /api/<path>. Throws BackendError on non-2xx.
 * `bodyJson` callers (mutation queue) may pass a pre-serialized string via
 * `body` being a string — it is sent verbatim so retries stay byte-identical.
 */
export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const isIdempotent = method === "GET";
  const maxAttempts = isIdempotent ? (options.retries ?? 3) : 1;
  const request: RawRequest = { method, path };
  if (options.body !== undefined) {
    request.bodyJson = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await rustRequest(request);
      if (res.status >= 200 && res.status < 300) {
        return (res.body ? JSON.parse(res.body) : undefined) as T;
      }
      const error = errorFromBody(res.status, res.body);
      const transient = error.status === 429 || error.status >= 500;
      if (transient && attempt < maxAttempts - 1) {
        lastError = error;
        await sleep(error.retryAfterMs ?? 500 * 2 ** attempt, options.signal);
        continue;
      }
      throw error;
    } catch (err) {
      if (err instanceof BackendError) {
        if (err.status === 0 && attempt < maxAttempts - 1) {
          lastError = err;
          await sleep(500 * 2 ** attempt, options.signal);
          continue;
        }
        throw err;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new BackendError(0, "network_error", "Network error", true);
}

type StreamEvent =
  | { event: "started"; status: number }
  | { event: "chunk"; data: string }
  | { event: "end" }
  | { event: "error"; message: string; status: number; body: string };

/**
 * Authenticated streaming POST yielding raw body chunks (SSE text).
 * Aborting `signal` cancels the underlying connection immediately.
 */
export async function apiStream(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<AsyncIterable<string>> {
  const channel = new Channel<StreamEvent>();
  const queue: StreamEvent[] = [];
  let notify: (() => void) | null = null;
  channel.onmessage = (event) => {
    queue.push(event);
    notify?.();
  };

  let handle: { streamId: number };
  try {
    handle = await invoke<{ streamId: number }>("api_stream", {
      path,
      bodyJson: JSON.stringify(body),
      onEvent: channel,
    });
  } catch (err) {
    const commandError = err as { code?: string; message?: string };
    if (commandError.code === "device_revoked" || commandError.code === "no_device_session") {
      throw new BackendError(401, commandError.code, commandError.message ?? "Signed out.");
    }
    throw new BackendError(0, "network_error", commandError.message ?? "Network error", true);
  }

  const cancel = () => {
    void invoke("api_stream_cancel", { streamId: handle.streamId }).catch(() => {});
  };
  if (signal.aborted) {
    cancel();
    throw new DOMException("Aborted", "AbortError");
  }
  signal.addEventListener("abort", cancel);

  async function* iterate(): AsyncGenerator<string> {
    try {
      for (;;) {
        while (queue.length === 0) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
        const event = queue.shift()!;
        switch (event.event) {
          case "started":
            break;
          case "chunk":
            yield event.data;
            break;
          case "end":
            return;
          case "error": {
            if (event.status > 0) throw errorFromBody(event.status, event.body);
            throw new BackendError(0, "network_error", event.message || "Stream failed", true);
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  }

  return iterate();
}
