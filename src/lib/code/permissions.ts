/**
 * Permission engine — port of juno-app/core/src/permissions.ts with
 * Windows-specific sensitive-command patterns added. Sensitive actions
 * always confirm; no mode and no allowlist bypasses that.
 */
import type { PermissionMode, RiskLevel, ToolDefinition } from "./types";

const SENSITIVE_COMMAND_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // POSIX-ish (git bash / WSL / dev shells)
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: "recursive force delete" },
  { re: /\bsudo\b/, why: "privilege escalation" },
  { re: /\bgit\s+push\b.*(--force|\s-f\b)/, why: "git force-push" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "discards local changes" },
  { re: /\bgit\s+clean\b.*-[a-z]*f/, why: "deletes untracked files" },
  { re: /\bgit\s+rebase\b/, why: "rewrites git history" },
  { re: /\bgit\s+(commit|filter-branch)\b.*--amend/, why: "rewrites git history" },
  { re: /\bchmod\s+(-R\s+)?777\b/, why: "world-writable permissions" },
  { re: /\b(mkfs|diskutil\s+erase|dd\s+if=)/i, why: "disk-level operation" },
  { re: /\b(shutdown|reboot|halt)\b/i, why: "system power control" },
  { re: /\bkillall\b/, why: "mass process kill" },
  { re: /(curl|wget|iwr|invoke-webrequest)[^|;&]*\|\s*(ba|z|pwr)?sh\b/i, why: "pipes remote content into a shell" },
  { re: /(^|[\s/\\])\.ssh\b|\.aws\b|\.gnupg\b/i, why: "touches credential directory" },
  { re: /\.env(\.[a-z]+)?\b.*(cat|cp|curl|scp|nc|type|copy)\b|(cat|cp|curl|scp|nc|type|copy)\b.*\.env(\.[a-z]+)?\b/i, why: "reads or ships env secrets" },
  // Windows-specific
  { re: /\b(rd|rmdir)\b\s+(\/s|\/q|\/s\s+\/q)/i, why: "recursive directory delete" },
  { re: /\bdel\b\s+.*(\/f|\/s|\/q)/i, why: "force delete" },
  // remove-item + its aliases/abbreviations (ri, erase; -r/-re.../-fo...)
  { re: /\b(remove-item|ri|erase)\b.*(\s-r(e[a-z]*)?\b|\s-f(o[a-z]*)?\b|-recurse|-force)/i, why: "recursive force delete" },
  { re: /\[(system\.)?io\.(directory|file)\]::(delete|move)/i, why: ".NET filesystem delete" },
  { re: /\bgit\s+push\b.*\s\+\S+/, why: "git force-push (refspec)" },
  { re: /\b(gc|get-content|type)\b.*\.env(\.[a-z]+)?\b/i, why: "reads env secrets" },
  { re: /\[(system\.)?io\.file\]::read/i, why: ".NET file read of arbitrary paths" },
  { re: /\b(iex|invoke-expression)\b/i, why: "dynamic script execution" },
  { re: /\bformat(\.com)?\s+[a-z]:/i, why: "disk format" },
  { re: /\breg(\.exe)?\s+(add|delete)\b/i, why: "registry modification" },
  { re: /\b(netsh|bcdedit|schtasks|sc(\.exe)?\s+(config|delete|create))\b/i, why: "system configuration change" },
  { re: /\bset-executionpolicy\b/i, why: "weakens script security policy" },
  { re: /\b(stop-computer|restart-computer)\b/i, why: "system power control" },
  { re: /\bstop-process\b.*-force/i, why: "force process kill" },
  { re: /\btakeown\b|\bicacls\b.*\/grant/i, why: "permission takeover" },
  { re: /\bvssadmin\b\s+delete/i, why: "deletes shadow copies" },
  { re: /(cmdkey|vaultcmd)\b/i, why: "credential store access" },
];

/** Commands that reach the network or install packages: elevated in modes below full. */
const ELEVATED_COMMAND_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|up(date|grade)?)\b/i, why: "installs packages" },
  { re: /\bpip3?\s+(install|uninstall)\b/i, why: "installs packages" },
  { re: /\bcargo\s+(install|add)\b/i, why: "installs packages" },
  { re: /\bwinget\s+(install|uninstall|upgrade)\b/i, why: "installs software" },
  { re: /\bchoco\s+(install|uninstall|upgrade)\b/i, why: "installs software" },
  { re: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i, why: "network request" },
  { re: /\bgit\s+(push|pull|fetch|clone)\b/i, why: "network git operation" },
  { re: /\bssh\b|\bscp\b|\brsync\b.*:/i, why: "remote access" },
];

/**
 * Best-effort detection: a regex denylist cannot be complete against
 * PowerShell's alias/expression space. The hard guarantees live in Rust
 * (workspace containment, read-only enforcement, .git/.juno write protection)
 * — this layer decides when to ASK, and errs toward asking.
 */
export function classifySensitiveCommand(command: string): string | null {
  for (const { re, why } of SENSITIVE_COMMAND_PATTERNS) {
    if (re.test(command)) return why;
  }
  return null;
}

export function classifyElevatedCommand(command: string): string | null {
  for (const { re, why } of ELEVATED_COMMAND_PATTERNS) {
    if (re.test(command)) return why;
  }
  return null;
}

export function classifyRisk(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): { risk: RiskLevel; reason: string } {
  if (tool.kind === "read") return { risk: "safe", reason: "read-only" };
  if (tool.kind === "edit") return { risk: "edit", reason: "modifies files" };
  const command = String(input.command ?? "");
  const sensitive = tool.spec.name === "run_command" ? classifySensitiveCommand(command) : null;
  if (sensitive) return { risk: "sensitive", reason: sensitive };
  return { risk: "command", reason: "runs a shell command" };
}

export type PermissionOutcome = "allow" | "ask" | "deny";

export class PermissionEngine {
  private alwaysAllowed = new Set<string>();

  grantAlways(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  decide(mode: PermissionMode, toolName: string, risk: RiskLevel, input?: Record<string, unknown>): PermissionOutcome {
    // Sensitive actions always confirm — no mode bypasses this.
    if (risk === "sensitive") return "ask";
    if (mode === "readOnly") return risk === "safe" ? "allow" : "deny";
    if (risk === "safe") return "allow";
    if (this.alwaysAllowed.has(toolName)) return "allow";
    switch (mode) {
      case "ask":
        return "ask";
      case "workspaceWrite": {
        if (risk === "edit") return "allow";
        // Safe commands run; network/install commands still ask.
        const command = String(input?.command ?? "");
        return classifyElevatedCommand(command) ? "ask" : "allow";
      }
      case "full": {
        return "allow";
      }
    }
  }
}
