/**
 * Ctrl+K search overlay. Server title search via GET /api/conversations?q=
 * (debounced 250ms; titles only — message bodies are encrypted at rest),
 * projects filtered client-side from the store by name.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Search } from "lucide-react";
import { registerOverlay } from "@/components/overlayStack";
import { api } from "@/lib/backend/http";
import type { ClientConversation, ProjectSummary } from "@/lib/data/entities";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import { byLastMessageDesc } from "./dateGroups";
import { openConversation } from "./conversationActions";

type PaletteItem =
  | { type: "conversation"; conversation: ClientConversation }
  | { type: "project"; project: ProjectSummary };

const DEBOUNCE_MS = 250;
const MAX_CONVERSATIONS = 8;
const MAX_PROJECTS = 5;

export function SearchPalette({ open, onClose }: { open: boolean; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [serverResults, setServerResults] = useState<ClientConversation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  const conversations = useDataStore((s) => s.conversations);
  const projects = useDataStore((s) => s.projects);

  const trimmed = query.trim();

  const runSearch = useCallback((term: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    api<{ conversations: ClientConversation[] }>(
      `/conversations?q=${encodeURIComponent(term)}`,
      { signal: controller.signal },
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setServerResults(res.conversations.filter((c) => c.kind === "chat"));
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Search failed.");
      });
  }, []);

  // Reset when opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setServerResults(null);
      setError(null);
      setLoading(false);
      setActiveIndex(0);
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  // aria-modal promises the rest of the app is inert: register on the overlay
  // stack and restore focus to the trigger element when the palette closes.
  useEffect(() => {
    if (!open) return;
    const overlay = registerOverlay();
    const previousFocus = document.activeElement as HTMLElement | null;
    return () => {
      overlay.unregister();
      previousFocus?.focus();
    };
  }, [open]);

  // Debounced server query.
  useEffect(() => {
    if (!open) return;
    if (!trimmed) {
      abortRef.current?.abort();
      setServerResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const timer = setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, trimmed, runSearch]);

  const conversationHits: ClientConversation[] = useMemo(() => {
    if (!trimmed) {
      return Object.values(conversations)
        .filter((c) => c.kind === "chat" && !c.archivedAt)
        .sort(byLastMessageDesc)
        .slice(0, MAX_CONVERSATIONS);
    }
    return (serverResults ?? []).slice(0, MAX_CONVERSATIONS);
  }, [trimmed, conversations, serverResults]);

  const projectHits: ProjectSummary[] = useMemo(() => {
    if (!trimmed) return [];
    const needle = trimmed.toLowerCase();
    return Object.values(projects)
      .filter((p) => p.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PROJECTS);
  }, [trimmed, projects]);

  const items: PaletteItem[] = useMemo(
    () => [
      ...conversationHits.map((conversation) => ({ type: "conversation", conversation }) as const),
      ...projectHits.map((project) => ({ type: "project", project }) as const),
    ],
    [conversationHits, projectHits],
  );

  const clampedActive = Math.min(activeIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${clampedActive}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedActive, items.length]);

  const select = (item: PaletteItem) => {
    onClose();
    if (item.type === "conversation") {
      openConversation(item.conversation.id);
    } else {
      const ui = useUiStore.getState();
      if (ui.mode !== "chat") ui.setMode("chat");
      ui.setView({ kind: "project", id: item.project.id });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[clampedActive];
      if (item) select(item);
    } else if (e.key === "Tab") {
      // Focus trap: cycle within the palette instead of tabbing behind the
      // scrim into content aria-modal declares inert.
      const root = paletteRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  if (!open) return null;

  let renderedIndex = -1;
  const renderItem = (item: PaletteItem) => {
    renderedIndex += 1;
    const index = renderedIndex;
    const label = item.type === "conversation" ? item.conversation.title : item.project.name;
    const key = item.type === "conversation" ? `c-${item.conversation.id}` : `p-${item.project.id}`;
    return (
      <div
        key={key}
        id={`sidebar-palette-item-${index}`}
        data-index={index}
        role="option"
        aria-selected={index === clampedActive}
        className="sidebar-palette-item"
        data-active={index === clampedActive || undefined}
        onPointerEnter={() => setActiveIndex(index)}
        onClick={() => select(item)}
      >
        <span className="sidebar-convo-title">{label}</span>
      </div>
    );
  };

  return createPortal(
    <div
      className="sidebar-palette-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={paletteRef}
        className="sidebar-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search chats"
        onKeyDown={onKeyDown}
      >
        <div className="sidebar-palette-inputrow">
          <Search size={16} aria-hidden />
          <input
            autoFocus
            className="sidebar-palette-input"
            placeholder="Search chats"
            aria-label="Search chats"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="sidebar-palette-list"
            aria-activedescendant={
              items.length > 0 ? `sidebar-palette-item-${clampedActive}` : undefined
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
          {loading ? <LoaderCircle size={16} className="sidebar-spin" aria-hidden /> : null}
        </div>

        <div className="sidebar-palette-results" id="sidebar-palette-list" role="listbox" ref={listRef}>
          {error ? (
            <div className="sidebar-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="sidebar-error-retry"
                onClick={() => runSearch(trimmed)}
              >
                Retry
              </button>
            </div>
          ) : null}

          {conversationHits.length > 0 ? (
            <div className="sidebar-palette-group-label">
              {trimmed ? "Conversations" : "Recent"}
            </div>
          ) : null}
          {conversationHits.map((conversation) => renderItem({ type: "conversation", conversation }))}

          {projectHits.length > 0 ? (
            <div className="sidebar-palette-group-label">Projects</div>
          ) : null}
          {projectHits.map((project) => renderItem({ type: "project", project }))}

          {!error && !loading && items.length === 0 ? (
            <div className="sidebar-hint">
              {trimmed ? `No results for "${trimmed}"` : "No chats yet"}
            </div>
          ) : null}
        </div>

        <div className="sidebar-palette-legend" aria-hidden>
          <span>Up and down to navigate</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
