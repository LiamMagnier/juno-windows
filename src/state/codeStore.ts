/**
 * Code-mode state: granted workspaces, local agent sessions (with a
 * device-local transcript and a synced conversation stub so sessions appear
 * on other devices), and the remote task queue (monitor + host).
 */
import { create } from "zustand";
import { api } from "@/lib/backend/http";
import { AgentSession } from "@/lib/code/agentSession";
import { workspaceHost, type WorkspaceGrant } from "@/lib/code/host";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
} from "@/lib/code/types";
import { dbDelete, dbGet, dbGetAll, dbPut } from "@/lib/data/db";
import { useDataStore } from "./dataStore";

/** One rendered row in a session's activity timeline. */
export type CodeTimelineItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      summary: string;
      output: string;
      state: "running" | "done" | "error" | "denied";
      durationMs?: number;
    }
  | { kind: "files"; id: string; turnIndex: number; paths: string[] }
  | { kind: "error"; id: string; message: string }
  | { kind: "status"; id: string; text: string };

export interface CodeSessionMeta {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  conversationId: string | null; // synced stub id
  projectId: string | null;
  providerId: string;
  model: string;
  mode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

interface PersistedSession {
  meta: CodeSessionMeta;
  timeline: CodeTimelineItem[];
}

export interface RemoteTask {
  id: string;
  deviceId: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
  prompt: string;
  status: "queued" | "running" | "awaiting_approval" | "done" | "failed" | "cancelled";
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  workspaces: Array<{ name: string; path: string }>;
  lastSeenAt: string;
  online: boolean;
}

interface CodeState {
  workspaces: WorkspaceGrant[];
  sessions: Record<string, CodeSessionMeta>;
  timelines: Record<string, CodeTimelineItem[]>;
  activeSessionId: string | null;
  running: Record<string, boolean>;
  pendingApproval: (ApprovalRequest & { sessionId: string }) | null;
  githubConnected: boolean | null;
  remoteTasks: RemoteTask[];
  remoteDevices: RemoteDevice[];
  hydrated: boolean;

  hydrate(): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  pickWorkspace(): Promise<WorkspaceGrant | null>;
  setWorkspaceMode(id: string, mode: PermissionMode): Promise<void>;
  revokeWorkspace(id: string): Promise<void>;

  createSession(options: {
    workspace: WorkspaceGrant;
    providerId: string;
    model: string;
    projectId?: string | null;
  }): Promise<string>;
  openSession(sessionId: string): void;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  setSessionMode(sessionId: string, mode: PermissionMode): void;
  setSessionModel(sessionId: string, providerId: string, model: string): void;
  resolveApproval(decision: ApprovalDecision): void;
  undoLastTurn(sessionId: string): Promise<string[]>;

