/**
 * Project file upload. The backend contract (POST /api/upload) links a file
 * to a project via an optional `projectId` multipart field — there is no
 * separate attach step. The shared uploadByPath helper forwards projectId
 * through the Rust transport, which sends it as that multipart field.
 */
import type { ClientAttachment } from "@/lib/data/entities";
import { uploadByPath } from "@/lib/data/uploads";

export function uploadProjectFileByPath(
  path: string,
  projectId: string,
): Promise<ClientAttachment> {
  return uploadByPath(path, { projectId });
}
