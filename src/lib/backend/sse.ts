/**
 * Minimal SSE reader for the backend's framing: every event is a single
 * `data: <json>\n\n` block with the discriminator inside the JSON `type`
 * (see juno-app/docs/BACKEND_API.md §3). Multi-line `data:` continuations
 * are joined per the SSE spec; comment/heartbeat lines (`:` prefix) and
 * `event:`/`id:` fields are tolerated and ignored.
 *
 * Accepts either a fetch Response (tests, future direct use) or an
 * AsyncIterable of text chunks (the Rust-proxied transport).
 */

async function* chunksOf(source: Response | AsyncIterable<string>): AsyncGenerator<string> {
  if (typeof (source as AsyncIterable<string>)[Symbol.asyncIterator] === "function") {
    yield* source as AsyncIterable<string>;
    return;
  }
  const body = (source as Response).body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readSseJson<T>(source: Response | AsyncIterable<string>): AsyncGenerator<T> {
  let buffer = "";
  for await (const chunk of chunksOf(source)) {
    buffer += chunk;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as T;
      } catch {
        // Malformed frame: skip rather than kill the stream.
      }
    }
  }
}
