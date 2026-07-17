import { api } from "@/lib/backend/http";

export type ClarificationQuestionType = "single-choice" | "multi-choice" | "text" | "text-long";
export type ClarificationAnswerSource = "option" | "else" | "skip";
export type ClarificationAnswerValue = string | string[] | boolean;

export interface ClarificationQuestion {
  id: string;
  question: string;
  type: ClarificationQuestionType;
  options: string[];
  allowElse: boolean;
  elseLabel: string;
  elsePlaceholder: string;
  required: boolean;
}

export interface PreflightClarificationResult {
  needsClarification: boolean;
  reason: string;
  title: string;
  description: string;
  questions: ClarificationQuestion[];
}

export interface PreflightClarificationAnswer {
  questionId: string;
  question?: string;
  source: ClarificationAnswerSource;
  value?: ClarificationAnswerValue;
}

export interface PreflightClarificationContext {
  originalUserMessage: string;
  answers: PreflightClarificationAnswer[];
  skipped?: boolean;
}

function isQuestion(value: unknown): value is ClarificationQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.question === "string" &&
    ["single-choice", "multi-choice", "text", "text-long"].includes(String(row.type)) &&
    Array.isArray(row.options) &&
    row.options.every((option) => typeof option === "string") &&
    typeof row.allowElse === "boolean" &&
    typeof row.elseLabel === "string" &&
    typeof row.elsePlaceholder === "string" &&
    typeof row.required === "boolean"
  );
}

export function isPreflightClarificationResult(
  value: unknown,
): value is PreflightClarificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.needsClarification === "boolean" &&
    typeof result.reason === "string" &&
    typeof result.title === "string" &&
    typeof result.description === "string" &&
    Array.isArray(result.questions) &&
    result.questions.every(isQuestion) &&
    (!result.needsClarification || result.questions.length > 0)
  );
}

export async function checkPreflightClarification(input: {
  message: string;
  conversationId?: string | null;
  hasAttachments?: boolean;
  privateMode?: boolean;
}): Promise<PreflightClarificationResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const result = await api<unknown>("/chat/clarify", {
      method: "POST",
      body: input,
      signal: controller.signal,
      timeoutMs: 6_000,
    });
    return isPreflightClarificationResult(result) ? result : null;
  } catch {
    // Clarification is deliberately fail-open. Network or triage failure must
    // never prevent the user's actual message from being sent.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

