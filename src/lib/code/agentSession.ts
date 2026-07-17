/**
 * The Code agent loop — a port of juno-app/core/src/agent.ts onto the
 * Tauri host services. Streams model turns through the backend provider
 * proxy, executes tools locally with permission gating + checkpoints, and
 * supports a hard Stop that cancels the stream, running commands, and any
 * pending approval in one call.
 */
import { checkpointHost, fsHost, killSessionCommands } from "./host";
import { classifyRisk, PermissionEngine } from "./permissions";
import { createAgentProvider } from "./provider";
import { recordTurn, refundTurn, reserveTurn } from "./usage";
import { defaultTools } from "./tools";
import type {
  AgentChatMessage,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  AssistantContent,
  PermissionMode,
  ToolDefinition,
  Usage,
} from "./types";

const MAX_STEPS_PER_TURN = 60;
const MEMORY_FILES = ["JUNO.md", "AGENTS.md", "CLAUDE.md"];

export interface AgentSessionOptions {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  providerId: string;
  model: string;
  mode: PermissionMode;
  onEvent(event: AgentEvent): void;
  /** Surface-supplied approval UI. Resolves when the user decides. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** When false (BYOK/dev), turns are not reported to the plan. */
  reportUsage?: boolean;
}

async function buildSystemPrompt(
  workspaceId: string,
  workspaceName: string,
  mode: PermissionMode,
): Promise<string> {
  let memory = "";
  for (const name of MEMORY_FILES) {
    try {
      const file = await fsHost.read(workspaceId, name);
      if (!file.binary && file.content.trim()) {
        memory = `\n\n# Project memory (${name})\n${file.content.slice(0, 20_000)}`;
        break;
      }
    } catch {
      // absent — try the next
    }
  }
  const platform = navigator.userAgent.includes("Windows") ? "windows" : "desktop";
  return `You are Juno, an agentic coding assistant working directly in the user's repository.

Environment:
- Workspace: ${workspaceName}
- Platform: ${platform} (shell commands run in PowerShell on Windows)
- Date: ${new Date().toISOString().slice(0, 10)}

Operating rules:
- Use the tools to read code before editing it. Prefer edit_file for surgical changes; write_file only for new files or full rewrites.
- Verify your work: after making changes, run the project's own checks (build, tests, linter) with run_command and fix what fails before finishing.
- Keep edits minimal and consistent with the surrounding code style.
- Tool calls are gated by user permission settings; a denied call means the user declined — adjust your approach rather than retrying the same call.
${mode === "readOnly" ? "- You are in READ-ONLY mode: only read tools are available. Produce a concise numbered implementation plan and wait; do not attempt edits." : ""}${memory}`;
}

