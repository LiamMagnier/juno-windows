import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Globe2,
  LoaderCircle,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Shield,
  Square,
  X,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { api } from "@/lib/backend/http";
import { hasStoredSession } from "@/lib/backend/tokens";
import type { Profile, SessionResponse } from "@/lib/backend/types";
import {
  checkPreflightClarification,
  type ClarificationAnswerValue,
  type ClarificationQuestion,
  type PreflightClarificationContext,
  type PreflightClarificationResult,
} from "@/lib/chat/clarification";
import { sendMessage, stopGeneration } from "@/lib/chat/chatEngine";
import { hydrateFromDisk } from "@/lib/data/syncEngine";
import { uploadBytes } from "@/lib/data/uploads";
import type {
  ClientAttachment,
  ClientMessage,
  ReasoningEffort,
} from "@/lib/data/entities";
import { dbGet } from "@/lib/data/db";
import { defaultEffort, effortOptions, gateModel, resolveModelId, buildPrivateHistory } from "@/features/chat/helpers";
import { applyThemeToDocument } from "@/state/uiStore";
import { useDataStore } from "@/state/dataStore";
import { emptyThread, useThreadStore } from "@/state/threadStore";
import { useChatPrefs } from "@/features/chat/chatPrefs";
import { clearQuickDraft, loadQuickDraft, saveQuickDraft } from "@/lib/quick/draft";
import { replayEnvelopeMatches, type QuickReplayEnvelope } from "@/lib/quick/replay";
import { escapeAction, shouldDismissOnBlur, type QuickPhase } from "@/lib/quick/machine";
import {
  getQuickSettings,
  hideQuick,
  openInJuno,
  setQuickRuntimeState,
  type QuickSettings,
} from "@/lib/quick/native";
import "./quick.css";

interface PendingClarification {
  original: string;
  result: PreflightClarificationResult;
  question: ClarificationQuestion;
}

interface StagedAttachment {
  localId: string;
  name: string;
  attachment: ClientAttachment | null;
  error: string | null;
}

interface AttachmentReference {
  id: string;
  name: string;
}

interface ConnectorInfo {
  id: string;
  label: string;
  connected: boolean;
}

interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function phaseFromStatus(status: string, local: QuickPhase): QuickPhase {
  if (local === "checking" || local === "clarifying" || local === "error") return local;
  if (status === "stopping") return "stopping";
  if (status === "submitting") return "submitting";
  if (status === "thinking" || status === "writing") return "streaming";
  return "idle";
}

function lastAssistantError(messages: ClientMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "ASSISTANT") return message.errorMessage ?? null;
  }
  return null;
}

function validSourceUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function sourceLabel(title: string | null | undefined, url: string): string {
  if (title?.trim()) return title.trim();
  try {
    return new URL(url).hostname || "Source";
  } catch {
    return "Source";
  }
}

const ACCEPTED_FILE_TYPES = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".txt", ".md", ".csv", ".json",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".xml", ".yaml", ".yml",
].join(",");

function acceptedMimeType(file: File): string | null {
  const supplied = file.type.trim().toLowerCase();
  const allowed = new Set([
    "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain",
    "text/markdown", "text/csv", "application/json", "text/javascript", "application/javascript",
    "application/typescript", "text/typescript", "text/x-python", "application/xml", "text/xml",
    "application/yaml", "text/yaml", "text/x-yaml",
  ]);
  if (supplied === "application/typescript") return "text/typescript";
  if (supplied === "application/yaml") return "text/yaml";
  if (allowed.has(supplied)) return supplied;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const inferred: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
    json: "application/json", js: "text/javascript", jsx: "text/javascript", ts: "text/typescript",
    tsx: "text/typescript", py: "text/x-python", xml: "application/xml", yaml: "text/yaml",
    yml: "text/yaml",
  };
  return inferred[extension] ?? null;
}

