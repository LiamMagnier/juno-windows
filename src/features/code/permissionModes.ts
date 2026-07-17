/**
 * Shared presentation metadata for the four code permission modes.
 * The semantics live in src/lib/code/permissions.ts (finished contract);
 * this module only names and colors them for the UI.
 */
import type { PermissionMode } from "@/lib/code/types";

export type ModeTone = "muted" | "warning" | "primary" | "destructive";

export interface ModeInfo {
  id: PermissionMode;
  label: string;
  /** One-line description shown in pickers and menus. */
  description: string;
  tone: ModeTone;
}

export const PERMISSION_MODES: ModeInfo[] = [
  {
    id: "readOnly",
    label: "Read only",
    description: "Explore and plan without changing files",
    tone: "muted",
  },
  {
    id: "ask",
    label: "Ask first",
    description: "Confirm every edit and command",
    tone: "warning",
  },
  {
    id: "workspaceWrite",
    label: "Workspace write",
    description: "Edit files freely; risky commands still confirm",
    tone: "primary",
  },
  {
    id: "full",
    label: "Full access",
    description: "Run most commands without asking",
    tone: "destructive",
  },
];

export function modeInfo(mode: PermissionMode): ModeInfo {
  return PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[1]!;
}
