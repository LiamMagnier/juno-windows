/**
 * Message transcript: user bubbles right-aligned, assistant messages
 * full-width markdown with reasoning disclosure, activity timeline, sources,
 * attachments, error states, version pager, and a hover toolbar. Owns the
 * scroll container so it can stick to the bottom while streaming.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  FileText,
  Gauge,
  Globe,
  Lightbulb,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "@/lib/backend/http";
import type {
  ActivityEvent,
  ActivityKind,
  ClientAttachment,
  ClientMessage,
  ClientSource,
} from "@/lib/data/entities";
import { editAndResend, sendFeedback } from "@/lib/chat/chatEngine";
import { useThreadStore, type GenerationStatus } from "@/state/threadStore";
import { Markdown } from "@/components/Markdown";
import { useContextMenu, type MenuItem } from "@/components/ContextMenu";
import { ThinkingDots } from "@/components/signature/ThinkingDots";
import { domainOf, formatBytes } from "./helpers";
import { fileUrl } from "./fileUrl";

const ACTIVITY_ICONS: Record<ActivityKind, typeof Wrench> = {
  context: BookOpen,
  model: Cpu,
  reasoning: Lightbulb,
  search: Search,
  visit: Globe,
  write: Pencil,
  usage: Gauge,
  done: Check,
  warning: AlertTriangle,
  tool: Wrench,
};

interface FullMessageVersion {
  id: string;
  content: string;
  reasoning?: string | null;
  model: string | null;
  createdAt: string;
}

export function MessageList({
  threadKey,
  conversationId,
  privateMode,
  status,
  messages,
  modelId,
  onRegenerate,
  onContinue,
}: {
  threadKey: string;
  conversationId: string | null;
  privateMode: boolean;
  status: GenerationStatus;
  messages: ClientMessage[];
  modelId: string | null;
  onRegenerate(): void;
  onContinue(): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const busy = status !== "idle";

  const lastMessage = messages[messages.length - 1];
  const lastContentLength =
    (lastMessage?.content.length ?? 0) + (lastMessage?.reasoning?.length ?? 0);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  // Stick to bottom while content grows, unless the user scrolled up.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages.length, lastContentLength, scrollToBottom]);

  // Jump to bottom when switching threads.
  useEffect(() => {
    scrollToBottom();
  }, [threadKey, scrollToBottom]);

  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "ASSISTANT") return i;
    }
    return -1;
  }, [messages]);

  return (
    <div className="chat-scroll-wrap">
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        tabIndex={0}
      >
        <div className="chat-column">
          {messages.map((message, index) => (
            <MessageItem
              key={message.id}
              message={message}
              threadKey={threadKey}
              conversationId={conversationId}
              privateMode={privateMode}
              modelId={modelId}
              isLast={index === messages.length - 1}
              isLastAssistant={index === lastAssistantIndex}
              streaming={busy && index === messages.length - 1 && message.role === "ASSISTANT"}
              status={status}
              busy={busy}
              onRegenerate={onRegenerate}
              onContinue={onContinue}
            />
          ))}
        </div>
      </div>
      {!pinned ? (
        <button
          type="button"
          className="chat-jump-pill"
          onClick={() => scrollToBottom("smooth")}
        >
          <ArrowDown size={13} aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- message

function MessageItem({
  message,
  threadKey,
  conversationId,
  privateMode,
  modelId,
  isLast,
  isLastAssistant,
  streaming,
  status,
  busy,
  onRegenerate,
  onContinue,
}: {
  message: ClientMessage;
  threadKey: string;
  conversationId: string | null;
  privateMode: boolean;
  modelId: string | null;
  isLast: boolean;
  isLastAssistant: boolean;
  streaming: boolean;
  status: GenerationStatus;
  busy: boolean;
  onRegenerate(): void;
  onContinue(): void;
}) {
  const { open: openMenu } = useContextMenu();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** Huge user pastes stay collapsed in the DOM until expanded. */
  const [userExpanded, setUserExpanded] = useState(false);

  // ---- version pager ----
  const versionCount = message.versions?.length ?? 0;
  const pages = versionCount + 1;
  const [viewPage, setViewPage] = useState<number | null>(null); // null = live (last page)
  const [fullVersions, setFullVersions] = useState<FullMessageVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  useEffect(() => {
    // A regenerate grows versions in place: snap back to the live page.
    setViewPage(null);
    setFullVersions(null);
  }, [versionCount]);

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const res = await api<{ versions: FullMessageVersion[] }>(
        `/messages/${encodeURIComponent(message.id)}/versions`,
      );
      setFullVersions(res.versions);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Couldn't load versions.");
    } finally {
      setVersionsLoading(false);
    }
  }, [message.id]);

  const goToPage = (page: number) => {
    const clamped = Math.max(0, Math.min(pages - 1, page));
    if (clamped === pages - 1) {
      setViewPage(null);
      return;
    }
    setViewPage(clamped);
    if (!fullVersions && !versionsLoading) void loadVersions();
  };

  const viewingOld = viewPage !== null && viewPage < pages - 1;
  const displayedContent = viewingOld
    ? (fullVersions?.[viewPage]?.content ?? null)
    : message.content;

  // ---- actions ----
  const copy = () => {
    // Copy what's on screen: the paged-back version when one is displayed.
    if (displayedContent === null) return;
    void navigator.clipboard.writeText(displayedContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const copyDisabled = viewingOld && displayedContent === null;

  const setFeedback = (value: "UP" | "DOWN") => {
    const next = message.feedback === value ? null : value;
    useThreadStore.getState().updateMessages(threadKey, (list) =>
      list.map((m) => (m.id === message.id ? { ...m, feedback: next } : m)),
    );
    sendFeedback(message.id, next);
  };

  const startEdit = () => {
    setEditText(message.content);
    setEditError(null);
    setEditing(true);
  };

  const submitEdit = async () => {
    if (!conversationId || !modelId || !editText.trim()) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await editAndResend(conversationId, message.id, editText.trim(), modelId);
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Couldn't save the edit.");
    } finally {
      setEditBusy(false);
    }
  };

  const isUser = message.role === "USER";
  const isAssistant = message.role === "ASSISTANT";
  const canEdit = isUser && !privateMode && conversationId !== null && !busy;
  const canRegenerate =
    isAssistant && isLastAssistant && isLast && !privateMode && conversationId !== null && !busy;
  const canFeedback = isAssistant && !privateMode && conversationId !== null && !streaming;
  const canContinue =
    isAssistant &&
    isLast &&
    !busy &&
    !privateMode &&
    conversationId !== null &&
    (message.finishReason === "length" || message.finishReason === "network_error");

  const contextItems = (): MenuItem[] => {
    const items: MenuItem[] = [
      {
        id: "copy",
        label: "Copy",
        icon: <Copy size={14} aria-hidden />,
        disabled: copyDisabled,
        onSelect: copy,
      },
    ];
    if (canEdit) {
      items.push({
        id: "edit",
        label: "Edit",
        icon: <Pencil size={14} aria-hidden />,
        onSelect: startEdit,
      });
    }
    if (canRegenerate) {
      items.push({
        id: "regenerate",
        label: "Regenerate",
        icon: <RefreshCw size={14} aria-hidden />,
        onSelect: onRegenerate,
      });
    }
    return items;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(contextItems(), e.clientX, e.clientY);
  };

  // ---- render ----
  if (isUser) {
    return (
      <div className="chat-msg chat-msg-user" onContextMenu={onContextMenu}>
        {message.attachments.length > 0 ? (
          <AttachmentRow attachments={message.attachments} align="end" />
        ) : null}
        {editing ? (
          <div className="chat-edit">
            <textarea
              className="chat-edit-input selectable"
              value={editText}
              rows={Math.min(10, Math.max(2, editText.split("\n").length))}
              aria-label="Edit message"
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                // Never treat an IME conversion commit as a submit.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              autoFocus
            />
            {editError ? <div className="chat-inline-error">{editError}</div> : null}
            <div className="chat-edit-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditing(false)}
                disabled={editBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submitEdit()}
                disabled={editBusy || !editText.trim()}
              >
                Save and submit
              </button>
            </div>
          </div>
        ) : (
          <div className="chat-user-bubble selectable">
            {viewingOld ? (
              displayedContent === null ? (
                <VersionLoading loading={versionsLoading} error={versionsError} retry={loadVersions} />
              ) : (
                (() => {
                  const body = displayedContent;
                  if (body.length > 12_000 && !userExpanded) {
                    return (
                      <>
                        {body.slice(0, 12_000)}
                        {"\n\n"}… ({body.length.toLocaleString()} characters —{" "}
                        <button type="button" className="chat-inline-link" onClick={() => setUserExpanded(true)}>
                          expand
                        </button>
                        )
                      </>
                    );
                  }
                  return body;
                })()
              )
            ) : message.content.length > 12_000 && !userExpanded ? (
              <>
                {message.content.slice(0, 12_000)}
                {"\n\n"}… ({message.content.length.toLocaleString()} characters —{" "}
                <button type="button" className="chat-inline-link" onClick={() => setUserExpanded(true)}>
                  expand
                </button>
                )
              </>
            ) : (
              message.content
            )}
          </div>
        )}
        <div className="chat-msg-footer">
          {pages > 1 ? (
            <VersionPager page={viewPage ?? pages - 1} pages={pages} onPage={goToPage} />
          ) : null}
          <div className="chat-msg-actions">
            <ToolbarButton
              label={copied ? "Copied" : "Copy"}
              onClick={copy}
              disabled={copyDisabled}
              icon={copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            />
            {canEdit && !editing ? (
              <ToolbarButton
                label="Edit"
                onClick={startEdit}
                icon={<Pencil size={13} aria-hidden />}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // Assistant / system
  const hasError = Boolean(message.errorMessage);
  const showErrorCard = hasError && !streaming;
  const abnormalFinish =
    message.finishReason &&
    message.finishReason !== "stop" &&
    message.finishReason !== "unknown";

  return (
    <div className="chat-msg chat-msg-assistant" onContextMenu={onContextMenu}>
      {message.reasoning || (message.reasoningParts?.length ?? 0) > 0 ? (
        <ReasoningDisclosure message={message} streaming={streaming} />
      ) : null}

      {(message.activity?.length ?? 0) > 0 ? (
        <ActivityTimeline events={message.activity!} />
      ) : null}

      {streaming && !message.content && !message.reasoning ? (
        <div className="chat-stream-status" role="status">
          <ThinkingDots
            label={status === "writing" ? "Writing" : status === "thinking" ? "Thinking" : "Checking"}
          />
          <span className="chat-stream-label eyebrow">
            {status === "writing" ? "Writing" : status === "thinking" ? "Thinking" : "Checking"}
          </span>
        </div>
      ) : null}

      {viewingOld ? (
        displayedContent === null ? (
          <VersionLoading loading={versionsLoading} error={versionsError} retry={loadVersions} />
        ) : (
          <div className="chat-old-version">
            <Markdown text={displayedContent} />
          </div>
        )
      ) : message.content ? (
        <div className="chat-assistant-body">
          <Markdown text={message.content} />
          {streaming ? <span className="chat-caret" aria-hidden /> : null}
        </div>
      ) : null}

      {message.attachments.length > 0 ? (
        <AttachmentRow attachments={message.attachments} align="start" />
      ) : null}

      {(message.sources?.length ?? 0) > 0 ? <SourceChips sources={message.sources!} /> : null}

      {showErrorCard ? (
        <div className="chat-error-card" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <div className="chat-error-body">
            <span>{message.errorMessage}</span>
            {message.finishReason ? (
              <span className="chat-finish-badge">{finishLabel(message.finishReason)}</span>
            ) : null}
          </div>
          {canContinue ? (
            <button type="button" className="btn btn-secondary" onClick={onContinue}>
              Continue
            </button>
          ) : null}
          {canRegenerate ? (
            <button type="button" className="btn btn-secondary" onClick={onRegenerate}>
              Retry
            </button>
          ) : null}
        </div>
      ) : abnormalFinish && !streaming ? (
        <div className="chat-finish-note">
          <span className="chat-finish-badge">{finishLabel(message.finishReason!)}</span>
          {canContinue ? (
            <button type="button" className="btn btn-secondary" onClick={onContinue}>
              Continue
            </button>
          ) : null}
        </div>
      ) : null}

      {!streaming ? (
        <div className="chat-msg-footer">
          {pages > 1 ? (
            <VersionPager page={viewPage ?? pages - 1} pages={pages} onPage={goToPage} />
          ) : null}
          <div className="chat-msg-actions">
            <ToolbarButton
              label={copied ? "Copied" : "Copy"}
              onClick={copy}
              disabled={copyDisabled}
              icon={copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            />
            {canFeedback ? (
              <>
                <ToolbarButton
                  label="Good response"
                  pressed={message.feedback === "UP"}
                  onClick={() => setFeedback("UP")}
                  icon={
                    <ThumbsUp
                      size={13}
                      fill={message.feedback === "UP" ? "currentColor" : "none"}
                      aria-hidden
                    />
                  }
                />
                <ToolbarButton
                  label="Bad response"
                  pressed={message.feedback === "DOWN"}
                  onClick={() => setFeedback("DOWN")}
                  icon={
                    <ThumbsDown
                      size={13}
                      fill={message.feedback === "DOWN" ? "currentColor" : "none"}
                      aria-hidden
                    />
                  }
                />
              </>
            ) : null}
            {canRegenerate ? (
              <ToolbarButton
                label="Regenerate"
                onClick={onRegenerate}
                icon={<RefreshCw size={13} aria-hidden />}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function ToolbarButton({
  label,
  icon,
  onClick,
  pressed,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick(): void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="chat-toolbar-btn"
      aria-label={label}
      title={label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      data-active={pressed || undefined}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function VersionPager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage(page: number): void;
}) {
  return (
    <div className="chat-version-pager" role="group" aria-label="Message versions">
      <button
        type="button"
        className="chat-toolbar-btn"
        aria-label="Previous version"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={13} aria-hidden />
      </button>
      <span className="chat-version-count">
        {page + 1}/{pages}
      </span>
      <button
        type="button"
        className="chat-toolbar-btn"
        aria-label="Next version"
        disabled={page === pages - 1}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={13} aria-hidden />
      </button>
    </div>
  );
}

function VersionLoading({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry(): void;
}) {
  if (loading) {
    return (
      <div className="chat-stream-status">
        <Loader2 size={13} className="chat-spin" aria-hidden />
        Loading version…
      </div>
    );
  }
  return (
    <div className="chat-inline-error">
      {error ?? "Couldn't load this version."}{" "}
      <button type="button" className="chat-link-btn" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

function ReasoningDisclosure({
  message,
  streaming,
}: {
  message: ClientMessage;
  streaming: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const autoOpen = streaming && !message.content;
  const open = override ?? autoOpen;
  const parts =
    message.reasoningParts && message.reasoningParts.length > 0
      ? message.reasoningParts
      : message.reasoning
        ? [message.reasoning]
        : [];

  return (
    <div className="chat-reasoning" data-open={open || undefined}>
      <button
        type="button"
        className="chat-reasoning-header"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <Lightbulb size={13} aria-hidden />
        <span data-shimmer={streaming && !message.content ? true : undefined}>
          {streaming && !message.content ? "Thinking…" : "Thought for a moment"}
        </span>
        <ChevronDown size={13} className="chat-disclosure-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="chat-reasoning-body selectable">
          {parts.map((part, i) => (
            <p key={i}>{part}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-activity" data-open={open || undefined}>
      <button
        type="button"
        className="chat-reasoning-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench size={13} aria-hidden />
        <span>
          Activity ({events.length})
        </span>
        <ChevronDown size={13} className="chat-disclosure-chevron" aria-hidden />
      </button>
      {open ? (
        <ul className="chat-activity-list">
          {events.map((event) => {
            const Icon = ACTIVITY_ICONS[event.kind] ?? Wrench;
            return (
              <li key={event.id} className="chat-activity-row">
                <span className="chat-activity-icon">
                  <Icon size={12} aria-hidden />
                </span>
                <span className="chat-activity-title">{event.title}</span>
                {event.detail ? (
                  <span className="chat-activity-detail" title={event.detail}>
                    {event.detail}
                  </span>
                ) : null}
                {event.url ? (
                  <button
                    type="button"
                    className="chat-source-chip"
                    title={event.url}
                    onClick={() => void openUrl(event.url!)}
                  >
                    {domainOf(event.url)}
                  </button>
                ) : null}
                <span className="chat-activity-time">
                  {new Date(event.createdAt).toLocaleTimeString(undefined, { hour12: false })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function SourceChips({ sources }: { sources: ClientSource[] }) {
  return (
    <div className="chat-sources">
      <span className="chat-sources-eyebrow">
        <Globe size={12} aria-hidden />
        {sources.length} {sources.length === 1 ? "source" : "sources"}
      </span>
      <div className="chat-source-row">
        {sources.map((source, index) => (
          <button
            key={`${source.url}-${index}`}
            type="button"
            className="chat-source-chip"
            title={`${source.title} — ${source.url}`}
            onClick={() => void openUrl(source.url)}
          >
            <span className="chat-source-index">{index + 1}</span>
            {domainOf(source.url)}
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachmentRow({
  attachments,
  align,
}: {
  attachments: ClientAttachment[];
  align: "start" | "end";
}) {
  return (
    <div className="chat-msg-attachments" data-align={align}>
      {attachments.map((attachment) =>
        attachment.kind === "IMAGE" ? (
          <img
            key={attachment.id}
            className="chat-msg-image"
            src={fileUrl(attachment.url)}
            alt={attachment.fileName}
          />
        ) : (
          <button
            key={attachment.id}
            type="button"
            className="chat-file-card"
            title={attachment.fileName}
            onClick={() => void openUrl(fileUrl(attachment.url))}
          >
            <FileText size={15} aria-hidden />
            <span className="chat-file-name">{attachment.fileName}</span>
            <span className="chat-file-size">{formatBytes(attachment.size)}</span>
          </button>
        ),
      )}
    </div>
  );
}

function finishLabel(reason: string): string {
  switch (reason) {
    case "length":
      return "Reached length limit";
    case "network_error":
      return "Network error";
    case "model_context_window_exceeded":
      return "Context window exceeded";
    case "sensitive":
      return "Flagged as sensitive";
    case "user_stopped":
      return "Stopped";
    case "error":
      return "Error";
    default:
      return reason;
  }
}