export function QuickApp() {
  const [booting, setBooting] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [nativeSettings, setNativeSettings] = useState<QuickSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [privateMode, setPrivateMode] = useState(false);
  const [localPhase, setLocalPhase] = useState<QuickPhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingClarification, setPendingClarification] =
    useState<PendingClarification | null>(null);
  const [clarificationText, setClarificationText] = useState("");
  const [clarificationChoices, setClarificationChoices] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [dictating, setDictating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [recoveredAttachments, setRecoveredAttachments] = useState<AttachmentReference[]>([]);
  const [replayEnvelope, setReplayEnvelope] = useState<QuickReplayEnvelope | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const [retryMode, setRetryMode] = useState<"unsent" | "new-replay" | "regenerate" | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const nativeDialogOpenRef = useRef(false);
  const suspendDraftSaveRef = useRef(false);
  const submittedTextRef = useRef<string | null>(null);
  const submissionIdsRef = useRef<{ request: string; message: string } | null>(null);
  const wasGeneratingRef = useRef(false);
  const completionTimerRef = useRef<number | null>(null);

  const manifest = useDataStore((state) => state.manifest);
  const projects = useDataStore((state) => state.projects);
  const accountSettings = useDataStore((state) => state.settings);
  const subscription = useDataStore((state) => state.subscription);
  const quota = useDataStore((state) => state.quota);
  const webSearch = useChatPrefs((state) => state.webSearch);
  const setWebSearch = useChatPrefs((state) => state.setWebSearch);
  const activeId = useThreadStore((state) => state.activeConversationId);
  const conversationId = !privateMode && activeId && activeId !== "new" ? activeId : null;
  const threadKey = privateMode ? "private" : (conversationId ?? "new");
  const thread = useThreadStore((state) => state.threads[threadKey]) ?? emptyThread;
  const generationStatus = thread.status;
  const phase = phaseFromStatus(generationStatus, localPhase);

  const plan = quota?.plan ?? subscription?.plan ?? "free";
  const models = useMemo(
    () => (manifest?.models ?? []).filter((model) => gateModel(model, plan).selectable),
    [manifest, plan],
  );
  const selectedModel = models.find((model) => model.id === modelId) ?? null;
  const attachmentsSupported = selectedModel?.capabilities.attachments ?? false;
  const requestWebSearch = Boolean(selectedModel?.capabilities.webSearch && webSearch);
  const requestConnectorIds = useMemo(
    () => selectedModel?.capabilities.tools ? selectedConnectorIds.slice(0, 5) : [],
    [selectedConnectorIds, selectedModel?.capabilities.tools],
  );
  const reasoningOptions = selectedModel ? effortOptions(selectedModel) : [];
  const projectRows = useMemo(
    () => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );
  const readyAttachments = useMemo(
    () => attachments
      .map((row) => row.attachment)
      .filter((row): row is ClientAttachment => row !== null),
    [attachments],
  );
  const uploading = attachments.some((row) => row.attachment === null && row.error === null);
  const hasAttachmentError = attachments.some((row) => row.error !== null);
  const isGenerating = !["idle", "checking"].includes(generationStatus);
  const attachmentReferences = useMemo(() => {
    const byId = new Map(recoveredAttachments.map((attachment) => [attachment.id, attachment]));
    for (const attachment of readyAttachments) {
      byId.set(attachment.id, { id: attachment.id, name: attachment.fileName });
    }
    return [...byId.values()].slice(0, 5);
  }, [readyAttachments, recoveredAttachments]);
  const actionableNotice = Boolean(
    notice && notice !== "Listening… speak, then edit before sending.",
  );
  const expanded =
    signedOut ||
    thread.messages.length > 0 ||
    thread.artifacts.length > 0 ||
    thread.followUps.length > 0 ||
    Boolean(pendingClarification) ||
    draftRestored ||
    attachments.length > 0 ||
    recoveredAttachments.length > 0 ||
    connectorsOpen ||
    localPhase === "error";
  const replayLocked = Boolean(replayEnvelope && submissionIdsRef.current);

  useEffect(() => {
    const cleanupTheme = applyThemeToDocument();
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    void (async () => {
      const [, quickSettings, hasSession, cached] = await Promise.all([
        hydrateFromDisk().catch(() => {}),
        getQuickSettings().catch(() => null),
        hasStoredSession().catch(() => false),
        dbGet<{ bootstrap?: { profile?: Profile } }>("meta", "snapshot").catch(() => undefined),
      ]);
      if (cancelled) return;
      setNativeSettings(quickSettings);
      if (!hasSession) {
        setSignedOut(true);
        setBooting(false);
        return;
      }
      let currentProfile = cached?.bootstrap?.profile ?? null;

      // Cached identity and the protected draft are sufficient for the first
      // usable frame. Refresh the session after paint; invocation never waits
      // on network merely to display an authenticated composer.
      if (currentProfile) {
        setProfile(currentProfile);
        setSignedOut(false);
        const saved = await loadQuickDraft().catch(() => null);
        if (cancelled) return;
        if (saved) {
          setDraft(saved.text);
          const stableIds = saved.clientRequestId && saved.clientMessageId
            ? { request: saved.clientRequestId, message: saved.clientMessageId }
            : null;
          submissionIdsRef.current = stableIds;
          const restoredAttachments = (saved.attachmentIds ?? []).map((id, index) => ({
            id,
            name: saved.attachmentNames?.[index] ?? "Attached file",
          }));
          setRecoveredAttachments(restoredAttachments);
          const restoredEffort = saved.reasoningEffort ?? null;
          const restoredWebSearch = saved.webSearch ?? false;
          const restoredConnectors = (saved.connectorIds ?? []).slice(0, 5);
          const restoredPreflight = saved.preflightClarification ?? null;
          setReplayEnvelope(stableIds ? {
            text: saved.text,
            modelId: saved.modelId,
            projectId: saved.projectId,
            attachmentIds: restoredAttachments.map((attachment) => attachment.id),
            reasoningEffort: restoredEffort,
            webSearch: restoredWebSearch,
            connectorIds: restoredConnectors,
            preflightClarification: restoredPreflight,
          } : null);
          setDraftRestored(Boolean(saved.text || stableIds || restoredAttachments.length));
          setModelId(saved.modelId);
          setProjectId(saved.projectId);
          setEffort(restoredEffort);
          setWebSearch(restoredWebSearch);
          setSelectedConnectorIds(restoredConnectors);
        }
        setDraftLoaded(true);
        setBooting(false);
        requestAnimationFrame(() => textareaRef.current?.focus());
        void api<SessionResponse>("/v1/auth/session", { retries: 1 })
          .then((session) => {
            if (!cancelled) setProfile(session.profile);
          })
          .catch(() => {
            // Offline remains usable from cache. Definitive revocation is
            // emitted by the Rust auth layer and handled below.
          });
      } else {
        // A fresh installation has no cached identity to render. One direct
        // session request establishes and securely binds the account.
        try {
          const session = await api<SessionResponse>("/v1/auth/session", { retries: 1 });
          currentProfile = session.profile;
        } catch {
          currentProfile = null;
        }
        if (cancelled) return;
        setProfile(currentProfile);
        setSignedOut(!currentProfile);
        if (currentProfile) {
          const saved = await loadQuickDraft().catch(() => null);
          if (saved) {
            setDraft(saved.text);
            const stableIds = saved.clientRequestId && saved.clientMessageId
              ? { request: saved.clientRequestId, message: saved.clientMessageId }
              : null;
            submissionIdsRef.current = stableIds;
            const restoredAttachments = (saved.attachmentIds ?? []).map((id, index) => ({
              id,
              name: saved.attachmentNames?.[index] ?? "Attached file",
            }));
            setRecoveredAttachments(restoredAttachments);
            const restoredEffort = saved.reasoningEffort ?? null;
            const restoredWebSearch = saved.webSearch ?? false;
            const restoredConnectors = (saved.connectorIds ?? []).slice(0, 5);
            const restoredPreflight = saved.preflightClarification ?? null;
            setReplayEnvelope(stableIds ? {
              text: saved.text,
              modelId: saved.modelId,
              projectId: saved.projectId,
              attachmentIds: restoredAttachments.map((attachment) => attachment.id),
              reasoningEffort: restoredEffort,
              webSearch: restoredWebSearch,
              connectorIds: restoredConnectors,
              preflightClarification: restoredPreflight,
            } : null);
            setDraftRestored(Boolean(saved.text || stableIds || restoredAttachments.length));
            setModelId(saved.modelId);
            setProjectId(saved.projectId);
            setEffort(restoredEffort);
            setWebSearch(restoredWebSearch);
            setSelectedConnectorIds(restoredConnectors);
          }
        }
        setDraftLoaded(true);
        setBooting(false);
      }
      if (useThreadStore.getState().activeConversationId === null) {
        useThreadStore.getState().setActive("new");
      }
      setDraftLoaded(true);
      setBooting(false);
    })();

    void listen<QuickSettings>("juno://quick-settings-changed", (event) => {
      setNativeSettings(event.payload);
    }).then((off) => cleanups.push(off));
    void listen("juno://auth-revoked", () => {
      recognitionRef.current?.stop();
      if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
      setProfile(null);
      setSignedOut(true);
      setDraft("");
      setAttachments([]);
      setRecoveredAttachments([]);
      setReplayEnvelope(null);
      setRetryMode(null);
      submissionIdsRef.current = null;
    }).then((off) => cleanups.push(off));
    void listen("juno://quick-shown", () => {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }).then((off) => cleanups.push(off));
    void listen("juno://quick-hidden", () => {
      recognitionRef.current?.stop();
      setConnectorsOpen(false);
      setComposerFocused(false);
    }).then((off) => cleanups.push(off));
    void listen("juno://quick-focus-composer", () => {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }).then((off) => cleanups.push(off));

    return () => {
      cancelled = true;
      cleanupTheme();
      for (const cleanup of cleanups) cleanup();
      recognitionRef.current?.stop();
      if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (replayLocked) return;
    if (modelId && models.some((model) => model.id === modelId)) return;
    const resolved = resolveModelId(models, plan, [accountSettings?.defaultModel]);
    if (resolved) setModelId(resolved);
  }, [accountSettings?.defaultModel, modelId, models, plan, replayLocked]);

  useEffect(() => {
    if (!selectedModel || replayLocked) return;
    setEffort(defaultEffort(selectedModel));
  }, [replayLocked, selectedModel?.id]);

  useEffect(() => {
    if (!profile) {
      setConnectors([]);
      setSelectedConnectorIds([]);
      return;
    }
    let cancelled = false;
    void api<{ connectors: ConnectorInfo[] }>("/connectors", { retries: 1 })
      .then((response) => {
        if (cancelled) return;
        const connected = response.connectors
          .filter((connector) => connector.connected)
          .map((connector) => ({
            id: connector.id,
            label: connector.label || connector.id,
            connected: true,
          }));
        setConnectors(connected);
        setSelectedConnectorIds((current) => submissionIdsRef.current
          ? current.slice(0, 5)
          : current.filter((id) => connected.some((connector) => connector.id === id)).slice(0, 5));
      })
      .catch(() => {
        // Connector discovery is optional; the composer remains usable offline.
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.id]);

  useEffect(() => {
    if (!draftLoaded || !profile || privateMode || suspendDraftSaveRef.current) return;
    const timer = setTimeout(() => {
      if (suspendDraftSaveRef.current) return;
      const stable = submissionIdsRef.current;
      void saveQuickDraft({
        text: draft,
        modelId,
        projectId,
        clientRequestId: stable?.request ?? null,
        clientMessageId: stable?.message ?? null,
        attachmentIds: attachmentReferences.map((attachment) => attachment.id),
        attachmentNames: attachmentReferences.map((attachment) => attachment.name),
        reasoningEffort: replayEnvelope?.reasoningEffort ?? effort,
        webSearch: replayEnvelope?.webSearch ?? requestWebSearch,
        connectorIds: replayEnvelope?.connectorIds ?? requestConnectorIds,
        preflightClarification: replayEnvelope?.preflightClarification ?? null,
        updatedAt: Date.now(),
      }).catch(() => setNotice("Draft protection is temporarily unavailable."));
    }, 420);
    return () => clearTimeout(timer);
  }, [attachmentReferences, draft, draftLoaded, effort, modelId, privateMode, profile, projectId, replayEnvelope, requestConnectorIds, requestWebSearch]);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      const failed = Boolean(lastAssistantError(thread.messages));
      setCompletionAnnouncement(failed ? "Response failed. Your draft is safe." : "Response complete.");
      if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = window.setTimeout(() => {
        setCompletionAnnouncement("");
        completionTimerRef.current = null;
      }, 3_000);
      wasGeneratingRef.current = isGenerating;
      return;
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useEffect(() => {
    let remove: (() => void) | null = null;
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) return;
      const actionablePhase = attachments.some((attachment) => attachment.error) || actionableNotice
        ? "error"
        : phase;
      const interaction = { phase: actionablePhase, dictating, menuOpen: connectorsOpen };
      if (
        shouldDismissOnBlur(
          interaction,
          nativeSettings?.dismissOnBlur ?? true,
          nativeDialogOpenRef.current,
          uploading,
          Boolean(draft.trim() || attachmentReferences.length),
        )
      ) {
        void hideQuick();
      }
    }).then((off) => {
      remove = off;
    });
    return () => remove?.();
  }, [actionableNotice, attachmentReferences.length, attachments, connectorsOpen, dictating, draft, nativeSettings?.dismissOnBlur, phase, uploading]);

  useEffect(() => {
    const actionableError =
      phase === "error" || attachments.some((attachment) => attachment.error !== null) || actionableNotice;
    const busy = phase !== "idle" || dictating || uploading || actionableError || connectorsOpen;
    void setQuickRuntimeState(busy, composerFocused, expanded).catch(() => {});
  }, [actionableNotice, attachments, composerFocused, connectorsOpen, dictating, expanded, phase, uploading]);

  const performSend = useCallback(
    async (text: string, preflightClarification?: PreflightClarificationContext) => {
      if (
        !modelId ||
        !selectedModel ||
        !text.trim() ||
        uploading ||
        hasAttachmentError ||
        isGenerating ||
        (attachmentReferences.length > 0 && !attachmentsSupported)
      ) return;
      recognitionRef.current?.stop();
      const trimmed = text.trim();
      setNotice(null);
      setPendingClarification(null);
      setRetryMode(null);
      const materialEnvelope: QuickReplayEnvelope = {
        text: trimmed,
        modelId,
        projectId,
        attachmentIds: attachmentReferences.map((attachment) => attachment.id),
        reasoningEffort: replayEnvelope?.reasoningEffort ?? effort,
        webSearch: replayEnvelope?.webSearch ?? requestWebSearch,
        connectorIds: replayEnvelope?.connectorIds ?? requestConnectorIds,
        preflightClarification:
          replayEnvelope?.preflightClarification ?? preflightClarification ?? null,
      };

      if (!privateMode && !conversationId && !submissionIdsRef.current) {
        submissionIdsRef.current = {
          request: crypto.randomUUID(),
          message: crypto.randomUUID(),
        };
        setReplayEnvelope(materialEnvelope);
      }
      const stable = submissionIdsRef.current;
      if (stable && replayEnvelope) {
        if (!replayEnvelopeMatches(replayEnvelope, materialEnvelope)) {
          setNotice("This protected replay is immutable. Choose Start as new before changing it.");
          setLocalPhase("error");
          return;
        }
      }
      submittedTextRef.current = trimmed;

      // Persist the exact idempotent replay envelope before transport begins.
      // If Credential Manager is unavailable, nothing leaves the device.
      if (!privateMode) {
        try {
          await saveQuickDraft({
            text: trimmed,
            modelId,
            projectId,
            clientRequestId: stable?.request ?? null,
            clientMessageId: stable?.message ?? null,
            attachmentIds: attachmentReferences.map((attachment) => attachment.id),
            attachmentNames: attachmentReferences.map((attachment) => attachment.name),
            reasoningEffort: materialEnvelope.reasoningEffort,
            webSearch: materialEnvelope.webSearch,
            connectorIds: materialEnvelope.connectorIds,
            preflightClarification: materialEnvelope.preflightClarification,
            updatedAt: Date.now(),
          });
        } catch {
          setNotice("Juno could not protect this send yet. Nothing was sent; retry when draft protection is available.");
          setRetryMode("unsent");
          setLocalPhase("error");
          return;
        }
      }

      setLocalPhase("submitting");
      suspendDraftSaveRef.current = true;
      setDraftRestored(false);
      setDraft("");
      const result = await sendMessage({
        conversationId,
        message: trimmed,
        model: modelId,
        projectId: privateMode || conversationId ? null : projectId,
        attachmentIds: attachmentReferences.map((attachment) => attachment.id),
        attachments: readyAttachments,
        privateMode,
        canvasEnabled: !privateMode,
        ...(privateMode
          ? { privateHistory: buildPrivateHistory(thread.messages, trimmed) }
          : {}),
        ...(materialEnvelope.reasoningEffort
          ? { reasoningEffort: materialEnvelope.reasoningEffort }
          : {}),
        ...(!privateMode && selectedModel?.capabilities.webSearch
          ? { webSearch: materialEnvelope.webSearch }
          : {}),
        ...(!privateMode && selectedModel?.capabilities.tools && materialEnvelope.connectorIds.length
          ? { connectors: materialEnvelope.connectorIds }
          : {}),
        ...(materialEnvelope.preflightClarification
          ? { preflightClarification: materialEnvelope.preflightClarification }
          : {}),
        ...(!privateMode && !conversationId && stable
          ? {
              origin: "quick_windows" as const,
              clientRequestId: stable.request,
              clientMessageId: stable.message,
            }
          : {}),
      });

      const resultingKey = privateMode ? "private" : (result ?? conversationId ?? "new");
      const resultingThread = useThreadStore.getState().threads[resultingKey] ?? emptyThread;
      const sendError = lastAssistantError(resultingThread.messages);
      const canonicalFirstTurn = !privateMode && !conversationId && Boolean(result);
      const terminalCanonicalFailure =
        canonicalFirstTurn && Boolean(sendError) && resultingThread.status === "idle";
      const accepted = privateMode
        ? !sendError
        : canonicalFirstTurn || (Boolean(result) && (!sendError || resultingThread.status !== "idle"));
      if (accepted) {
        submissionIdsRef.current = null;
        setReplayEnvelope(null);
        setAttachments([]);
        setRecoveredAttachments([]);
        setSelectedConnectorIds([]);
        if (terminalCanonicalFailure) {
          submittedTextRef.current = trimmed;
          setRetryMode("regenerate");
          setLocalPhase("error");
          setNotice(sendError);
        } else {
          submittedTextRef.current = null;
          setRetryMode(null);
          setLocalPhase("idle");
        }
        if (!privateMode) {
          try {
            await clearQuickDraft();
          } catch {
            setDraftRestored(true);
            setNotice(terminalCanonicalFailure
              ? `${sendError ?? "The accepted response failed."} Windows also could not clear the protected draft; use Clear before retrying.`
              : "Response complete, but Windows could not clear the protected draft. Use Clear before sending again.");
          }
        }
      } else {
        const original = submittedTextRef.current;
        if (original) setDraft((current) => current || original);
        setRetryMode(!privateMode && conversationId ? "regenerate" : stable ? "new-replay" : null);
        setNotice(sendError ?? "Juno could not start that response. Your draft was restored.");
        setLocalPhase("error");
      }
      suspendDraftSaveRef.current = false;
      if (!privateMode && !accepted) {
        void saveQuickDraft({
          text: submittedTextRef.current ?? trimmed,
          modelId,
          projectId,
          clientRequestId: stable?.request ?? null,
          clientMessageId: stable?.message ?? null,
          attachmentIds: attachmentReferences.map((attachment) => attachment.id),
          attachmentNames: attachmentReferences.map((attachment) => attachment.name),
          reasoningEffort: materialEnvelope.reasoningEffort,
          webSearch: materialEnvelope.webSearch,
          connectorIds: materialEnvelope.connectorIds,
          preflightClarification: materialEnvelope.preflightClarification,
          updatedAt: Date.now(),
        }).catch(() => {});
      }
    },
    [
      conversationId,
      effort,
      isGenerating,
      modelId,
      privateMode,
      projectId,
      replayEnvelope,
      attachmentReferences,
      attachmentsSupported,
      hasAttachmentError,
      readyAttachments,
      selectedConnectorIds,
      selectedModel,
      selectedModel?.capabilities.tools,
      selectedModel?.capabilities.webSearch,
      thread.messages,
      uploading,
      webSearch,
    ],
  );

  const beginSend = useCallback(
    async (override?: string) => {
      recognitionRef.current?.stop();
      const text = (override ?? draft).trim();
      if (!text || !modelId || !selectedModel || uploading || hasAttachmentError || isGenerating) return;
      if (attachmentReferences.length > 0 && !attachmentsSupported) {
        setNotice("Choose an attachment-capable model or remove the attachments.");
        setLocalPhase("error");
        return;
      }
      if (replayLocked && replayEnvelope) {
        await performSend(text, replayEnvelope.preflightClarification ?? undefined);
        return;
      }
      setLocalPhase("checking");
      setNotice(null);
      const result = await checkPreflightClarification({
        message: text,
        conversationId,
        hasAttachments: attachmentReferences.length > 0,
        privateMode,
      });
      if (result?.needsClarification && result.questions[0]) {
        setPendingClarification({ original: text, result, question: result.questions[0] });
        setClarificationText("");
        setClarificationChoices([]);
        setLocalPhase("clarifying");
        return;
      }
      await performSend(text);
    },
    [attachmentReferences.length, attachmentsSupported, conversationId, draft, hasAttachmentError, isGenerating, modelId, performSend, privateMode, replayEnvelope, replayLocked, selectedModel, uploading],
  );

  const retryFailedTurn = useCallback(async () => {
    if (!modelId || !selectedModel || uploading || isGenerating) return;
    const original = submittedTextRef.current;

    // A failed first turn is replayed with the same durable idempotency IDs.
    // Remove only its local optimistic pair so the renderer does not duplicate
    // bubbles while the server adopts or creates the canonical conversation.
    if (retryMode === "unsent" && !privateMode && original) {
      await beginSend(original);
      return;
    }

    if (retryMode === "new-replay" && !privateMode && !conversationId && submissionIdsRef.current && original) {
      useThreadStore.getState().updateMessages("new", (messages) => {
        const next = [...messages];
        const assistant = next.at(-1);
        if (assistant?.role === "ASSISTANT" && assistant.errorMessage) next.pop();
        const user = next.at(-1);
        if (user?.role === "USER" && user.id.startsWith("temp-user") && user.content === original) {
          next.pop();
        }
        return next;
      });
      await beginSend(original);
      return;
    }

    // Saved-chat failures retry the existing turn in place. Regenerate keeps
    // the already-persisted user row and replaces only the failed assistant.
    if (retryMode === "regenerate" && !privateMode && conversationId) {
      setNotice(null);
      setLocalPhase("submitting");
      suspendDraftSaveRef.current = true;
      const result = await sendMessage({
        conversationId,
        message: "",
        model: modelId,
        regenerate: true,
        canvasEnabled: true,
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(selectedModel?.capabilities.webSearch ? { webSearch } : {}),
        ...(selectedModel?.capabilities.tools && selectedConnectorIds.length
          ? { connectors: selectedConnectorIds.slice(0, 5) }
          : {}),
      });
      const retriedThread = useThreadStore.getState().threads[result ?? conversationId] ?? emptyThread;
      const retryError = lastAssistantError(retriedThread.messages);
      if (result && !retryError) {
        submittedTextRef.current = null;
        setDraft("");
        setRetryMode(null);
        setLocalPhase("idle");
        try {
          await clearQuickDraft();
        } catch {
          setDraftRestored(true);
          setNotice("Response complete, but Windows could not clear the protected draft. Use Clear before sending again.");
        }
      } else {
        setLocalPhase("error");
        setNotice(retryError ?? "That turn could not be retried. Your protected draft is unchanged.");
      }
      suspendDraftSaveRef.current = false;
    }
  }, [beginSend, conversationId, effort, isGenerating, modelId, privateMode, retryMode, selectedConnectorIds, selectedModel, uploading, webSearch]);

  const resolveClarification = useCallback(
    async (source: "option" | "else" | "skip", value?: ClarificationAnswerValue) => {
      if (!pendingClarification) return;
      const { original, result, question } = pendingClarification;
      const answers: PreflightClarificationContext["answers"] = [
        {
          questionId: question.id,
          question: question.question,
          source,
          ...(value === undefined ? {} : { value }),
        },
        ...result.questions.slice(1).map((remaining) => ({
          questionId: remaining.id,
          question: remaining.question,
          source: "skip" as const,
        })),
      ];
      await performSend(original, {
        originalUserMessage: original,
        answers,
        skipped: source === "skip" || result.questions.length > 1,
      });
    },
    [pendingClarification, performSend],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const action = escapeAction({ phase, dictating, menuOpen: connectorsOpen });
        if (action === "close-menu") setConnectorsOpen(false);
        else if (action === "stop-dictation") recognitionRef.current?.stop();
        else if (action === "stop-generation") void stopGeneration(threadKey);
        else if (action === "cancel-clarification") {
          setPendingClarification(null);
          setLocalPhase("idle");
          requestAnimationFrame(() => textareaRef.current?.focus());
        } else if (action === "wait") return;
        else void hideQuick();
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!privateMode && conversationId) void openInJuno(conversationId);
        return;
      }
      const enterSubmit =
        event.key === "Enter" &&
        !event.isComposing &&
        ((event.ctrlKey && !event.shiftKey && !event.altKey) ||
          (!event.shiftKey && !event.altKey && !event.metaKey));
      if (enterSubmit) {
        const target = event.target as HTMLElement;
        if (target.tagName === "TEXTAREA" && !pendingClarification) {
          event.preventDefault();
          void beginSend();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [beginSend, connectorsOpen, conversationId, dictating, pendingClarification, phase, privateMode, threadKey]);

  const addFiles = async (files: FileList | File[]) => {
    if (privateMode || !attachmentsSupported) {
      setNotice(privateMode ? "Attachments are unavailable in Private mode." : "This model does not support attachments.");
      return;
    }
    const pendingUploads = attachments.filter((row) => row.attachment === null).length;
    const rows = Array.from(files).slice(
      0,
      Math.max(0, 5 - attachmentReferences.length - pendingUploads),
    );
    for (const file of rows) {
      const localId = crypto.randomUUID();
      if (file.size > 25 * 1024 * 1024) {
        setAttachments((current) => [
          ...current,
          { localId, name: file.name, attachment: null, error: "Open Juno for files over 25 MB." },
        ]);
        continue;
      }
      const mimeType = acceptedMimeType(file);
      if (!mimeType) {
        setAttachments((current) => [
          ...current,
          { localId, name: file.name, attachment: null, error: "This file type is not supported in Quick." },
        ]);
        continue;
      }
      setAttachments((current) => [
        ...current,
        { localId, name: file.name, attachment: null, error: null },
      ]);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const uploaded = await uploadBytes(file.name, mimeType, bytes, {
          ...(conversationId ? { conversationId } : {}),
          ...(!conversationId && projectId ? { projectId } : {}),
        });
        setAttachments((current) =>
          current.map((row) => (row.localId === localId ? { ...row, attachment: uploaded } : row)),
        );
      } catch (error) {
        setAttachments((current) =>
          current.map((row) =>
            row.localId === localId
              ? {
                  ...row,
                  error: error instanceof Error ? error.message : "Upload failed. Try again.",
                }
              : row,
          ),
        );
      }
    }
  };

  const startDictation = () => {
    if (dictating) {
      recognitionRef.current?.stop();
      return;
    }
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) {
      textareaRef.current?.focus();
      setNotice("Press Windows+H to use Windows voice typing here.");
      return;
    }
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.onresult = (event) => {
      let addition = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result?.isFinal) addition += result[0].transcript;
      }
      if (addition) setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${addition}`);
    };
    recognition.onerror = () => {
      setNotice("Dictation could not start. Check Windows microphone and speech permissions.");
    };
    recognition.onend = () => {
      setDictating(false);
      recognitionRef.current = null;
      textareaRef.current?.focus();
    };
    recognitionRef.current = recognition;
    setDictating(true);
    setNotice("Listening… speak, then edit before sending.");
    recognition.start();
  };

  const newConversation = () => {
    recognitionRef.current?.stop();
    useThreadStore.getState().setActive("new");
    useThreadStore.getState().setPrivateMode(false);
    setPrivateMode(false);
    setDraft("");
    setAttachments([]);
    setRecoveredAttachments([]);
    setSelectedConnectorIds([]);
    setConnectorsOpen(false);
    setPendingClarification(null);
    setNotice(null);
    setRetryMode(null);
    submissionIdsRef.current = null;
    setReplayEnvelope(null);
    submittedTextRef.current = null;
    void clearQuickDraft().catch(() => {});
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  if (booting) {
    return (
      <main className="quick-root quick-centered" aria-label="Juno Quick">
        <LoaderCircle className="quick-spinner" size={22} aria-hidden />
        <span role="status">Preparing Juno Quick…</span>
      </main>
    );
  }

  if (signedOut || !profile) {
    return (
      <main className="quick-root quick-signed-out" aria-label="Juno Quick">
        <div className="quick-drag" data-tauri-drag-region>
          <span className="quick-brand">Juno Quick</span>
          <button className="quick-icon-button" aria-label="Close" onClick={() => void hideQuick()}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="quick-signed-out-card">
          <Shield size={28} aria-hidden />
          <h1>Sign in to Juno</h1>
          <p>Quick uses your Juno account, models, projects, and usage limits.</p>
          <button className="quick-primary-button" onClick={() => void openInJuno()}>
            Open Juno to sign in
          </button>
        </div>
      </main>
    );
  }

  const latestAssistant = [...thread.messages].reverse().find((message) => message.role === "ASSISTANT");
  const canSend = Boolean(
    draft.trim() &&
    modelId &&
    selectedModel &&
    !uploading &&
    !hasAttachmentError &&
    !isGenerating &&
    phase !== "checking" &&
    (attachmentReferences.length === 0 || attachmentsSupported),
  );
  const canRetryFailedTurn = Boolean(
    !privateMode && retryMode && submittedTextRef.current,
  );

  return (
    <main
      className={`quick-root${dragActive ? " is-dragging" : ""}${expanded ? " is-expanded" : ""}`}
      aria-label="Juno Quick"
      onPointerDownCapture={(event) => {
        if (connectorsOpen && !(event.target as HTMLElement).closest(".quick-connectors-wrap")) {
          setConnectorsOpen(false);
        }
      }}
      onDragEnter={(event) => {
        if (privateMode || !attachmentsSupported) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (privateMode || !attachmentsSupported) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        if (!privateMode && attachmentsSupported && event.dataTransfer.files.length) {
          void addFiles(event.dataTransfer.files);
        }
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">{completionAnnouncement}</span>
      {dragActive ? <div className="quick-drop-overlay">Drop files to attach</div> : null}
      <header className="quick-drag" data-tauri-drag-region>
        <div className="quick-brand" data-tauri-drag-region>
          <span className="quick-brand-mark" aria-hidden>J</span>
          <span>Juno Quick</span>
          {privateMode ? <span className="quick-private-badge">Private</span> : null}
        </div>
        <div className="quick-header-actions">
          <span className="quick-shortcut" aria-label="Global shortcut">
            {nativeSettings?.shortcut ?? "Ctrl+Space"}
          </span>
          <button className="quick-icon-button" aria-label="New conversation" onClick={newConversation}>
            <Plus size={16} aria-hidden />
          </button>
          <button className="quick-icon-button" aria-label="Close Juno Quick" onClick={() => void hideQuick()}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>

      <section className="quick-content" aria-label="Conversation">
        {thread.messages.length > 0 ? (
          <div className="quick-transcript" aria-busy={isGenerating}>
            {thread.messages.slice(-6).map((message) => (
              <article
                className={`quick-message quick-message-${message.role.toLowerCase()}`}
                key={message.id}
              >
                <div className="quick-message-body">
                  {message.role === "ASSISTANT" && message.content
                    ? <Markdown text={message.content} />
                    : (message.content || (message.role === "ASSISTANT" ? "…" : ""))}
                </div>
                {message.errorMessage ? (
                  <p className="quick-inline-error" role="alert">{message.errorMessage}</p>
                ) : null}
                {message.role === "ASSISTANT" && message.content ? (
                  <button
                    className="quick-copy"
                    aria-label="Copy response"
                    onClick={() => {
                      void navigator.clipboard.writeText(message.content).then(() => {
                        setCopiedId(message.id);
                        setTimeout(() => setCopiedId(null), 1_400);
                      });
                    }}
                  >
                    {copiedId === message.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                    {copiedId === message.id ? "Copied" : "Copy"}
                  </button>
                ) : null}
                {message.sources?.length ? (
                  <div className="quick-sources" aria-label="Sources">
                    {message.sources.slice(0, 4).map((source) => (
                      <button
                        key={`${message.id}-${source.url}`}
                        disabled={!validSourceUrl(source.url)}
                        onClick={() => validSourceUrl(source.url) && void openUrl(source.url)}
                      >
                        <ExternalLink size={12} aria-hidden />
                        {sourceLabel(source.title, source.url)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {thread.artifacts.length ? (
              <div className="quick-artifacts" aria-label="Artifacts">
                {thread.artifacts.slice(-2).map((artifact) => (
                  <button key={artifact.id} onClick={() => void openInJuno(conversationId)}>
                    <FileText size={15} aria-hidden />
                    <span><strong>{artifact.title}</strong><small>{artifact.type}</small></span>
                    <ExternalLink size={13} aria-hidden />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="quick-welcome">
            <span>Ask Juno</span>
            <small>Fast, focused, and ready in any app.</small>
          </div>
        )}

        {localPhase === "error" ? (
          <div className="quick-error-banner" role="alert">
            <span>{canRetryFailedTurn ? "Your draft and conversation are safe." : "Nothing was discarded."}</span>
            {canRetryFailedTurn ? (
              <button type="button" onClick={() => void retryFailedTurn()}>Retry this turn</button>
            ) : null}
          </div>
        ) : null}

        {pendingClarification ? (
          <section className="quick-clarification" aria-labelledby="quick-clarification-title">
            <div>
              <span className="quick-eyebrow">One quick detail</span>
              <h2 id="quick-clarification-title">{pendingClarification.question.question}</h2>
            </div>
            {pendingClarification.question.options.length > 0 ? (
              <div className="quick-choice-list">
                {pendingClarification.question.options.slice(0, 5).map((option) => {
                  const selected = clarificationChoices.includes(option);
                  return (
                    <button
                      key={option}
                      className={selected ? "is-selected" : undefined}
                      aria-pressed={pendingClarification.question.type === "multi-choice" ? selected : undefined}
                      onClick={() => {
                        if (pendingClarification.question.type === "multi-choice") {
                          setClarificationChoices((current) =>
                            current.includes(option)
                              ? current.filter((value) => value !== option)
                              : [...current, option],
                          );
                        } else {
                          void resolveClarification("option", option);
                        }
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {pendingClarification.question.type === "text" ||
            pendingClarification.question.type === "text-long" ||
            pendingClarification.question.allowElse ? (
              <input
                className="quick-clarification-input"
                value={clarificationText}
                onChange={(event) => setClarificationText(event.target.value)}
                placeholder={pendingClarification.question.elsePlaceholder || "Type a short answer"}
                aria-label="Clarification answer"
              />
            ) : null}
            <div className="quick-clarification-actions">
              <button onClick={() => void resolveClarification("skip")}>Use my best judgment</button>
              {(clarificationText.trim() || clarificationChoices.length > 0) ? (
                <button
                  className="quick-primary-button"
                  onClick={() =>
                    void resolveClarification(
                      clarificationText.trim() ? "else" : "option",
                      clarificationText.trim() || clarificationChoices,
                    )
                  }
                >
                  Continue
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="quick-composer" aria-label="Message composer">
            {draftRestored ? (
              <div className="quick-restored-draft" role="status">
                <Shield size={12} aria-hidden />
                {replayLocked ? "Protected send ready to retry" : "Protected draft restored"}
                {replayLocked ? (
                  <button
                    onClick={() => {
                      submissionIdsRef.current = null;
                      submittedTextRef.current = null;
                      setReplayEnvelope(null);
                      setDraftRestored(false);
                      setRetryMode(null);
                      setLocalPhase("idle");
                      setNotice("Started a new send. The previous replay identity was retired.");
                      void saveQuickDraft({
                        text: draft,
                        modelId,
                        projectId,
                        clientRequestId: null,
                        clientMessageId: null,
                        attachmentIds: attachmentReferences.map((attachment) => attachment.id),
                        attachmentNames: attachmentReferences.map((attachment) => attachment.name),
                        reasoningEffort: effort,
                        webSearch: requestWebSearch,
                        connectorIds: requestConnectorIds,
                        preflightClarification: null,
                        updatedAt: Date.now(),
                      }).catch(() => setNotice("Draft protection is temporarily unavailable."));
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    Start as new
                  </button>
                ) : null}
                <button
                  onClick={() => {
                    recognitionRef.current?.stop();
                    setDraft("");
                    setDraftRestored(false);
                    setAttachments([]);
                    setRecoveredAttachments([]);
                    submissionIdsRef.current = null;
                    setReplayEnvelope(null);
                    setRetryMode(null);
                    submittedTextRef.current = null;
                    void clearQuickDraft().catch(() => {});
                    textareaRef.current?.focus();
                  }}
                >
                  Clear
                </button>
              </div>
            ) : null}
            {attachments.length ? (
              <div className="quick-attachments" aria-label="Attachments">
                {attachments.map((row) => (
                  <div key={row.localId} className={row.error ? "has-error" : undefined}>
                    {row.attachment === null && !row.error ? <LoaderCircle size={13} className="quick-spinner" /> : <Paperclip size={13} />}
                    <span title={row.error ?? row.name}>{row.error ?? row.name}</span>
                    <button
                      aria-label={`Remove ${row.name}`}
                      disabled={replayLocked}
                      onClick={() => setAttachments((current) => current.filter((item) => item.localId !== row.localId))}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {recoveredAttachments.length ? (
              <div className="quick-attachments" aria-label="Restored attachments">
                {recoveredAttachments.map((attachment) => (
                  <div key={attachment.id}>
                    <Shield size={13} aria-hidden />
                    <span title={attachment.name}>{attachment.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (localPhase === "error") setLocalPhase("idle");
              }}
              onPaste={(event) => {
                if (privateMode || !attachmentsSupported || replayLocked) return;
                const images = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (images.length) void addFiles(images);
              }}
              placeholder={privateMode ? "Ask privately…" : "Ask Juno anything…"}
              rows={2}
              aria-label="Message Juno"
              autoFocus
              readOnly={replayLocked}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
            />
            <div className="quick-composer-actions">
              <div>
                <input
                  ref={fileInputRef}
                  className="quick-file-input"
                  type="file"
                  multiple
                  accept={ACCEPTED_FILE_TYPES}
                  onChange={(event) => {
                    nativeDialogOpenRef.current = false;
                    if (event.target.files) void addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button
                  className="quick-icon-button"
                  aria-label="Attach files"
                  disabled={privateMode || replayLocked || !attachmentsSupported || attachmentReferences.length + attachments.filter((row) => row.attachment === null).length >= 5}
                  title={attachmentsSupported ? "Attach files" : "This model does not support attachments"}
                  onClick={() => {
                    nativeDialogOpenRef.current = true;
                    fileInputRef.current?.click();
                    setTimeout(() => {
                      nativeDialogOpenRef.current = false;
                    }, 2_000);
                  }}
                >
                  <Paperclip size={17} aria-hidden />
                </button>
                <button
                  className={`quick-icon-button${dictating ? " is-active" : ""}`}
                  aria-label={dictating ? "Stop dictation" : "Dictate message"}
                  aria-pressed={dictating}
                  disabled={replayLocked}
                  onClick={startDictation}
                >
                  <Mic size={17} aria-hidden />
                </button>
                <button
                  className={`quick-icon-button${webSearch && !privateMode && selectedModel?.capabilities.webSearch ? " is-active" : ""}`}
                  aria-label="Use web search"
                  aria-pressed={webSearch && !privateMode && Boolean(selectedModel?.capabilities.webSearch)}
                  disabled={privateMode || replayLocked || !selectedModel?.capabilities.webSearch}
                  title={selectedModel?.capabilities.webSearch ? "Web search" : "This model does not support web search"}
                  onClick={() => setWebSearch(!webSearch)}
                >
                  <Globe2 size={17} aria-hidden />
                </button>
                <div className="quick-connectors-wrap">
                  <button
                    className={`quick-icon-button${selectedConnectorIds.length ? " is-active" : ""}`}
                    aria-label="Choose connected apps"
                    aria-haspopup="menu"
                    aria-expanded={connectorsOpen}
                    disabled={privateMode || replayLocked || !selectedModel?.capabilities.tools || connectors.length === 0}
                    title={connectors.length ? "Connected apps" : "Connect apps from the full Juno window"}
                    onClick={() => setConnectorsOpen((open) => !open)}
                  >
                    <Plug size={17} aria-hidden />
                    {selectedConnectorIds.length ? <span>{selectedConnectorIds.length}</span> : null}
                  </button>
                  {connectorsOpen ? (
                    <div className="quick-connectors-menu" role="menu" aria-label="Connected apps">
                      <strong>Use connected apps</strong>
                      {connectors.map((connector) => {
                        const selected = selectedConnectorIds.includes(connector.id);
                        const atLimit = selectedConnectorIds.length >= 5 && !selected;
                        return (
                          <button
                            key={connector.id}
                            role="menuitemcheckbox"
                            aria-checked={selected}
                            disabled={atLimit}
                            onClick={() => setSelectedConnectorIds((current) =>
                              selected
                                ? current.filter((id) => id !== connector.id)
                                : [...current, connector.id].slice(0, 5)
                            )}
                          >
                            <span>{connector.label}</span>
                            {selected ? <Check size={13} aria-hidden /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
              {isGenerating ? (
                <button
                  className="quick-send-button is-stop"
                  aria-label="Stop response"
                  onClick={() => void stopGeneration(threadKey)}
                >
                  <Square size={13} fill="currentColor" aria-hidden />
                </button>
              ) : (
                <button
                  className="quick-send-button"
                  aria-label="Send message"
                  disabled={!canSend}
                  onClick={() => void beginSend()}
                >
                  {phase === "checking" ? <LoaderCircle size={16} className="quick-spinner" aria-hidden /> : <ArrowUp size={17} aria-hidden />}
                </button>
              )}
            </div>
          </section>
        )}

        {thread.followUps.length > 0 && !isGenerating && !pendingClarification && !replayLocked ? (
          <div className="quick-followups" aria-label="Suggested follow-ups">
            {thread.followUps.slice(0, 3).map((suggestion) => (
              <button key={suggestion} onClick={() => void beginSend(suggestion)}>{suggestion}</button>
            ))}
          </div>
        ) : null}
      </section>

      <footer className="quick-footer">
        <div className="quick-selects">
          <select
            value={modelId ?? ""}
            onChange={(event) => setModelId(event.target.value || null)}
            disabled={replayLocked}
            aria-label="Model"
          >
            {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
          {reasoningOptions.length > 1 ? (
            <select
              value={effort ?? ""}
              onChange={(event) => setEffort((event.target.value || null) as ReasoningEffort | null)}
              disabled={replayLocked}
              aria-label="Reasoning effort"
            >
              {reasoningOptions.map((option) => (
                <option key={option.value ?? "instant"} value={option.value ?? ""}>{option.label}</option>
              ))}
            </select>
          ) : null}
          <select
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || null)}
            disabled={privateMode || replayLocked || Boolean(conversationId)}
            aria-label="Project"
          >
            <option value="">No project</option>
            {projectRows.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button
            className={`quick-private-toggle${privateMode ? " is-active" : ""}`}
            aria-pressed={privateMode}
            disabled={replayLocked}
            onClick={() => {
              recognitionRef.current?.stop();
              const next = !privateMode;
              setPrivateMode(next);
              useThreadStore.getState().setPrivateMode(next);
              // Private text and upload references never cross either side of
              // the persistence boundary.
              setDraft("");
              setDraftRestored(false);
              setAttachments([]);
              setRecoveredAttachments([]);
              setPendingClarification(null);
              setSelectedConnectorIds([]);
              submissionIdsRef.current = null;
              setReplayEnvelope(null);
              setRetryMode(null);
              submittedTextRef.current = null;
              void clearQuickDraft().catch(() => {});
            }}
          >
            <Shield size={13} aria-hidden />
            Private
          </button>
        </div>
        <div className="quick-footer-right">
          {conversationId ? (
            <button className="quick-open-main" onClick={() => void openInJuno(conversationId)}>
              Open in Juno <ExternalLink size={12} aria-hidden />
            </button>
          ) : null}
          <span className={`quick-status quick-status-${phase}`} role="status" aria-live="polite">
            {notice ??
              (phase === "checking" ? "Checking one detail…" :
                phase === "submitting" ? "Starting…" :
                  phase === "streaming" ? "Juno is responding…" :
                    phase === "stopping" ? "Stopping…" :
                      latestAssistant?.errorMessage ?? "Enter to send · Shift+Enter for a new line")}
          </span>
        </div>
      </footer>
    </main>
  );
}
