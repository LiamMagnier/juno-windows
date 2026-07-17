/**
 * Client entity shapes, copied literally from the backend serializers
 * (juno/src/lib/serializers.ts, src/types/chat.ts, model-catalog-api.ts).
 */

export interface ClientConversation {
  id: string;
  title: string;
  titleSource: "default" | "ai" | "manual" | "user";
  model: string | null;
  kind: "chat" | "code";
  codeWorkspaceName: string | null;
  codeWorkspacePath: string | null;
  pinned: boolean;
  folderId: string | null;
  projectId: string | null;
  activeConnectors: string[];
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface ClientAttachment {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  width?: number;
  height?: number;
}

export interface ClientSource {
  title: string;
  url: string;
  snippet: string;
  cited?: boolean;
}

export type ActivityKind =
  | "context"
  | "model"
  | "reasoning"
  | "search"
  | "visit"
  | "write"
  | "usage"
  | "done"
  | "warning"
  | "tool";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  url?: string;
  createdAt: string;
}

export type ChatFinishReason =
  | "stop"
  | "length"
  | "network_error"
  | "model_context_window_exceeded"
  | "sensitive"
  | "tool_calls"
  | "user_stopped"
  | "error"
  | "unknown";

export interface MessageVersionMeta {
  id: string;
  model: string | null;
  createdAt: string;
}

export interface ClientMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  reasoning?: string | null;
  reasoningParts?: string[] | null;
  model?: string | null;
  feedback: "UP" | "DOWN" | null;
  createdAt: string;
  conversationId?: string;
  versions?: MessageVersionMeta[];
  attachments: ClientAttachment[];
  sources?: ClientSource[];
  activity?: ActivityEvent[];
  finishReason?: ChatFinishReason;
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

export interface ClientArtifactVersion {
  version: number;
  content: string;
  createdAt: string;
}

export interface ClientArtifact {
  id: string;
  identifier: string;
  type: string;
  title: string;
  language?: string | null;
  currentVersion: number;
  content: string;
  versions: ClientArtifactVersion[];
  messageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Plan = "FREE" | "PRO" | "MAX" | "MAX20" | "OWNER";

export interface ClientQuota {
  plan: Plan;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface ClientFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  instructions: string;
  updatedAt: string;
  conversationCount: number;
  fileCount: number;
  coverUrl: string | null;
}

export interface ProjectDetail {
  project: { id: string; name: string; instructions: string; updatedAt: string };
  conversations: Array<{
    id: string;
    title: string;
    pinned: boolean;
    kind?: "chat" | "code";
    lastMessageAt: string;
  }>;
  files: ClientAttachment[];
}

export interface MemoryEntry {
  id: string;
  content: string;
  source: string;
  kind: "FACT" | "SUPPRESSION";
  sourceRef?: string | null;
  createdAt: string;
}

export interface MemorySummary {
  content: string;
  updatedAt: string;
  entryCount: number;
}

export interface SavedPrompt {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Raw Prisma Settings row as bootstrap returns it. */
export interface AccountSettings {
  id: string;
  theme: "LIGHT" | "DARK" | "SYSTEM";
  accent: string;
  defaultModel: string | null;
  customInstructions: string | null;
  responseLanguage: string | null;
  uiLocale: string | null;
  personality: string | null;
  memoryEnabled: boolean;
  voiceId: string | null;
  favoriteModels: string[];
  emailBudgetAlerts?: boolean;
  emailWeeklyDigest?: boolean;
}

export interface Subscription {
  plan: "free" | "pro" | "max" | "max20" | "owner";
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** v1 model manifest entry (juno/src/lib/model-catalog-api.ts). */
export interface ModelEntry {
  id: string;
  provider: { id: string; displayName: string };
  displayName: string;
  description: string | null;
  lifecycle: "deprecated" | "legacy" | "active";
  availability: "coming_soon" | "available";
  minimumPlan: "free" | "pro" | "max" | "max20" | "owner";
  modalities: { input: string[]; output: string[] };
  contextWindowTokens: number;
  pricing: {
    class: "premium" | "standard" | "economy";
    inputPerMillion: number;
    outputPerMillion: number;
    currency: string;
    source: string;
  };
  supportedReasoningEfforts: string[];
  reasoning: {
    supported: boolean;
    canDisable: boolean;
    onOffOnly: boolean;
    supportsProMode: boolean;
  };
  capabilities: { tools: boolean; webSearch: boolean; attachments: boolean; streaming: boolean };
  deprecationNote: string | null;
}

export interface ModelManifest {
  manifestVersion: string;
  contractDigest: string;
  generatedAt: string;
  models: ModelEntry[];
}

export interface BootstrapResponse {
  profile: { id: string; name: string | null; email: string; image: string | null };
  subscription: Subscription;
  usage: {
    period: string;
    messageCount: number;
    promptTokens: string;
    completionTokens: string;
  };
  settings: AccountSettings | null;
  featureFlags: Record<string, unknown>;
  currentChangeCursor: string;
  compactionFloorCursor: string;
  modelManifestVersion: string;
  contractVersion: string;
  minimumClientVersions: Record<string, string>;
  announcements: unknown[];
}

export interface ChangeEnvelope {
  cursor: string;
  entityType: string;
  entityId: string;
  parentEntityId: string | null;
  revision: number;
  operation: "upsert" | "delete";
  changedAt: string;
}

export interface ChangesResponse {
  after: string;
  changes: ChangeEnvelope[];
  nextCursor: string;
  compactionFloorCursor: string;
  hasMore: boolean;
}

/** SSE frames from POST /api/chat (juno/src/types/chat.ts StreamChunk). */
export type StreamChunk =
  | {
      type: "meta";
      conversationId: string;
      userMessageId: string | null;
      title: string;
      titleSource?: "default" | "ai" | "manual";
      generationId?: string;
    }
  | { type: "title"; conversationId: string; title: string; titleSource?: string }
  | { type: "activity"; event: ActivityEvent }
  | { type: "sources"; sources: ClientSource[] }
  | { type: "reasoning"; text: string; part?: number }
  | { type: "delta"; text: string }
  | {
      type: "progress";
      stage: "queued" | "generating" | "polling" | "downloading" | "uploading";
      pct?: number;
      note?: string;
    }
  | {
      type: "done";
      message: ClientMessage;
      artifacts: ClientArtifact[];
      memoryUpdated: boolean;
      quota: ClientQuota;
      finishReason?: ChatFinishReason;
      title?: string;
      projectId?: string | null;
      projectName?: string | null;
    }
  | {
      type: "error";
      message: string;
      quota?: ClientQuota;
      finishReason?: ChatFinishReason;
      preservePartial?: boolean;
      generationId?: string;
      receiptState?: "failed";
      failureCode?: string;
    }
  | { type: "ping" };

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
