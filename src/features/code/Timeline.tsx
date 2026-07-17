/**
 * Session activity timeline: renders the CodeTimelineItem union — user
 * prompts, streaming assistant markdown, collapsed thinking, tool rows with
 * expandable (live) output, changed-file chips with undo, errors and status
 * lines. Sticks to the bottom while running unless the reader scrolled up.
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  FileDiff,
  Folder,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  TriangleAlert,
  Undo2,
  Wrench,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { CodeTimelineItem } from "@/state/codeStore";
import { formatDuration } from "./helpers";

const STICK_THRESHOLD_PX = 140;

function toolIcon(name: string) {
  switch (name) {
    case "read_file":
      return <Eye size={16} aria-hidden />;
    case "list_files":
      return <Folder size={16} aria-hidden />;
    case "search_files":
      return <Search size={16} aria-hidden />;
    case "edit_file":
    case "write_file":
      return <Pencil size={16} aria-hidden />;
    case "run_command":
      return <Terminal size={16} aria-hidden />;
    default:
      return <Wrench size={16} aria-hidden />;
  }
}

export function CodeTimeline({
  items,
  running,
  undoBusy,
  onUndoTurn,
}: {
  items: CodeTimelineItem[];
  running: boolean;
  undoBusy: boolean;
  onUndoTurn(): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // undoLastTurn only restores the most recent turn, so only the newest
  // files row offers the button.
  const lastFilesId = [...items].reverse().find((i) => i.kind === "files")?.id ?? null;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, running]);

  return (
    <div className="code-timeline-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="code-timeline-column">
        {items.length === 0 ? (
          <p className="code-timeline-empty">
            No activity yet — describe what to build, fix, refactor or explain.
          </p>
        ) : null}
        {items.map((item) => (
          <TimelineRow
            key={item.id}
            item={item}
            undoBusy={undoBusy}
            undoable={item.id === lastFilesId}
            onUndoTurn={onUndoTurn}
          />
        ))}
        {running ? (
          <div className="code-working" role="status">
            <span className="code-working-dot" aria-hidden />
            Working…
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TimelineRow({
  item,
  undoBusy,
  undoable,
  onUndoTurn,
}: {
  item: CodeTimelineItem;
  undoBusy: boolean;
  undoable: boolean;
  onUndoTurn(): void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="code-row-user">
          <div className="code-user-bubble selectable">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="code-row-assistant">
          <Markdown text={item.text} />
          {item.streaming ? <span className="code-caret" aria-hidden /> : null}
        </div>
      );
    case "thinking":
      return <ThinkingRow text={item.text} streaming={item.streaming} />;
    case "tool":
      return <ToolRow item={item} />;
    case "files":
      return (
        <div className="code-row-files">
          <div className="code-files-head">
            <FileDiff size={16} aria-hidden />
            <span>
              {item.paths.length} file{item.paths.length === 1 ? "" : "s"} changed
            </span>
            {undoable ? (
              <button
                type="button"
                className="code-undo-btn"
                disabled={undoBusy}
                onClick={onUndoTurn}
              >
                <Undo2 size={14} aria-hidden />
                Undo this turn
              </button>
            ) : null}
          </div>
          <div className="code-files-chips">
            {item.paths.map((path) => (
              <span key={path} className="code-file-chip code-mono-inline" title={path}>
                {path}
              </span>
            ))}
          </div>
        </div>
      );
    case "error":
      return (
        <div className="code-row-error" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <span className="selectable">{item.message}</span>
        </div>
      );
    case "status":
      return <div className="code-row-status">{item.text}</div>;
  }
}

function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="code-thinking" data-open={open || undefined}>
      <button
        type="button"
        className="code-thinking-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {streaming ? <LoaderCircle size={14} className="code-spin" aria-hidden /> : null}
        <span data-shimmer={streaming || undefined}>Thinking…</span>
        <ChevronDown size={14} className="code-disclosure-chevron" aria-hidden />
      </button>
      {open ? <div className="code-thinking-body selectable">{text}</div> : null}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<CodeTimelineItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const liveRun = item.name === "run_command" && item.state === "running";
  const showOutput = (expanded || liveRun) && item.output.length > 0;

  // Live command output tails its own scrollback, not the page.
  useEffect(() => {
    const el = outputRef.current;
    if (liveRun && el) el.scrollTop = el.scrollHeight;
  }, [item.output, liveRun]);

  return (
    <div className="code-tool" data-state={item.state}>
      <button
        type="button"
        className="code-tool-head"
        aria-expanded={showOutput}
        onClick={() => setExpanded((e) => !e)}
      >
        {item.state === "running" ? (
          <LoaderCircle size={16} className="code-spin" aria-hidden />
        ) : (
          toolIcon(item.name)
        )}
        <span className="code-tool-summary">{item.summary}</span>
        {item.state === "denied" ? <span className="code-tool-note">Denied</span> : null}
        {item.state === "error" ? <span className="code-tool-note">Failed</span> : null}
        {item.durationMs !== undefined ? (
          <span className="code-tool-time">{formatDuration(item.durationMs)}</span>
        ) : null}
        <ChevronDown size={14} className="code-disclosure-chevron" data-open={showOutput || undefined} aria-hidden />
      </button>
      {showOutput ? (
        <pre ref={outputRef} className="code-tool-output code-mono selectable">
          {item.output}
        </pre>
      ) : null}
    </div>
  );
}
