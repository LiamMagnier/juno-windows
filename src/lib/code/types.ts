/**
 * Code-mode agent types — a port of juno-app/core/src/types.ts with the
 * Windows permission-mode names (readOnly ≙ plan, workspaceWrite ≙ auto-edit).
 */

export type PermissionMode = "readOnly" | "ask" | "workspaceWrite" | "full";

export type RiskLevel = "safe" | "edit" | "command" | "sensitive";

export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type UserContent =
  | { type: "text"; text: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown };

export type AgentChatMessage =
  | { role: "user"; content: UserContent[] }
  | { role: "assistant"; content: AssistantContent[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ApprovalRequest {
  callId: string;
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  /** Human-readable line explaining what is being approved. */
  summary: string;
}

export type AgentEvent =
  | {
      type: "session_started";
      sessionId: string;
      workspaceId: string;
      model: string;
      mode: PermissionMode;
    }
  | { type: "turn_started"; turnIndex: number }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; callId: string; name: string; input: unknown; risk: RiskLevel }
  | {
      type: "tool_finished";
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: "tool_output_delta"; callId: string; text: string }
  | { type: "tool_denied"; callId: string; name: string; reason: string }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; callId: string; decision: ApprovalDecision }
  | { type: "files_changed"; turnIndex: number; paths: string[] }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "turn_finished"; turnIndex: number; stopReason: string; usage: Usage }
  | { type: "error"; message: string };

export interface ToolContext {
  workspaceId: string;
  sessionId: string;
  turnIndex: number;
  /** Live output during long tool runs (terminal streaming). */
  onOutput?(callId: string, text: string): void;
  callId: string;
  signal: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolDefinition {
  spec: ToolSpec;
  /** Coarse action class used by the permission engine. */
  kind: "read" | "edit" | "command";
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Workspace-relative paths this call mutates — snapshotted before execution. */
  mutatedPaths?(input: Record<string, unknown>): string[];
  /** One-line human-readable summary shown in approval prompts. */
  summarize(input: Record<string, unknown>): string;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "other"; usage: Usage };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: AgentChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal: AbortSignal;
}

export interface AgentProvider {
  /** Backend provider id — the path segment under /api/agent. */
  id: string;
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent>;
}
