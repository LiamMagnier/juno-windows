/**
 * Attachment `url` values are pre-resolved by the server but may be
 * origin-relative ("/api/files/<key>") — resolve those against the backend
 * base URL since the webview does not share the server's origin.
 */
import { backendBaseUrl } from "@/lib/backend/config";

export function fileUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${backendBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
}
