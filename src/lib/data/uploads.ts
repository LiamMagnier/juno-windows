/**
 * Attachment uploads. Multipart POST /api/upload must not carry a browser
 * Origin header (backend middleware rejects cross-origin), so uploads run
 * through the Rust transport: by path (drag-drop / file picker give real
 * paths in Tauri) or by bytes (clipboard paste).
 */
import { invoke } from "@tauri-apps/api/core";
import type { ClientAttachment } from "./entities";

export interface UploadResult {
  attachment: ClientAttachment;
}

/** Upload a file the OS gave us a path for (picker / drag-drop). */
export async function uploadByPath(path: string): Promise<ClientAttachment> {
  const res = await invoke<UploadResult>("api_upload_path", { path });
  return res.attachment;
}

/** Upload in-memory bytes (e.g. a pasted image). */
export async function uploadBytes(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ClientAttachment> {
  const res = await invoke<UploadResult>("api_upload_bytes", {
    fileName,
    mimeType,
    bytes: Array.from(bytes),
  });
  return res.attachment;
}
