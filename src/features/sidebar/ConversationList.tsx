/**
 * The main conversation list: Pinned section then date groups, as an ARIA
 * listbox with roving tabindex. Enter opens, F2 renames, Delete deletes
 * (confirm handled by the parent).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { LoaderCircle, Pin } from "lucide-react";
import type { ClientConversation } from "@/lib/data/entities";
import type { ConversationGroup } from "./dateGroups";
import { openConversation } from "./conversationActions";
import { ConversationRow } from "./ConversationRow";

export interface ConversationListProps {
  pinned: ClientConversation[];
  groups: ConversationGroup[];
  activeId: string | null;
  hydrated: boolean;
  isStreaming(id: string): boolean;
  renamingId: string | null;
  onStartRename(id: string): void;
  onFinishRename(): void;
  onRequestDelete(conversation: ClientConversation): void;
}

export function ConversationList({
  pinned,
  groups,
  activeId,
  hydrated,
  isStreaming,
  renamingId,
  onStartRename,
  onFinishRename,
  onRequestDelete,
}: ConversationListProps) {
  const flat = useMemo(
    () => [...pinned, ...groups.flatMap((g) => g.items)],
    [pinned, groups],
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const clampedFocus = Math.min(focusIndex, Math.max(0, flat.length - 1));

  const focusRow = useCallback(
    (index: number) => {
      const target = flat[index];
      if (!target) return;
      setFocusIndex(index);
      rowRefs.current.get(target.id)?.focus();
    },
    [flat],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(Math.min(clampedFocus + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(Math.max(clampedFocus - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(flat.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target) openConversation(target.id);
    } else if (e.key === "F2") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target) onStartRename(target.id);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const target = flat[clampedFocus];
      if (target && !isStreaming(target.id)) onRequestDelete(target);
    }
  };

  if (!hydrated) {
    return (
      <div className="sidebar-hint" role="status">
        <LoaderCircle size={16} className="sidebar-spin" aria-hidden />
        Loading chats
      </div>
    );
  }

  if (flat.length === 0) {
    return <div className="sidebar-hint">No chats yet. Start a new chat to begin.</div>;
  }

  const renderRow = (conversation: ClientConversation) => {
    const index = flat.indexOf(conversation);
    return (
      <ConversationRow
        key={conversation.id}
        conversation={conversation}
        active={conversation.id === activeId}
        streaming={isStreaming(conversation.id)}
        renaming={renamingId === conversation.id}
        onStartRename={() => {
          setFocusIndex(index);
          onStartRename(conversation.id);
        }}
        onFinishRename={onFinishRename}
        onRequestDelete={() => onRequestDelete(conversation)}
        option={{
          focusable: index === clampedFocus,
          onFocusRow: () => setFocusIndex(index),
          registerRef: (el) => {
            if (el) rowRefs.current.set(conversation.id, el);
            else rowRefs.current.delete(conversation.id);
          },
        }}
      />
    );
  };

  return (
    <div role="listbox" aria-label="Chats" className="sidebar-convos" onKeyDown={onKeyDown}>
      {pinned.length > 0 ? (
        <div role="group" aria-label="Pinned">
          <div className="sidebar-group-label">
            <Pin size={12} aria-hidden />
            Pinned
          </div>
          {pinned.map(renderRow)}
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          <div className="sidebar-group-label">{group.label}</div>
          {group.items.map(renderRow)}
        </div>
      ))}
    </div>
  );
}
