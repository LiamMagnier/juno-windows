/**
 * Code-mode sidebar: new session, pull requests, chat-mode shortcuts,
 * sessions grouped by project (local + synced from other devices), granted
 * workspaces with permission-mode dots, and a device-readiness footer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  MonitorSmartphone,
  Pencil,
  Plug,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useContextMenu, type MenuItem } from "@/components/ContextMenu";
import type { ClientConversation } from "@/lib/data/entities";
import type { PermissionMode } from "@/lib/code/types";
import type { WorkspaceGrant } from "@/lib/code/host";
import { useCodeStore, type CodeSessionMeta } from "@/state/codeStore";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import {
  openCodeSession,
  startNewCodeSession,
  useCodeViewStore,
} from "@/features/code/codeViewStore";
import { modeInfo, PERMISSION_MODES } from "@/features/code/permissionModes";
import { FullAccessDialog } from "@/features/code/pickers";
import { RenameInput } from "./ConversationRow";
import "@/features/code/code.css";

type SessionRow =
  | { type: "local"; id: string; meta: CodeSessionMeta }
  | { type: "remote"; id: string; convo: ClientConversation };

interface SessionGroup {
  key: string;
  label: string | null;
  rows: SessionRow[];
}

export function CodeSidebarSlot() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  useEffect(() => {
    const store = useCodeStore.getState();
    void store.hydrate();
    void store.refreshRemote();
    void store.refreshGithub();
  }, []);

  return collapsed ? <CodeRail /> : <CodeSidebarContent />;
}

// ---- Collapsed rail ----

function CodeRail() {
  const view = useCodeViewStore((s) => s.view);
  const setUiView = useUiStore((s) => s.setView);
  const setMode = useUiStore((s) => s.setMode);

  return (
    <div className="sidebar-rail">
      <button
        type="button"
        className="sidebar-rail-btn sidebar-rail-primary"
        aria-label="New session"
        title="New session"
        onClick={startNewCodeSession}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="sidebar-rail-btn"
        aria-label="Pull requests"
        title="Pull requests"
        data-selected={view.kind === "pulls" || undefined}
        onClick={() => useCodeViewStore.getState().setView({ kind: "pulls" })}
      >
        <GitPullRequest size={16} />
      </button>
      <button
        type="button"
        className="sidebar-rail-btn"
        aria-label="Scheduled tasks"
        title="Scheduled tasks"
        onClick={() => {
          setMode("chat");
          setUiView({ kind: "tasks" });
        }}
      >
        <Clock size={16} />
      </button>
      <button
        type="button"
        className="sidebar-rail-btn"
        aria-label="Connectors"
        title="Connectors"
        onClick={() => {
          setMode("chat");
          setUiView({ kind: "connectors" });
        }}
      >
        <Plug size={16} />
      </button>
    </div>
  );
}

// ---- Full sidebar ----

function CodeSidebarContent() {
  const sessions = useCodeStore((s) => s.sessions);
  const running = useCodeStore((s) => s.running);
  const workspaces = useCodeStore((s) => s.workspaces);
  const remoteDevices = useCodeStore((s) => s.remoteDevices);
  const hydrated = useCodeStore((s) => s.hydrated);
  const activeSessionId = useCodeStore((s) => s.activeSessionId);
  const conversations = useDataStore((s) => s.conversations);
  const projects = useDataStore((s) => s.projects);
  const view = useCodeViewStore((s) => s.view);
  const setView = useCodeViewStore((s) => s.setView);
  const setMode = useUiStore((s) => s.setMode);
  const setUiView = useUiStore((s) => s.setView);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CodeSessionMeta | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<WorkspaceGrant | null>(null);
  const [pendingFullAccess, setPendingFullAccess] = useState<WorkspaceGrant | null>(null);

  const groups = useMemo(
    () => buildGroups(sessions, conversations, projects),
    [sessions, conversations, projects],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const onlineDevices = remoteDevices.filter((d) => d.online).length;
  const defaultMode = useMemo(() => {
    const latest = [...workspaces].sort((a, b) =>
      b.lastOpenedAt.localeCompare(a.lastOpenedAt),
    )[0];
    return modeInfo(latest?.permissionMode ?? "ask");
  }, [workspaces]);

  return (
    <>
      <div className="sidebar-scroll">
        <button
          type="button"
          className="sidebar-row sidebar-newchat"
          onClick={startNewCodeSession}
        >
          <span className="sidebar-action-icon"><Plus size={15} aria-hidden /></span>
          New session
        </button>

        <nav className="sidebar-nav" aria-label="Code sections">
          <button
            type="button"
            className="sidebar-row"
            data-selected={view.kind === "pulls" || undefined}
            aria-current={view.kind === "pulls" ? "page" : undefined}
            onClick={() => setView({ kind: "pulls" })}
          >
            <GitPullRequest size={16} aria-hidden />
            Pull requests
          </button>
          <button
            type="button"
            className="sidebar-row"
            onClick={() => {
              setMode("chat");
              setUiView({ kind: "tasks" });
            }}
          >
            <Clock size={16} aria-hidden />
            Scheduled tasks
          </button>
          <button
            type="button"
            className="sidebar-row"
            onClick={() => {
              setMode("chat");
              setUiView({ kind: "connectors" });
            }}
          >
            <Plug size={16} aria-hidden />
            Connectors
          </button>
        </nav>

        <SessionsList
          groups={groups}
          flat={flat}
          hydrated={hydrated}
          activeSessionId={view.kind === "session" ? activeSessionId : null}
          activeRemoteId={view.kind === "remote" ? view.conversationId : null}
          isRunning={(id) => running[id] === true}
          renamingId={renamingId}
          onStartRename={setRenamingId}
          onFinishRename={() => setRenamingId(null)}
          onRequestDelete={setPendingDelete}
        />

        <WorkspacesSection
          workspaces={workspaces}
          onRequestRevoke={setPendingRevoke}
          onRequestFullAccess={setPendingFullAccess}
        />
      </div>

      <div className="code-sidebar-footer">
        <ShieldCheck size={14} aria-hidden />
        <span className="code-sidebar-footer-text">
          Local · {defaultMode.label}
          {onlineDevices > 0
            ? ` · ${onlineDevices} device${onlineDevices === 1 ? "" : "s"} online`
            : ""}
        </span>
      </div>

      <Dialog
        title="Delete session"
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => {
                const meta = pendingDelete;
                setPendingDelete(null);
                if (meta) void useCodeStore.getState().deleteSession(meta.id);
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p>
          This removes "{pendingDelete?.title}" and its transcript from this device. Your files
          on disk are left untouched.
        </p>
      </Dialog>

      <Dialog
        title="Revoke access"
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPendingRevoke(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => {
                const grant = pendingRevoke;
                setPendingRevoke(null);
                if (grant) void useCodeStore.getState().revokeWorkspace(grant.id);
              }}
            >
              Revoke
            </button>
          </>
        }
      >
        <p>
          Juno loses access to "{pendingRevoke?.name}". Files on disk are left untouched; you
          can grant access again any time.
        </p>
      </Dialog>

      <FullAccessDialog
        open={pendingFullAccess !== null}
        onCancel={() => setPendingFullAccess(null)}
        onConfirm={() => {
          const grant = pendingFullAccess;
          setPendingFullAccess(null);
          if (grant) void useCodeStore.getState().setWorkspaceMode(grant.id, "full");
        }}
      />
    </>
  );
}

// ---- Session list (keyboard: arrows / Enter / F2 / Delete) ----

function SessionsList({
  groups,
  flat,
  hydrated,
  activeSessionId,
  activeRemoteId,
  isRunning,
  renamingId,
  onStartRename,
  onFinishRename,
  onRequestDelete,
}: {
  groups: SessionGroup[];
  flat: SessionRow[];
  hydrated: boolean;
  activeSessionId: string | null;
  activeRemoteId: string | null;
  isRunning(id: string): boolean;
  renamingId: string | null;
  onStartRename(id: string | null): void;
  onFinishRename(): void;
  onRequestDelete(meta: CodeSessionMeta): void;
}) {
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const clampedFocus = Math.min(focusIndex, Math.max(0, flat.length - 1));

  const focusRow = (index: number) => {
    const target = flat[index];
    if (!target) return;
    setFocusIndex(index);
    rowRefs.current.get(target.id)?.focus();
  };

  const openRow = (row: SessionRow) => {
    if (row.type === "local") openCodeSession(row.meta.id);
    else useCodeViewStore.getState().setView({ kind: "remote", conversationId: row.convo.id });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(Math.min(clampedFocus + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(Math.max(clampedFocus - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(flat.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target) openRow(target);
    } else if (e.key === "F2") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target?.type === "local") onStartRename(target.meta.id);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target?.type === "local" && !isRunning(target.meta.id)) {
        onRequestDelete(target.meta);
      }
    }
  };

  if (!hydrated) {
    return <div className="sidebar-hint">Loading sessions</div>;
  }
  if (flat.length === 0) {
    return (
      <div className="sidebar-section">
        <div className="sidebar-group-label">Sessions</div>
        <div className="sidebar-hint">No sessions yet. Pick a folder and start one.</div>
      </div>
    );
  }

  return (
    <div
      className="sidebar-section"
      role="listbox"
      aria-label="Code sessions"
      onKeyDown={onKeyDown}
    >
      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.key} role="group" aria-label={group.label ?? "Sessions"}>
            <div className="sidebar-group-label">{group.label ?? "Sessions"}</div>
            {group.rows.map((row) => {
              const index = flat.indexOf(row);
              return (
                <SessionRowView
                  key={row.id}
                  row={row}
                  active={
                    row.type === "local"
                      ? row.meta.id === activeSessionId
                      : row.convo.id === activeRemoteId
                  }
                  running={row.type === "local" && isRunning(row.meta.id)}
                  renaming={row.type === "local" && renamingId === row.meta.id}
                  focusable={index === clampedFocus}
                  onFocusRow={() => setFocusIndex(index)}
                  registerRef={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                  onOpen={() => openRow(row)}
                  onStartRename={() => {
                    if (row.type === "local") {
                      setFocusIndex(index);
                      onStartRename(row.meta.id);
                    }
                  }}
                  onFinishRename={onFinishRename}
                  onRequestDelete={() => {
                    if (row.type === "local") onRequestDelete(row.meta);
                  }}
                />
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

function SessionRowView({
  row,
  active,
  running,
  renaming,
  focusable,
  onFocusRow,
  registerRef,
  onOpen,
  onStartRename,
  onFinishRename,
  onRequestDelete,
}: {
  row: SessionRow;
  active: boolean;
  running: boolean;
  renaming: boolean;
  focusable: boolean;
  onFocusRow(): void;
  registerRef(el: HTMLDivElement | null): void;
  onOpen(): void;
  onStartRename(): void;
  onFinishRename(): void;
  onRequestDelete(): void;
}) {
  const menu = useContextMenu();
  const title = row.type === "local" ? row.meta.title : row.convo.title;
  const caption =
    row.type === "local"
      ? row.meta.workspaceName
      : (row.convo.codeWorkspaceName ?? "Another device");

  const openMenu = (x: number, y: number) => {
    if (row.type !== "local") return;
    const items: MenuItem[] = [
      { id: "rename", label: "Rename", icon: <Pencil size={16} />, onSelect: onStartRename },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={16} />,
        destructive: true,
        separatorBefore: true,
        disabled: running,
        onSelect: onRequestDelete,
      },
    ];
    menu.open(items, x, y);
  };

  const optionLabel = [
    title,
    caption,
    running ? "running" : null,
    row.type === "remote" ? "on another device" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className="sidebar-convo code-session-row"
      role="option"
      aria-selected={active}
      aria-label={optionLabel}
      data-active={active || undefined}
      tabIndex={focusable ? 0 : -1}
      onFocus={onFocusRow}
      ref={registerRef}
      onClick={() => {
        if (!renaming) onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!renaming) openMenu(e.clientX, e.clientY);
      }}
    >
      {renaming && row.type === "local" ? (
        <RenameInput
          initial={row.meta.title}
          ariaLabel="Rename session"
          onCommit={(value) => {
            const trimmed = value.trim();
            if (trimmed && trimmed !== row.meta.title) {
              void useCodeStore.getState().renameSession(row.meta.id, trimmed);
            }
            onFinishRename();
          }}
          onCancel={onFinishRename}
        />
      ) : (
        <>
          <span className="code-session-text">
            <span className="sidebar-convo-title">{title}</span>
            <span className="code-session-caption">{caption}</span>
          </span>
          {running ? <span className="sidebar-convo-dot" aria-hidden /> : null}
          {row.type === "remote" ? (
            <MonitorSmartphone size={14} className="code-session-device" aria-hidden />
          ) : null}
        </>
      )}
    </div>
  );
}

// ---- Workspaces ----

function WorkspacesSection({
  workspaces,
  onRequestRevoke,
  onRequestFullAccess,
}: {
  workspaces: WorkspaceGrant[];
  onRequestRevoke(grant: WorkspaceGrant): void;
  onRequestFullAccess(grant: WorkspaceGrant): void;
}) {
  const menu = useContextMenu();
  const anchor = useRef({ x: 0, y: 0 });

  const openModeMenu = (grant: WorkspaceGrant) => {
    const items: MenuItem[] = PERMISSION_MODES.map((mode) => ({
      id: `mode-${mode.id}`,
      label: `${mode.label} — ${mode.description}`,
      disabled: mode.id === grant.permissionMode,
      destructive: mode.id === "full",
      onSelect: () => {
        if (mode.id === "full") onRequestFullAccess(grant);
        else void useCodeStore.getState().setWorkspaceMode(grant.id, mode.id as PermissionMode);
      },
    }));
    // Re-open at the same anchor after the first menu closed.
    setTimeout(() => menu.open(items, anchor.current.x, anchor.current.y), 0);
  };

  const openMenu = (grant: WorkspaceGrant, x: number, y: number) => {
    anchor.current = { x, y };
    const items: MenuItem[] = [
      {
        id: "mode",
        label: `Permission mode: ${modeInfo(grant.permissionMode).label}`,
        icon: <ShieldCheck size={16} />,
        onSelect: () => openModeMenu(grant),
      },
      {
        id: "revoke",
        label: "Revoke access",
        icon: <Trash2 size={16} />,
        destructive: true,
        separatorBefore: true,
        onSelect: () => onRequestRevoke(grant),
      },
    ];
    menu.open(items, x, y);
  };

  return (
    <div className="sidebar-section" aria-label="Workspaces">
      <div className="sidebar-group-label">
        <FolderGit2 size={12} aria-hidden />
        Workspaces
      </div>
      {workspaces.map((grant) => (
        <div
          key={grant.id}
          className="sidebar-convo code-workspace-row"
          tabIndex={0}
          title={grant.path}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(grant, e.clientX, e.clientY);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu(grant, rect.left + 16, rect.bottom);
            }
          }}
        >
          <span
            className="code-mode-dot"
            data-tone={modeInfo(grant.permissionMode).tone}
            role="img"
            aria-label={`Permission: ${modeInfo(grant.permissionMode).label}`}
          />
          <span className="sidebar-convo-title">{grant.name}</span>
        </div>
      ))}
      {workspaces.length === 0 ? (
        <div className="sidebar-hint">No folders granted yet.</div>
      ) : null}
      <button
        type="button"
        className="sidebar-row"
        onClick={() => void useCodeStore.getState().pickWorkspace()}
      >
        <FolderOpen size={16} aria-hidden />
        Open folder…
      </button>
    </div>
  );
}

// ---- Grouping ----

function buildGroups(
  sessions: Record<string, CodeSessionMeta>,
  conversations: Record<string, ClientConversation>,
  projects: Record<string, { id: string; name: string }>,
): SessionGroup[] {
  const locals = Object.values(sessions);
  const localConversationIds = new Set(
    locals.map((m) => m.conversationId).filter((id): id is string => id !== null),
  );
  const localIds = new Set(locals.map((m) => m.id));
  // Synced code conversations minted on other devices (not mirroring a local
  // session by conversation stub id or by raw id).
  const remotes = Object.values(conversations).filter(
    (c) =>
      c.kind === "code" &&
      !c.archivedAt &&
      !localConversationIds.has(c.id) &&
      !localIds.has(c.id),
  );

  const rowTime = (row: SessionRow): string =>
    row.type === "local" ? row.meta.updatedAt : row.convo.lastMessageAt;

  const toRows = (metas: CodeSessionMeta[], convos: ClientConversation[]): SessionRow[] =>
    [
      ...metas.map((meta): SessionRow => ({ type: "local", id: meta.id, meta })),
      ...convos.map((convo): SessionRow => ({ type: "remote", id: convo.id, convo })),
    ].sort((a, b) => rowTime(b).localeCompare(rowTime(a)));

  const groups: SessionGroup[] = [];
  const projectList = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name));
  const projectIds = new Set(projectList.map((p) => p.id));

  for (const project of projectList) {
    const rows = toRows(
      locals.filter((m) => m.projectId === project.id),
      remotes.filter((c) => c.projectId === project.id),
    );
    if (rows.length > 0) {
      groups.push({ key: `project-${project.id}`, label: project.name, rows });
    }
  }

  const unassigned = toRows(
    locals.filter((m) => m.projectId === null || !projectIds.has(m.projectId)),
    remotes.filter((c) => c.projectId === null || !projectIds.has(c.projectId)),
  );
  groups.push({ key: "sessions", label: "Sessions", rows: unassigned });

  return groups;
}
