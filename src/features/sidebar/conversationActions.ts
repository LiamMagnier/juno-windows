/**
 * Conversation writes from the sidebar: optimistic store change first, then
 * the matching v1 mutation (conversation.* ops cover rename, pinned,
 * projectId, folderId and delete — see the v1 sync contract).
 */
import type { ClientConversation } from "@/lib/data/entities";
import { enqueueMutation } from "@/lib/data/mutationQueue";
import { useDataStore } from "@/state/dataStore";
import { emptyThread, useThreadStore } from "@/state/threadStore";
import { useUiStore } from "@/state/uiStore";

/** Show the chat pane (switching mode if needed) and select a conversation. */
export function openConversation(id: string): void {
  const ui = useUiStore.getState();
  if (ui.mode !== "chat") ui.setMode("chat");
  ui.setView({ kind: "chat" });
  const threads = useThreadStore.getState();
  if (threads.privateMode) {
    // Picking a saved conversation leaves private mode and discards the
    // private transcript entirely.
    threads.patchThread("private", { ...emptyThread });
    threads.setPrivateMode(false);
  }
  threads.setActive(id);
}

export function startNewChat(): void {
  const ui = useUiStore.getState();
  if (ui.mode !== "chat") ui.setMode("chat");
  ui.setView({ kind: "chat" });
  const threads = useThreadStore.getState();
  if (threads.privateMode) {
    // "New chat" inside private mode resets the transcript but stays private.
    threads.patchThread("private", { ...emptyThread });
  }
  threads.setActive(null);
}

export function renameConversation(conversation: ClientConversation, title: string): void {
  const trimmed = title.trim().slice(0, 200);
  if (!trimmed || trimmed === conversation.title) return;
  useDataStore
    .getState()
    .upsertConversation({ ...conversation, title: trimmed, titleSource: "user" });
  void enqueueMutation({ type: "conversation.rename", entityId: conversation.id, title: trimmed });
}

export function setConversationPinned(conversation: ClientConversation, pinned: boolean): void {
  useDataStore.getState().upsertConversation({ ...conversation, pinned });
  void enqueueMutation({
    type: "conversation.update",
    entityId: conversation.id,
    patch: { pinned },
  });
}

export function moveConversationToProject(
  conversation: ClientConversation,
  projectId: string | null,
): void {
  useDataStore.getState().upsertConversation({ ...conversation, projectId });
  void enqueueMutation({
    type: "conversation.update",
    entityId: conversation.id,
    patch: { projectId },
  });
}

export function moveConversationToFolder(
  conversation: ClientConversation,
  folderId: string | null,
): void {
  useDataStore.getState().upsertConversation({ ...conversation, folderId });
  void enqueueMutation({
    type: "conversation.update",
    entityId: conversation.id,
    patch: { folderId },
  });
}

export function deleteConversation(conversation: ClientConversation): void {
  const threads = useThreadStore.getState();
  if (threads.activeConversationId === conversation.id) {
    threads.setActive(null);
    useUiStore.getState().setView({ kind: "chat" });
  }
  useDataStore.getState().removeConversation(conversation.id);
  void enqueueMutation({ type: "conversation.delete", entityId: conversation.id });
}
