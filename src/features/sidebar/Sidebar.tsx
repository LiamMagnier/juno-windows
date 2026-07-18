/**
 * Chat-mode sidebar: mode switcher, new chat, search (Ctrl+K palette),
 * nav rows, folders, date-grouped conversations, account footer.
 * Code mode renders the CodeSidebarSlot placeholder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  CodeXml,
  Folder,
  MessageSquare,
  NotebookPen,
  Plug,
  Plus,
  Search,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { ClientConversation } from "@/lib/data/entities";
import { isGenerating } from "@/lib/chat/chatEngine";
import { useDataStore } from "@/state/dataStore";
import { useThreadStore } from "@/state/threadStore";
import { useUiStore, type AppMode, type MainView } from "@/state/uiStore";
import { byLastMessageDesc, groupByDate } from "./dateGroups";
import { deleteConversation, startNewChat } from "./conversationActions";
import { CodeSidebarSlot } from "./CodeSidebarSlot";
import { ConversationList } from "./ConversationList";
import { FoldersSection } from "./FoldersSection";
import { SearchPalette } from "./SearchPalette";
import { SidebarFooter } from "./SidebarFooter";
import "./sidebar.css";

interface NavRow {
  key: string;
  label: string;
  icon: React.ReactNode;
  view: MainView;
  selected(view: MainView): boolean;
}

const NAV_ROWS: NavRow[] = [
  {
    key: "projects",
    label: "Projects",
    icon: <Folder size={16} />,
    view: { kind: "projects" },
    selected: (v) => v.kind === "projects" || v.kind === "project",
  },
  {
    key: "memory",
    label: "Memory",
    icon: <NotebookPen size={16} />,
    view: { kind: "memory" },
    selected: (v) => v.kind === "memory",
  },
  {
    key: "connectors",
    label: "Connectors",
    icon: <Plug size={16} />,
    view: { kind: "connectors" },
    selected: (v) => v.kind === "connectors",
  },
  {
    key: "tasks",
    label: "Scheduled tasks",
    icon: <Clock size={16} />,
    view: { kind: "tasks" },
    selected: (v) => v.kind === "tasks",
  },
];

export function Sidebar({ mode, collapsed }: { mode: AppMode; collapsed: boolean }) {
  const setMode = useUiStore((s) => s.setMode);
  const [searchOpen, setSearchOpen] = useState(false);
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const codeTabRef = useRef<HTMLButtonElement>(null);

  // Tablist keyboard pattern: arrows move between the two mode tabs.
  const switchMode = (next: AppMode) => {
    setMode(next);
    (next === "chat" ? chatTabRef : codeTabRef).current?.focus();
  };
  const onModeKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "ArrowRight" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowUp"
    ) {
      e.preventDefault();
      switchMode(mode === "chat" ? "code" : "chat");
    } else if (e.key === "Home") {
      e.preventDefault();
      switchMode("chat");
    } else if (e.key === "End") {
      e.preventDefault();
      switchMode("code");
    }
  };

  // Global Ctrl+K toggles the search palette.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="sidebar" data-collapsed={collapsed || undefined}>
      <div
        className="sidebar-modes"
        role="tablist"
        aria-label="App mode"
        onKeyDown={onModeKeyDown}
      >
        <button
          ref={chatTabRef}
          type="button"
          role="tab"
          aria-selected={mode === "chat"}
          aria-label="Chat"
          title={collapsed ? "Chat" : undefined}
          tabIndex={mode === "chat" ? 0 : -1}
          className="sidebar-mode"
          onClick={() => setMode("chat")}
        >
          <MessageSquare size={15} aria-hidden />
          {!collapsed ? <span>Chat</span> : null}
        </button>
        <button
          ref={codeTabRef}
          type="button"
          role="tab"
          aria-selected={mode === "code"}
          aria-label="Code"
          title={collapsed ? "Code" : undefined}
          tabIndex={mode === "code" ? 0 : -1}
          className="sidebar-mode"
          onClick={() => setMode("code")}
        >
          <CodeXml size={15} aria-hidden />
          {!collapsed ? <span>Code</span> : null}
        </button>
      </div>

      {mode === "code" ? (
        <CodeSidebarSlot />
      ) : collapsed ? (
        <CollapsedRail onOpenSearch={() => setSearchOpen(true)} />
      ) : (
        <ChatSidebarContent onOpenSearch={() => setSearchOpen(true)} />
      )}

      {mode === "chat" ? <SidebarFooter collapsed={collapsed} /> : null}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function CollapsedRail({ onOpenSearch }: { onOpenSearch(): void }) {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <div className="sidebar-rail">
      <button
        type="button"
        className="sidebar-rail-btn sidebar-rail-primary"
        aria-label="New chat"
        title="New chat"
        onClick={startNewChat}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="sidebar-rail-btn"
        aria-label="Search chats"
        title="Search chats (Ctrl+K)"
        onClick={onOpenSearch}
      >
        <Search size={16} />
      </button>
      {NAV_ROWS.map((row) => (
        <button
          key={row.key}
          type="button"
          className="sidebar-rail-btn"
          aria-label={row.label}
          title={row.label}
          data-selected={row.selected(view) || undefined}
          aria-current={row.selected(view) ? "page" : undefined}
          onClick={() => setView(row.view)}
        >
          {row.icon}
        </button>
      ))}
    </div>
  );
}

function ChatSidebarContent({ onOpenSearch }: { onOpenSearch(): void }) {
  const conversations = useDataStore((s) => s.conversations);
  const hydrated = useDataStore((s) => s.hydrated);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const activeId = useThreadStore((s) => s.activeConversationId);
  const threads = useThreadStore((s) => s.threads);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClientConversation | null>(null);

  const { pinned, groups } = useMemo(() => {
    const unfiled = Object.values(conversations)
      .filter((c) => c.kind === "chat" && !c.archivedAt && !c.folderId)
      .sort(byLastMessageDesc);
    return {
      pinned: unfiled.filter((c) => c.pinned),
      groups: groupByDate(unfiled.filter((c) => !c.pinned)),
    };
  }, [conversations]);

  const isStreaming = (id: string): boolean => {
    const status = threads[id]?.status;
    return (status !== undefined && status !== "idle") || isGenerating(id);
  };

  const requestDelete = (conversation: ClientConversation) => setPendingDelete(conversation);

  return (
    <>
      <div className="sidebar-scroll">
        <div className="sidebar-top-actions">
          <button type="button" className="sidebar-row sidebar-newchat" onClick={startNewChat}>
            <span className="sidebar-action-icon"><Plus size={15} aria-hidden /></span>
            New chat
          </button>
          <button type="button" className="sidebar-row sidebar-search" onClick={onOpenSearch}>
            <Search size={15} aria-hidden />
            Search
            <kbd className="sidebar-kbd">Ctrl K</kbd>
          </button>
        </div>

        <div className="sidebar-section-label">Workspace</div>
        <nav className="sidebar-nav" aria-label="Sections">
          {NAV_ROWS.map((row) => (
            <button
              key={row.key}
              type="button"
              className="sidebar-row"
              data-selected={row.selected(view) || undefined}
              aria-current={row.selected(view) ? "page" : undefined}
              onClick={() => setView(row.view)}
            >
              {row.icon}
              {row.label}
            </button>
          ))}
        </nav>

        <FoldersSection
          activeId={activeId}
          isStreaming={isStreaming}
          renamingConversationId={renamingId}
          onStartRenameConversation={setRenamingId}
          onFinishRenameConversation={() => setRenamingId(null)}
          onRequestDeleteConversation={requestDelete}
        />

        <div className="sidebar-section">
          <ConversationList
            pinned={pinned}
            groups={groups}
            activeId={activeId}
            hydrated={hydrated}
            isStreaming={isStreaming}
            renamingId={renamingId}
            onStartRename={setRenamingId}
            onFinishRename={() => setRenamingId(null)}
            onRequestDelete={requestDelete}
          />
        </div>
      </div>

      <Dialog
        title="Delete chat"
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => {
                const conversation = pendingDelete;
                setPendingDelete(null);
                if (conversation) deleteConversation(conversation);
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p>
          This permanently removes "{pendingDelete?.title}" and its messages.
        </p>
      </Dialog>
    </>
  );
}
