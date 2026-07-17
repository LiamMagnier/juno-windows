import { describe, expect, it } from "vitest";
import type { ModelEntry, ModelManifest } from "@/lib/data/entities";
import type { CodeTimelineItem } from "@/state/codeStore";
import {
  agentModels,
  changesByTurn,
  defaultAgentModelId,
  diffLineClass,
  findModelEntry,
  splitModelId,
} from "../helpers";

function makeModel(overrides: Partial<ModelEntry> & { id: string }): ModelEntry {
  return {
    provider: { id: overrides.id.split(":")[0] ?? "p", displayName: "Provider" },
    displayName: overrides.id,
    description: null,
    lifecycle: "active",
    availability: "available",
    minimumPlan: "free",
    modalities: { input: ["text"], output: ["text"] },
    contextWindowTokens: 128_000,
    pricing: {
      class: "standard",
      inputPerMillion: 1,
      outputPerMillion: 2,
      currency: "USD",
      source: "test",
    },
    supportedReasoningEfforts: [],
    reasoning: { supported: false, canDisable: false, onOffOnly: false, supportsProMode: false },
    capabilities: { tools: true, webSearch: false, attachments: false, streaming: true },
    deprecationNote: null,
    ...overrides,
  };
}

function makeManifest(models: ModelEntry[]): ModelManifest {
  return { manifestVersion: "1", contractDigest: "d", generatedAt: "now", models };
}

describe("splitModelId", () => {
  it("splits provider:model manifest ids", () => {
    const entry = makeModel({ id: "anthropic:claude-sonnet-4" });
    expect(splitModelId(entry)).toEqual({ providerId: "anthropic", model: "claude-sonnet-4" });
  });

  it("keeps colonless ids whole", () => {
    const entry = makeModel({ id: "sololess" });
    expect(splitModelId(entry).model).toBe("sololess");
  });

  it("only strips the first colon segment", () => {
    const entry = makeModel({ id: "openai:ft:gpt" });
    expect(splitModelId(entry).model).toBe("ft:gpt");
  });
});

describe("agentModels", () => {
  it("filters to available tool-capable models", () => {
    const manifest = makeManifest([
      makeModel({ id: "a:one" }),
      makeModel({
        id: "a:no-tools",
        capabilities: { tools: false, webSearch: false, attachments: false, streaming: true },
      }),
      makeModel({ id: "a:soon", availability: "coming_soon" }),
    ]);
    expect(agentModels(manifest).map((m) => m.id)).toEqual(["a:one"]);
  });

  it("returns empty for a missing manifest", () => {
    expect(agentModels(null)).toEqual([]);
  });
});

describe("defaultAgentModelId", () => {
  const models = [makeModel({ id: "a:one" }), makeModel({ id: "a:two" })];

  it("prefers the settings default when usable", () => {
    expect(defaultAgentModelId(models, "a:two")).toBe("a:two");
  });

  it("falls back to the first model", () => {
    expect(defaultAgentModelId(models, "a:gone")).toBe("a:one");
    expect(defaultAgentModelId([], "a:gone")).toBeNull();
  });
});

describe("findModelEntry", () => {
  it("matches by provider id + model half", () => {
    const models = [makeModel({ id: "anthropic:claude" }), makeModel({ id: "openai:gpt" })];
    expect(findModelEntry(models, "openai", "gpt")?.id).toBe("openai:gpt");
    expect(findModelEntry(models, "openai", "missing")).toBeNull();
  });
});

describe("changesByTurn", () => {
  it("dedupes paths per turn and orders turns ascending", () => {
    const timeline: CodeTimelineItem[] = [
      { kind: "files", id: "1", turnIndex: 2, paths: ["b.ts"] },
      { kind: "user", id: "2", text: "hi" },
      { kind: "files", id: "3", turnIndex: 0, paths: ["a.ts", "a.ts"] },
      { kind: "files", id: "4", turnIndex: 0, paths: ["c.ts"] },
    ];
    expect(changesByTurn(timeline)).toEqual([
      { turnIndex: 0, paths: ["a.ts", "c.ts"] },
      { turnIndex: 2, paths: ["b.ts"] },
    ]);
  });
});

describe("diffLineClass", () => {
  it("classifies unified diff lines", () => {
    expect(diffLineClass("+added")).toBe("code-diff-add");
    expect(diffLineClass("-removed")).toBe("code-diff-del");
    expect(diffLineClass("+++ b/x")).toBe("code-diff-file");
    expect(diffLineClass("--- a/x")).toBe("code-diff-file");
    expect(diffLineClass("@@ -1 +1 @@")).toBe("code-diff-hunk");
    expect(diffLineClass("diff --git a b")).toBe("code-diff-meta");
    expect(diffLineClass(" context")).toBe("code-diff-ctx");
  });
});
