import { describe, expect, it } from "vitest";
import { isPreflightClarificationResult } from "../clarification";

describe("preflight clarification contract", () => {
  it("accepts the canonical question shape", () => {
    expect(
      isPreflightClarificationResult({
        needsClarification: true,
        reason: "ambiguous",
        title: "One detail",
        description: "",
        questions: [
          {
            id: "audience",
            question: "Who is this for?",
            type: "single-choice",
            options: ["Customers", "Team"],
            allowElse: true,
            elseLabel: "Something else",
            elsePlaceholder: "Audience",
            required: true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a clarification without a usable question", () => {
    expect(
      isPreflightClarificationResult({
        needsClarification: true,
        reason: "ambiguous",
        title: "One detail",
        description: "",
        questions: [],
      }),
    ).toBe(false);
  });
});
