/** Thin typed wrappers over the privileged Rust command surface. */
import { invoke } from "@tauri-apps/api/core";

export interface HostInfo {
  deviceName: string;
  platform: string;
  arch: string;
  appVersion: string;
}

export function hostInfo(): Promise<HostInfo> {
  return invoke<HostInfo>("host_info");
}

export type SecretKey = "refresh-token" | "installation-id" | "workspace-grants";

export function secretSet(key: SecretKey, value: string): Promise<void> {
  return invoke("secret_set", { key, value });
}

export function secretGet(key: SecretKey): Promise<string | null> {
  return invoke<string | null>("secret_get", { key });
}

export function secretDelete(key: SecretKey): Promise<void> {
  return invoke("secret_delete", { key });
}
