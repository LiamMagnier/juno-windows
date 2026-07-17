/**
 * Folders section: expandable folders with their conversations, inline
 * create/rename, and delete with confirm (conversations fall back to
 * unfiled). Folder writes are legacy REST — see folderActions.ts.
 */
import { useState } from "react";
import { ChevronRight, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useContextMenu, type MenuItem } from "@/components/ContextMenu";
import type { ClientConversation, ClientFolder } from "@/lib/data/entities";
import { useDataStore } from "@/state/dataStore";
import { byLastMessageDesc } from "./dateGroups";
import { createFolder, deleteFolder, refetchFolders, renameFolder } from "./folderActions";
import { ConversationRow, RenameInput } from "./ConversationRow";

export interface FoldersSectionProps {
  activeId: string | null;
  isStreaming(id: string): boolean;
  renamingConversationId: string | null;
  onStartRenameConversation(id: string): void;
  onFinishRenameConversation(): void;
  onRequestDeleteConversation(conversation: ClientConversation): void;
}

export function FoldersSection({
  activeId,
  isStreaming,
  renamingConversationId,
  onStartRenameConversation,
  onFinishRenameConversation,
  onRequestDeleteConversation,
}: FoldersSectionProps) {
  const folders = useDataStore((s) => s.folders);
  const conversations = useDataStore((s) => s.conversations);
  const menu = useContextMenu();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClientFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = Object.values(folders).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The folder change didn't save.");
    } finally {
      setBusy(false);
    }
  };

  const conversationsIn = (folderId: string): ClientConversation[] =>
    Object.values(conversations)
      .filter((c) => c.kind === "chat" && !c.archivedAt && c.folderId === folderId)
      .sort(byLastMessageDesc);

  const openFolderMenu = (folder: ClientFolder, x: number, y: number) => {
    const items: MenuItem[] = [
      {
        id: "rename",
        label: "Rename",
        icon: <Pencil size={16} />,
        onSelect: () => setRenamingFolderId(folder.id),
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={16} />,
        destructive: true,
        onSelect: () => setPendingDelete(folder),
      },
    ];
    menu.open(items, x, y);
  };

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header">
        <span>Folders</span>
        <button
          type="button"
          className="sidebar-icon-btn"
          aria-label="New folder"
          title="New folder"
          onClick={() => setCreating(true)}
        >
          <FolderPlus size={16} />
        </button>
      </div>

      {error ? (
        <div className="sidebar-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="sidebar-error-retry"
            onClick={() => {
              setError(null);
              void refetchFolders().catch(() => setError("Couldn't reload folders."));
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {creating ? (
        <div className="sidebar-folder">
          <ChevronRight size={14} className="sidebar-folder-chevron" aria-hidden />
          <RenameInput
            initial=""
            ariaLabel="Folder name"
            onCommit={(name) => {
              setCreating(false);
              if (name.trim()) void run(() => createFolder(name));
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}

      {sorted.length === 0 && !creating ? (
        <div className="sidebar-hint">No folders yet</div>
      ) : null}

      {sorted.map((folder) => {
        const open = expanded[folder.id] === true;
        const items = conversationsIn(folder.id);
        return (
          <div key={folder.id}>
            <div
              className="sidebar-folder"
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => setExpanded((s) => ({ ...s, [folder.id]: !open }))}
              onContextMenu={(e) => {
                e.preventDefault();
                openFolderMenu(folder, e.clientX, e.clientY);
              }}
              onKeyDown={(e) => {
                if (renamingFolderId === folder.id) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded((s) => ({ ...s, [folder.id]: !open }));
                } else if (e.key === "F2") {
                  e.preventDefault();
                  setRenamingFolderId(folder.id);
                } else if (e.key === "Delete") {
                  e.preventDefault();
                  setPendingDelete(folder);
                }
              }}
            >
              <ChevronRight
                size={14}
                className="sidebar-folder-chevron"
                data-open={open || undefined}
                aria-hidden
              />
              {renamingFolderId === folder.id ? (
                <RenameInput
                  initial={folder.name}
                  ariaLabel="Rename folder"
                  onCommit={(name) => {
                    setRenamingFolderId(null);
                    void run(() => renameFolder(folder, name));
                  }}
                  onCancel={() => setRenamingFolderId(null)}
                />
              ) : (
                <>
                  <span className="sidebar-convo-title">{folder.name}</span>
                  <span className="sidebar-folder-count">{items.length}</span>
                </>
              )}
            </div>
            {open ? (
              <div className="sidebar-folder-items">
                {items.length === 0 ? (
                  <div className="sidebar-hint">No chats in this folder</div>
                ) : (
                  items.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === activeId}
                      streaming={isStreaming(conversation.id)}
                      renaming={renamingConversationId === conversation.id}
                      onStartRename={() => onStartRenameConversation(conversation.id)}
                      onFinishRename={onFinishRenameConversation}
                      onRequestDelete={() => onRequestDeleteConversation(conversation)}
                    />
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}

      <Dialog
        title="Delete folder"
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              disabled={busy}
              onClick={() => {
                const folder = pendingDelete;
                setPendingDelete(null);
                if (folder) void run(() => deleteFolder(folder));
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p>
          Delete "{pendingDelete?.name}"? Chats inside move back to the main list.
        </p>
      </Dialog>
    </div>
  );
}
