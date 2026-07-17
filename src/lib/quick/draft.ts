import { invoke } from "@tauri-apps/api/core";
import type { PreflightClarificationContext } from "@/lib/chat/clarification";
import type { ReasoningEffort } from "@/lib/data/entities";

export interface QuickDraft {
  text: string;
  modelId: string | null;
  projectId: string | null;
  clientRequestId?: string | null;
  clientMessageId?: string | null;
  attachmentIds?: string[];
  attachmentNames?: string[];
  reasoningEffort?: ReasoningEffort | null;
  webSearch?: boolean;
  connectorIds?: string[];
  preflightClarification?: PreflightClarificationContext | null;
  updatedAt: number;
}

export function loadQuickDraft(): Promise<QuickDraft | null> {
  return invoke<QuickDraft | null>("quick_draft_load");
}

export function saveQuickDraft(draft: QuickDraft): Promise<void> {
  return invoke("quick_draft_save", { draft });
}

export function clearQuickDraft(): Promise<void> {
  return invoke("quick_draft_clear");
}
