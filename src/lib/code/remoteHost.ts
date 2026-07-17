/**
 * Remote code host: registers this PC as a code device, long-polls the
 * task queue, claims queued tasks targeted at it, runs them with the local
 * agent, and relays progress through the append-only event protocol
 * (juno/src/lib/code-remote.ts). Approvals and cancellation arrive as
 * control events piggybacked on event posts.
 */
import { api } from "../backend/http";
import { hostInfo } from "../host";
import { workspaceHost } from "./host";
import { AgentSession } from "./agentSession";
import type { AgentEvent, ApprovalDecision } from "./types";

interface RemoteTaskPayload {
  id: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
  prompt: string;
  status: string;
}

interface OutboundEvent {
  kind: string;
  payload: Record<string, unknown>;
}

const HEARTBEAT_MS = 60_000;
const EVENT_FLUSH_MS = 1_000;
const DEVICE_ID_KEY = "juno.code.deviceId";
const HOSTING_KEY = "juno.code.hosting";

let running = false;
let deviceId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let queueAbort: AbortController | null = null;
let onStateChange: ((state: RemoteHostState) => void) | null = null;

export interface RemoteHostState {
  hosting: boolean;
  deviceId: string | null;
  activeTaskId: string | null;
}

let state: RemoteHostState = { hosting: false, deviceId: null, activeTaskId: null };

function setState(patch: Partial<RemoteHostState>): void {
  state = { ...state, ...patch };
  onStateChange?.(state);
}

export function remoteHostState(): RemoteHostState {
  return state;
}

export function observeRemoteHost(listener: (state: RemoteHostState) => void): () => void {
  onStateChange = listener;
  listener(state);
  return () => {
    if (onStateChange === listener) onStateChange = null;
  };
}

export function isHostingPreferred(): boolean {
  return localStorage.getItem(HOSTING_KEY) === "1";
}

async function registerDevice(): Promise<string> {
  const info = await hostInfo();
  const grants = await workspaceHost.list();
  const body: Record<string, unknown> = {
    name: info.deviceName,
    platform: "windows",
    workspaces: grants.slice(0, 100).map((g) => ({ name: g.name, path: g.path })),
  };
  const saved = localStorage.getItem(DEVICE_ID_KEY);
  if (saved) body.deviceId = saved;
  const res = await api<{ device: { id: string } }>("/code/devices", {
    method: "POST",
    body,
  });
  localStorage.setItem(DEVICE_ID_KEY, res.device.id);
  return res.device.id;
}

export async function startHosting(): Promise<void> {
  if (running) return;
  running = true;
  localStorage.setItem(HOSTING_KEY, "1");
  try {
    deviceId = await registerDevice();
  } catch {
    running = false;
    setState({ hosting: false });
    throw new Error("Couldn't register this PC as a code device.");
  }
  setState({ hosting: true, deviceId });
  heartbeatTimer = setInterval(() => {
    void registerDevice().catch(() => {});
  }, HEARTBEAT_MS);
  void queueLoop();
}

export function stopHosting(): void {
  running = false;
  localStorage.setItem(HOSTING_KEY, "0");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  queueAbort?.abort();
  setState({ hosting: false, activeTaskId: null });
}