export class AgentSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  model: string;
  mode: PermissionMode;
  providerId: string;

  private tools: ToolDefinition[];
  private toolsByName: Map<string, ToolDefinition>;
  private permissions = new PermissionEngine();
  private messages: AgentChatMessage[] = [];
  private options: AgentSessionOptions;
  private aborter: AbortController | null = null;
  private pendingApprovalDeny: (() => void) | null = null;
  private turnCount = 0;
  private busy = false;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.workspaceId = options.workspaceId;
    this.workspaceName = options.workspaceName;
    this.model = options.model;
    this.mode = options.mode;
    this.providerId = options.providerId;
    this.tools = defaultTools();
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.emit({
      type: "session_started",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      model: this.model,
      mode: this.mode,
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get turnIndex(): number {
    return this.turnCount;
  }

  get history(): readonly AgentChatMessage[] {
    return this.messages;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.emit({ type: "mode_changed", mode });
  }

  setModel(providerId: string, model: string): void {
    this.providerId = providerId;
    this.model = model;
  }

  /**
   * Emergency stop: cancels the model stream, kills the session's running
   * commands, and denies any pending approval. Always safe to call.
   */
  async stop(): Promise<void> {
    this.aborter?.abort();
    this.pendingApprovalDeny?.();
    await killSessionCommands(this.sessionId).catch(() => {});
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent(event);
  }

  /** Run one full user turn: stream, execute tools with gating, until end_turn. */
  async prompt(text: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const turnIndex = this.turnCount;
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "turn_started", turnIndex });
    this.aborter = new AbortController();

    if (this.options.reportUsage !== false) {
      const reservation = await reserveTurn();
      if (!reservation.allowed) {
        this.emit({
          type: "error",
          message: reservation.message ?? "You've reached your plan's usage limit.",
        });
        this.turnCount = turnIndex + 1;
        this.emit({
          type: "turn_finished",
          turnIndex,
          stopReason: "quota",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        this.busy = false;
        return;
      }
    }

    const toolSpecs =
      this.mode === "readOnly"
        ? this.tools.filter((t) => t.kind === "read").map((t) => t.spec)
        : this.tools.map((t) => t.spec);

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "end_turn";
    const provider = createAgentProvider(this.providerId);
    const system = await buildSystemPrompt(this.workspaceId, this.workspaceName, this.mode);

    try {
      for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
        const assistantContent: AssistantContent[] = [];
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        let textAcc = "";

        for await (const ev of provider.stream({
          model: this.model,
          system,
          messages: this.messages,
          tools: toolSpecs,
          signal: this.aborter.signal,
        })) {
          if (ev.type === "text_delta") {
            textAcc += ev.text;
            this.emit({ type: "assistant_delta", text: ev.text });
          } else if (ev.type === "thinking_delta") {
            this.emit({ type: "thinking_delta", text: ev.text });
          } else if (ev.type === "tool_call") {
            toolCalls.push({
              id: ev.id,
              name: ev.name,
              input: (ev.input ?? {}) as Record<string, unknown>,
            });
          } else if (ev.type === "done") {
            usage = {
              inputTokens: usage.inputTokens + ev.usage.inputTokens,
              outputTokens: usage.outputTokens + ev.usage.outputTokens,
            };
            stopReason = ev.stopReason;
          }
        }

        if (textAcc) {
          assistantContent.push({ type: "text", text: textAcc });
          this.emit({ type: "assistant_message", text: textAcc });
        }
        for (const call of toolCalls) {
          assistantContent.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        }
        if (assistantContent.length > 0) {
          this.messages.push({ role: "assistant", content: assistantContent });
        }

        if (stopReason !== "tool_use" || toolCalls.length === 0) break;
        if (this.aborter.signal.aborted) {
          stopReason = "aborted";
          break;
        }

        const results: AgentChatMessage = { role: "user", content: [] };
        for (const call of toolCalls) {
          const result = await this.executeToolCall(turnIndex, call);
          results.content.push(result);
        }
        this.messages.push(results);
        if (this.aborter.signal.aborted) {
          stopReason = "aborted";
          break;
        }
      }
    } catch (err) {
      if (this.aborter.signal.aborted) {
        stopReason = "aborted";
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", message });
        stopReason = "error";
      }
    }

    try {
      const changed = await checkpointHost.changedPaths(this.sessionId);
      const paths = changed.pathsByTurn[String(turnIndex)] ?? [];
      if (paths.length > 0) {
        this.emit({ type: "files_changed", turnIndex, paths });
      }
    } catch {
      // checkpoint bookkeeping is best-effort
    }

    if (this.options.reportUsage !== false) {
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        await recordTurn(`${this.providerId}:${this.model}`, usage);
      } else {
        await refundTurn();
      }
    }
    this.turnCount = turnIndex + 1;
    this.emit({ type: "turn_finished", turnIndex, stopReason, usage });
    this.busy = false;
  }

  private async executeToolCall(
    turnIndex: number,
    call: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<{ type: "tool_result"; toolCallId: string; content: string; isError?: boolean }> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return { type: "tool_result", toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    const { risk, reason } = classifyRisk(tool, call.input);
    const outcome = this.permissions.decide(this.mode, call.name, risk, call.input);

    if (outcome === "deny") {
      const why =
        this.mode === "readOnly"
          ? "Denied: read-only mode only allows read tools."
          : "Denied by permission rules.";
      this.emit({ type: "tool_denied", callId: call.id, name: call.name, reason: why });
      return { type: "tool_result", toolCallId: call.id, content: why, isError: true };
    }

    if (outcome === "ask") {
      const request: ApprovalRequest = {
        callId: call.id,
        toolName: call.name,
        input: call.input,
        risk,
        summary: `${tool.summarize(call.input)}${risk === "sensitive" ? ` — SENSITIVE (${reason})` : ""}`,
      };
      this.emit({ type: "approval_requested", request });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        // Stop denies the pending approval and unblocks the loop.
        this.pendingApprovalDeny = () => resolve("deny");
        void this.options.requestApproval(request).then(resolve);
      }).finally(() => {
        this.pendingApprovalDeny = null;
      });
      this.emit({ type: "approval_resolved", callId: call.id, decision });
      if (decision === "deny") {
        const msg = "The user declined this action.";
        this.emit({ type: "tool_denied", callId: call.id, name: call.name, reason: msg });
        return { type: "tool_result", toolCallId: call.id, content: msg, isError: true };
      }
      if (decision === "allow_always" && risk !== "sensitive") {
        this.permissions.grantAlways(call.name);
      }
    }

    for (const path of tool.mutatedPaths?.(call.input) ?? []) {
      await checkpointHost.snapshot(this.workspaceId, this.sessionId, turnIndex, path).catch(() => {});
    }

    this.emit({ type: "tool_started", callId: call.id, name: call.name, input: call.input, risk });
    const started = Date.now();
    let output: string;
    let isError = false;
    try {
      const result = await tool.execute(call.input, {
        workspaceId: this.workspaceId,
        sessionId: this.sessionId,
        turnIndex,
        callId: call.id,
        signal: this.aborter?.signal ?? new AbortController().signal,
        onOutput: (callId, text) => this.emit({ type: "tool_output_delta", callId, text }),
      });
      output = result.output;
      isError = result.isError ?? false;
    } catch (err) {
      const raw = err as { message?: string; code?: string };
      output = `Tool failed: ${raw.message ?? String(err)}`;
      isError = true;
    }
    this.emit({
      type: "tool_finished",
      callId: call.id,
      name: call.name,
      output: output.length > 2000 ? output.slice(0, 2000) + "…" : output,
      isError,
      durationMs: Date.now() - started,
    });
    return { type: "tool_result", toolCallId: call.id, content: output, isError };
  }

  /** Undo everything the previous turn changed on disk. Returns restored paths. */
  async undoLastTurn(): Promise<string[]> {
    const changed = await checkpointHost.changedPaths(this.sessionId);
    const turns = changed.turns;
    if (turns.length === 0) return [];
    const result = await checkpointHost.restoreToBefore(
      this.workspaceId,
      this.sessionId,
      turns[turns.length - 1]!,
    );
    return result.restored;
  }

  /** Rewind the workspace to its state before the given turn. */
  async rewindToTurn(turnIndex: number): Promise<string[]> {
    const result = await checkpointHost.restoreToBefore(this.workspaceId, this.sessionId, turnIndex);
    return result.restored;
  }
}
