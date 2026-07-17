/** Devices: list native device sessions, revoke non-current ones. */
import { useCallback, useEffect, useState } from "react";
import { Laptop, Smartphone, Monitor } from "lucide-react";
import { api } from "@/lib/backend/http";
import type { DeviceSession } from "@/lib/backend/types";
import { SectionTitle } from "./controls";

function relativeTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (abs < minute) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < hour) return rtf.format(Math.round(diff / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  return rtf.format(Math.round(diff / day), "day");
}

function deviceIcon(platform: string | undefined) {
  const p = (platform ?? "").toLowerCase();
  if (p.includes("ios") || p.includes("android")) return <Smartphone size={16} aria-hidden />;
  if (p.includes("mac")) return <Laptop size={16} aria-hidden />;
  return <Monitor size={16} aria-hidden />;
}

export function DevicesSection() {
  const [devices, setDevices] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ devices: DeviceSession[] }>("/v1/auth/devices");
      setDevices(res.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load devices.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setRevoking(id);
    setActionError(null);
    try {
      await api(`/v1/auth/devices/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't revoke the device.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="settings-section" aria-label="Devices">
      <SectionTitle>Devices</SectionTitle>
      <p className="settings-muted">Everywhere your account is signed in to the Juno app.</p>

      {devices === null && error === null ? (
        <p className="settings-muted">Loading devices…</p>
      ) : null}

      {error !== null ? (
        <>
          <p className="settings-muted">{error}</p>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </>
      ) : null}

      {devices !== null && devices.length === 0 ? (
        <p className="settings-muted">No devices yet. Sign in on another device to see it here.</p>
      ) : null}

      {devices !== null && devices.length > 0 ? (
        <ul className="settings-devices">
          {devices.map((d) => {
            const revoked = d.revokedAt != null;
            const lastSeen = relativeTime(d.lastSeenAt);
            const revokedAt = relativeTime(d.revokedAt ?? undefined);
            return (
              <li key={d.id} className={`settings-device${revoked ? " is-revoked" : ""}`}>
                <span className="settings-device-icon">{deviceIcon(d.platform)}</span>
                <div className="settings-device-text">
                  <span className="settings-device-name">
                    {d.name}
                    {d.current ? <span className="settings-chip">This device</span> : null}
                  </span>
                  <span className="settings-device-meta">
                    {[
                      d.platform,
                      d.appVersion ? `v${d.appVersion}` : null,
                      revoked
                        ? `Revoked${revokedAt ? ` ${revokedAt}` : ""}`
                        : lastSeen
                          ? `Active ${lastSeen}`
                          : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {!revoked && !d.current ? (
                  <button
                    type="button"
                    className="btn btn-secondary settings-device-revoke"
                    disabled={revoking !== null}
                    onClick={() => void revoke(d.id)}
                  >
                    {revoking === d.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {actionError ? <p className="settings-error">{actionError}</p> : null}
    </section>
  );
}
