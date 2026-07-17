/**
 * Account footer: profile, sync status, settings, and a quota mini-meter
 * when the plan has a finite message limit.
 */
import { LoaderCircle, Settings } from "lucide-react";
import { useAuthStore } from "@/state/authStore";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";

export function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const profile = useAuthStore((s) => s.profile);
  const syncPhase = useDataStore((s) => s.syncPhase);
  const syncError = useDataStore((s) => s.syncError);
  const quota = useDataStore((s) => s.quota);
  const openSettings = useUiStore((s) => s.openSettings);

  const name = profile?.name ?? profile?.email ?? "Account";
  const initial = (profile?.name ?? profile?.email ?? "?").slice(0, 1).toUpperCase();

  const avatar = profile?.image ? (
    <img className="sidebar-avatar" src={profile.image} alt="" />
  ) : (
    <span className="sidebar-avatar sidebar-avatar-initial" aria-hidden>
      {initial}
    </span>
  );

  if (collapsed) {
    return (
      <div className="sidebar-footer" data-collapsed>
        <button
          type="button"
          className="sidebar-rail-btn"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings(true)}
        >
          {avatar}
        </button>
      </div>
    );
  }

  const meter =
    quota !== null && quota.limit !== null && Number.isFinite(quota.limit)
      ? { used: quota.used, limit: quota.limit }
      : null;
  const meterPct = meter && meter.limit > 0 ? Math.min(1, meter.used / meter.limit) : 0;

  return (
    <div className="sidebar-footer">
      {meter ? (
        <div className="sidebar-meter" title={`${meter.used} of ${meter.limit} messages used`}>
          <div className="sidebar-meter-track" aria-hidden>
            <div
              className="sidebar-meter-fill"
              data-warn={meterPct >= 0.9 || undefined}
              style={{ width: `${Math.round(meterPct * 100)}%` }}
            />
          </div>
          <span className="sidebar-meter-label">
            {meter.used} of {meter.limit} messages
          </span>
        </div>
      ) : null}

      {syncPhase === "offline" ? (
        <div className="sidebar-sync-note" data-tone="offline">
          Offline — changes will sync
        </div>
      ) : null}
      {syncPhase === "error" ? (
        <div className="sidebar-sync-note" data-tone="error" role="alert">
          {syncError ?? "Sync failed"}
        </div>
      ) : null}

      <div className="sidebar-account">
        {avatar}
        <div className="sidebar-account-text">
          <span className="sidebar-account-name">{name}</span>
          {profile?.email && profile.name ? (
            <span className="sidebar-account-email">{profile.email}</span>
          ) : null}
        </div>
        <SyncDot phase={syncPhase} error={syncError} />
        <button
          type="button"
          className="sidebar-icon-btn"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings(true)}
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
}

function SyncDot({ phase, error }: { phase: string; error: string | null }) {
  if (phase === "syncing" || phase === "hydrating") {
    return (
      <span role="status" aria-label="Syncing" title="Syncing">
        <LoaderCircle size={14} className="sidebar-spin" aria-hidden />
      </span>
    );
  }
  const tone = phase === "offline" ? "offline" : phase === "error" ? "error" : "ok";
  const label =
    phase === "offline"
      ? "Offline — changes will sync"
      : phase === "error"
        ? (error ?? "Sync failed")
        : "Synced";
  return <span className="sidebar-sync-dot" data-tone={tone} role="status" aria-label={label} title={label} />;
}
