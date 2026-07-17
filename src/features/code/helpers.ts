/**
 * Pure helpers for the code surface: manifest filtering for agent-capable
 * models, "provider:model" id splitting, and light formatting. Side-effect
 * free so they are unit-testable.
 */
import type { ModelEntry, ModelManifest } from "@/lib/data/entities";
import type { CodeTimelineItem } from "@/state/codeStore";

/** Chat models that can drive the agent loop (tool use required). */
export function agentModels(manifest: ModelManifest | null): ModelEntry[] {
  if (!manifest) return [];
  return manifest.models.filter(
    (m) => m.capabilities.tools && m.availability === "available",
  );
}

/**
 * Manifest ids are "provider:modelId"; the agent session wants the two
 * halves separately (providerId = entry.provider.id).
 */
export function splitModelId(entry: ModelEntry): { providerId: string; model: string } {
  const colon = entry.id.indexOf(":");
  return {
    providerId: entry.provider.id,
    model: colon >= 0 ? entry.id.slice(colon + 1) : entry.id,
  };
}

/** Finds the manifest entry for a session's providerId + model pair. */
export function findModelEntry(
  models: ModelEntry[],
  providerId: string,
  model: string,
): ModelEntry | null {
  return (
    models.find((m) => {
      const parts = splitModelId(m);
      return parts.providerId === providerId && parts.model === model;
    }) ?? null
  );
}

/** Default model id for a new session: settings default if usable, else first. */
export function defaultAgentModelId(
  models: ModelEntry[],
  settingsDefault: string | null | undefined,
): string | null {
  if (settingsDefault && models.some((m) => m.id === settingsDefault)) {
    return settingsDefault;
  }
  return models[0]?.id ?? null;
}

/** Groups files timeline items by turn, newest turn last. */
export function changesByTurn(
  timeline: CodeTimelineItem[],
): Array<{ turnIndex: number; paths: string[] }> {
  const byTurn = new Map<number, Set<string>>();
  for (const item of timeline) {
    if (item.kind !== "files") continue;
    const bucket = byTurn.get(item.turnIndex) ?? new Set<string>();
    for (const path of item.paths) bucket.add(path);
    byTurn.set(item.turnIndex, bucket);
  }
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turnIndex, paths]) => ({ turnIndex, paths: [...paths] }));
}

/** One CSS class per unified-diff line kind. */
export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "code-diff-file";
  if (line.startsWith("+")) return "code-diff-add";
  if (line.startsWith("-")) return "code-diff-del";
  if (line.startsWith("@@")) return "code-diff-hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "code-diff-meta";
  return "code-diff-ctx";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
