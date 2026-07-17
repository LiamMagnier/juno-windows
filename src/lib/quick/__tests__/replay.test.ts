import { describe, expect, it } from "vitest";
import { replayEnvelopeMatches, type QuickReplayEnvelope } from "../replay";

const base: QuickReplayEnvelope = {
  text: "Summarize the release",
  modelId: "gpt-5",
  projectId: "project-1",
  attachmentIds: ["attachment-1"],
  reasoningEffort: "high",
  webSearch: true,
  connectorIds: ["github"],
  preflightClarification: {
    originalUserMessage: "Summarize the release",
    answers: [{ questionId: "scope", question: "Which release?", source: "option", value: "Latest" }],
    skipped: false,
  },
};

describe("protected Quick replay envelope", () => {
  it("matches only an identical material request", () => {
    expect(replayEnvelopeMatches(base, structuredClone(base))).toBe(true);
    expect(replayEnvelopeMatches(base, { ...base, webSearch: false })).toBe(false);
    expect(replayEnvelopeMatches(base, { ...base, reasoningEffort: "low" })).toBe(false);
    expect(replayEnvelopeMatches(base, { ...base, connectorIds: [] })).toBe(false);
    expect(replayEnvelopeMatches(base, { ...base, attachmentIds: ["attachment-2"] })).toBe(false);
    expect(replayEnvelopeMatches(base, { ...base, preflightClarification: null })).toBe(false);
  });
});
