import { describe, expect, it } from "vitest";
import { errorFromBody } from "../http";

describe("idempotency receipt errors", () => {
  it("preserves the canonical receipt fields and retryability", () => {
    const accepted = errorFromBody(409, JSON.stringify({
      code: "REQUEST_ALREADY_SUBMITTED",
      message: "Already accepted",
      conversationId: "conversation-1",
      userMessageId: "message-1",
      generationId: "generation-1",
      receiptState: "running",
      finishReason: null,
      failureCode: null,
      retryable: false,
    }));
    expect(accepted.code).toBe("REQUEST_ALREADY_SUBMITTED");
    expect(accepted.retryable).toBe(false);
    expect(accepted.details).toMatchObject({
      conversationId: "conversation-1",
      generationId: "generation-1",
      receiptState: "running",
    });

    const claimed = errorFromBody(409, JSON.stringify({
      code: "REQUEST_IN_PROGRESS",
      message: "Claim is not accepted yet",
      generationId: "generation-2",
      receiptState: "claimed",
      retryable: true,
    }));
    expect(claimed.code).toBe("REQUEST_IN_PROGRESS");
    expect(claimed.retryable).toBe(true);
  });
});
