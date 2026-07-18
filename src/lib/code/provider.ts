/**
 * Agent model transport: provider-native wire protocols through the
 * backend's transparent proxy (/api/agent/<provider>/...). The server
 * injects its key; the client never holds one. Anthropic speaks
 * v1/messages; every other provider is OpenAI-compatible chat/completions.
 */
import { apiStream } from "../backend/http";
import type { AgentChatMessage, AgentProvider, ProviderRequest, ProviderStreamEvent, ToolSpec } from "./types";

interface SseFrame {
  event: string | null;
  data: string;
}

/** Generic SSE framing (event: + data: lines) over a chunk iterable. */
async function* readSseFrames(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0 || event) yield { event, data: data.join("\n") };
    }
  }
}

export function wireKindFor(providerId: string): "anthropic" | "openai" {
  return providerId === "anthropic" ? "anthropic" : "openai";
}

export function createAgentProvider(providerId: string): AgentProvider {
  return wireKindFor(providerId) === "anthropic"
    ? new AnthropicWire(providerId)
    : new OpenAiWire(providerId);
}

// ---------- Anthropic v1/messages ----------

function toAnthropicMessages(messages: AgentChatMessage[]): unknown[] {
  return messages.map((m) =>
    m.role === "user"
      ? {
          role: "user",
          content: m.content.map((c) =>
            c.type === "text"
              ? { type: "text", text: c.text }
              : {
                  type: "tool_result",
                  tool_use_id: c.toolCallId,
                  content: c.content,
                  is_error: c.isError ?? false,
                },
          ),
        }
      : {
          role: "assistant",
          content: m.content.map((c) =>
            c.type === "text"
              ? { type: "text", text: c.text }
              : { type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} },
          ),
        },
  );
}

class AnthropicWire implements AgentProvider {
  constructor(public id: string) {}

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const body = {
      // No plan cap on replies — default to Claude's native 64k output ceiling.
      model: req.model,
      max_tokens: req.maxTokens ?? 64000,
      stream: true,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t: ToolSpec) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };
    const chunks = await apiStream(`/agent/${this.id}/v1/messages`, body, req.signal);

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "other" = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    // Open tool_use blocks: index -> {id, name, jsonAcc}
    const openTools = new Map<number, { id: string; name: string; json: string }>();

    for await (const frame of readSseFrames(chunks)) {
      if (!frame.data) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(payload.type ?? frame.event ?? "");
      switch (type) {
        case "message_start": {
          const usage = (payload.message as { usage?: { input_tokens?: number } })?.usage;
          inputTokens = usage?.input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const block = payload.content_block as { type?: string; id?: string; name?: string };
          if (block?.type === "tool_use") {
            openTools.set(Number(payload.index ?? 0), {
              id: block.id ?? "",
              name: block.name ?? "",
              json: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = payload.delta as {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
          };
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (delta?.type === "input_json_delta") {
            const tool = openTools.get(Number(payload.index ?? 0));
            if (tool) tool.json += delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          const tool = openTools.get(Number(payload.index ?? 0));
          if (tool) {
            openTools.delete(Number(payload.index ?? 0));
            let input: unknown = {};
            try {
              input = tool.json ? JSON.parse(tool.json) : {};
            } catch {
              input = {};
            }
            yield { type: "tool_call", id: tool.id, name: tool.name, input };
          }
          break;
        }
        case "message_delta": {
          const delta = payload.delta as { stop_reason?: string };
          const usage = payload.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
          if (delta?.stop_reason) {
            stopReason =
              delta.stop_reason === "end_turn"
                ? "end_turn"
                : delta.stop_reason === "tool_use"
                  ? "tool_use"
                  : delta.stop_reason === "max_tokens"
                    ? "max_tokens"
                    : "other";
          }
          break;
        }
        case "error": {
          const error = payload.error as { message?: string } | undefined;
          throw new Error(error?.message ?? "Model stream error");
        }
        default:
          break; // ping, message_stop
      }
    }
    yield { type: "done", stopReason, usage: { inputTokens, outputTokens } };
  }
}

// ---------- OpenAI-compatible chat/completions ----------

function toOpenAiMessages(system: string, messages: AgentChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      const toolResults = m.content.filter((c) => c.type === "tool_result");
      const texts = m.content.filter((c) => c.type === "text");
      for (const r of toolResults) {
        out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }
      if (texts.length > 0) {
        out.push({ role: "user", content: texts.map((t) => t.text).join("\n") });
      }
    } else {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolCalls = m.content
        .filter((c) => c.type === "tool_call")
        .map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        ...(text ? { content: text } : { content: null }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return out;
}

class OpenAiWire implements AgentProvider {
  constructor(public id: string) {}

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const body = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      // No plan cap on replies — default to the native output ceiling.
      max_tokens: req.maxTokens ?? 32000,
      messages: toOpenAiMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };
    const chunks = await apiStream(`/agent/${this.id}/chat/completions`, body, req.signal);

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "other" = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const frame of readSseFrames(chunks)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const usage = payload.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | null
        | undefined;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.completion_tokens ?? outputTokens;
      }
      const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      const delta = choice.delta as
        | {
            content?: string | null;
            reasoning_content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          }
        | undefined;
      if (delta?.reasoning_content) {
        yield { type: "thinking_delta", text: delta.reasoning_content };
      }
      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? { id: "", name: "", args: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        toolCalls.set(call.index, existing);
      }
      const finish = choice.finish_reason as string | null | undefined;
      if (finish) {
        stopReason =
          finish === "stop"
            ? "end_turn"
            : finish === "tool_calls"
              ? "tool_use"
              : finish === "length"
                ? "max_tokens"
                : "other";
      }
    }
    for (const call of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      let input: unknown = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = {};
      }
      yield { type: "tool_call", id: call.id || crypto.randomUUID(), name: call.name, input };
    }
    yield { type: "done", stopReason, usage: { inputTokens, outputTokens } };
  }
}
