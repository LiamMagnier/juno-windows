/**
 * Attachment uploads. Multipart POST /api/upload must not carry a browser
 * Origin header (backend middleware rejects cross-origin), so uploads run
 * through the Rust transport: by path (drag-drop / file picker give real
 * paths in Tauri) or by bytes (clipboard paste).
 */
import { invoke } from "@tauri-apps/api/core";
import { errorFromBody } from "../backend/http";
import { BackendError } from "../backend/types";
import type { ClientAttachment } from "./entities";

interface RustUploadResponse {
  status: number;
  body: string;
}

export interface UploadTarget {
  conversationId?: string;
  projectId?: string;
}

async function finish(promise: Promise<RustUploadResponse>): Promise<ClientAttachment> {
  let res: RustUploadResponse;
  try {
    res = await promise;
  } catch (err) {
    const commandError = err as { code?: string; message?: string };
    throw new BackendError(0, commandError.code ?? "upload_failed", commandError.message ?? "Upload failed");
  }
  if (res.status < 200 || res.status >= 300) {
    throw errorFromBody(res.status, res.body);
  }
  const parsed = JSON.parse(res.body) as { attachment: ClientAttachment };
  return parsed.attachment;
}

/** Upload a file the OS gave us a path for (picker / drag-drop). */
export function uploadByPath(path: string, target: UploadTarget = {}): Promise<ClientAttachment> {
  return finish(
    invoke<RustUploadResponse>("api_upload_path", {
      path,
      conversationId: target.conversationId ?? null,
      projectId: target.projectId ?? null,
    }),
  );
}

/** Upload in-memory bytes (e.g. a pasted image). */
export function uploadBytes(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
  target: UploadTarget = {},
): Promise<ClientAttachment> {
  return finish(
    invoke<RustUploadResponse>("api_upload_bytes", {
      fileName,
      mimeType,
      bytes: Array.from(bytes),
      conversationId: target.conversationId ?? null,
      projectId: target.projectId ?? null,
    }),
  );
}
