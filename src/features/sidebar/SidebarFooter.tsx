/**
 * Account footer: profile, sync status, settings, and a quota mini-meter
 * when the plan has a finite message limit. Quiet "Relaunch to update" chip
 * when an update is staged (Mac-style — never a modal popup).
 */
import { ArrowUpCircle, LoaderCircle, Settings } from "lucide-react";
import { useAuthStore } from "@/state/authStore";
import { useDataStore } from "@/state/dataStore";
import { useUiStore } from "@/state/uiStore";
import { useUpdateStore } from "@/lib/updater";
import { DotIdenticon } from "@/components/signature/DotMatrix";

export function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const profile = useAuthStore((s) => s.profile);
  const syncPhase = useDataStore((s) => s.syncPhase);
  const syncError = useDataStore((s) => s.syncError);
  const quota = useDataStore((s) => s.quota);
  const openSettings = useUiStore((s) => s.openSettings);
  const updatePhase = useUpdateStore((s) => s.phase);
  const relaunchToUpdate = useUpdateStore((s) => s.relaunchToUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);

  const name = profile?.name ?? profile?.email ?? "Account";
  const seed = profile?.email ?? profile?.name ?? "juno";

  const avatar = profile?.image ? (
    <img className="sidebar-avatar" src={profile.image} alt="" />
  ) : (
    <DotIdenticon seed={seed} size={28} className="sidebar-avatar" />
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

  const updateChip =
    updatePhase.kind === "ready" ? (
      <button
        type="button"
        className="sidebar-update-chip"
        onClick={() => void relaunchToUpdate()}
      >
        <ArrowUpCircle size={14} aria-hidden />
        Relaunch to update — Juno {updatePhase.version} is ready
      </button>
    ) : updatePhase.kind === "downloading" ? (
      <div className="sidebar-update-chip" data-progress role="status">
        <LoaderCircle size={14} className="sidebar-spin" aria-hidden />
        Downloading Juno {updatePhase.version}…
        <span className="sidebar-update-bar" aria-hidden>
          <span style={{ width: `${Math.round(updatePhase.progress * 100)}%` }} />
        </span>
      </div>
    ) : updatePhase.kind === "available" ? (
      <button
        type="button"
        className="sidebar-update-chip"
        onClick={() => void downloadAndInstall()}
      >
        <ArrowUpCircle size={14} aria-hidden />
        Update available — Juno {updatePhase.version}
      </button>
    ) : null;

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

      {updateChip}

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
