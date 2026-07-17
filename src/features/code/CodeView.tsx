/**
 * Code mode's main pane: routes between the pull-requests parity page, the
 * read-only notice for sessions from other devices, the new-session composer
 * (activeSessionId === null) and the working cockpit.
 */
import { useEffect } from "react";
import { ExternalLink, GitPullRequest, LoaderCircle, MonitorSmartphone } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCodeStore } from "@/state/codeStore";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import { useCodeViewStore } from "./codeViewStore";
import { NewSessionView } from "./NewSessionView";
import { SessionCockpit } from "./SessionCockpit";
import "./code.css";

export function CodeView() {
  const view = useCodeViewStore((s) => s.view);
  const activeSessionId = useCodeStore((s) => s.activeSessionId);
  const session = useCodeStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : undefined,
  );

  useEffect(() => {
    void useCodeStore.getState().hydrate();
  }, []);

  if (view.kind === "pulls") return <PullsView />;
  if (view.kind === "remote") return <RemoteSessionNotice conversationId={view.conversationId} />;
  if (session) return <SessionCockpit key={session.id} meta={session} />;
  return <NewSessionView />;
}

/**
 * Honest parity page — the backend has no PR-list API yet, so this mirrors
 * the web /code/pulls page instead of fabricating data.
 */
function PullsView() {
  const githubConnected = useCodeStore((s) => s.githubConnected);

  if (githubConnected === null) {
    return (
      <div className="code-center-state" role="status">
        <LoaderCircle size={20} className="code-spin" aria-hidden />
        <p className="code-center-text">Checking the GitHub connection</p>
      </div>
    );
  }

  if (!githubConnected) {
    return (
      <div className="code-center-state">
        <GitPullRequest size={28} className="code-center-icon" aria-hidden />
        <h2 className="code-center-title">Connect GitHub</h2>
        <p className="code-center-text">
          Connect the GitHub connector to bring pull requests into Juno.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            const ui = useUiStore.getState();
            ui.setMode("chat");
            ui.setView({ kind: "connectors" });
          }}
        >
          Open connectors
        </button>
      </div>
    );
  }

  return (
    <div className="code-center-state">
      <GitPullRequest size={28} className="code-center-icon" aria-hidden />
      <h2 className="code-center-title">GitHub is connected</h2>
      <p className="code-center-text">
        The pull-request list is on its way — review PRs on GitHub for now.
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => void openUrl("https://github.com/pulls")}
      >
        <ExternalLink size={14} aria-hidden />
        Open GitHub
      </button>
    </div>
  );
}

/** Synced code sessions from other devices keep their transcripts there. */
function RemoteSessionNotice({ conversationId }: { conversationId: string }) {
  const conversation = useDataStore((s) => s.conversations[conversationId]);

  if (!conversation) {
    return (
      <div className="code-center-state">
        <p className="code-center-text">This session is no longer available.</p>
      </div>
    );
  }

  return (
    <div className="code-center-state">
      <MonitorSmartphone size={28} className="code-center-icon" aria-hidden />
      <h2 className="code-center-title">{conversation.title}</h2>
      {conversation.codeWorkspaceName ? (
        <p className="code-center-caption">{conversation.codeWorkspaceName}</p>
      ) : null}
      <p className="code-center-text">
        This session ran on another device. Code transcripts stay on the device that created
        them, so only the title and workspace sync here.
      </p>
    </div>
  );
}
