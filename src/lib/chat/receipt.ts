import type { ChatFinishReason } from "@/lib/data/entities";

export type DurableReceiptState = "claimed" | "accepted" | "running" | "completed" | "failed";

export interface DurableReceiptStatus {
  conversationId: string;
  userMessageId: string;
  generationId: string;
  receiptState: DurableReceiptState;
  finishReason: ChatFinishReason | null;
  failureCode: string | null;
}

const RECEIPT_KEY = /^[A-Za-z0-9._:-]{8,120}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_STATES = new Set<DurableReceiptState>([
  "claimed",
  "accepted",
  "running",
  "completed",
  "failed",
]);
const FINISH_REASONS = new Set<ChatFinishReason>([
  "stop",
  "length",
  "network_error",
  "model_context_window_exceeded",
  "sensitive",
  "tool_calls",
  "user_stopped",
  "error",
  "unknown",
]);

export function durableReceiptPath(
  selector: { clientRequestId: string; generationId?: never } | { clientRequestId?: never; generationId: string },
): string {
  const entries = Object.entries(selector).filter(([, value]) => value !== undefined);
  if (entries.length !== 1) throw new Error("A durable receipt lookup requires exactly one key.");
  const [key, value] = entries[0]!;
  if ((key !== "clientRequestId" && key !== "generationId") || !RECEIPT_KEY.test(value)) {
    throw new Error("Invalid durable receipt lookup key.");
  }
  return `/chat/receipt?${key}=${encodeURIComponent(value)}`;
}

export function parseDurableReceipt(value: unknown): DurableReceiptStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.conversationId !== "string" ||
    !ENTITY_ID.test(receipt.conversationId) ||
    typeof receipt.userMessageId !== "string" ||
    !ENTITY_ID.test(receipt.userMessageId) ||
    typeof receipt.generationId !== "string" ||
    !RECEIPT_KEY.test(receipt.generationId) ||
    typeof receipt.receiptState !== "string" ||
    !RECEIPT_STATES.has(receipt.receiptState as DurableReceiptState) ||
    !(
      receipt.finishReason === null ||
      (typeof receipt.finishReason === "string" &&
        FINISH_REASONS.has(receipt.finishReason as ChatFinishReason))
    ) ||
    !(receipt.failureCode === null || typeof receipt.failureCode === "string")
  ) {
    return null;
  }
  return receipt as unknown as DurableReceiptStatus;
}

export function durableReceiptFailureMessage(receipt: DurableReceiptStatus): string {
  if (receipt.failureCode === "GENERATION_LEASE_EXPIRED") {
    return "The response did not finish after the connection dropped. Retry this turn.";
  }
  return receipt.failureCode
    ? `The accepted response failed (${receipt.failureCode}). Retry this turn.`
    : "The accepted response failed. Retry this turn.";
}
