/**
 * Popover pickers for the code surface: a shared anchored listbox popover
 * (opens up or down), plus the workspace / model / permission-mode pickers
 * built on it. Full access always routes through an explicit confirm dialog.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FolderOpen, ShieldAlert } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { ModelEntry } from "@/lib/data/entities";
import type { PermissionMode } from "@/lib/code/types";
import type { WorkspaceGrant } from "@/lib/code/host";
import { gateModel } from "@/features/chat/helpers";
import { PERMISSION_MODES, modeInfo } from "./permissionModes";

// ---- Shared popover listbox ----

export type PickerRow =
  | { kind: "header"; label: string }
  | {
      kind: "option";
      id: string;
      label: string;
      caption?: string;
      selected?: boolean;
      disabled?: boolean;
      reason?: string;
      dotTone?: string;
    };

function CodePopover({
  open,
  onClose,
  label,
  side,
  children,
  width,
}: {
  open: boolean;
  onClose(): void;
  label: string;
  side: "up" | "down";
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const wrap = ref.current?.parentElement;
    const onPointerDown = (e: PointerEvent) => {
      if (wrap && !wrap.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        wrap?.querySelector<HTMLElement>("button")?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="code-popover"
      role="dialog"
      aria-label={label}
      data-side={side}
      style={width !== undefined ? { width } : undefined}
    >
      {children}
    </div>
  );
}

export function PickerList({
  rows,
  label,
  onPick,
}: {
  rows: PickerRow[];
  label: string;
  onPick(id: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const enabledIndexes = useMemo(
    () =>
      rows
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => row.kind === "option" && !row.disabled)
        .map(({ i }) => i),
    [rows],
  );
  const [focusIndex, setFocusIndex] = useState(() => {
    const selected = rows.findIndex((r) => r.kind === "option" && r.selected);
    return enabledIndexes.includes(selected) ? selected : (enabledIndexes[0] ?? 0);
  });

  useEffect(() => {
    requestAnimationFrame(() => listRef.current?.focus());
  }, []);

  const move = (delta: number) => {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(focusIndex);
    const next =
      enabledIndexes[(position + delta + enabledIndexes.length) % enabledIndexes.length]!;
    setFocusIndex(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const row = rows[focusIndex];
      if (row && row.kind === "option" && !row.disabled) onPick(row.id);
    }
  };

  return (
    <div
      ref={listRef}
      className="code-picker-list"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {rows.map((row, index) =>
        row.kind === "header" ? (
          <div key={`h-${row.label}-${index}`} className="code-picker-header">
            {row.label}
          </div>
        ) : (
          <div
            key={`${row.id}-${index}`}
            id={`code-pick-${row.id}`}
            role="option"
            aria-selected={row.selected ?? false}
            aria-disabled={row.disabled || undefined}
            className="code-picker-row"
            data-row-index={index}
            data-focused={index === focusIndex || undefined}
            data-selected={row.selected || undefined}
            data-disabled={row.disabled || undefined}
            onPointerEnter={() => !row.disabled && setFocusIndex(index)}
            onClick={() => !row.disabled && onPick(row.id)}
          >
            {row.dotTone ? (
              <span className="code-mode-dot" data-tone={row.dotTone} aria-hidden />
            ) : null}
            <span className="code-picker-main">
              <span className="code-picker-label">{row.label}</span>
              {row.caption ? <span className="code-picker-caption">{row.caption}</span> : null}
            </span>
            {row.reason ? <span className="code-picker-reason">{row.reason}</span> : null}
          </div>
        ),
      )}
      {rows.length === 0 ? <div className="code-picker-empty">Nothing here yet</div> : null}
    </div>
  );
}

function PickerPill({
  label,
  icon,
  open,
  disabled,
  ariaLabel,
  onToggle,
  tone,
}: {
  label: string;
  icon?: ReactNode;
  open: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onToggle(): void;
  tone?: string | undefined;
}) {
  return (
    <button
      type="button"
      className="code-pill"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      data-tone={tone}
      disabled={disabled}
      onClick={onToggle}
    >
      {icon}
      <span className="code-pill-label">{label}</span>
      <ChevronDown size={14} aria-hidden />
    </button>
  );
}

// ---- Workspace picker ----

export const OPEN_FOLDER_ID = "__open_folder__";

export function WorkspacePicker({
  workspaces,
  selectedId,
  side,
  disabled,
  onSelect,
  onOpenFolder,
}: {
  workspaces: WorkspaceGrant[];
  selectedId: string | null;
  side: "up" | "down";
  disabled?: boolean;
  onSelect(id: string): void;
  onOpenFolder(): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = workspaces.find((w) => w.id === selectedId) ?? null;

  const rows: PickerRow[] = [
    ...workspaces.map(
      (w): PickerRow => ({
        kind: "option",
        id: w.id,
        label: w.name,
        caption: w.path,
        selected: w.id === selectedId,
        dotTone: modeInfo(w.permissionMode).tone,
      }),
    ),
    { kind: "option", id: OPEN_FOLDER_ID, label: "Open folder…" },
  ];

  return (
    <div className="code-pop-wrap">
      <PickerPill
        label={selected?.name ?? "Choose folder"}
        icon={<FolderOpen size={14} aria-hidden />}
        open={open}
        disabled={disabled ?? false}
        ariaLabel="Choose workspace"
        onToggle={() => setOpen((o) => !o)}
      />
      <CodePopover open={open} onClose={() => setOpen(false)} label="Workspaces" side={side} width={300}>
        <PickerList
          rows={rows}
          label="Workspaces"
          onPick={(id) => {
            setOpen(false);
            if (id === OPEN_FOLDER_ID) onOpenFolder();
            else onSelect(id);
          }}
        />
      </CodePopover>
    </div>
  );
}

// ---- Model picker ----

export function CodeModelPicker({
  models,
  selectedId,
  plan,
  side,
  disabled,
  onSelect,
}: {
  models: ModelEntry[];
  selectedId: string | null;
  plan: string;
  side: "up" | "down";
  disabled?: boolean;
  onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.id === selectedId) ?? null;

  const rows = useMemo(() => {
    const out: PickerRow[] = [];
    let provider: string | null = null;
    for (const model of models) {
      if (model.provider.displayName !== provider) {
        provider = model.provider.displayName;
        out.push({ kind: "header", label: provider });
      }
      const gate = gateModel(model, plan);
      out.push({
        kind: "option",
        id: model.id,
        label: model.displayName,
        selected: model.id === selectedId,
        disabled: !gate.selectable,
        ...(gate.reason ? { reason: gate.reason } : {}),
      });
    }
    return out;
  }, [models, plan, selectedId]);

  return (
    <div className="code-pop-wrap">
      <PickerPill
        label={selected?.displayName ?? "Choose model"}
        open={open}
        disabled={disabled ?? false}
        ariaLabel="Choose model"
        onToggle={() => setOpen((o) => !o)}
      />
      <CodePopover open={open} onClose={() => setOpen(false)} label="Models" side={side} width={300}>
        <PickerList
          rows={rows}
          label="Models"
          onPick={(id) => {
            setOpen(false);
            onSelect(id);
          }}
        />
      </CodePopover>
    </div>
  );
}

// ---- Permission-mode picker (full access confirms) ----

export function ModePicker({
  value,
  side,
  disabled,
  onChange,
}: {
  value: PermissionMode;
  side: "up" | "down";
  disabled?: boolean;
  onChange(mode: PermissionMode): void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const info = modeInfo(value);

  const rows: PickerRow[] = PERMISSION_MODES.map((m) => ({
    kind: "option",
    id: m.id,
    label: m.label,
    caption: m.description,
    selected: m.id === value,
    dotTone: m.tone,
  }));

  return (
    <div className="code-pop-wrap">
      <PickerPill
        label={info.label}
        icon={<span className="code-mode-dot" data-tone={info.tone} aria-hidden />}
        open={open}
        disabled={disabled ?? false}
        ariaLabel="Permission mode"
        onToggle={() => setOpen((o) => !o)}
        tone={value === "full" ? "destructive" : undefined}
      />
      <CodePopover
        open={open}
        onClose={() => setOpen(false)}
        label="Permission mode"
        side={side}
        width={300}
      >
        <PickerList
          rows={rows}
          label="Permission mode"
          onPick={(id) => {
            setOpen(false);
            if (id === "full") setConfirmingFull(true);
            else onChange(id as PermissionMode);
          }}
        />
      </CodePopover>
      <FullAccessDialog
        open={confirmingFull}
        onCancel={() => setConfirmingFull(false)}
        onConfirm={() => {
          setConfirmingFull(false);
          onChange("full");
        }}
      />
    </div>
  );
}

/** Explicit confirm before granting full access — reused by the sidebar too. */
export function FullAccessDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog
      title="Allow full access?"
      open={open}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-destructive" onClick={onConfirm}>
            Allow full access
          </button>
        </>
      }
    >
      <div className="code-full-warning">
        <ShieldAlert size={16} aria-hidden />
        <p>
          Full access lets Juno run most commands without asking — destructive commands still
          confirm.
        </p>
      </div>
    </Dialog>
  );
}
