/**
 * The new-session state (activeSessionId === null): serif greeting and a
 * command composer card with workspace / model / permission-mode pickers.
 * Sending creates the session (provider id + model split from the manifest
 * id) and fires the first prompt.
 */
import { useMemo, useRef, useState } from "react";
import { ArrowUp, FolderOpen } from "lucide-react";
import { useCodeStore } from "@/state/codeStore";
import { useDataStore } from "@/state/dataStore";
import { agentModels, defaultAgentModelId, splitModelId } from "./helpers";
import { useCodeViewStore } from "./codeViewStore";
import { CodeModelPicker, ModePicker, WorkspacePicker } from "./pickers";

export function NewSessionView() {
  const workspaces = useCodeStore((s) => s.workspaces);
  const manifest = useDataStore((s) => s.manifest);
  const settings = useDataStore((s) => s.settings);
  const plan = useDataStore((s) => s.subscription?.plan ?? "free");

  const draftWorkspaceId = useCodeViewStore((s) => s.draftWorkspaceId);
  const draftModelId = useCodeViewStore((s) => s.draftModelId);
  const draftMode = useCodeViewStore((s) => s.draftMode);
  const setDraftWorkspaceId = useCodeViewStore((s) => s.setDraftWorkspaceId);
  const setDraftModelId = useCodeViewStore((s) => s.setDraftModelId);
  const setDraftMode = useCodeViewStore((s) => s.setDraftMode);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const models = useMemo(() => agentModels(manifest), [manifest]);
  const workspace =
    workspaces.find((w) => w.id === draftWorkspaceId) ?? workspaces[0] ?? null;
  const modelId =
    (draftModelId !== null && models.some((m) => m.id === draftModelId)
      ? draftModelId
      : null) ?? defaultAgentModelId(models, settings?.defaultModel);
  const mode = draftMode ?? workspace?.permissionMode ?? "ask";

  const canSend =
    !sending && text.trim().length > 0 && workspace !== null && modelId !== null;

  const send = async () => {
    const entry = models.find((m) => m.id === modelId);
    if (!canSend || !workspace || !entry) return;
    const prompt = text.trim();
    setSending(true);
    try {
      const { providerId, model } = splitModelId(entry);
      const store = useCodeStore.getState();
      const sessionId = await store.createSession({
        workspace,
        providerId,
        model,
        projectId: null,
      });
      if (mode !== workspace.permissionMode) store.setSessionMode(sessionId, mode);
      setText("");
      void store.prompt(sessionId, prompt);
    } finally {
      setSending(false);
    }
  };

  const openFolder = () => {
    void useCodeStore
      .getState()
      .pickWorkspace()
      .then((grant) => {
        if (grant) setDraftWorkspaceId(grant.id);
      });
  };

  return (
    <div className="code-new-session">
      <h1 className="code-greeting">What should Juno build?</h1>

      {workspaces.length === 0 ? (
        <p className="code-new-hint">
          Juno works inside folders you grant. Access stays on this device and can be revoked
          any time.
        </p>
      ) : null}
      {models.length === 0 ? (
        <p className="code-new-hint">
          No models are available yet — sign in and let the model list sync first.
        </p>
      ) : null}

      <div className="code-composer code-new-composer">
        <textarea
          ref={textareaRef}
          className="code-composer-input"
          rows={4}
          placeholder="Describe what to build, fix, refactor or explain…"
          aria-label="Describe the coding task"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="code-composer-controls">
          {workspaces.length === 0 ? (
            <button type="button" className="code-pill" onClick={openFolder}>
              <FolderOpen size={14} aria-hidden />
              <span className="code-pill-label">Open folder…</span>
            </button>
          ) : (
            <WorkspacePicker
              workspaces={workspaces}
              selectedId={workspace?.id ?? null}
              side="up"
              onSelect={(id) => {
                setDraftWorkspaceId(id);
                setDraftMode(null);
              }}
              onOpenFolder={openFolder}
            />
          )}
          <CodeModelPicker
            models={models}
            selectedId={modelId}
            plan={plan}
            side="up"
            disabled={models.length === 0}
            onSelect={setDraftModelId}
          />
          <ModePicker value={mode} side="up" onChange={setDraftMode} />
          <span className="code-composer-spacer" />
          <button
            type="button"
            className="code-send-btn"
            aria-label="Start session"
            disabled={!canSend}
            onClick={() => void send()}
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        </div>
      </div>
      <p className="code-disclaimer">
        Juno edits real files in the folder you pick — changes can be undone per turn.
      </p>
    </div>
  );
}
