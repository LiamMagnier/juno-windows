/**
 * Working cockpit for an active session: context bar (workspace · branch ·
 * mode · status), the activity timeline, the pinned composer with the
 * send ⇄ stop morph, the approval sheet, and the collapsible right inspector
 * (auto-opens once per session on the first files_changed).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  FolderOpen,
  GitBranch,
  PanelRight,
  Square,
} from "lucide-react";
import { gitHost, type GitStatus } from "@/lib/code/host";
import { useCodeStore, type CodeSessionMeta } from "@/state/codeStore";
import { useDataStore } from "@/state/dataStore";
import { ApprovalSheet } from "./ApprovalSheet";
import { CodeTimeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { useCodeViewStore } from "./codeViewStore";
import { agentModels, findModelEntry, splitModelId } from "./helpers";
import { CodeModelPicker, ModePicker } from "./pickers";

export function SessionCockpit({ meta }: { meta: CodeSessionMeta }) {
  const timeline = useCodeStore((s) => s.timelines[meta.id]) ?? EMPTY_TIMELINE;
  const running = useCodeStore((s) => s.running[meta.id] === true);
  const pendingApproval = useCodeStore((s) => s.pendingApproval);
  const workspaces = useCodeStore((s) => s.workspaces);
  const manifest = useDataStore((s) => s.manifest);
  const plan = useDataStore((s) => s.subscription?.plan ?? "free");

  const inspectorOpen = useCodeViewStore((s) => s.inspectorOpen);
  const setInspectorOpen = useCodeViewStore((s) => s.setInspectorOpen);
  const setInspectorTab = useCodeViewStore((s) => s.setInspectorTab);
  const autoOpened = useCodeViewStore((s) => s.autoOpened[meta.id] === true);
  const markAutoOpened = useCodeViewStore((s) => s.markAutoOpened);

  const [text, setText] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);

  const workspaceGranted = workspaces.some((w) => w.id === meta.workspaceId);
  const models = useMemo(() => agentModels(manifest), [manifest]);
  const modelEntry = useMemo(
    () => findModelEntry(models, meta.providerId, meta.model),
    [models, meta.providerId, meta.model],
  );

  // Branch: read on mount and again whenever a turn finishes (running -> false).
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    gitHost
      .status(meta.workspaceId)
      .then((status: GitStatus) => {
        if (!cancelled) setBranch(status.isRepo ? status.branch : null);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.workspaceId, running]);

  // Auto-open the inspector on the first changed files of this session.
  const hasChanges = useMemo(() => timeline.some((i) => i.kind === "files"), [timeline]);
  useEffect(() => {
    if (hasChanges && !autoOpened) {
      markAutoOpened(meta.id);
      setInspectorTab("changes");
      setInspectorOpen(true);
    }
  }, [hasChanges, autoOpened, meta.id, markAutoOpened, setInspectorOpen, setInspectorTab]);

  const send = () => {
    const prompt = text.trim();
    if (!prompt || running || !workspaceGranted) return;
    setText("");
    void useCodeStore.getState().prompt(meta.id, prompt);
  };

  const undoTurn = () => {
    if (undoBusy) return;
    setUndoBusy(true);
    void useCodeStore
      .getState()
      .undoLastTurn(meta.id)
      .finally(() => setUndoBusy(false));
  };

  return (
    <div className="code-cockpit">
      <div className="code-main-pane">
        <header className="code-context-bar">
          <span className="code-context-item" title={meta.workspacePath}>
            <FolderOpen size={14} aria-hidden />
            {meta.workspaceName}
          </span>
          {branch ? (
            <span className="code-context-item">
              <GitBranch size={14} aria-hidden />
              <span className="code-mono-inline">{branch}</span>
            </span>
          ) : null}
          <ModePicker
            value={meta.mode}
            side="down"
            onChange={(mode) => useCodeStore.getState().setSessionMode(meta.id, mode)}
          />
          <span className="code-context-spacer" />
          {running ? (
            <span className="code-working code-context-working" role="status">
              <span className="code-working-dot" aria-hidden />
              Working…
            </span>
          ) : null}
          <button
            type="button"
            className="code-icon-btn"
            aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <PanelRight size={16} aria-hidden />
          </button>
        </header>

        {!workspaceGranted ? (
          <div className="code-revoked-note" role="alert">
            Access to this folder was revoked — open it again to continue the session.
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void useCodeStore.getState().pickWorkspace()}
            >
              Open folder…
            </button>
          </div>
        ) : null}

        <CodeTimeline
          items={timeline}
          running={running}
          undoBusy={undoBusy || running}
          onUndoTurn={undoTurn}
        />

        <div className="code-composer-dock">
          <div className="code-composer">
            <textarea
              className="code-composer-input"
              rows={2}
              placeholder="Describe the next step…"
              aria-label="Message the agent"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="code-composer-controls">
              <ModePicker
                value={meta.mode}
                side="up"
                onChange={(mode) => useCodeStore.getState().setSessionMode(meta.id, mode)}
              />
              <CodeModelPicker
                models={models}
                selectedId={modelEntry?.id ?? null}
                plan={plan}
                side="up"
                disabled={models.length === 0}
                onSelect={(id) => {
                  const entry = models.find((m) => m.id === id);
                  if (!entry) return;
                  const { providerId, model } = splitModelId(entry);
                  useCodeStore.getState().setSessionModel(meta.id, providerId, model);
                }}
              />
              <span className="code-composer-spacer" />
              {running ? (
                <button
                  type="button"
                  className="code-send-btn code-stop-btn"
                  aria-label="Stop"
                  onClick={() => void useCodeStore.getState().stop(meta.id)}
                >
                  <Square size={14} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  className="code-send-btn"
                  aria-label="Send"
                  disabled={text.trim().length === 0 || !workspaceGranted}
                  onClick={send}
                >
                  <ArrowUp size={16} aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {inspectorOpen ? (
        <Inspector
          meta={meta}
          timeline={timeline}
          running={running}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}

      {pendingApproval && pendingApproval.sessionId === meta.id ? (
        <ApprovalSheet
          request={pendingApproval}
          onResolve={(decision) => useCodeStore.getState().resolveApproval(decision)}
        />
      ) : null}
    </div>
  );
}

const EMPTY_TIMELINE: never[] = [];