  refreshRemote(): Promise<void>;
  refreshGithub(): Promise<void>;
}

const liveSessions = new Map<string, AgentSession>();
const approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();

let itemCounter = 0;
function itemId(): string {
  return `ci-${Date.now()}-${++itemCounter}`;
}

function persist(sessionId: string): void {
  const { sessions, timelines } = useCodeStore.getState();
  const meta = sessions[sessionId];
  if (!meta) return;
  const record: PersistedSession = {
    meta,
    timeline: (timelines[sessionId] ?? []).slice(-500),
  };
  void dbPut("codeSessions", sessionId, record);
}

function appendTimeline(sessionId: string, item: CodeTimelineItem): void {
  useCodeStore.setState((s) => ({
    timelines: { ...s.timelines, [sessionId]: [...(s.timelines[sessionId] ?? []), item] },
  }));
}

function updateTimeline(
  sessionId: string,
  update: (items: CodeTimelineItem[]) => CodeTimelineItem[],
): void {
  useCodeStore.setState((s) => ({
    timelines: { ...s.timelines, [sessionId]: update(s.timelines[sessionId] ?? []) },
  }));
}

function handleAgentEvent(sessionId: string, event: AgentEvent): void {
  const store = useCodeStore;
  switch (event.type) {
    case "turn_started":
      store.setState((s) => ({ running: { ...s.running, [sessionId]: true } }));
      break;
    case "assistant_delta":
      updateTimeline(sessionId, (items) => {
        const last = items[items.length - 1];
        if (last && last.kind === "assistant" && last.streaming) {
          return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
        }
        return [...items, { kind: "assistant", id: itemId(), text: event.text, streaming: true }];
      });
      break;
    case "thinking_delta":
      updateTimeline(sessionId, (items) => {
        const last = items[items.length - 1];
        if (last && last.kind === "thinking" && last.streaming) {
          return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
        }
        return [...items, { kind: "thinking", id: itemId(), text: event.text, streaming: true }];
      });
      break;
    case "assistant_message":
      updateTimeline(sessionId, (items) =>
        items.map((item) =>
          (item.kind === "assistant" || item.kind === "thinking") && item.streaming
            ? { ...item, streaming: false }
            : item,
        ),
      );
      break;
    case "tool_started":
      appendTimeline(sessionId, {
        kind: "tool",
        id: itemId(),
        callId: event.callId,
        name: event.name,
        summary: summarizeToolInput(event.name, event.input),
        output: "",
        state: "running",
      });
      break;
    case "tool_output_delta":
      updateTimeline(sessionId, (items) =>
        items.map((item) =>
          item.kind === "tool" && item.callId === event.callId
            ? { ...item, output: (item.output + event.text).slice(-40_000) }
            : item,
        ),
      );
      break;
    case "tool_finished":
      updateTimeline(sessionId, (items) =>
        items.map((item) =>
          item.kind === "tool" && item.callId === event.callId
            ? {
                ...item,
                output: item.output || event.output,
                state: event.isError ? "error" : "done",
                durationMs: event.durationMs,
              }
            : item,
        ),
      );
      break;
    case "tool_denied":
      updateTimeline(sessionId, (items) => {
        const existing = items.some((i) => i.kind === "tool" && i.callId === event.callId);
        if (!existing) {
          return [
            ...items,
            {
              kind: "tool",
              id: itemId(),
              callId: event.callId,
              name: event.name,
              summary: event.reason,
              output: event.reason,
              state: "denied",
            },
          ];
        }
        return items.map((item) =>
          item.kind === "tool" && item.callId === event.callId
            ? { ...item, state: "denied", output: event.reason }
            : item,
        );
      });
      break;
    case "approval_requested":
      store.setState({ pendingApproval: { ...event.request, sessionId } });
      break;
    case "approval_resolved":
      store.setState((s) =>
        s.pendingApproval?.callId === event.callId ? { pendingApproval: null } : {},
      );
      break;
    case "files_changed":
      appendTimeline(sessionId, {
        kind: "files",
        id: itemId(),
        turnIndex: event.turnIndex,
        paths: event.paths,
      });
      break;
    case "mode_changed":
      store.setState((s) => {
        const meta = s.sessions[sessionId];
        if (!meta) return {};
        return { sessions: { ...s.sessions, [sessionId]: { ...meta, mode: event.mode } } };
      });
      break;
    case "turn_finished":
      store.setState((s) => {
        const meta = s.sessions[sessionId];
        const next: Partial<CodeState> = { running: { ...s.running, [sessionId]: false } };
        if (meta) {
          next.sessions = {
            ...s.sessions,
            [sessionId]: {
              ...meta,
              turnCount: event.turnIndex + 1,
              updatedAt: new Date().toISOString(),
            },
          };
        }
        return next;
      });
      persist(sessionId);
      break;
    case "error":
      appendTimeline(sessionId, { kind: "error", id: itemId(), message: event.message });
      break;
    default:
      break;
  }
}

function summarizeToolInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return `Read ${String(record.path ?? "")}`;
    case "list_files":
      return `List ${String(record.path ?? "workspace")}`;
    case "search_files":
      return `Search /${String(record.pattern ?? "")}/`;
    case "edit_file":
      return `Edit ${String(record.path ?? "")}`;
    case "write_file":
      return `Write ${String(record.path ?? "")}`;
    case "run_command":
      return `$ ${String(record.command ?? "")}`;
    default:
      return name;
  }
}

