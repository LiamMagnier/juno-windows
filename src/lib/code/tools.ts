/**
 * Agent tools over the Rust workspace services — a port of
 * juno-app/core/src/tools/{fs,bash}.ts with streaming terminal output.
 */
import { fsHost, runCommand, type RunningCommand } from "./host";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

const MAX_TOOL_OUTPUT = 30_000;

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated ${text.length - MAX_TOOL_OUTPUT} chars]`
    : text;
}

const readFile: ToolDefinition = {
  spec: {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns the file content (large files are truncated).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. src/main.ts" },
      },
      required: ["path"],
    },
  },
  kind: "read",
  summarize: (input) => `Read ${String(input.path ?? "")}`,
  async execute(input, ctx): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const file = await fsHost.read(ctx.workspaceId, path);
    if (file.binary) return { output: `${path} is a binary file (${file.size} bytes).` };
    const suffix = file.truncated ? "\n…[file truncated]" : "";
    return { output: clip(file.content) + suffix };
  },
};

const listFiles: ToolDefinition = {
  spec: {
    name: "list_files",
    description:
      "List files and directories in the workspace (gitignore-aware). Optionally scope to a subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Subdirectory to list; omit for the whole workspace" },
        maxDepth: { type: "number", description: "Limit recursion depth (default unlimited)" },
      },
    },
  },
  kind: "read",
  summarize: (input) => `List ${String(input.path ?? "workspace")}`,
  async execute(input, ctx): Promise<ToolResult> {
    const entries = await fsHost.list(
      ctx.workspaceId,
      input.path ? String(input.path) : undefined,
      typeof input.maxDepth === "number" ? input.maxDepth : undefined,
    );
    const lines = entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.size}b)`));
    return { output: clip(lines.join("\n")) || "(empty)" };
  },
};

const searchFiles: ToolDefinition = {
  spec: {
    name: "search_files",
    description:
      "Search file contents in the workspace with a regular expression (rust regex syntax). Returns path:line matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for" },
        path: { type: "string", description: "Subdirectory to search; omit for the whole workspace" },
        caseSensitive: { type: "boolean" },
        fixedString: { type: "boolean", description: "Treat pattern as a literal string" },
      },
      required: ["pattern"],
    },
  },
  kind: "read",
  summarize: (input) => `Search for /${String(input.pattern ?? "")}/`,
  async execute(input, ctx): Promise<ToolResult> {
    const opts: { subpath?: string; caseSensitive?: boolean; fixedString?: boolean } = {};
    if (input.path) opts.subpath = String(input.path);
    if (typeof input.caseSensitive === "boolean") opts.caseSensitive = input.caseSensitive;
    if (typeof input.fixedString === "boolean") opts.fixedString = input.fixedString;
    const matches = await fsHost.search(ctx.workspaceId, String(input.pattern ?? ""), opts);
    if (matches.length === 0) return { output: "No matches." };
    return {
      output: clip(matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")),
    };
  },
};

const editFile: ToolDefinition = {
  spec: {
    name: "edit_file",
    description:
      "Make a surgical edit: replace `oldText` (must appear exactly once) with `newText` in the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Exact existing text to replace (must be unique)" },
        newText: { type: "string", description: "Replacement text" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  kind: "edit",
  summarize: (input) => `Edit ${String(input.path ?? "")}`,
  mutatedPaths: (input) => [String(input.path ?? "")],
  async execute(input, ctx): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const oldText = String(input.oldText ?? "");
    const newText = String(input.newText ?? "");
    const file = await fsHost.read(ctx.workspaceId, path);
    if (file.binary) return { output: `${path} is binary; cannot edit.`, isError: true };
    if (file.truncated) {
      return { output: `${path} is too large to edit safely.`, isError: true };
    }
    const first = file.content.indexOf(oldText);
    if (first === -1) {
      return { output: `oldText not found in ${path}. Read the file and retry with exact text.`, isError: true };
    }
    if (file.content.indexOf(oldText, first + 1) !== -1) {
      return { output: `oldText appears multiple times in ${path}; provide more context to disambiguate.`, isError: true };
    }
    const next = file.content.slice(0, first) + newText + file.content.slice(first + oldText.length);
    await fsHost.write(ctx.workspaceId, path, next);
    return { output: `Edited ${path}.` };
  },
};

const writeFile: ToolDefinition = {
  spec: {
    name: "write_file",
    description: "Create a new file or fully overwrite an existing one with the given content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  kind: "edit",
  summarize: (input) => `Write ${String(input.path ?? "")}`,
  mutatedPaths: (input) => [String(input.path ?? "")],
  async execute(input, ctx): Promise<ToolResult> {
    const path = String(input.path ?? "");
    await fsHost.write(ctx.workspaceId, path, String(input.content ?? ""));
    return { output: `Wrote ${path}.` };
  },
};

const runShell: ToolDefinition = {
  spec: {
    name: "run_command",
    description:
      "Run a shell command in the workspace (PowerShell on Windows). Output streams live; long or interactive commands are killed on Stop.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Workspace-relative working directory (optional)" },
      },
      required: ["command"],
    },
  },
  kind: "command",
  summarize: (input) => `$ ${String(input.command ?? "")}`,
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? "");
    let output = "";
    let run: RunningCommand;
    const runOptions: Parameters<typeof runCommand>[0] = {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      command,
      onOutput: (text) => {
        output += text;
        ctx.onOutput?.(ctx.callId, text);
      },
    };
    if (input.cwd) runOptions.subdir = String(input.cwd);
    try {
      run = await runCommand(runOptions);
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : "Failed to start the command.",
        isError: true,
      };
    }
    const onAbort = () => void run.kill();
    ctx.signal.addEventListener("abort", onAbort);
    try {
      const { code, truncated } = await run.done;
      const trailer = truncated ? "\n[output truncated]" : "";
      return {
        output: clip(output) + trailer + (code === 0 ? "" : `\n[exit code ${code}]`),
        isError: code !== 0,
      };
    } catch (err) {
      return {
        output: `${clip(output)}\n[command failed: ${err instanceof Error ? err.message : "unknown"}]`,
        isError: true,
      };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

export function defaultTools(): ToolDefinition[] {
  return [readFile, listFiles, searchFiles, editFile, writeFile, runShell];
}
