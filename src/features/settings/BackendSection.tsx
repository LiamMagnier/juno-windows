/** Backend (dev): environment switch and app version. */
import { useEffect, useState } from "react";
import {
  backendBaseUrl,
  backendEnvironment,
  setBackendEnvironment,
  type BackendEnvironment,
} from "@/lib/backend/config";
import { hostInfo, type HostInfo } from "@/lib/host";
import { useAuthStore } from "@/state/authStore";
import { SectionTitle, SettingRow } from "./controls";

const ENVIRONMENTS: Array<{ value: BackendEnvironment; label: string }> = [
  { value: "production", label: "Production" },
  { value: "local", label: "Local" },
];

export function BackendSection() {
  const [environment, setEnvironment] = useState<BackendEnvironment>(backendEnvironment());
  const [pending, setPending] = useState<BackendEnvironment | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostInfo()
      .then((info) => {
        if (!cancelled) setHost(info);
      })
      .catch(() => {
        // Host info is display-only; leave the row empty on failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPending = () => {
    if (pending === null) return;
    setBackendEnvironment(pending);
    setEnvironment(pending);
    setPending(null);
    // Tokens are bound to the issuing backend; switching requires sign-in.
    void useAuthStore.getState().signOut();
  };

  return (
    <section className="settings-section" aria-label="Backend">
      <SectionTitle>Backend (dev)</SectionTitle>

      <SettingRow label="Environment" hint={backendBaseUrl()}>
        <select
          className="settings-select"
          value={pending ?? environment}
          aria-label="Backend environment"
          onChange={(e) => {
            const next = e.target.value as BackendEnvironment;
            if (next === environment) setPending(null);
            else setPending(next);
          }}
        >
          {ENVIRONMENTS.map((env) => (
            <option key={env.value} value={env.value}>
              {env.label}
            </option>
          ))}
          {environment === "custom" ? <option value="custom">Custom</option> : null}
        </select>
      </SettingRow>

      {pending !== null ? (
        <div className="settings-confirm">
          <p>Switching backends signs you out on this device. Continue?</p>
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={applyPending}>
              Switch and sign out
            </button>
          </div>
        </div>
      ) : null}

      <SettingRow label="App version">
        <span className="settings-value">
          {host ? `${host.appVersion} · ${host.platform} ${host.arch}` : "—"}
        </span>
      </SettingRow>
    </section>
  );
}
