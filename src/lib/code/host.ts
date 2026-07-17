/** Typed wrappers over the privileged Rust code-service commands. */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { PermissionMode } from "./types";

export interface WorkspaceGrant {
  id: string;
  path: string;
  name: string;
  permissionMode: PermissionMode;
  grantedAt: string;
  lastOpenedAt: string;
}

export interface FsEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface GitFileStatus {
  path: string;
  staged: string;
  unstaged: string;
  renamedFrom: string | null;
}

export interface GitStatus {
  available: boolean;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitLogEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export const workspaceHost = {
  pick: () => invoke<WorkspaceGrant | null>("workspace_pick"),
  list: () => invoke<WorkspaceGrant[]>("workspace_list"),
  setMode: (id: string, mode: PermissionMode) => invoke<void>("workspace_set_mode", { id, mode }),
  revoke: (id: string) => invoke<void>("workspace_revoke", { id }),
};

export const fsHost = {
  list: (workspaceId: string, subpath?: string, maxDepth?: number) =>
    invoke<FsEntry[]>("ws_list", { workspaceId, subpath: subpath ?? null, maxDepth: maxDepth ?? null }),
  read: (workspaceId: string, path: string) => invoke<FileContent>("ws_read", { workspaceId, path }),
  write: (workspaceId: string, path: string, content: string) =>
    invoke<void>("ws_write", { workspaceId, path, content }),
  deleteFile: (workspaceId: string, path: string) =>
    invoke<void>("ws_delete_file", { workspaceId, path }),
  search: (
    workspaceId: string,
    pattern: string,
    opts?: { subpath?: string; caseSensitive?: boolean; fixedString?: boolean },
  ) =>
    invoke<SearchMatch[]>("ws_search", {
      workspaceId,
      pattern,
      subpath: opts?.subpath ?? null,
      caseSensitive: opts?.caseSensitive ?? null,
      fixedString: opts?.fixedString ?? null,
    }),
};

export const checkpointHost = {
  snapshot: (workspaceId: string, sessionId: string, turn: number, path: string) =>
    invoke<void>("ws_snapshot", { workspaceId, sessionId, turn, path }),
  restoreToBefore: (workspaceId: string, sessionId: string, turn: number) =>
    invoke<{ restored: string[] }>("ws_restore_to_before", { workspaceId, sessionId, turn }),
  changedPaths: (sessionId: string) =>
    invoke<{ turns: number[]; pathsByTurn: Record<string, string[]> }>("ws_changed_paths", {
      sessionId,
    }),
};

export type RunEvent =
  | { event: "output"; data: string }
  | { event: "exit"; code: number; truncated: boolean }
  | { event: "error"; message: string };

export interface RunningCommand {
  runId: number;
  /** Resolves with the exit code. */
  done: Promise<{ code: number; truncated: boolean }>;
  write(data: string): Promise<void>;
  kill(): Promise<void>;
}

export async function runCommand(options: {
  workspaceId: string;
  sessionId: string;
  command: string;
  subdir?: string;
  onOutput(text: string): void;
}): Promise<RunningCommand> {
  const channel = new Channel<RunEvent>();
  let resolveDone!: (result: { code: number; truncated: boolean }) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<{ code: number; truncated: boolean }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  channel.onmessage = (event) => {
    if (event.event === "output") options.onOutput(event.data);
    else if (event.event === "exit") resolveDone({ code: event.code, truncated: event.truncated });
    else rejectDone(new Error(event.message));
  };
  const handle = await invoke<{ runId: number }>("pty_run", {
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    command: options.command,
    subdir: options.subdir ?? null,
    cols: 120,
    rows: 32,
    onEvent: channel,
  });
  return {
    runId: handle.runId,
    done,
    write: (data: string) => invoke<void>("pty_write", { runId: handle.runId, data }),
    kill: () => invoke<void>("pty_kill", { runId: handle.runId }),
  };
}

export function killSessionCommands(sessionId: string): Promise<number> {
  return invoke<number>("pty_kill_session", { sessionId });
}

export const gitHost = {
  status: (workspaceId: string) => invoke<GitStatus>("git_status", { workspaceId }),
  diff: (workspaceId: string, path?: string, staged?: boolean) =>
    invoke<string>("git_diff", { workspaceId, path: path ?? null, staged: staged ?? null }),
  log: (workspaceId: string, limit?: number) =>
    invoke<GitLogEntry[]>("git_log", { workspaceId, limit: limit ?? null }),
  commit: (workspaceId: string, message: string, paths?: string[]) =>
    invoke<string>("git_commit", { workspaceId, message, paths: paths ?? null }),
};
