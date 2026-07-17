/**
 * Minimal SSE reader for the backend's framing: every event is a single
 * `data: <json>\n\n` block with the discriminator inside the JSON `type`
 * (see juno-app/docs/BACKEND_API.md §3). Multi-line `data:` continuations
 * are joined per the SSE spec; comment/heartbeat lines (`:` prefix) and
 * `event:`/`id:` fields are tolerated and ignored.
 */

export async function* readSseJson<T>(res: Response): AsyncGenerator<T> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

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
  } finally {
    reader.releaseLock();
  }
}
