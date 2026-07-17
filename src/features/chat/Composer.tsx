/**
 * Chat composer: auto-growing textarea (Enter sends, Shift+Enter newline),
 * model / reasoning-effort / web-search / connectors controls, attachments
 * (picker, paste, OS drag-drop), private mode, quota bar, follow-up pills,
 * and the morphing send/stop button.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  Brain,
  Check,
  FileText,
  Folder,
  Globe,
  ImagePlus,
  Library,
  Loader2,
  Lock,
  LockOpen,
  Mic,
  Paperclip,
  PencilRuler,
  Plus,
  Sparkles,
  Square,
  Telescope,
  X,
} from "lucide-react";
import { api } from "@/lib/backend/http";
import type { ClientAttachment, ModelEntry, ReasoningEffort } from "@/lib/data/entities";
import { uploadByPath, uploadBytes } from "@/lib/data/uploads";
import { sendMessage, stopGeneration, type SendOptions } from "@/lib/chat/chatEngine";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import { emptyThread, useThreadStore, type GenerationStatus } from "@/state/threadStore";
import { useVoiceStore } from "@/state/voiceStore";
import { VoicePanel } from "@/features/voice/VoicePanel";
import {
  consumePendingProjectId,
  peekPendingProjectId,
  setPendingProjectId,
} from "@/features/projects/projectContext";
import { ChatPopover } from "./ChatPopover";
import { ModelSelector } from "./ModelSelector";
import { ReasoningSlider } from "./ReasoningSlider";
import { LibraryPicker } from "./LibraryPicker";
import { EFFORT_NONE, useChatPrefs } from "./chatPrefs";
import {
  buildPrivateHistory,
  defaultEffort,
  effortOptions,
  formatBytes,
} from "./helpers";
import { fileUrl } from "./fileUrl";

const MAX_ATTACHMENTS = 10;

interface StagedAttachment {
  localId: string;
  fileName: string;
  status: "uploading" | "done" | "error";
  attachment?: ClientAttachment;
  error?: string;
}

interface ConnectorInfo {
  id: string;
  label: string;
  description: string;
  connected: boolean;
  accountLabel: string | null;
}

export function Composer({
  threadKey,
  conversationId,
  privateMode,
  status,
  modelId,
  models,
  plan,
}: {
  threadKey: string;
  conversationId: string | null;
  privateMode: boolean;
  status: GenerationStatus;
  modelId: string | null;
  models: ModelEntry[];
  plan: string;
}) {
  const quota = useDataStore((s) => s.quota);
  const settings = useDataStore((s) => s.settings);
  const setSettings = useDataStore((s) => s.setSettings);
  const conversation = useDataStore((s) =>
    conversationId ? s.conversations[conversationId] : undefined,
  );
  const followUps = useThreadStore((s) => s.threads[threadKey]?.followUps);
  const setPrivateMode = useThreadStore((s) => s.setPrivateMode);
  const voicePhase = useVoiceStore((s) => s.phase);
  const startVoice = useVoiceStore((s) => s.start);

  const prefs = useChatPrefs();
  const model = models.find((m) => m.id === modelId) ?? null;

  // ---- pending project hand-off (new chat started from inside a project) ----
  const isNewChat = conversationId === null && !privateMode;
  const [pendingProject, setPendingProject] = useState<string | null>(() =>
    isNewChat ? peekPendingProjectId() : null,
  );
  const pendingProjectName = useDataStore((s) =>
    pendingProject ? (s.projects[pendingProject]?.name ?? null) : null,
  );
  useEffect(() => {
    // Once the user is composing in an existing chat or private mode, any
    // stashed project no longer applies — clear it so it can't leak into a
    // later unrelated new chat.
    if (!isNewChat) setPendingProjectId(null);
  }, [isNewChat]);
  const removePendingProject = () => {
    setPendingProjectId(null);
    setPendingProject(null);
  };

  const [draft, setDraft] = useState("");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const stagedCountRef = useRef(0);
  stagedCountRef.current = staged.length;
  const [dragging, setDragging] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Projects for the "Add to project" picker (new chats only).
  const projects = useDataStore((s) => s.projects);
  const projectList = useMemo(
    () => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const busy = status !== "idle";
  const quotaExhausted = quota?.remaining === 0;
  const uploading = staged.some((s) => s.status === "uploading");
  const readyAttachments = staged.filter(
    (s): s is StagedAttachment & { attachment: ClientAttachment } =>
      s.status === "done" && s.attachment !== undefined,
  );

  // ---- reasoning effort ----
  const efforts = model ? effortOptions(model) : [];
  const storedEffort = model ? prefs.effortByModel[model.id] : undefined;
  const selectedEffort: ReasoningEffort | null = model
    ? storedEffort === EFFORT_NONE
      ? null
      : (storedEffort ?? defaultEffort(model))
    : null;
  const effortDisplay =
    efforts.find((o) => o.value === selectedEffort)?.label ??
    (selectedEffort ? selectedEffort : "Instant");

  // ---- connectors selection (seeded from the conversation's stored set) ----
  const selectedConnectors = useMemo(
    () =>
      prefs.connectorsByThread[threadKey] ?? conversation?.activeConnectors ?? [],
    [prefs.connectorsByThread, threadKey, conversation?.activeConnectors],
  );

  // ---- canvas + deep research ----
  const canvasOn = prefs.canvas;
  const deepResearch = !privateMode && (prefs.deepResearchByThread[threadKey] ?? false);
  // Badge counts genuinely-added items (canvas is on by default, so its state
  // isn't an "addition"); it tells the user something is attached behind the +.
  const addActiveCount =
    (deepResearch ? 1 : 0) + selectedConnectors.length + (pendingProject ? 1 : 0);

  const chooseProject = (id: string | null) => {
    setPendingProjectId(id);
    setPendingProject(id);
  };

  const loadConnectors = useCallback(async () => {
    setConnectorsLoading(true);
    setConnectorsError(null);
    try {
      const res = await api<{ connectors: ConnectorInfo[] }>("/connectors");
      setConnectors(res.connectors.filter((c) => c.connected));
    } catch (err) {
      setConnectorsError(err instanceof Error ? err.message : "Couldn't load connectors.");
    } finally {
      setConnectorsLoading(false);
    }
  }, []);

  // ---- attachments ----
  const stageUpload = useCallback(
    (fileName: string, run: () => Promise<ClientAttachment>) => {
      const localId = crypto.randomUUID();
      stagedCountRef.current += 1;
      setStaged((s) => [...s, { localId, fileName, status: "uploading" }]);
      run()
        .then((attachment) => {
          setStaged((s) =>
            s.map((item) =>
              item.localId === localId ? { ...item, status: "done", attachment } : item,
            ),
          );
        })
        .catch((err: unknown) => {
          setStaged((s) =>
            s.map((item) =>
              item.localId === localId
                ? {
                    ...item,
                    status: "error",
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : item,
            ),
          );
        });
    },
    [],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      if (privateMode) return;
      const room = MAX_ATTACHMENTS - stagedCountRef.current;
      for (const path of paths.slice(0, Math.max(0, room))) {
        const fileName = path.split(/[\\/]/).pop() ?? path;
        stageUpload(fileName, () => uploadByPath(path));
      }
    },
    [privateMode, stageUpload],
  );

  const pickFiles = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true, title: "Attach files" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    addPaths(paths);
  }, [addPaths]);

  const pickImages = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: true,
      title: "Add photos",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    addPaths(paths);
  }, [addPaths]);

  const attachFromLibrary = useCallback(
    (attachments: ClientAttachment[]) => {
      const room = MAX_ATTACHMENTS - stagedCountRef.current;
      for (const attachment of attachments.slice(0, Math.max(0, room))) {
        const localId = crypto.randomUUID();
        stagedCountRef.current += 1;
        setStaged((s) => [...s, { localId, fileName: attachment.fileName, status: "done", attachment }]);
      }
    },
    [],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (privateMode) return;
      const images = Array.from(e.clipboardData?.items ?? []).filter(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      e.preventDefault();
      for (const item of images) {
        const file = item.getAsFile();
        if (!file) continue;
        const ext = item.type.split("/")[1] ?? "png";
        const name = file.name || `pasted-${Date.now()}.${ext}`;
        stageUpload(name, async () => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          return uploadBytes(name, item.type, bytes);
        });
      }
    },
    [privateMode, stageUpload],
  );

  // OS drag-drop through the webview (browser drop events don't carry paths in Tauri).
  useEffect(() => {
    if (privateMode) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") setDragging(true);
        else if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          addPaths(payload.paths);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Drag-drop is an enhancement; the picker still works.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [privateMode, addPaths]);

  // ---- sending ----
  const canSend =
    !busy &&
    !uploading &&
    !quotaExhausted &&
    modelId !== null &&
    (draft.trim().length > 0 || readyAttachments.length > 0);

  const send = useCallback(
    async (text: string) => {
      if (busy || uploading || quotaExhausted || !modelId) return;
      const message = text.trim();
      const attachmentIds = privateMode ? [] : readyAttachments.map((s) => s.attachment.id);
      if (!message && attachmentIds.length === 0) return;

      const supportsWebSearch = model?.capabilities.webSearch ?? false;
      // One-shot: creating the conversation consumes the stashed project id.
      const projectId =
        !privateMode && !conversationId ? consumePendingProjectId() : null;
      const options: SendOptions = {
        conversationId: privateMode ? null : conversationId,
        message,
        model: modelId,
        ...(projectId ? { projectId } : {}),
        ...(attachmentIds.length > 0
          ? {
              attachmentIds,
              attachments: readyAttachments.map((s) => s.attachment),
            }
          : {}),
        ...(supportsWebSearch ? { webSearch: prefs.webSearch } : {}),
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        ...(!privateMode ? { connectors: selectedConnectors.slice(0, 5) } : {}),
        ...(!privateMode ? { canvasEnabled: canvasOn } : {}),
        ...(deepResearch ? { deepResearch: true } : {}),
        ...(privateMode
          ? {
              privateMode: true,
              privateHistory: buildPrivateHistory(
                useThreadStore.getState().threads["private"]?.messages ?? [],
                message,
              ),
            }
          : {}),
      };

      setDraft("");
      setStaged([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      await sendMessage(options);
    },
    [
      busy,
      uploading,
      quotaExhausted,
      modelId,
      model,
      privateMode,
      conversationId,
      readyAttachments,
      prefs.webSearch,
      selectedEffort,
      selectedConnectors,
      canvasOn,
      deepResearch,
    ],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME users commit conversions with Enter — never send mid-composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void send(draft);
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  };

  const togglePrivate = () => {
    if (busy) return;
    if (privateMode) {
      // Leaving private mode discards the private transcript entirely.
      useThreadStore.getState().patchThread("private", { ...emptyThread });
      setPrivateMode(false);
    } else {
      setStaged([]);
      setPrivateMode(true);
    }
  };

  const toggleFavorite = (id: string) => {
    const current = settings?.favoriteModels ?? [];
    const next = current.includes(id) ? current.filter((f) => f !== id) : [...current, id];
    if (settings) setSettings({ ...settings, favoriteModels: next });
    void enqueueMutation({ type: "settings.update", patch: { favoriteModels: next } });
  };

  const toggleConnector = (id: string) => {
    const next = selectedConnectors.includes(id)
      ? selectedConnectors.filter((c) => c !== id)
      : selectedConnectors.length < 5
        ? [...selectedConnectors, id]
        : selectedConnectors;
    prefs.setConnectors(threadKey, next);
  };

  const showFollowUps =
    status === "idle" && !privateMode && (followUps?.length ?? 0) > 0;

  return (
    <div className="chat-composer-area">
      {showFollowUps ? (
        <div className="chat-followups" role="group" aria-label="Suggested follow-ups">
          {followUps!.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chat-followup-pill"
              onClick={() => void send(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {quotaExhausted ? (
        <div className="chat-quota-bar" role="status">
          <Sparkles size={14} aria-hidden />
          <span>You've reached your plan limit. Upgrade your plan to keep chatting.</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => useUiStore.getState().openSettings(true)}
          >
            Open plan settings
          </button>
        </div>
      ) : null}

      {privateMode ? (
        <div className="chat-private-banner" role="status">
          <Lock size={13} aria-hidden />
          Private chat — not saved
        </div>
      ) : null}

      <VoicePanel />

      <div className="chat-composer" data-private={privateMode || undefined}>
        {dragging && !privateMode ? (
          <div className="chat-drop-overlay" aria-hidden>
            Drop to attach
          </div>
        ) : null}

        {pendingProject ? (
          <div className="chat-attachment-chips">
            <div className="chat-attachment-chip chat-project-chip" role="status">
              <Folder size={13} aria-hidden />
              <span className="chat-attachment-name">
                New chat in {pendingProjectName ?? "project"}
              </span>
              <button
                type="button"
                className="chat-chip-remove"
                aria-label="Don't add this chat to the project"
                onClick={removePendingProject}
              >
                <X size={11} aria-hidden />
              </button>
            </div>
          </div>
        ) : null}

        {staged.length > 0 ? (
          <div className="chat-attachment-chips">
            {staged.map((item) => (
              <div
                key={item.localId}
                className="chat-attachment-chip"
                data-error={item.status === "error" || undefined}
              >
                {item.status === "uploading" ? (
                  <Loader2 size={13} className="chat-spin" aria-label="Uploading" />
                ) : item.attachment?.kind === "IMAGE" ? (
                  <img
                    className="chat-attachment-thumb"
                    src={fileUrl(item.attachment.url)}
                    alt=""
                  />
                ) : (
                  <FileText size={13} aria-hidden />
                )}
                <span className="chat-attachment-name" title={item.fileName}>
                  {item.fileName}
                </span>
                {item.status === "done" && item.attachment ? (
                  <span className="chat-attachment-size">
                    {formatBytes(item.attachment.size)}
                  </span>
                ) : null}
                {item.status === "error" ? (
                  <span className="chat-attachment-error" title={item.error}>
                    Failed
                  </span>
                ) : null}
                <button
                  type="button"
                  className="chat-chip-remove"
                  aria-label={`Remove ${item.fileName}`}
                  onClick={() =>
                    setStaged((s) => s.filter((x) => x.localId !== item.localId))
                  }
                >
                  <X size={11} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="chat-input selectable"
          rows={1}
          placeholder={privateMode ? "Message Juno privately…" : "Message Juno…"}
          aria-label="Message Juno"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <div className="chat-controls">
          {!privateMode ? (
            <div className="chat-pop-wrap">
              <button
                type="button"
                className="chat-control-toggle chat-add-btn"
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                aria-label="Add attachments, canvas, research, projects and connectors"
                title="Add"
                data-active={addActiveCount > 0 || undefined}
                disabled={busy}
                onClick={() => {
                  const next = !addOpen;
                  setAddOpen(next);
                  if (next && connectors === null && !connectorsLoading) void loadConnectors();
                }}
              >
                <Plus size={17} aria-hidden />
                {addActiveCount > 0 ? (
                  <span className="chat-control-count">{addActiveCount}</span>
                ) : null}
              </button>
              <ChatPopover open={addOpen} onClose={() => setAddOpen(false)} label="Add" width={300}>
                <div className="chat-addmenu">
                  <button
                    type="button"
                    className="chat-menu-item chat-menu-row"
                    disabled={staged.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      setAddOpen(false);
                      void pickImages();
                    }}
                  >
                    <ImagePlus size={16} aria-hidden />
                    <span className="chat-menu-row-name">Add photos</span>
                  </button>
                  <button
                    type="button"
                    className="chat-menu-item chat-menu-row"
                    disabled={staged.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      setAddOpen(false);
                      void pickFiles();
                    }}
                  >
                    <Paperclip size={16} aria-hidden />
                    <span className="chat-menu-row-name">Add files</span>
                  </button>
                  <button
                    type="button"
                    className="chat-menu-item chat-menu-row"
                    disabled={staged.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      setAddOpen(false);
                      setLibraryOpen(true);
                    }}
                  >
                    <Library size={16} aria-hidden />
                    <span className="chat-menu-row-name">From your library</span>
                  </button>

                  <div className="chat-menu-sep" role="separator" />

                  <button
                    type="button"
                    aria-pressed={canvasOn}
                    className="chat-menu-item chat-menu-row"
                    data-selected={canvasOn || undefined}
                    onClick={() => prefs.setCanvas(!canvasOn)}
                  >
                    <PencilRuler size={16} aria-hidden />
                    <span className="chat-menu-row-name">Canvas &amp; artifacts</span>
                    {canvasOn ? <Check size={15} className="chat-menu-check" aria-hidden /> : null}
                  </button>
                  <button
                    type="button"
                    aria-pressed={deepResearch}
                    className="chat-menu-item chat-menu-row"
                    data-selected={deepResearch || undefined}
                    onClick={() => prefs.setDeepResearch(threadKey, !deepResearch)}
                  >
                    <Telescope size={16} aria-hidden />
                    <span className="chat-menu-row-name">Deep research</span>
                    {deepResearch ? <Check size={15} className="chat-menu-check" aria-hidden /> : null}
                  </button>

                  {isNewChat && projectList.length > 0 ? (
                    <>
                      <div className="chat-menu-sep" role="separator" />
                      <div className="chat-popover-title" id="add-project-label">
                        Add to project
                      </div>
                      <div className="chat-addmenu-scroll" role="group" aria-labelledby="add-project-label">
                        {projectList.map((p) => {
                          const active = pendingProject === p.id;
                          return (
                            <button
                              key={p.id}
                              type="button"
                              aria-pressed={active}
                              className="chat-menu-item chat-menu-row"
                              data-selected={active || undefined}
                              onClick={() => chooseProject(active ? null : p.id)}
                            >
                              <Folder size={16} aria-hidden />
                              <span className="chat-menu-row-name">{p.name}</span>
                              {active ? <Check size={15} className="chat-menu-check" aria-hidden /> : null}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : null}

                  <div className="chat-menu-sep" role="separator" />
                  <div className="chat-popover-title">Use connectors</div>
                  {connectorsLoading ? (
                    <div className="chat-popover-empty">
                      <Loader2 size={14} className="chat-spin" aria-hidden /> Loading…
                    </div>
                  ) : connectorsError ? (
                    <div className="chat-popover-empty">
                      <span>{connectorsError}</span>
                      <button type="button" className="btn btn-secondary" onClick={() => void loadConnectors()}>
                        Retry
                      </button>
                    </div>
                  ) : connectors && connectors.length === 0 ? (
                    <div className="chat-popover-empty">
                      No connectors yet. Connect apps from the Connections page.
                    </div>
                  ) : (
                    <div className="chat-addmenu-scroll">
                      {connectors?.map((connector) => {
                        const checked = selectedConnectors.includes(connector.id);
                        const capped = !checked && selectedConnectors.length >= 5;
                        return (
                          <label
                            key={connector.id}
                            className="chat-connector-row"
                            data-disabled={capped || undefined}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={capped}
                              onChange={() => toggleConnector(connector.id)}
                            />
                            <span className="chat-connector-label">{connector.label}</span>
                            {connector.accountLabel ? (
                              <span className="chat-connector-account">{connector.accountLabel}</span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {connectors && connectors.length > 0 ? (
                    <div className="chat-connectors-hint">Up to 5 per conversation</div>
                  ) : null}
                </div>
              </ChatPopover>
            </div>
          ) : null}

          <ModelSelector
            models={models}
            selectedId={modelId}
            plan={plan}
            favorites={settings?.favoriteModels ?? []}
            disabled={busy}
            onSelect={(id) => prefs.setModel(threadKey, id)}
            onToggleFavorite={toggleFavorite}
          />

          {model && efforts.length > 0 ? (
            <div className="chat-pop-wrap">
              <button
                type="button"
                className="chat-control-pill"
                aria-haspopup="dialog"
                aria-expanded={effortOpen}
                aria-label={`Thinking effort: ${effortDisplay}`}
                disabled={busy}
                onClick={() => setEffortOpen((v) => !v)}
              >
                <Brain size={13} aria-hidden />
                <span>{effortDisplay}</span>
              </button>
              <ChatPopover
                open={effortOpen}
                onClose={() => setEffortOpen(false)}
                label="Thinking effort"
                width={272}
              >
                <div className="chat-thinking-pop">
                  <ReasoningSlider
                    options={efforts}
                    value={selectedEffort}
                    onChange={(v) => prefs.setEffort(model.id, v)}
                  />
                </div>
              </ChatPopover>
            </div>
          ) : null}

          {model?.capabilities.webSearch ? (
            <button
              type="button"
              className="chat-control-toggle"
              aria-pressed={prefs.webSearch}
              aria-label="Web search"
              title="Web search"
              data-active={prefs.webSearch || undefined}
              disabled={busy || privateMode}
              onClick={() => prefs.setWebSearch(!prefs.webSearch)}
            >
              <Globe size={15} aria-hidden />
            </button>
          ) : null}

          <button
            type="button"
            className="chat-control-toggle"
            aria-pressed={privateMode}
            aria-label={privateMode ? "Leave private mode" : "Private mode"}
            title={privateMode ? "Leave private mode" : "Private mode"}
            data-active={privateMode || undefined}
            disabled={busy}
            onClick={togglePrivate}
          >
            {privateMode ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden />}
          </button>

          <div className="chat-controls-spacer" />

          {!privateMode ? (
            <button
              type="button"
              className="chat-control-toggle"
              aria-label="Start voice conversation"
              title={
                voicePhase !== "idle"
                  ? "A voice session is already running"
                  : "Start voice conversation"
              }
              disabled={busy || voicePhase !== "idle"}
              onClick={() => void startVoice(conversationId)}
            >
              <Mic size={15} aria-hidden />
            </button>
          ) : null}

          {busy ? (
            <button
              type="button"
              className="chat-send-btn chat-stop-btn"
              aria-label="Stop generating"
              disabled={status === "stopping"}
              onClick={() => void stopGeneration(threadKey)}
            >
              <Square size={13} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="chat-send-btn"
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void send(draft)}
            >
              <ArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>

      <p className="chat-disclaimer">
        {privateMode
          ? "Private chats aren't saved or added to memory."
          : "Juno can be wrong — worth a second look on anything that matters."}
      </p>

      <LibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onAttach={attachFromLibrary}
        remaining={MAX_ATTACHMENTS - staged.length}
      />
    </div>
  );
}
