import { describe, expect, it } from "vitest";
import { readSseJson } from "./sse";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(res: Response): Promise<T[]> {
  const out: T[] = [];
  for await (const event of readSseJson<T>(res)) out.push(event);
  return out;
}

describe("readSseJson", () => {
  it("parses single-line data frames", async () => {
    const events = await collect(sseResponse(['data: {"type":"delta","text":"hi"}\n\ndata: {"type":"done"}\n\n']));
    expect(events).toEqual([
      { type: "delta", text: "hi" },
      { type: "done" },
    ]);
  });

  it("reassembles frames split across network chunks", async () => {
    const events = await collect(
      sseResponse(['data: {"type":"del', 'ta","text":"a"}', "\n", "\ndata: ", '{"type":"done"}\n\n']),
    );
    expect(events).toEqual([
      { type: "delta", text: "a" },
      { type: "done" },
    ]);
  });

  it("ignores comments, event names and malformed frames", async () => {
    const events = await collect(
      sseResponse([":heartbeat\n\n", "event: message\ndata: {\"type\":\"ok\"}\n\n", "data: not-json\n\n"]),
    );
    expect(events).toEqual([{ type: "ok" }]);
  });

  it("handles multi-line data continuations", async () => {
    const events = await collect(sseResponse(['data: {"type":"a",\ndata: "text":"b"}\n\n']));
    expect(events).toEqual([{ type: "a", text: "b" }]);
  });

  it("preserves multibyte characters across chunk boundaries", async () => {
    const frame = 'data: {"type":"delta","text":"héllo — ✓"}\n\n';
    const bytes = new TextEncoder().encode(frame);
    // Split in the middle of the multibyte em-dash.
    const cut = frame.indexOf("—") + 1;
    const events = await collect(
      sseResponse([]).body
        ? (() => {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, cut));
                controller.enqueue(bytes.slice(cut));
                controller.close();
              },
            });
            return new Response(stream);
          })()
        : new Response(),
    );
    expect(events).toEqual([{ type: "delta", text: "héllo — ✓" }]);
  });
});