function getLiveSession(sessionId: string): AgentSession | null {
  return liveSessions.get(sessionId) ?? null;
}

function ensureLiveSession(meta: CodeSessionMeta): AgentSession {
  const existing = liveSessions.get(meta.id);
  if (existing) return existing;
  const session = new AgentSession({
    sessionId: meta.id,
    workspaceId: meta.workspaceId,
    workspaceName: meta.workspaceName,
    providerId: meta.providerId,
    model: meta.model,
    mode: meta.mode,
    onEvent: (event) => handleAgentEvent(meta.id, event),
    requestApproval: (request) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvalResolvers.set(request.callId, resolve);
      }),
  });
  liveSessions.set(meta.id, session);
  return session;
}

export const useCodeStore = create<CodeState>((set, get) => ({
  workspaces: [],
  sessions: {},
  timelines: {},
  activeSessionId: null,
  running: {},
  pendingApproval: null,
  githubConnected: null,
  remoteTasks: [],
  remoteDevices: [],
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const [persisted] = await Promise.all([
      dbGetAll<PersistedSession>("codeSessions"),
      get().refreshWorkspaces(),
    ]);
    const sessions: Record<string, CodeSessionMeta> = {};
    const timelines: Record<string, CodeTimelineItem[]> = {};
    for (const record of persisted) {
      sessions[record.meta.id] = record.meta;
      timelines[record.meta.id] = record.timeline;
    }
    set({ sessions, timelines, hydrated: true });
  },

  async refreshWorkspaces() {
    const workspaces = await workspaceHost.list().catch(() => []);
    set({ workspaces });
  },

  async pickWorkspace() {
    const grant = await workspaceHost.pick();
    if (grant) await get().refreshWorkspaces();
    if (grant) void syncWorkspaceMetadata();
    return grant;
  },

  async setWorkspaceMode(id, mode) {
    await workspaceHost.setMode(id, mode);
    await get().refreshWorkspaces();
  },

  async revokeWorkspace(id) {
    await workspaceHost.revoke(id);
    await get().refreshWorkspaces();
  },

  async createSession({ workspace, providerId, model, projectId }) {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Create the synced conversation stub so this session is visible on
    // other devices (kind:"code" + workspace metadata; transcript stays local).
    let conversationId: string | null = null;
    try {
      const res = await api<{ conversation: { id: string } }>("/conversations", {
        method: "POST",
        body: {
          kind: "code",
          codeWorkspaceName: workspace.name,
          codeWorkspacePath: workspace.path,
        },
      });
      conversationId = res.conversation.id;
      if (projectId) {
        await api(`/conversations/${encodeURIComponent(conversationId)}`, {
          method: "PATCH",
          body: { projectId },
        }).catch(() => {});
      }
    } catch {
      // Offline: session still works locally; stub sync can happen later.
    }
    const meta: CodeSessionMeta = {
      id: sessionId,
      title: "New session",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      conversationId,
      projectId: projectId ?? null,
      providerId,
      model,
      mode: workspace.permissionMode,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    };
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: meta },
      timelines: { ...s.timelines, [sessionId]: [] },
      activeSessionId: sessionId,
    }));
    persist(sessionId);
    return sessionId;
  },

  openSession(sessionId) {
    set({ activeSessionId: sessionId });
  },

  async renameSession(sessionId, title) {
    const meta = get().sessions[sessionId];
    if (!meta) return;
    const next = { ...meta, title, updatedAt: new Date().toISOString() };
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
    persist(sessionId);
    if (meta.conversationId) {
      await api(`/conversations/${encodeURIComponent(meta.conversationId)}`, {
        method: "PATCH",
        body: { title },
      }).catch(() => {});
    }
  },

  async deleteSession(sessionId) {
    const meta = get().sessions[sessionId];
    const live = liveSessions.get(sessionId);
    if (live) {
      await live.stop().catch(() => {});
      liveSessions.delete(sessionId);
    }
    set((s) => {
      const { [sessionId]: _m, ...sessions } = s.sessions;
      const { [sessionId]: _t, ...timelines } = s.timelines;
      return {
        sessions,
        timelines,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
    await dbDelete("codeSessions", sessionId);
    if (meta?.conversationId) {
      await api(`/conversations/${encodeURIComponent(meta.conversationId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  },

  async prompt(sessionId, text) {
    const meta = get().sessions[sessionId];
    if (!meta) return;
    const session = ensureLiveSession(meta);
    if (session.isBusy) return;
    if (meta.title === "New session") {
      void get().renameSession(sessionId, text.slice(0, 60));
    }
    appendTimeline(sessionId, { kind: "user", id: itemId(), text });
    persist(sessionId);
    await session.prompt(text);
  },

  async stop(sessionId) {
    const session = getLiveSession(sessionId);
    const { pendingApproval } = get();
    if (pendingApproval && pendingApproval.sessionId === sessionId) {
      approvalResolvers.get(pendingApproval.callId)?.("deny");
      approvalResolvers.delete(pendingApproval.callId);
      set({ pendingApproval: null });
    }
    await session?.stop();
  },

  setSessionMode(sessionId, mode) {
    const meta = get().sessions[sessionId];
    if (!meta) return;
    getLiveSession(sessionId)?.setMode(mode);
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...meta, mode } } }));
    persist(sessionId);
  },

  setSessionModel(sessionId, providerId, model) {
    const meta = get().sessions[sessionId];
    if (!meta) return;
    getLiveSession(sessionId)?.setModel(providerId, model);
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: { ...meta, providerId, model } },
    }));
    persist(sessionId);
  },

  resolveApproval(decision) {
    const { pendingApproval } = get();
    if (!pendingApproval) return;
    approvalResolvers.get(pendingApproval.callId)?.(decision);
    approvalResolvers.delete(pendingApproval.callId);
    set({ pendingApproval: null });
  },

  async undoLastTurn(sessionId) {
    const meta = get().sessions[sessionId];
    if (!meta) return [];
    const session = ensureLiveSession(meta);
    const restored = await session.undoLastTurn();
    if (restored.length > 0) {
      appendTimeline(sessionId, {
        kind: "status",
        id: itemId(),
        text: `Restored ${restored.length} file${restored.length === 1 ? "" : "s"}: ${restored.join(", ")}`,
      });
      persist(sessionId);
    }
    return restored;
  },

  async refreshRemote() {
    try {
      const [devices, tasks] = await Promise.all([
        api<{ devices: RemoteDevice[] }>("/code/devices"),
        api<{ tasks: RemoteTask[] }>("/code/tasks?limit=100"),
      ]);
      set({ remoteDevices: devices.devices, remoteTasks: tasks.tasks });
    } catch {
      // Remote data is decoration on top of local sessions; stay quiet offline.
    }
  },

  async refreshGithub() {
    try {
      const res = await api<{ connectors: Array<{ id: string; connected: boolean }> }>(
        "/connectors",
      );
      set({ githubConnected: res.connectors.some((c) => c.id === "github" && c.connected) });
    } catch {
      set({ githubConnected: null });
    }
  },
}));

/**
 * Union-merge this device's workspaces into the account's portable list
 * (GET then PUT — the endpoint is mirror-sync, so a plain PUT of only our
 * grants would clobber other devices' entries).
 */
export async function syncWorkspaceMetadata(): Promise<void> {
  try {
    const [grants, server] = await Promise.all([
      workspaceHost.list(),
      api<{ workspaces: Array<{ id: string; name: string; path: string; lastOpenedAt: string }> }>(
        "/code/workspaces",
      ),
    ]);
    const byPath = new Map(server.workspaces.map((w) => [w.path, w]));
    for (const grant of grants) {
      const existing = byPath.get(grant.path);
      byPath.set(grant.path, {
        id: existing?.id ?? grant.id.slice(0, 64),
        name: grant.name,
        path: grant.path,
        lastOpenedAt: grant.lastOpenedAt,
      });
    }
    await api("/code/workspaces", {
      method: "PUT",
      body: { workspaces: [...byPath.values()].slice(0, 200) },
    });
  } catch {
    // Portable metadata sync is best-effort.
  }
}