async function queueLoop(): Promise<void> {
  while (running && deviceId) {
    try {
      queueAbort = new AbortController();
      const res = await api<{ task: RemoteTaskPayload | null }>(
        `/code/queue?deviceId=${encodeURIComponent(deviceId)}`,
        { signal: queueAbort.signal, timeoutMs: 40_000, retries: 1 },
      );
      if (!running) break;
      if (res.task) {
        await runTask(res.task);
      }
    } catch {
      if (!running) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function runTask(task: RemoteTaskPayload): Promise<void> {
  if (!deviceId) return;
  try {
    await api(`/code/tasks/${encodeURIComponent(task.id)}/claim`, {
      method: "POST",
      body: { deviceId },
    });
  } catch {
    return; // raced another device or task cancelled
  }
  setState({ activeTaskId: task.id });

  // Event relay with control-channel piggybacking.
  let pending: OutboundEvent[] = [];
  let afterControlSeq = 0;
  let taskStatus: string | undefined;
  let flushing = false;
  const approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();
  let session: AgentSession | null = null;
  let cancelled = false;
  let textAcc = "";

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      if (textAcc) {
        pending.push({ kind: "text", payload: { text: textAcc } });
        textAcc = "";
      }
      if (pending.length === 0 && taskStatus === undefined) return;
      const events = pending.splice(0, 500);
      const body: Record<string, unknown> = { events, afterControlSeq };
      if (taskStatus !== undefined) {
        body.status = taskStatus;
        taskStatus = undefined;
      }
      const res = await api<{
        lastSeq: number;
        control: Array<{ seq: number; kind: string; payload: Record<string, unknown> }>;
      }>(`/code/tasks/${encodeURIComponent(task.id)}/events`, { method: "POST", body });
      for (const control of res.control) {
        afterControlSeq = Math.max(afterControlSeq, control.seq);
        if (control.kind === "approval_response") {
          const requestId = String(control.payload.requestId ?? "");
          const approve = control.payload.approve === true;
          approvalResolvers.get(requestId)?.(approve ? "allow" : "deny");
          approvalResolvers.delete(requestId);
        } else if (control.kind === "cancel_request" && !cancelled) {
          cancelled = true;
          await session?.stop();
        }
      }
    } catch {
      // Events retry on the next flush tick.
    } finally {
      flushing = false;
    }
  };
  const flushTimer = setInterval(() => void flush(), EVENT_FLUSH_MS);

  const grants = await workspaceHost.list();
  const grant = grants.find((g) => g.path === task.workspacePath);
  if (!grant) {
    pending.push({
      kind: "error",
      payload: {
        message: `This PC has no granted workspace at ${task.workspacePath}. Open the folder in Juno Code on this device first.`,
      },
    });
    taskStatus = "failed";
    await flush();
    clearInterval(flushTimer);
    setState({ activeTaskId: null });
    return;
  }

  pending.push({ kind: "user", payload: { text: task.prompt } });

  const modelEntry = await pickRemoteModel();
  session = new AgentSession({
    sessionId: `remote-${task.id}`,
    workspaceId: grant.id,
    workspaceName: grant.name,
    providerId: modelEntry.providerId,
    model: modelEntry.model,
    mode: grant.permissionMode === "readOnly" ? "readOnly" : grant.permissionMode,
    onEvent: (event: AgentEvent) => {
      switch (event.type) {
        case "assistant_delta":
          textAcc += event.text;
          break;
        case "tool_started":
          if (textAcc) {
            pending.push({ kind: "text", payload: { text: textAcc } });
            textAcc = "";
          }
          break;
        case "tool_finished":
          pending.push({
            kind: "tool",
            payload: {
              name: event.name,
              summary: `${event.name} ${event.isError ? "— failed" : "— ok"}`,
              detail: event.output.slice(0, 2_000),
            },
          });
          break;
        case "files_changed":
          for (const path of event.paths) {
            pending.push({
              kind: "file_change",
              payload: { path, changeKind: "edit", added: 0, removed: 0 },
            });
          }
          break;
        case "approval_requested":
          pending.push({
            kind: "approval_request",
            payload: {
              requestId: event.request.callId,
              summary: event.request.summary,
              risk: event.request.risk === "sensitive" ? "destructive" : "neutral",
            },
          });
          taskStatus = "awaiting_approval";
          void flush();
          break;
        case "error":
          pending.push({ kind: "error", payload: { message: event.message } });
          break;
        default:
          break;
      }
    },
    requestApproval: (request) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvalResolvers.set(request.callId, resolve);
      }),
  });

  try {
    await session.prompt(task.prompt);
    if (textAcc) {
      pending.push({ kind: "text", payload: { text: textAcc } });
      textAcc = "";
    }
    pending.push({ kind: "done", payload: {} });
    taskStatus = cancelled ? "cancelled" : "done";
  } catch (err) {
    pending.push({
      kind: "error",
      payload: { message: err instanceof Error ? err.message : "Task failed." },
    });
    taskStatus = "failed";
  } finally {
    await flush();
    clearInterval(flushTimer);
    setState({ activeTaskId: null });
  }
}

async function pickRemoteModel(): Promise<{ providerId: string; model: string }> {
  const { useDataStore } = await import("@/state/dataStore");
  const manifest = useDataStore.getState().manifest;
  const entry = manifest?.models.find(
    (m) =>
      m.availability === "available" &&
      m.capabilities.tools &&
      m.modalities.output.includes("text"),
  );
  if (!entry) throw new Error("No tool-capable model is available for this account.");
  const [, ...rest] = entry.id.split(":");
  return { providerId: entry.provider.id, model: rest.join(":") || entry.id };
}
