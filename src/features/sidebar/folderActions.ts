/**
 * Folder writes. Folders have NO v1 mutation ops (see the v1 sync contract),
 * so writes go through legacy REST with optimistic dataStore updates and a
 * refetch of GET /api/folders after every write to restore server truth.
 */
import { api } from "@/lib/backend/http";
import type { ClientFolder } from "@/lib/data/entities";
import { useDataStore } from "@/state/dataStore";

export async function refetchFolders(): Promise<void> {
  const res = await api<{ folders: ClientFolder[] }>("/folders");
  useDataStore.getState().replaceFolders(res.folders);
}

export async function createFolder(name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return;
  const res = await api<{ folder: ClientFolder }>("/folders", {
    method: "POST",
    body: { name: trimmed },
  });
  useDataStore.getState().upsertFolder(res.folder);
  await refetchFolders();
}

export async function renameFolder(folder: ClientFolder, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed || trimmed === folder.name) return;
  useDataStore.getState().upsertFolder({ ...folder, name: trimmed });
  try {
    await api(`/folders/${encodeURIComponent(folder.id)}`, {
      method: "PATCH",
      body: { name: trimmed },
    });
  } finally {
    await refetchFolders();
  }
}

/** Delete a folder; its conversations fall back to unfiled (server nulls folderId via FK). */
export async function deleteFolder(folder: ClientFolder): Promise<void> {
  const store = useDataStore.getState();
  store.removeFolder(folder.id);
  for (const conversation of Object.values(store.conversations)) {
    if (conversation.folderId === folder.id) {
      store.upsertConversation({ ...conversation, folderId: null });
    }
  }
  try {
    await api(`/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
  } finally {
    await refetchFolders();
  }
}
