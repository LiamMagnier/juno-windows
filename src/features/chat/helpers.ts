/**
 * Pure helpers for the chat surface: plan gating, model grouping and
 * resolution, reasoning-effort options, private history shaping, and small
 * formatting utilities. Kept side-effect free so they are unit-testable.
 */
import type { ClientMessage, ModelEntry, ReasoningEffort } from "@/lib/data/entities";

// ---- Plan gating (map [9]: free < pro < max < max20 < owner) ----

export const PLAN_ORDER = ["free", "pro", "max", "max20", "owner"] as const;

export function planRank(plan: string | null | undefined): number {
  if (!plan) return 0;
  const index = PLAN_ORDER.indexOf(plan.toLowerCase() as (typeof PLAN_ORDER)[number]);
  return index === -1 ? 0 : index;
}

export function planLabel(plan: string): string {
  switch (plan.toLowerCase()) {
    case "pro":
      return "Pro";
    case "max":
      return "Max";
    case "max20":
      return "Max x20";
    case "owner":
      return "Owner";
    default:
      return "Free";
  }
}

export interface ModelGate {
  selectable: boolean;
  reason: string | null;
}

/** Whether a manifest model can be selected on the given plan. */
export function gateModel(model: ModelEntry, plan: string | null | undefined): ModelGate {
  if (model.availability === "coming_soon") {
    return { selectable: false, reason: "Coming soon" };
  }
  if (planRank(model.minimumPlan) > planRank(plan)) {
    return { selectable: false, reason: `Requires ${planLabel(model.minimumPlan)}` };
  }
  return { selectable: true, reason: null };
}

// ---- Model grouping ----

export interface ModelGroup {
  provider: string;
  models: ModelEntry[];
}

export interface GroupedModels {
  favorites: ModelEntry[];
  groups: ModelGroup[];
}

/** Groups manifest models by provider (manifest order preserved); favorites pinned. */
export function groupModels(models: ModelEntry[], favoriteIds: string[]): GroupedModels {
  const favoriteSet = new Set(favoriteIds);
  const favorites = models.filter((m) => favoriteSet.has(m.id));
  const byProvider = new Map<string, ModelEntry[]>();
  for (const model of models) {
    const key = model.provider.displayName;
    const bucket = byProvider.get(key);
    if (bucket) bucket.push(model);
    else byProvider.set(key, [model]);
  }
  return {
    favorites,
    groups: [...byProvider.entries()].map(([provider, group]) => ({ provider, models: group })),
  };
}

/**
 * Resolves the effective model id: first selectable candidate in order,
 * else the first selectable manifest model, else null.
 */
export function resolveModelId(
  models: ModelEntry[],
  plan: string | null | undefined,
  candidates: Array<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const model = models.find((m) => m.id === candidate);
    if (model && gateModel(model, plan).selectable) return model.id;
  }
  return models.find((m) => gateModel(m, plan).selectable)?.id ?? null;
}

// ---- Reasoning effort ----

export interface EffortOption {
  /** null = no reasoningEffort sent (instant / provider default). */
  value: ReasoningEffort | null;
  label: string;
}

export function effortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
  }
}

/** Menu options for a model's reasoning control (parity: ModelSelectorThinking). */
export function effortOptions(model: ModelEntry): EffortOption[] {
  if (!model.reasoning.supported) return [];
  const tiers = model.supportedReasoningEfforts.filter(isReasoningEffort);
  if (model.reasoning.onOffOnly) {
    const last = tiers[tiers.length - 1];
    const options: EffortOption[] = [];
    if (model.reasoning.canDisable) options.push({ value: null, label: "Instant" });
    if (last) options.push({ value: last, label: "Thinking" });
    return options;
  }
  const options: EffortOption[] = model.reasoning.canDisable
    ? [{ value: null, label: "Instant" }]
    : [];
  return [...options, ...tiers.map((tier) => ({ value: tier, label: effortLabel(tier) }))];
}

/** Default effort when the user hasn't picked one (nil if disableable, else medium, else 2nd tier). */
export function defaultEffort(model: ModelEntry): ReasoningEffort | null {
  if (!model.reasoning.supported) return null;
  if (model.reasoning.canDisable) return null;
  const tiers = model.supportedReasoningEfforts.filter(isReasoningEffort);
  if (tiers.includes("medium")) return "medium";
  return tiers[1] ?? tiers[0] ?? null;
}

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (EFFORTS as string[]).includes(value);
}

// ---- Private mode ----

export const PRIVATE_HISTORY_LIMIT = 24;

/**
 * Local-only history for a private send: prior non-error USER/ASSISTANT rows
 * plus the new user message, capped to the last 24 (server zod limit).
 */
export function buildPrivateHistory(
  messages: ClientMessage[],
  newMessage: string,
): Array<{ role: "USER" | "ASSISTANT"; content: string }> {
  const rows = messages
    .filter(
      (m) =>
        (m.role === "USER" || m.role === "ASSISTANT") &&
        !m.errorMessage &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: m.content }));
  const all = newMessage.trim() ? [...rows, { role: "USER" as const, content: newMessage }] : rows;
  return all.slice(-PRIVATE_HISTORY_LIMIT);
}

// ---- Formatting ----

export function greetingForHour(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Artifacts ----

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  tsx: "tsx",
  javascript: "js",
  jsx: "jsx",
  python: "py",
  rust: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  ruby: "rb",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  json: "json",
  yaml: "yml",
  sql: "sql",
  bash: "sh",
  shell: "sh",
};

export function artifactExtension(type: string, language?: string | null): string {
  switch (type.toUpperCase()) {
    case "HTML":
      return "html";
    case "SVG":
      return "svg";
    case "MARKDOWN":
      return "md";
    case "MERMAID":
      return "mmd";
    case "REACT":
      return "jsx";
    default:
      return (language && LANGUAGE_EXTENSIONS[language.toLowerCase()]) ?? "txt";
  }
}

/** Sandboxed iframe document for previewable artifact types; null = code view only. */
export function artifactSrcDoc(type: string, content: string): string | null {
  const t = type.toUpperCase();
  if (t === "SVG") {
    return (
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
      "html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}" +
      "svg{max-width:100%;max-height:100%}" +
      "</style></head><body>" +
      content +
      "</body></html>"
    );
  }
  if (t === "HTML") {
    if (/<html[\s>]/i.test(content)) return content;
    return (
      "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" +
      content +
      "</body></html>"
    );
  }
  return null;
}
