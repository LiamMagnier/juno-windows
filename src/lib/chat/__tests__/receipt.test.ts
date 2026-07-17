import { describe, expect, it } from "vitest";
import {
  durableReceiptFailureMessage,
  durableReceiptPath,
  parseDurableReceipt,
} from "../receipt";

describe("durable first-submission receipts", () => {
  it("builds a lookup with exactly one bounded key", () => {
    expect(durableReceiptPath({ clientRequestId: "request:12345678" })).toBe(
      "/chat/receipt?clientRequestId=request%3A12345678",
    );
    expect(durableReceiptPath({ generationId: "generation-12345678" })).toBe(
      "/chat/receipt?generationId=generation-12345678",
    );
    expect(() => durableReceiptPath({ clientRequestId: "short" })).toThrow();
  });

  it("accepts the canonical account-scoped response and rejects malformed state", () => {
    const receipt = parseDurableReceipt({
      conversationId: "conversation-1",
      userMessageId: "message-1",
      generationId: "generation-1",
      receiptState: "failed",
      finishReason: "error",
      failureCode: "GENERATION_LEASE_EXPIRED",
    });
    expect(receipt?.receiptState).toBe("failed");
    expect(durableReceiptFailureMessage(receipt!)).toContain("Retry this turn");
    expect(parseDurableReceipt({ ...receipt, receiptState: "mystery" })).toBeNull();
    expect(parseDurableReceipt({ ...receipt, conversationId: "../foreign" })).toBeNull();
  });
});
