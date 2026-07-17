/** Plan & usage: plan badge, quota bar, budget window meters, billing actions. */
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "@/lib/backend/http";
import type { ClientQuota, Plan } from "@/lib/data/entities";
import { useDataStore } from "@/state/dataStore";
import { SectionTitle } from "./controls";

interface UsageWindow {
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  pct: number;
  resetsAtMs: number;
}

interface ProfileUsage {
  quota: ClientQuota;
  spend: {
    spentMicroUsd: number;
    budgetMicroUsd: number | null;
    remainingMicroUsd: number | null;
    eurPerUsd: number | null;
    windows: { session: UsageWindow; weekly: UsageWindow };
    billing: { renewsAtMs: number | null; cancelAtPeriodEnd: boolean };
  };
}

const PLAN_NAMES: Record<Plan, string> = {
  FREE: "Free",
  PRO: "Pro",
  MAX: "Max x5",
  MAX20: "Max x20",
  OWNER: "Owner",
};

const PLAN_RANK: Record<Plan, number> = { FREE: 0, PRO: 1, MAX: 2, MAX20: 3, OWNER: 4 };

type CheckoutPlan = "PRO" | "MAX" | "MAX20";

const UPGRADE_TARGETS: Array<{ plan: CheckoutPlan; label: string }> = [
  { plan: "PRO", label: "Upgrade to Pro" },
  { plan: "MAX", label: "Upgrade to Max x5" },
  { plan: "MAX20", label: "Upgrade to Max x20" },
];

function formatMoney(microUsd: number, eurPerUsd: number | null | undefined): string {
  if (typeof eurPerUsd === "number" && eurPerUsd > 0) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(
      (microUsd * eurPerUsd) / 1_000_000,
    );
  }
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    microUsd / 1_000_000,
  );
}

function formatResetMoment(ms: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(ms),
  );
}

function BudgetMeter({
  title,
  window: win,
  eurPerUsd,
}: {
  title: string;
  window: UsageWindow;
  eurPerUsd: number | null;
}) {
  const pct = Math.max(0, Math.min(1, win.pct));
  return (
    <div className="settings-meter">
      <div className="settings-meter-head">
        <span className="settings-meter-title">{title}</span>
        <span className="settings-meter-detail">
          {win.budgetMicroUsd !== null
            ? `${formatMoney(win.spentMicroUsd, eurPerUsd)} of ${formatMoney(win.budgetMicroUsd, eurPerUsd)}`
            : formatMoney(win.spentMicroUsd, eurPerUsd)}
        </span>
      </div>
      <div
        className="settings-meter-track"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
      >
        <div
          className={`settings-meter-fill${pct >= 0.9 ? " is-warning" : ""}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <span className="settings-meter-foot">Resets {formatResetMoment(win.resetsAtMs)}</span>
    </div>
  );
}

export function PlanSection() {
  const subscription = useDataStore((s) => s.subscription);
  const storeQuota = useDataStore((s) => s.quota);
  const [usage, setUsage] = useState<ProfileUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    setError(null);
    try {
      const res = await api<ProfileUsage>("/profile/usage");
      hasLoaded.current = true;
      setUsage(res);
      useDataStore.getState().setQuota(res.quota);
    } catch (err) {
      if (!hasLoaded.current) {
        setError(err instanceof Error ? err.message : "Couldn't load usage.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Plan flips land via the Stripe webhook; refresh when the window refocuses
  // (e.g. the user returns from checkout in the browser).
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const startCheckout = async (plan: CheckoutPlan) => {
    setBusy(plan);
    setActionError(null);
    try {
      const res = await api<{ url: string }>("/stripe/checkout", {
        method: "POST",
        body: { plan },
      });
      await openUrl(res.url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't start checkout.");
    } finally {
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy("portal");
    setActionError(null);
    try {
      const res = await api<{ url: string }>("/stripe/portal", { method: "POST" });
      await openUrl(res.url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't open billing.");
    } finally {
      setBusy(null);
    }
  };

  const quota = usage?.quota ?? storeQuota;
  const plan: Plan = quota?.plan ?? "FREE";
  const spend = usage?.spend;
  const rank = PLAN_RANK[plan];
  const upgrades = plan === "OWNER" ? [] : UPGRADE_TARGETS.filter((t) => PLAN_RANK[t.plan] > rank);
  const subscriptionActive =
    subscription !== null &&
    subscription.plan !== "free" &&
    ["active", "trialing"].includes(subscription.status.toLowerCase());

  if (loading && !usage) {
    return (
      <section className="settings-section" aria-label="Plan and usage">
        <SectionTitle>Plan &amp; usage</SectionTitle>
        <p className="settings-muted">Loading usage…</p>
      </section>
    );
  }

  if (error && !usage) {
    return (
      <section className="settings-section" aria-label="Plan and usage">
        <SectionTitle>Plan &amp; usage</SectionTitle>
        <p className="settings-muted">{error}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-section" aria-label="Plan and usage">
      <SectionTitle
        trailing={<span className="settings-plan-badge">{PLAN_NAMES[plan]}</span>}
      >
        Plan &amp; usage
      </SectionTitle>

      {spend?.billing.renewsAtMs ? (
        <p className="settings-muted">
          {spend.billing.cancelAtPeriodEnd
            ? `Access ends ${formatDay(spend.billing.renewsAtMs)}`
            : `Renews ${formatDay(spend.billing.renewsAtMs)}`}
        </p>
      ) : null}

      {quota && quota.limit !== null ? (
        <div className="settings-meter">
          <div className="settings-meter-head">
            <span className="settings-meter-title">Messages</span>
            <span className="settings-meter-detail">
              {quota.used} of {quota.limit}
            </span>
          </div>
          <div
            className="settings-meter-track"
            role="progressbar"
            aria-label="Messages"
            aria-valuemin={0}
            aria-valuemax={quota.limit}
            aria-valuenow={Math.min(quota.used, quota.limit)}
          >
            <div
              className="settings-meter-fill"
              style={{
                width: `${quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 100}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {spend ? (
        spend.budgetMicroUsd === null ? (
          <p className="settings-muted">No usage limits on this plan.</p>
        ) : (
          <>
            <BudgetMeter
              title="Current session (5-hour)"
              window={spend.windows.session}
              eurPerUsd={spend.eurPerUsd}
            />
            <BudgetMeter
              title="Weekly (7-day)"
              window={spend.windows.weekly}
              eurPerUsd={spend.eurPerUsd}
            />
          </>
        )
      ) : null}

      {upgrades.length > 0 || subscriptionActive ? (
        <div className="settings-actions">
          {upgrades.map((t) => (
            <button
              key={t.plan}
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void startCheckout(t.plan)}
            >
              {busy === t.plan ? "Opening…" : t.label}
            </button>
          ))}
          {subscriptionActive ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() => void openPortal()}
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          ) : null}
        </div>
      ) : null}
      {actionError ? <p className="settings-error">{actionError}</p> : null}
    </section>
  );
}
