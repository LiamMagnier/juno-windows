import type { PreflightClarificationContext } from "@/lib/chat/clarification";
import type { ReasoningEffort } from "@/lib/data/entities";

/** Every field that can change the backend hash for a protected first send. */
export interface QuickReplayEnvelope {
  text: string;
  modelId: string | null;
  projectId: string | null;
  attachmentIds: string[];
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean;
  connectorIds: string[];
  preflightClarification: PreflightClarificationContext | null;
}

export function replayEnvelopeMatches(
  expected: QuickReplayEnvelope,
  current: QuickReplayEnvelope,
): boolean {
  return (
    expected.text === current.text &&
    expected.modelId === current.modelId &&
    expected.projectId === current.projectId &&
    expected.reasoningEffort === current.reasoningEffort &&
    expected.webSearch === current.webSearch &&
    expected.attachmentIds.length === current.attachmentIds.length &&
    expected.attachmentIds.every((id, index) => id === current.attachmentIds[index]) &&
    expected.connectorIds.length === current.connectorIds.length &&
    expected.connectorIds.every((id, index) => id === current.connectorIds[index]) &&
    JSON.stringify(expected.preflightClarification) ===
      JSON.stringify(current.preflightClarification)
  );
}
