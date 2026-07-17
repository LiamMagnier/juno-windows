/**
 * Memory panel — what Juno remembers about the account.
 *
 * Reads dataStore.memories/memorySummary (kept fresh by the sync engine),
 * refetches GET /api/memory on mount, and writes through the mutation queue
 * (memory.create/update/delete, settings.update). Natural-language editing
 * is the two-phase propose/apply flow from POST /api/memory/edit(+/apply),
 * with one-shot undo via the returned inverse operations. Backfill is the
 * client-driven POST loop over /api/memory/backfill.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "@/lib/backend/http";
import { BackendError } from "@/lib/backend/types";
import type { MemoryEntry, MemorySummary } from "@/lib/data/entities";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";
import { useContextMenu } from "@/components/ContextMenu";
import "./memory.css";

interface MemoryListResponse {
  memories: MemoryEntry[];
  summary: MemorySummary | null;
}

type MemoryOperation =
  | { op: "add"; content: string; suppress?: boolean }
  | { op: "update"; id: string; before: string; content: string }
  | { op: "remove"; id: string; before: string };

interface EditProposal {
  summary: string;
  operations: MemoryOperation[];
}

interface ApplyResponse {
  memories: MemoryEntry[];
  summary: MemorySummary | null;
  inverse: MemoryOperation[];
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

export function MemoryPanel() {
  const memories = useDataStore((s) => s.memories);
  const summary = useDataStore((s) => s.memorySummary);
  const settings = useDataStore((s) => s.settings);
  const replaceMemories = useDataStore((s) => s.replaceMemories);
  const upsertMemory = useDataStore((s) => s.upsertMemory);
  const removeMemory = useDataStore((s) => s.removeMemory);
  const setSettings = useDataStore((s) => s.setSettings);
  const contextMenu = useContextMenu();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  // Natural-language edit flow.
  const [nlDraft, setNlDraft] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [inverse, setInverse] = useState<MemoryOperation[] | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);

  // Backfill.
  const [backfillRemaining, setBackfillRemaining] = useState<number | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillProcessed, setBackfillProcessed] = useState(0);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const mounted = useRef(true);

  const entries = useMemo(() => {
    const list = Object.values(memories).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const q = query.trim().toLowerCase();
    return q ? list.filter((m) => m.content.toLowerCase().includes(q)) : list;
  }, [memories, query]);
  const hasAny = Object.keys(memories).length > 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<MemoryListResponse>("/memory");
      if (!mounted.current) return;
      replaceMemories(data.memories, data.summary);
      try {
        const backfill = await api<{ remaining: number }>("/memory/backfill");
        if (mounted.current) setBackfillRemaining(backfill.remaining);
      } catch {
        // Backfill availability is optional; the panel still works without it.
      }
    } catch (err) {
      if (mounted.current) setLoadError(errorMessage(err, "Couldn't load memory."));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [replaceMemories]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const memoryDisabled = settings?.memoryEnabled === false;

  const enableMemory = () => {
    if (settings) setSettings({ ...settings, memoryEnabled: true });
    void enqueueMutation({ type: "settings.update", patch: { memoryEnabled: true } });
  };

  const addMemory = () => {
    const content = addDraft.trim();
    if (!content) return;
    const clientEntityId = crypto.randomUUID();
    upsertMemory({
      id: clientEntityId,
      content,
      source: "MANUAL",
      kind: "FACT",
      createdAt: new Date().toISOString(),
    });
    void enqueueMutation({ type: "memory.create", clientEntityId, content });
    setAddDraft("");
  };

  const startEdit = (entry: MemoryEntry) => {
    setEditingId(entry.id);
    setEditDraft(entry.content);
  };

  const saveEdit = (entry: MemoryEntry) => {
    const content = editDraft.trim();
    setEditingId(null);
    if (!content || content === entry.content) return;
    upsertMemory({ ...entry, content });
    void enqueueMutation({ type: "memory.update", entityId: entry.id, content });
  };

  const deleteEntry = (entry: MemoryEntry) => {
    removeMemory(entry.id);
    void enqueueMutation({ type: "memory.delete", entityId: entry.id });
  };

  const regenerate = async () => {
    setRegenBusy(true);
    setRegenError(null);
    try {
      await api("/memory/consolidate", { method: "POST" });
      const data = await api<MemoryListResponse>("/memory");
      if (mounted.current) replaceMemories(data.memories, data.summary);
    } catch (err) {
      if (mounted.current) setRegenError(errorMessage(err, "Couldn't regenerate the summary."));
    } finally {
      if (mounted.current) setRegenBusy(false);
    }
  };

  const submitInstruction = async () => {
    const instruction = nlDraft.trim();
    if (!instruction || nlBusy) return;
    setNlBusy(true);
    setNlError(null);
    setRefusal(null);
    setProposal(null);
    setInverse(null);
    try {
      const res = await api<{ proposal?: EditProposal; refusal?: string }>("/memory/edit", {
        method: "POST",
        body: { instruction },
      });
      if (!mounted.current) return;
      if (res.refusal) setRefusal(res.refusal);
      else if (res.proposal) setProposal(res.proposal);
      else setNlError("Juno didn't suggest any changes.");
    } catch (err) {
      if (mounted.current) setNlError(errorMessage(err, "Couldn't draft that edit."));
    } finally {
      if (mounted.current) setNlBusy(false);
    }
  };

  const applyOperations = async (operations: MemoryOperation[], undo: boolean) => {
    const setBusy = undo ? setUndoBusy : setApplyBusy;
    setBusy(true);
    setNlError(null);
    try {
      const res = await api<ApplyResponse>("/memory/edit/apply", {
        method: "POST",
        body: { operations },
      });
      if (!mounted.current) return;
      replaceMemories(res.memories, res.summary);
      if (undo) {
        setInverse(null);
      } else {
        setProposal(null);
        setNlDraft("");
        setInverse(res.inverse);
      }
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof BackendError && err.status === 409) {
        setProposal(null);
        setInverse(null);
        setNlError(err.message);
        void refresh();
      } else {
        setNlError(errorMessage(err, "Couldn't apply the changes."));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const runBackfill = async () => {
    setBackfillBusy(true);
    setBackfillError(null);
    setBackfillProcessed(0);
    try {
      let remaining = backfillRemaining ?? 0;
      let processed = 0;
      while (remaining > 0 && mounted.current) {
        const res = await api<{ processedConversations: number; created: number; remaining: number }>(
          "/memory/backfill",
          { method: "POST" },
        );
        processed += res.processedConversations;
        remaining = res.remaining;
        if (!mounted.current) return;
        setBackfillProcessed(processed);
        setBackfillRemaining(remaining);
      }
      const data = await api<MemoryListResponse>("/memory");
      if (mounted.current) replaceMemories(data.memories, data.summary);
    } catch (err) {
      if (mounted.current) setBackfillError(errorMessage(err, "Backfill stopped early."));
    } finally {
      if (mounted.current) setBackfillBusy(false);
    }
  };

  const openRowMenu = (e: React.MouseEvent, entry: MemoryEntry) => {
    e.preventDefault();
    contextMenu.open(
      [
        { id: "edit", label: "Edit", icon: <Pencil size={16} />, onSelect: () => startEdit(entry) },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash2 size={16} />,
          destructive: true,
          separatorBefore: true,
          onSelect: () => deleteEntry(entry),
        },
      ],
      e.clientX,
      e.clientY,
    );
  };

  return (
    <div className="memory-panel">
      <div className="memory-inner">
        <header className="memory-header">
          <h1 className="memory-title">Memory</h1>
          <p className="memory-subtitle">What Juno remembers about you across conversations.</p>
        </header>

        {memoryDisabled ? (
          <div className="memory-empty">
            <Sparkles size={20} aria-hidden />
            <h2>Memory is off</h2>
            <p>
              When memory is on, Juno learns from your chats and uses what it knows to
              personalize replies. Nothing new is saved while it's off.
            </p>
            <button type="button" className="btn btn-primary" onClick={enableMemory}>
              Enable memory
            </button>
          </div>
        ) : (
          <>
            <section className="memory-summary" aria-label="Memory summary">
              <div className="memory-summary-head">
                <h2>Summary</h2>
                <button
                  type="button"
                  className="btn btn-secondary memory-regen"
                  onClick={() => void regenerate()}
                  disabled={regenBusy}
                >
                  <RefreshCw size={16} className={regenBusy ? "memory-spin" : undefined} aria-hidden />
                  {regenBusy ? "Regenerating…" : "Regenerate"}
                </button>
              </div>
              {summary ? (
                <>
                  <p className="memory-summary-content selectable">{summary.content}</p>
                  <p className="memory-summary-meta">
                    {summary.entryCount} {summary.entryCount === 1 ? "entry" : "entries"} · updated{" "}
                    {relativeTime(summary.updatedAt)}
                  </p>
                </>
              ) : (
                <p className="memory-summary-meta">
                  No summary yet. Regenerate to distill your memories into one.
                </p>
              )}
              {regenError ? (
                <p className="memory-error-text" role="alert">
                  {regenError}
                </p>
              ) : null}
            </section>

            {backfillRemaining !== null && backfillRemaining > 0 ? (
              <section className="memory-backfill" aria-label="Memory backfill">
                <div>
                  <p className="memory-backfill-title">
                    {backfillRemaining}{" "}
                    {backfillRemaining === 1 ? "conversation" : "conversations"} not yet distilled
                  </p>
                  <p className="memory-backfill-meta">
                    {backfillBusy
                      ? `Processing… ${backfillProcessed} done, ${backfillRemaining} to go`
                      : "Process past conversations so Juno can learn from them."}
                  </p>
                  {backfillError ? (
                    <p className="memory-error-text" role="alert">
                      {backfillError}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void runBackfill()}
                  disabled={backfillBusy}
                >
                  {backfillBusy ? "Processing…" : "Process"}
                </button>
              </section>
            ) : null}

            <section className="memory-nl" aria-label="Edit memory with an instruction">
              <form
                className="memory-nl-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitInstruction();
                }}
              >
                <Sparkles size={16} aria-hidden className="memory-nl-icon" />
                <input
                  value={nlDraft}
                  onChange={(e) => setNlDraft(e.target.value)}
                  placeholder="Tell Juno what to change…"
                  aria-label="Tell Juno what to change in memory"
                  disabled={nlBusy}
                  maxLength={600}
                />
                <button type="submit" className="btn btn-secondary" disabled={nlBusy || !nlDraft.trim()}>
                  {nlBusy ? "Drafting…" : "Draft changes"}
                </button>
              </form>
              {nlError ? (
                <p className="memory-error-text" role="alert">
                  {nlError}
                </p>
              ) : null}
              {refusal ? (
                <p className="memory-note" role="status">
                  {refusal}
                </p>
              ) : null}
              {inverse ? (
                <div className="memory-undo" role="status">
                  <span>Changes applied.</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void applyOperations(inverse, true)}
                    disabled={undoBusy}
                  >
                    <Undo2 size={16} aria-hidden />
                    {undoBusy ? "Undoing…" : "Undo"}
                  </button>
                </div>
              ) : null}
              {proposal ? (
                <div className="memory-proposal" aria-label="Proposed memory changes">
                  <p className="memory-proposal-summary">{proposal.summary}</p>
                  <ul className="memory-proposal-ops">
                    {proposal.operations.map((op, i) => (
                      <li key={i} className={`memory-op memory-op-${op.op}`}>
                        {op.op === "add" ? (
                          <>
                            <span className="memory-op-tag">Add</span>
                            <span className="memory-op-after">{op.content}</span>
                            {op.suppress ? (
                              <span className="memory-suppression-label">Won't remember</span>
                            ) : null}
                          </>
                        ) : op.op === "update" ? (
                          <>
                            <span className="memory-op-tag">Update</span>
                            <span className="memory-op-before">{op.before}</span>
                            <span className="memory-op-after">{op.content}</span>
                          </>
                        ) : (
                          <>
                            <span className="memory-op-tag">Remove</span>
                            <span className="memory-op-before">{op.before}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="memory-proposal-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setProposal(null)}
                      disabled={applyBusy}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void applyOperations(proposal.operations, false)}
                      disabled={applyBusy}
                    >
                      {applyBusy ? "Applying…" : "Apply"}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <div className="memory-toolbar">
              <form
                className="memory-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  addMemory();
                }}
              >
                <input
                  value={addDraft}
                  onChange={(e) => setAddDraft(e.target.value)}
                  placeholder="Add something Juno should remember…"
                  aria-label="Add a memory"
                  maxLength={500}
                />
                <button type="submit" className="btn btn-primary" disabled={!addDraft.trim()}>
                  <Plus size={16} aria-hidden />
                  Add
                </button>
              </form>
              <div className="memory-search">
                <Search size={16} aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search memories"
                  aria-label="Search memories"
                />
              </div>
            </div>

            {loadError && !hasAny ? (
              <div className="memory-error">
                <p>{loadError}</p>
                <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            ) : loading && !hasAny ? (
              <p className="memory-loading" role="status">
                Loading memories…
              </p>
            ) : entries.length === 0 ? (
              <div className="memory-empty">
                {hasAny ? (
                  <p>No memories match your search.</p>
                ) : (
                  <>
                    <h2>No memories yet</h2>
                    <p>Juno learns as you chat, or you can add something above to get started.</p>
                  </>
                )}
              </div>
            ) : (
              <ul className="memory-list" onKeyDown={handleListArrows} aria-label="Memories">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    data-row
                    tabIndex={-1}
                    className={`memory-row${entry.kind === "SUPPRESSION" ? " memory-row-suppression" : ""}`}
                    onContextMenu={(e) => openRowMenu(e, entry)}
                  >
                    {editingId === entry.id ? (
                      <div className="memory-edit">
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          maxLength={500}
                          aria-label="Edit memory"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit(entry);
                            } else if (e.key === "Escape") {
                              setEditingId(null);
                            }
                          }}
                        />
                        <div className="memory-edit-actions">
                          <button
                            type="button"
                            className="memory-icon-btn"
                            aria-label="Save changes"
                            onClick={() => saveEdit(entry)}
                          >
                            <Check size={16} />
                          </button>
                          <button
                            type="button"
                            className="memory-icon-btn"
                            aria-label="Cancel editing"
                            onClick={() => setEditingId(null)}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="memory-row-main">
                          <p className="memory-row-content selectable">{entry.content}</p>
                          <p className="memory-row-meta">
                            <span className="memory-badge">
                              {entry.source === "MANUAL" ? "Added by you" : "From chats"}
                            </span>
                            {entry.kind === "SUPPRESSION" ? (
                              <span className="memory-suppression-label">Won't remember</span>
                            ) : null}
                            <span>{relativeTime(entry.createdAt)}</span>
                          </p>
                        </div>
                        <div className="memory-row-actions">
                          <button
                            type="button"
                            className="memory-icon-btn"
                            aria-label={`Edit memory: ${entry.content.slice(0, 40)}`}
                            onClick={() => startEdit(entry)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="memory-icon-btn memory-icon-btn-destructive"
                            aria-label={`Delete memory: ${entry.content.slice(0, 40)}`}
                            onClick={() => deleteEntry(entry)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
