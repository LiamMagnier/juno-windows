import { describe, expect, it } from "vitest";
import type { ClientMessage, ModelEntry } from "@/lib/data/entities";
import {
  artifactExtension,
  artifactSrcDoc,
  buildPrivateHistory,
  defaultEffort,
  domainOf,
  effortOptions,
  formatBytes,
  gateModel,
  greetingForHour,
  groupModels,
  planRank,
  resolveModelId,
} from "../helpers";

function makeModel(overrides: Partial<ModelEntry> & { id: string }): ModelEntry {
  return {
    provider: { id: "anthropic", displayName: "Anthropic" },
    displayName: overrides.id,
    description: null,
    lifecycle: "active",
    availability: "available",
    minimumPlan: "pro",
    modalities: { input: ["text"], output: ["text"] },
    contextWindowTokens: 200000,
    pricing: {
      class: "standard",
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: "USD",
      source: "list",
    },
    supportedReasoningEfforts: [],
    reasoning: { supported: false, canDisable: false, onOffOnly: false, supportsProMode: false },
    capabilities: { tools: true, webSearch: false, attachments: true, streaming: true },
    deprecationNote: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ClientMessage> & { id: string }): ClientMessage {
  return {
    role: "USER",
    content: "hello",
    feedback: null,
    createdAt: "2026-07-17T10:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

describe("planRank", () => {
  it("orders plans free < pro < max < max20 < owner", () => {
    expect(planRank("free")).toBeLessThan(planRank("pro"));
    expect(planRank("pro")).toBeLessThan(planRank("max"));
    expect(planRank("max")).toBeLessThan(planRank("max20"));
    expect(planRank("max20")).toBeLessThan(planRank("owner"));
  });

  it("is case-insensitive and defaults unknown/absent to free", () => {
    expect(planRank("MAX20")).toBe(planRank("max20"));
    expect(planRank("PRO")).toBe(1);
    expect(planRank(null)).toBe(0);
    expect(planRank("mystery")).toBe(0);
  });
});

describe("gateModel", () => {
  it("blocks coming_soon models regardless of plan", () => {
    const model = makeModel({ id: "x", availability: "coming_soon", minimumPlan: "free" });
    expect(gateModel(model, "owner")).toEqual({ selectable: false, reason: "Coming soon" });
  });

  it("blocks models above the user's plan with a reason", () => {
    const model = makeModel({ id: "x", minimumPlan: "max" });
    const gate = gateModel(model, "PRO");
    expect(gate.selectable).toBe(false);
    expect(gate.reason).toBe("Requires Max");
  });

  it("allows models at or below the user's plan", () => {
    const model = makeModel({ id: "x", minimumPlan: "pro" });
    expect(gateModel(model, "pro").selectable).toBe(true);
    expect(gateModel(model, "MAX20").selectable).toBe(true);
  });
});

describe("groupModels", () => {
  const models = [
    makeModel({ id: "a:1", provider: { id: "a", displayName: "Alpha" } }),
    makeModel({ id: "b:1", provider: { id: "b", displayName: "Beta" } }),
    makeModel({ id: "a:2", provider: { id: "a", displayName: "Alpha" } }),
  ];

  it("groups by provider preserving manifest order", () => {
    const grouped = groupModels(models, []);
    expect(grouped.groups.map((g) => g.provider)).toEqual(["Alpha", "Beta"]);
    expect(grouped.groups[0]!.models.map((m) => m.id)).toEqual(["a:1", "a:2"]);
  });

  it("pins favorites in manifest order and keeps them in their group", () => {
    const grouped = groupModels(models, ["a:2", "missing"]);
    expect(grouped.favorites.map((m) => m.id)).toEqual(["a:2"]);
    expect(grouped.groups[0]!.models.map((m) => m.id)).toEqual(["a:1", "a:2"]);
  });
});

describe("resolveModelId", () => {
  const models = [
    makeModel({ id: "soon", availability: "coming_soon" }),
    makeModel({ id: "premium", minimumPlan: "max" }),
    makeModel({ id: "basic", minimumPlan: "pro" }),
  ];

  it("returns the first selectable candidate", () => {
    expect(resolveModelId(models, "pro", [null, "basic", "premium"])).toBe("basic");
  });

  it("skips locked and unknown candidates", () => {
    expect(resolveModelId(models, "pro", ["soon", "premium", "unknown", "basic"])).toBe("basic");
  });

  it("falls back to the first selectable manifest model", () => {
    expect(resolveModelId(models, "pro", [])).toBe("basic");
    expect(resolveModelId(models, "max", [])).toBe("premium");
  });

  it("returns null when nothing is selectable", () => {
    expect(resolveModelId([makeModel({ id: "premium", minimumPlan: "max" })], "pro", [])).toBe(
      null,
    );
  });
});

describe("effortOptions / defaultEffort", () => {
  it("returns nothing for non-reasoning models", () => {
    const model = makeModel({ id: "x" });
    expect(effortOptions(model)).toEqual([]);
    expect(defaultEffort(model)).toBe(null);
  });

  it("prepends Instant for disableable models and defaults to it", () => {
    const model = makeModel({
      id: "x",
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoning: { supported: true, canDisable: true, onOffOnly: false, supportsProMode: false },
    });
    const options = effortOptions(model);
    expect(options[0]).toEqual({ value: null, label: "Instant" });
    expect(options.map((o) => o.value)).toEqual([null, "low", "medium", "high"]);
    expect(defaultEffort(model)).toBe(null);
  });

  it("collapses on/off models to a single Thinking option", () => {
    const model = makeModel({
      id: "x",
      supportedReasoningEfforts: ["high"],
      reasoning: { supported: true, canDisable: false, onOffOnly: true, supportsProMode: false },
    });
    expect(effortOptions(model)).toEqual([{ value: "high", label: "Thinking" }]);
  });

  it("defaults always-on models to medium when available, else the second tier", () => {
    const withMedium = makeModel({
      id: "x",
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoning: { supported: true, canDisable: false, onOffOnly: false, supportsProMode: false },
    });
    expect(defaultEffort(withMedium)).toBe("medium");
    const withoutMedium = makeModel({
      id: "y",
      supportedReasoningEfforts: ["low", "high", "max"],
      reasoning: { supported: true, canDisable: false, onOffOnly: false, supportsProMode: false },
    });
    expect(defaultEffort(withoutMedium)).toBe("high");
  });

  it("ignores unknown effort strings from the manifest", () => {
    const model = makeModel({
      id: "x",
      supportedReasoningEfforts: ["low", "turbo", "high"],
      reasoning: { supported: true, canDisable: false, onOffOnly: false, supportsProMode: false },
    });
    expect(effortOptions(model).map((o) => o.value)).toEqual(["low", "high"]);
  });
});

describe("buildPrivateHistory", () => {
  it("appends the new user message and keeps role/content only", () => {
    const history = buildPrivateHistory(
      [
        makeMessage({ id: "1", role: "USER", content: "hi" }),
        makeMessage({ id: "2", role: "ASSISTANT", content: "hello" }),
      ],
      "next question",
    );
    expect(history).toEqual([
      { role: "USER", content: "hi" },
      { role: "ASSISTANT", content: "hello" },
      { role: "USER", content: "next question" },
    ]);
  });

  it("filters error rows, system rows, and empty content", () => {
    const history = buildPrivateHistory(
      [
        makeMessage({ id: "1", role: "SYSTEM", content: "system" }),
        makeMessage({ id: "2", role: "ASSISTANT", content: "bad", errorMessage: "failed" }),
        makeMessage({ id: "3", role: "ASSISTANT", content: "   " }),
        makeMessage({ id: "4", role: "USER", content: "kept" }),
      ],
      "new",
    );
    expect(history).toEqual([
      { role: "USER", content: "kept" },
      { role: "USER", content: "new" },
    ]);
  });

  it("caps at the server limit of 24, keeping the most recent turns", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      makeMessage({
        id: String(i),
        role: i % 2 === 0 ? "USER" : "ASSISTANT",
        content: `m${i}`,
      }),
    );
    const history = buildPrivateHistory(messages, "latest");
    expect(history).toHaveLength(24);
    expect(history[history.length - 1]).toEqual({ role: "USER", content: "latest" });
    expect(history[0]).toEqual({ role: "ASSISTANT", content: "m17" });
  });
});

describe("formatting helpers", () => {
  it("greetingForHour buckets the day", () => {
    expect(greetingForHour(2)).toBe("Up late");
    expect(greetingForHour(9)).toBe("Good morning");
    expect(greetingForHour(14)).toBe("Good afternoon");
    expect(greetingForHour(21)).toBe("Good evening");
  });

  it("domainOf strips www and survives junk", () => {
    expect(domainOf("https://www.example.com/a/b?c=1")).toBe("example.com");
    expect(domainOf("not a url")).toBe("not a url");
  });

  it("formatBytes picks sensible units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("artifact helpers", () => {
  it("maps types to extensions, honoring code language", () => {
    expect(artifactExtension("HTML")).toBe("html");
    expect(artifactExtension("MARKDOWN")).toBe("md");
    expect(artifactExtension("MERMAID")).toBe("mmd");
    expect(artifactExtension("REACT")).toBe("jsx");
    expect(artifactExtension("CODE", "python")).toBe("py");
    expect(artifactExtension("CODE", "klingon")).toBe("txt");
  });

  it("builds sandbox documents only for HTML and SVG", () => {
    expect(artifactSrcDoc("CODE", "x")).toBe(null);
    expect(artifactSrcDoc("MARKDOWN", "# x")).toBe(null);
    expect(artifactSrcDoc("SVG", "<svg></svg>")).toContain("<svg></svg>");
    expect(artifactSrcDoc("HTML", "<p>hi</p>")).toContain("<body><p>hi</p></body>");
  });

  it("passes full HTML documents through untouched", () => {
    const doc = "<html><body>full</body></html>";
    expect(artifactSrcDoc("HTML", doc)).toBe(doc);
  });
});
