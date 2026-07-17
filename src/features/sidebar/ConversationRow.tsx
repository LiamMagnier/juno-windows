/**
 * One conversation row: title, streaming dot / pin glyph, hover overflow
 * menu, right-click context menu, inline rename. Used by the main list
 * (listbox options with roving tabindex) and inside folders.
 */
import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useContextMenu, type MenuItem } from "@/components/ContextMenu";
import type { ClientConversation } from "@/lib/data/entities";
import { useDataStore } from "@/state/dataStore";
import {
  moveConversationToFolder,
  moveConversationToProject,
  openConversation,
  renameConversation,
  setConversationPinned,
} from "./conversationActions";

export interface ConversationRowProps {
  conversation: ClientConversation;
  active: boolean;
  streaming: boolean;
  renaming: boolean;
  onStartRename(): void;
  onFinishRename(): void;
  onRequestDelete(): void;
  /** Listbox mode: option semantics + parent-managed roving tabindex. */
  option?: {
    focusable: boolean;
    onFocusRow(): void;
    registerRef(el: HTMLDivElement | null): void;
  };
}

export function ConversationRow({
  conversation,
  active,
  streaming,
  renaming,
  onStartRename,
  onFinishRename,
  onRequestDelete,
  option,
}: ConversationRowProps) {
  const menu = useContextMenu();
  const anchor = useRef({ x: 0, y: 0 });

  const openSecondMenu = (items: MenuItem[]) => {
    // Re-open at the same anchor after the first menu closes.
    setTimeout(() => menu.open(items, anchor.current.x, anchor.current.y), 0);
  };

  const buildProjectItems = (): MenuItem[] => {
    const projects = Object.values(useDataStore.getState().projects).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const items: MenuItem[] = [];
    if (conversation.projectId !== null) {
      items.push({
        id: "project-none",
        label: "No project",
        onSelect: () => moveConversationToProject(conversation, null),
      });
    }
    for (const project of projects) {
      items.push({
        id: `project-${project.id}`,
        label: project.name,
        disabled: project.id === conversation.projectId,
        onSelect: () => moveConversationToProject(conversation, project.id),
      });
    }
    if (items.length === 0) {
      items.push({ id: "project-empty", label: "No projects yet", disabled: true, onSelect: () => {} });
    }
    return items;
  };

  const buildFolderItems = (): MenuItem[] => {
    const folders = Object.values(useDataStore.getState().folders).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const items: MenuItem[] = [];
    if (conversation.folderId !== null) {
      items.push({
        id: "folder-none",
        label: "No folder",
        onSelect: () => moveConversationToFolder(conversation, null),
      });
    }
    for (const folder of folders) {
      items.push({
        id: `folder-${folder.id}`,
        label: folder.name,
        disabled: folder.id === conversation.folderId,
        onSelect: () => moveConversationToFolder(conversation, folder.id),
      });
    }
    if (items.length === 0) {
      items.push({ id: "folder-empty", label: "No folders yet", disabled: true, onSelect: () => {} });
    }
    return items;
  };

  const openMenu = (x: number, y: number) => {
    anchor.current = { x, y };
    const items: MenuItem[] = [
      { id: "rename", label: "Rename", icon: <Pencil size={16} />, onSelect: onStartRename },
      {
        id: "pin",
        label: conversation.pinned ? "Unpin" : "Pin",
        icon: conversation.pinned ? <PinOff size={16} /> : <Pin size={16} />,
        onSelect: () => setConversationPinned(conversation, !conversation.pinned),
      },
      {
        id: "move-project",
        label: "Move to project",
        icon: <FolderInput size={16} />,
        onSelect: () => openSecondMenu(buildProjectItems()),
      },
      {
        id: "move-folder",
        label: "Move to folder",
        icon: <Folder size={16} />,
        onSelect: () => openSecondMenu(buildFolderItems()),
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={16} />,
        destructive: true,
        separatorBefore: true,
        disabled: streaming,
        onSelect: onRequestDelete,
      },
    ];
    menu.open(items, x, y);
  };

  const rowProps = option
    ? {
        role: "option" as const,
        "aria-selected": active,
        tabIndex: option.focusable ? 0 : -1,
        onFocus: option.onFocusRow,
        ref: option.registerRef,
      }
    : {
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (renaming) return;
          if (e.key === "Enter") {
            e.preventDefault();
            openConversation(conversation.id);
          } else if (e.key === "F2") {
            e.preventDefault();
            onStartRename();
          } else if (e.key === "Delete" && !streaming) {
            e.preventDefault();
            onRequestDelete();
          }
        },
      };

  return (
    <div
      className="sidebar-convo"
      data-active={active || undefined}
      onClick={() => {
        if (!renaming) openConversation(conversation.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!renaming) openMenu(e.clientX, e.clientY);
      }}
      {...rowProps}
    >
      {renaming ? (
        <RenameInput
          initial={conversation.title}
          onCommit={(title) => {
            renameConversation(conversation, title);
            onFinishRename();
          }}
          onCancel={onFinishRename}
        />
      ) : (
        <>
          <span className="sidebar-convo-title">{conversation.title}</span>
          {streaming ? (
            <span className="sidebar-convo-dot" role="status" aria-label="Generating" />
          ) : conversation.pinned ? (
            <Pin size={12} className="sidebar-convo-pin" aria-hidden />
          ) : null}
          <button
            type="button"
            className="sidebar-convo-menu"
            aria-label="Conversation options"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openMenu(rect.left, rect.bottom + 4);
            }}
          >
            <MoreHorizontal size={16} />
          </button>
        </>
      )}
    </div>
  );
}

export function RenameInput({
  initial,
  onCommit,
  onCancel,
  ariaLabel = "Rename",
}: {
  initial: string;
  onCommit(value: string): void;
  onCancel(): void;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  const committed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  };

  return (
    <input
      ref={inputRef}
      className="sidebar-rename-input"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
    />
  );
}
