/**
 * Backend environment selection. Mirrors the Mac app's BackendConfiguration:
 * production by default, editable local/preview URLs for development.
 * Non-secret, so plain localStorage is fine.
 */

export type BackendEnvironment = "production" | "local" | "custom";

const PRODUCTION_URL = "https://chat.liams.dev";
const LOCAL_URL = "http://localhost:3000";
const STORAGE_KEY = "juno.backend";

interface StoredBackend {
  environment: BackendEnvironment;
  customUrl?: string;
}

function load(): StoredBackend {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoredBackend;
  } catch {
    // fall through to default
  }
  return { environment: "production" };
}

let current = load();

export function backendEnvironment(): BackendEnvironment {
  return current.environment;
}

export function backendBaseUrl(): string {
  switch (current.environment) {
    case "production":
      return PRODUCTION_URL;
    case "local":
      return LOCAL_URL;
    case "custom":
      return (current.customUrl ?? PRODUCTION_URL).replace(/\/+$/, "");
  }
}

export function setBackendEnvironment(environment: BackendEnvironment, customUrl?: string): void {
  current = customUrl === undefined ? { environment } : { environment, customUrl };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
}

export function apiUrl(path: string): string {
  return `${backendBaseUrl()}/api${path.startsWith("/") ? path : `/${path}`}`;
}
