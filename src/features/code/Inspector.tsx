/**
 * Right inspector for an active code session: Changes (per-turn file lists),
 * Diff (unified git diff), Terminal (session command output), Git (status,
 * commit, log) and Context (file tree + detected stack). Every panel carries
 * honest loading / empty / unavailable states — no fabricated data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileDiff,
  FileText,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import {
  fsHost,
  gitHost,
  type FsEntry,
  type GitLogEntry,
  type GitStatus,
} from "@/lib/code/host";
import { useCodeStore, type CodeSessionMeta, type CodeTimelineItem } from "@/state/codeStore";
import { useCodeViewStore, type InspectorTab } from "./codeViewStore";
import { changesByTurn, diffLineClass } from "./helpers";

const TABS: Array<{ id: InspectorTab; label: string; icon: React.ReactNode }> = [
  { id: "changes", label: "Changes", icon: <FileDiff size={16} aria-hidden /> },
  { id: "diff", label: "Diff", icon: <FileText size={16} aria-hidden /> },
  { id: "terminal", label: "Terminal", icon: <Terminal size={16} aria-hidden /> },
  { id: "git", label: "Git", icon: <GitBranch size={16} aria-hidden /> },
  { id: "context", label: "Context", icon: <FolderTree size={16} aria-hidden /> },
];

export function Inspector({
  meta,
  timeline,
  running,
  onClose,
}: {
  meta: CodeSessionMeta;
  timeline: CodeTimelineItem[];
  running: boolean;
  onClose(): void;
}) {
  const tab = useCodeViewStore((s) => s.inspectorTab);
  const setTab = useCodeViewStore((s) => s.setInspectorTab);

  return (
    <aside className="code-inspector" aria-label="Session inspector">
      <div className="code-inspector-tabs" role="tablist" aria-label="Inspector panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            title={t.label}
            className="code-inspector-tab"
            onClick={() => setTab(t.id)}
          >
            {t.icon}
          </button>
        ))}
        <span className="code-inspector-spacer" />
        <button
          type="button"
          className="code-inspector-tab"
          aria-label="Hide inspector"
          title="Hide inspector"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="code-inspector-body" role="tabpanel" aria-label={tab}>
        {tab === "changes" ? <ChangesPanel meta={meta} timeline={timeline} running={running} /> : null}
        {tab === "diff" ? <DiffPanel meta={meta} running={running} /> : null}
        {tab === "terminal" ? <TerminalPanel timeline={timeline} /> : null}
        {tab === "git" ? <GitPanel meta={meta} running={running} /> : null}
        {tab === "context" ? <ContextPanel meta={meta} /> : null}
      </div>
    </aside>
  );
}

// ---- Changes ----

function ChangesPanel({
  meta,
  timeline,
  running,
}: {
  meta: CodeSessionMeta;
  timeline: CodeTimelineItem[];
  running: boolean;
}) {
  const turns = useMemo(() => changesByTurn(timeline), [timeline]);
  const setTab = useCodeViewStore((s) => s.setInspectorTab);
  const setDiffPath = useCodeViewStore((s) => s.setDiffPath);
  const [undoBusy, setUndoBusy] = useState(false);

  if (turns.length === 0) {
    return <p className="code-panel-empty">No files changed in this session yet.</p>;
  }

  const lastTurn = turns[turns.length - 1]!;

  return (
    <div className="code-panel-stack">
      {turns.map((turn) => (
        <section key={turn.turnIndex} className="code-changes-turn">
          <header className="code-changes-turn-head">
            <span>Turn {turn.turnIndex + 1}</span>
            {turn.turnIndex === lastTurn.turnIndex ? (
              <button
                type="button"
                className="code-undo-btn"
                disabled={undoBusy || running}
                onClick={() => {
                  setUndoBusy(true);
                  void useCodeStore
                    .getState()
                    .undoLastTurn(meta.id)
                    .finally(() => setUndoBusy(false));
                }}
              >
                <Undo2 size={14} aria-hidden />
                Undo
              </button>
            ) : null}
          </header>
          {turn.paths.map((path) => (
            <button
              key={path}
              type="button"
              className="code-change-row code-mono-inline"
              title={`Show diff for ${path}`}
              onClick={() => {
                setDiffPath(path);
                setTab("diff");
              }}
            >
              {path}
            </button>
          ))}
        </section>
      ))}
      <p className="code-panel-hint">Only the most recent turn can be undone.</p>
    </div>
  );
}

// ---- Diff ----

function DiffPanel({ meta, running }: { meta: CodeSessionMeta; running: boolean }) {
  const diffPath = useCodeViewStore((s) => s.diffPath);
  const setDiffPath = useCodeViewStore((s) => s.setDiffPath);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    gitHost
      .diff(meta.workspaceId, diffPath ?? undefined)
      .then(setDiff)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [meta.workspaceId, diffPath]);

  useEffect(() => {
    if (!running) load();
  }, [load, running]);

  return (
    <div className="code-panel-stack code-panel-fill">
      <div className="code-panel-toolbar">
        <span className="code-panel-title">
          {diffPath ? (
            <>
              <span className="code-mono-inline" title={diffPath}>
                {diffPath}
              </span>
              <button
                type="button"
                className="code-inline-link"
                onClick={() => setDiffPath(null)}
              >
                Show all
              </button>
            </>
          ) : (
            "Working tree diff"
          )}
        </span>
        <button
          type="button"
          className="code-icon-btn"
          aria-label="Refresh diff"
          title="Refresh diff"
          onClick={load}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      {loading && diff === null ? <PanelLoading label="Reading diff" /> : null}
      {error ? (
        <p className="code-panel-empty">Git isn't available here — {error}</p>
      ) : null}
      {diff !== null && !error ? (
        diff.trim().length === 0 ? (
          <p className="code-panel-empty">No uncommitted changes.</p>
        ) : (
          <pre className="code-diff code-mono selectable">
            {diff.split("\n").map((line, i) => (
              <span key={i} className={diffLineClass(line)}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        )
      ) : null}
    </div>
  );
}

// ---- Terminal ----

function TerminalPanel({ timeline }: { timeline: CodeTimelineItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(
    () =>
      timeline.filter(
        (item): item is Extract<CodeTimelineItem, { kind: "tool" }> =>
          item.kind === "tool" && item.name === "run_command",
      ),
    [timeline],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs]);

  if (runs.length === 0) {
    return <p className="code-panel-empty">No commands have run in this session yet.</p>;
  }

  return (
    <div ref={scrollRef} className="code-terminal selectable">
      {runs.map((run) => (
        <div key={run.id} className="code-terminal-block" data-state={run.state}>
          <div className="code-terminal-cmd code-mono">{run.summary}</div>
          {run.output ? <pre className="code-mono">{run.output}</pre> : null}
        </div>
      ))}
    </div>
  );
}

// ---- Git ----

function GitPanel({ meta, running }: { meta: CodeSessionMeta; running: boolean }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(`Juno: ${meta.title}`);
  const [committing, setCommitting] = useState(false);
  const [commitNote, setCommitNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([gitHost.status(meta.workspaceId), gitHost.log(meta.workspaceId, 10).catch(() => [])])
      .then(([s, l]) => {
        setStatus(s);
        setLog(l);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [meta.workspaceId]);

  useEffect(() => {
    if (!running) load();
  }, [load, running]);

  if (loading && status === null) return <PanelLoading label="Reading repository" />;
  if (error) return <p className="code-panel-empty">Git isn't available here — {error}</p>;
  if (!status) return null;
  if (!status.available) {
    return <p className="code-panel-empty">Git isn't available on this machine.</p>;
  }
  if (!status.isRepo) {
    return <p className="code-panel-empty">This folder isn't a git repository.</p>;
  }

  const commit = () => {
    if (!message.trim() || committing) return;
    setCommitting(true);
    setCommitNote(null);
    gitHost
      .commit(meta.workspaceId, message.trim())
      .then((hash) => {
        setCommitNote(`Committed ${hash.slice(0, 8)}`);
        setMessage(`Juno: ${meta.title}`);
        load();
      })
      .catch((e: unknown) =>
        setCommitNote(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setCommitting(false));
  };

  return (
    <div className="code-panel-stack">
      <div className="code-panel-toolbar">
        <span className="code-panel-title">
          <GitBranch size={14} aria-hidden />
          {status.branch ?? "detached"}
          {status.ahead > 0 || status.behind > 0 ? (
            <span className="code-git-sync code-mono-inline">
              {status.ahead > 0 ? `↑${status.ahead}` : ""}
              {status.behind > 0 ? ` ↓${status.behind}` : ""}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="code-icon-btn"
          aria-label="Refresh git status"
          title="Refresh git status"
          onClick={load}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>

      {status.files.length === 0 ? (
        <p className="code-panel-empty">Working tree is clean.</p>
      ) : (
        <div className="code-git-files">
          {status.files.map((file) => (
            <div key={file.path} className="code-git-file" title={file.path}>
              <span className="code-git-flags code-mono-inline">
                {(file.staged + file.unstaged).trim() || "?"}
              </span>
              <span className="code-git-path code-mono-inline">{file.path}</span>
            </div>
          ))}
        </div>
      )}

      <div className="code-git-commit">
        <label className="code-panel-label" htmlFor="code-commit-message">
          Commit message
        </label>
        <input
          id="code-commit-message"
          className="code-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <button
          type="button"
          className="btn btn-secondary code-git-commit-btn"
          disabled={committing || !message.trim() || status.files.length === 0}
          onClick={commit}
        >
          <GitCommitHorizontal size={14} aria-hidden />
          {committing ? "Committing…" : "Commit"}
        </button>
        {commitNote ? <p className="code-panel-hint">{commitNote}</p> : null}
      </div>

      {log.length > 0 ? (
        <div className="code-git-log">
          <p className="code-panel-label">Recent commits</p>
          {log.map((entry) => (
            <div key={entry.hash} className="code-git-log-row" title={entry.subject}>
              <span className="code-mono-inline">{entry.hash.slice(0, 7)}</span>
              <span className="code-git-log-subject">{entry.subject}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- Context ----

interface StackInfo {
  id: string;
  label: string;
}

function ContextPanel({ meta }: { meta: CodeSessionMeta }) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [stack, setStack] = useState<StackInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    fsHost
      .list(meta.workspaceId, undefined, 2)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    void detectStack(meta.workspaceId).then((chips) => {
      if (!cancelled) setStack(chips);
    });
    return () => {
      cancelled = true;
    };
  }, [meta.workspaceId]);

  if (error) {
    return <p className="code-panel-empty">Couldn't read the workspace — {error}</p>;
  }
  if (entries === null) return <PanelLoading label="Reading workspace" />;

  return (
    <div className="code-panel-stack">
      {stack.length > 0 ? (
        <div className="code-stack-chips">
          {stack.map((chip) => (
            <span key={chip.id} className="code-stack-chip">
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="code-panel-empty">This folder is empty.</p>
      ) : (
        <div className="code-tree selectable">
          {sortTree(entries).map((entry) => (
            <div
              key={entry.path}
              className="code-tree-row"
              data-dir={entry.isDir || undefined}
              style={{ paddingLeft: `${8 + depthOf(entry.path) * 14}px` }}
              title={entry.path}
            >
              {entry.name}
              {entry.isDir ? "/" : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function depthOf(path: string): number {
  return path.split(/[\\/]/).filter(Boolean).length - 1;
}

function sortTree(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.path.replace(/\\/g, "/").localeCompare(b.path.replace(/\\/g, "/")),
  );
}

async function detectStack(workspaceId: string): Promise<StackInfo[]> {
  const chips: StackInfo[] = [];
  try {
    const pkg = await fsHost.read(workspaceId, "package.json");
    const parsed = JSON.parse(pkg.content) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
    chips.push({
      id: "node",
      label: typeof parsed.name === "string" ? `Node · ${parsed.name}` : "Node",
    });
    for (const script of Object.keys(parsed.scripts ?? {}).slice(0, 6)) {
      chips.push({ id: `script-${script}`, label: `npm run ${script}` });
    }
  } catch {
    // no package.json
  }
  try {
    const cargo = await fsHost.read(workspaceId, "Cargo.toml");
    const name = /name\s*=\s*"([^"]+)"/.exec(cargo.content)?.[1];
    chips.push({ id: "rust", label: name ? `Rust · ${name}` : "Rust" });
  } catch {
    // no Cargo.toml
  }
  try {
    const py = await fsHost.read(workspaceId, "pyproject.toml");
    const name = /name\s*=\s*"([^"]+)"/.exec(py.content)?.[1];
    chips.push({ id: "python", label: name ? `Python · ${name}` : "Python" });
  } catch {
    // no pyproject.toml
  }
  return chips;
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="code-panel-empty" role="status">
      <LoaderCircle size={16} className="code-spin" aria-hidden />
      {label}
    </div>
  );
}
