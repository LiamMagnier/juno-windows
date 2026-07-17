/**
 * Scheduled tasks panel — CRUD over /api/tasks.
 *
 * Wire shapes and behaviors from the backend scheduled-tasks contract:
 * cadence DAILY|WEEKDAYS|WEEKLY|MONTHLY with hour/minute/weekday(0=Sun)/
 * monthday(1-28) + IANA timezone; enabled toggle PATCHes optimistically;
 * plan gates surface as 403 plan_locked / task_limit. Results land in a
 * normal chat conversation linked from each row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Globe,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/backend/http";
import { BackendError } from "@/lib/backend/types";
import { Dialog } from "@/components/Dialog";
import { useContextMenu } from "@/components/ContextMenu";
import { useDataStore } from "@/state/dataStore";
import { useThreadStore } from "@/state/threadStore";
import { useUiStore } from "@/state/uiStore";
import "./tasks.css";

type TaskCadence = "DAILY" | "WEEKDAYS" | "WEEKLY" | "MONTHLY";

interface TaskRunSummary {
  id: string;
  status: "running" | "done" | "error" | "budget";
  error: string | null;
  costMicroUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

interface TaskItem {
  id: string;
  name: string;
  prompt: string;
  model: string;
  modelName: string;
  cadence: TaskCadence;
  hour: number;
  minute: number;
  weekday: number | null;
  monthday: number | null;
  timezone: string;
  webSearch: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  conversationId: string | null;
  createdAt: string;
  latestRun: TaskRunSummary | null;
}

interface TasksResponse {
  tasks: TaskItem[];
  limit: number;
}

const CADENCES: Array<{ id: TaskCadence; label: string }> = [
  { id: "DAILY", label: "Daily" },
  { id: "WEEKDAYS", label: "Weekdays" },
  { id: "WEEKLY", label: "Weekly" },
  { id: "MONTHLY", label: "Monthly" },
];

/** Server stores 0=Sun…6=Sat; the picker renders Monday-first. */
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, max: 2, max20: 3, owner: 4 };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function describeSchedule(task: TaskItem): string {
  const time = `${pad(task.hour)}:${pad(task.minute)}`;
  let base: string;
  switch (task.cadence) {
    case "DAILY":
      base = `Daily at ${time}`;
      break;
    case "WEEKDAYS":
      base = `Weekdays at ${time}`;
      break;
    case "WEEKLY":
      base = `Weekly on ${WEEKDAY_LABELS[task.weekday ?? 0] ?? "Sunday"} at ${time}`;
      break;
    case "MONTHLY":
      base = `Monthly on the ${ordinal(task.monthday ?? 1)} at ${time}`;
      break;
  }
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return task.timezone === localZone ? base : `${base} (${task.timezone})`;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const unit = (n: number, u: string) => (diff < 0 ? `${n}${u} ago` : `in ${n}${u}`);
  if (abs < 60_000) return diff < 0 ? "just now" : "in under a minute";
  if (abs < 3_600_000) return unit(Math.round(abs / 60_000), "m");
  if (abs < 86_400_000) return unit(Math.round(abs / 3_600_000), "h");
  if (abs < 7 * 86_400_000) return unit(Math.round(abs / 86_400_000), "d");
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof BackendError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Arrow-key navigation across [data-row] elements inside the list. */
function handleListArrows(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-row]"));
  if (rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const current = rows.findIndex((r) => r === active || (active !== null && r.contains(active)));
  e.preventDefault();
  const next =
    current < 0
      ? 0
      : e.key === "ArrowDown"
        ? Math.min(rows.length - 1, current + 1)
        : Math.max(0, current - 1);
  rows[next]?.focus();
}

interface TaskFormState {
  name: string;
  prompt: string;
  model: string;
  cadence: TaskCadence;
  weekday: number;
  monthday: number;
  time: string; // "HH:MM"
  timezone: string;
  webSearch: boolean;
}

function formFromTask(task: TaskItem | null, defaultModel: string): TaskFormState {
  if (!task) {
    return {
      name: "",
      prompt: "",
      model: defaultModel,
      cadence: "DAILY",
      weekday: 1,
      monthday: 1,
      time: "09:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webSearch: true,
    };
  }
  return {
    name: task.name,
    prompt: task.prompt,
    model: task.model,
    cadence: task.cadence,
    weekday: task.weekday ?? 1,
    monthday: task.monthday ?? 1,
    time: `${pad(task.hour)}:${pad(task.minute)}`,
    timezone: task.timezone,
    webSearch: task.webSearch,
  };
}

function StatusChip({ run }: { run: TaskRunSummary }) {
  const cost =
    run.status === "done" && run.costMicroUsd > 0
      ? ` · $${(run.costMicroUsd / 1_000_000).toFixed(2)}`
      : "";
  if (run.status === "running") {
    return <span className="tasks-chip tasks-chip-running">Running now…</span>;
  }
  if (run.status === "done") {
    return (
      <span className="tasks-chip tasks-chip-success">
        Success{cost}
      </span>
    );
  }
  return (
    <span
      className="tasks-chip tasks-chip-error"
      title={run.error ?? undefined}
    >
      {run.status === "budget" ? "Skipped" : "Failed"}
    </span>
  );
}

export function TasksPanel() {
  const manifest = useDataStore((s) => s.manifest);
  const subscription = useDataStore((s) => s.subscription);
  const settings = useDataStore((s) => s.settings);
  const contextMenu = useContextMenu();

  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [planLocked, setPlanLocked] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaskItem | null>(null);
  const [form, setForm] = useState<TaskFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<TaskItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const mounted = useRef(true);

  const chatModels = useMemo(() => {
    const rank = PLAN_RANK[subscription?.plan ?? "free"] ?? 0;
    return (manifest?.models ?? []).filter(
      (m) =>
        m.availability === "available" &&
        m.lifecycle !== "deprecated" &&
        m.modalities.output.includes("text") &&
        (PLAN_RANK[m.minimumPlan] ?? 0) <= rank,
    );
  }, [manifest, subscription]);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [Intl.DateTimeFormat().resolvedOptions().timeZone];
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<TasksResponse>("/tasks");
      if (!mounted.current) return;
      setTasks(data.tasks);
      setLimit(data.limit);
      setPlanLocked(false);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof BackendError && err.status === 403) {
        setPlanLocked(true);
        setTasks([]);
      } else {
        setLoadError(errorMessage(err, "Couldn't load scheduled tasks."));
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const openCreate = () => {
    setEditing(null);
    setForm(
      formFromTask(
        null,
        settings?.defaultModel && chatModels.some((m) => m.id === settings.defaultModel)
          ? settings.defaultModel
          : (chatModels[0]?.id ?? ""),
      ),
    );
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (task: TaskItem) => {
    setEditing(task);
    setForm(formFromTask(task, task.model));
    setFormError(null);
    setDialogOpen(true);
  };

  const openConversation = (conversationId: string) => {
    useUiStore.getState().setView({ kind: "chat" });
    const threads = useThreadStore.getState();
    threads.setActive(conversationId);
    void threads.openThread(conversationId);
  };

  const toggleEnabled = async (task: TaskItem) => {
    const nextEnabled = !task.enabled;
    setRowError(null);
    setTasks((prev) =>
      (prev ?? []).map((t) => (t.id === task.id ? { ...t, enabled: nextEnabled } : t)),
    );
    try {
      const res = await api<{ task: TaskItem }>(`/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: { enabled: nextEnabled },
      });
      if (!mounted.current) return;
      setTasks((prev) => (prev ?? []).map((t) => (t.id === task.id ? res.task : t)));
    } catch (err) {
      if (!mounted.current) return;
      setTasks((prev) => (prev ?? []).map((t) => (t.id === task.id ? task : t)));
      setRowError(errorMessage(err, "Couldn't update the task."));
    }
  };

  const submitForm = async () => {
    if (!form || saving) return;
    const [hourStr, minuteStr] = form.time.split(":");
    const hour = Number(hourStr);
    const minute = Number(minuteStr);
    if (!form.name.trim()) {
      setFormError("Give the task a name.");
      return;
    }
    if (!form.prompt.trim()) {
      setFormError("Write a prompt for the task to run.");
      return;
    }
    if (!form.model) {
      setFormError("Pick a chat model for this task.");
      return;
    }
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      setFormError("Pick a time for the task.");
      return;
    }
    setSaving(true);
    setFormError(null);
    const body = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      model: form.model,
      cadence: form.cadence,
      hour,
      minute,
      weekday: form.cadence === "WEEKLY" ? form.weekday : null,
      monthday: form.cadence === "MONTHLY" ? form.monthday : null,
      timezone: form.timezone,
      webSearch: form.webSearch,
    };
    try {
      if (editing) {
        const res = await api<{ task: TaskItem }>(`/tasks/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body,
        });
        if (!mounted.current) return;
        setTasks((prev) => (prev ?? []).map((t) => (t.id === editing.id ? res.task : t)));
      } else {
        const res = await api<{ task: TaskItem }>("/tasks", { method: "POST", body });
        if (!mounted.current) return;
        setTasks((prev) => [...(prev ?? []), res.task]);
      }
      setDialogOpen(false);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof BackendError && err.status === 403 && limit === 0) {
        // plan_locked: the whole feature is gated, not just this save.
        setDialogOpen(false);
        setPlanLocked(true);
      } else {
        setFormError(errorMessage(err, "Couldn't save the task."));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api(`/tasks/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      if (!mounted.current) return;
      setTasks((prev) => (prev ?? []).filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      if (mounted.current) setDeleteError(errorMessage(err, "Couldn't delete the task."));
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  };

  const openRowMenu = (e: React.MouseEvent, task: TaskItem) => {
    e.preventDefault();
    contextMenu.open(
      [
        { id: "edit", label: "Edit", icon: <Pencil size={16} />, onSelect: () => openEdit(task) },
        ...(task.conversationId
          ? [
              {
                id: "open",
                label: "View results",
                icon: <MessageSquare size={16} />,
                onSelect: () => openConversation(task.conversationId!),
              },
            ]
          : []),
        {
          id: "delete",
          label: "Delete",
          icon: <Trash2 size={16} />,
          destructive: true,
          separatorBefore: true,
          onSelect: () => setDeleteTarget(task),
        },
      ],
      e.clientX,
      e.clientY,
    );
  };

  const atLimit = tasks !== null && limit > 0 && tasks.length >= limit;
  const locked = planLocked || (limit === 0 && tasks !== null && tasks.length === 0 && !loading && !loadError);

  return (
    <div className="tasks-panel">
      <div className="tasks-inner">
        <header className="tasks-header">
          <div>
            <h1 className="tasks-title">Scheduled tasks</h1>
            <p className="tasks-subtitle">
              Juno runs a prompt for you on a schedule and posts the results in a chat.
            </p>
          </div>
          {tasks !== null && !locked ? (
            <div className="tasks-header-actions">
              <span className="tasks-count">
                {tasks.length} of {limit}
              </span>
              <button
                type="button"
                className="btn btn-primary tasks-new"
                onClick={openCreate}
                disabled={atLimit}
              >
                <Plus size={16} aria-hidden />
                New task
              </button>
            </div>
          ) : null}
        </header>

        {atLimit ? (
          <p className="tasks-note">
            Your plan allows {limit} scheduled {limit === 1 ? "task" : "tasks"}. Delete one to make
            room.
          </p>
        ) : null}
        {rowError ? (
          <p className="tasks-error-text" role="alert">
            {rowError}
          </p>
        ) : null}

        {loadError && tasks === null ? (
          <div className="tasks-error">
            <p>{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : tasks === null ? (
          <p className="tasks-loading" role="status">
            Loading tasks…
          </p>
        ) : locked ? (
          <div className="tasks-empty">
            <CalendarClock size={20} aria-hidden />
            <h2>Scheduled tasks need a paid plan</h2>
            <p>
              Upgrade to schedule recurring prompts — a morning briefing, a weekly digest, or
              anything else Juno can do on its own.
            </p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="tasks-empty">
            <CalendarClock size={20} aria-hidden />
            <h2>No scheduled tasks yet</h2>
            <p>
              Create one and Juno will run your prompt on a schedule — daily, on weekdays, weekly,
              or monthly — and post each result in a chat.
            </p>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              New task
            </button>
          </div>
        ) : (
          <ul className="tasks-list" onKeyDown={handleListArrows} aria-label="Scheduled tasks">
            {tasks.map((task) => (
              <li
                key={task.id}
                data-row
                tabIndex={-1}
                className={`tasks-row${task.enabled ? "" : " tasks-row-paused"}`}
                onContextMenu={(e) => openRowMenu(e, task)}
              >
                <div className="tasks-row-main">
                  <p className="tasks-row-name">
                    {task.name}
                    {task.webSearch ? (
                      <Globe size={14} aria-label="Web search enabled" className="tasks-globe" />
                    ) : null}
                  </p>
                  <p className="tasks-row-schedule">
                    {describeSchedule(task)} · {task.modelName}
                  </p>
                  <p className="tasks-row-meta">
                    {!task.enabled && task.latestRun?.status !== "running" ? (
                      <span className="tasks-chip tasks-chip-paused">Paused</span>
                    ) : task.latestRun ? (
                      <StatusChip run={task.latestRun} />
                    ) : (
                      <span>First run {relativeTime(task.nextRunAt)}</span>
                    )}
                    {task.enabled ? <span>Next run {relativeTime(task.nextRunAt)}</span> : null}
                    {task.lastRunAt ? <span>Last run {relativeTime(task.lastRunAt)}</span> : null}
                    {task.conversationId ? (
                      <button
                        type="button"
                        className="tasks-link"
                        onClick={() => openConversation(task.conversationId!)}
                      >
                        View results
                      </button>
                    ) : null}
                  </p>
                </div>
                <div className="tasks-row-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={task.enabled}
                    aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
                    className="tasks-switch"
                    onClick={() => void toggleEnabled(task)}
                  >
                    <span className="tasks-switch-thumb" />
                  </button>
                  <button
                    type="button"
                    className="tasks-icon-btn"
                    aria-label={`Edit ${task.name}`}
                    onClick={() => openEdit(task)}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="tasks-icon-btn tasks-icon-btn-destructive"
                    aria-label={`Delete ${task.name}`}
                    onClick={() => setDeleteTarget(task)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog
        title={editing ? "Edit task" : "New task"}
        open={dialogOpen && form !== null}
        onClose={() => {
          if (!saving) setDialogOpen(false);
        }}
        width={520}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submitForm()}
              disabled={saving}
            >
              {saving ? "Saving…" : editing ? "Save" : "Create task"}
            </button>
          </>
        }
      >
        {form ? (
          <div className="tasks-form">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                value={form.name}
                maxLength={80}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Morning briefing"
              />
            </label>
            <label className="field">
              <span className="field-label">Prompt</span>
              <textarea
                value={form.prompt}
                maxLength={4000}
                rows={4}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="What should Juno do each time this runs?"
              />
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              >
                {chatModels.length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  chatModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="tasks-form-grid">
              <label className="field">
                <span className="field-label">Repeats</span>
                <select
                  value={form.cadence}
                  onChange={(e) => setForm({ ...form, cadence: e.target.value as TaskCadence })}
                >
                  {CADENCES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {form.cadence === "WEEKLY" ? (
                <label className="field">
                  <span className="field-label">Day</span>
                  <select
                    value={form.weekday}
                    onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
                  >
                    {WEEKDAY_ORDER.map((d) => (
                      <option key={d} value={d}>
                        {WEEKDAY_LABELS[d]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {form.cadence === "MONTHLY" ? (
                <label className="field">
                  <span className="field-label">Day of month</span>
                  <select
                    value={form.monthday}
                    onChange={(e) => setForm({ ...form, monthday: Number(e.target.value) })}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {ordinal(d)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field">
                <span className="field-label">Time</span>
                <input
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Timezone</span>
              <select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <div className="tasks-form-switch">
              <span>Search the web during runs</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.webSearch}
                aria-label="Search the web during runs"
                className="tasks-switch"
                onClick={() => setForm({ ...form, webSearch: !form.webSearch })}
              >
                <span className="tasks-switch-thumb" />
              </button>
            </div>
            {formError ? (
              <p className="tasks-error-text" role="alert">
                {formError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        title={`Delete ${deleteTarget?.name ?? "task"}`}
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleteBusy) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              disabled={deleteBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </button>
          </>
        }
      >
        <p>The schedule stops and its run history is removed. Past results stay in your chats.</p>
        {deleteError ? (
          <p className="tasks-error-text" role="alert">
            {deleteError}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
