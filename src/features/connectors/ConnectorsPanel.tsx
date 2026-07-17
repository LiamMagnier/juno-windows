/**
 * Connectors panel — the account's connected apps directory.
 *
 * Lists GET /api/connectors (native connectors + connected Composio apps)
 * and, when Composio is configured, the browsable Composio catalog.
 * OAuth connect flows are web-session-bound (cookie'd 302 chains), so
 * Connect opens the website's /connections page in the default browser and
 * the panel re-fetches on window focus to detect completion.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Plug, Unplug } from "lucide-react";
import { api } from "@/lib/backend/http";
import { backendBaseUrl } from "@/lib/backend/config";
import { BackendError } from "@/lib/backend/types";
import { Dialog } from "@/components/Dialog";
import "./connectors.css";

type ConnectorKind = "oauth_app" | "mcp_oauth" | "credentials" | "composio_app";

interface Connector {
  id: string;
  kind: ConnectorKind;
  label: string;
  description: string;
  capability: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: string | null;
}

interface ConnectorsResponse {
  connectors: Connector[];
  composioConfigured: boolean;
}

interface CatalogItem {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  noAuth: boolean;
  managedAuth: boolean;
  status: string | null;
  connectedAt: string | null;
}

interface CatalogResponse {
  items: CatalogItem[];
  cursor?: string;
  totalPages: number;
  total?: number;
  categories: Array<{ id: string; label: string; count?: number }>;
}

const KIND_LABELS: Record<ConnectorKind, string> = {
  oauth_app: "OAuth",
  mcp_oauth: "MCP",
  credentials: "Credentials",
  composio_app: "App",
};

/** Composio duplicates of native connectors are dropped from the catalog. */
const NATIVE_EQUIVALENT = new Set(["github", "figma", "notion"]);

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof BackendError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Arrow-key navigation across [data-row] elements inside the list. */
function handleListArrows(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-row]"));
  if (rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const current = rows.findIndex((r) => r === active || (active !== null && r.contains(active)));
  e.preventDefault();
  const next =
    current < 0
      ? 0
      : e.key === "ArrowDown"
        ? Math.min(rows.length - 1, current + 1)
        : Math.max(0, current - 1);
  rows[next]?.focus();
}

export function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [composioConfigured, setComposioConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [pendingConnect, setPendingConnect] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const mounted = useRef(true);

  const fetchCatalog = useCallback(async (cursor: string | null) => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const path = cursor
        ? `/connectors/composio/catalog?cursor=${encodeURIComponent(cursor)}`
        : "/connectors/composio/catalog";
      const data = await api<CatalogResponse>(path);
      if (!mounted.current) return;
      setCatalog((prev) => {
        const base = cursor ? prev : [];
        const seen = new Set(base.map((i) => i.slug));
        return [...base, ...data.items.filter((i) => !seen.has(i.slug))];
      });
      setCatalogCursor(data.cursor ?? null);
    } catch (err) {
      if (mounted.current)
        setCatalogError(errorMessage(err, "Couldn't load the Composio catalog."));
    } finally {
      if (mounted.current) setCatalogLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<ConnectorsResponse>("/connectors");
      if (!mounted.current) return;
      setConnectors(data.connectors);
      setComposioConfigured(data.composioConfigured);
      if (data.composioConfigured) void fetchCatalog(null);
    } catch (err) {
      if (mounted.current) setLoadError(errorMessage(err, "Couldn't load connectors."));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [fetchCatalog]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Connect finishes in the browser; re-check when the window regains focus.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const connect = (id: string) => {
    setPendingConnect(id);
    void openUrl(`${backendBaseUrl()}/connections`);
  };

  const setUpInComposio = (slug: string) => {
    void openUrl(`https://platform.composio.dev/marketplace/${encodeURIComponent(slug)}`);
  };

  const confirmDisconnect = async () => {
    if (!disconnectTarget) return;
    setDisconnectBusy(true);
    setDisconnectError(null);
    try {
      const { id } = disconnectTarget;
      const path = id.startsWith("composio:")
        ? `/connectors/composio/${encodeURIComponent(id.slice("composio:".length))}`
        : `/connectors/${encodeURIComponent(id)}`;
      await api(path, { method: "DELETE" });
      if (!mounted.current) return;
      setDisconnectTarget(null);
      await refresh();
    } catch (err) {
      if (mounted.current) setDisconnectError(errorMessage(err, "Couldn't disconnect."));
    } finally {
      if (mounted.current) setDisconnectBusy(false);
    }
  };

  const connected = useMemo(() => (connectors ?? []).filter((c) => c.connected), [connectors]);
  const available = useMemo(
    () => (connectors ?? []).filter((c) => c.configured && !c.connected),
    [connectors],
  );
  const unconfigured = useMemo(() => (connectors ?? []).filter((c) => !c.configured), [connectors]);
  const catalogAvailable = useMemo(
    () => catalog.filter((i) => !i.connected && !NATIVE_EQUIVALENT.has(i.slug)),
    [catalog],
  );

  const renderRow = (opts: {
    key: string;
    label: string;
    kind: ConnectorKind;
    description?: string;
    meta?: string;
    muted?: boolean;
    action?: React.ReactNode;
    pendingNote?: boolean;
  }) => (
    <li
      key={opts.key}
      data-row
      tabIndex={-1}
      className={`connectors-row${opts.muted ? " connectors-row-muted" : ""}`}
    >
      <div className="connectors-row-main">
        <p className="connectors-row-title">
          <span className="connectors-row-label">{opts.label}</span>
        <span className="connectors-kind-badge">{KIND_LABELS[opts.kind]}</span>
        </p>
        {opts.description ? <p className="connectors-row-desc">{opts.description}</p> : null}
        {opts.meta ? <p className="connectors-row-meta">{opts.meta}</p> : null}
        {opts.pendingNote ? (
          <p className="connectors-pending-note" role="status">
            Finish connecting in your browser, then come back.
          </p>
        ) : null}
      </div>
      {opts.action}
    </li>
  );

  return (
    <div className="connectors-panel">
      <div className="connectors-inner">
        <header className="connectors-header">
          <h1 className="connectors-title">Connectors</h1>
          <p className="connectors-subtitle">
            Connect your apps so Juno can use them in conversations.
          </p>
        </header>

        {loadError && connectors === null ? (
          <div className="connectors-error">
            <p>{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : connectors === null ? (
          <p className="connectors-loading" role="status">
            Loading connectors…
          </p>
        ) : (
          <>
            <section aria-label="Connected apps">
              <h2 className="connectors-section-title">Connected</h2>
              {connected.length === 0 ? (
                <p className="connectors-section-empty">
                  No connected apps yet. Connect one below to let Juno use it in chats.
                </p>
              ) : (
                <ul className="connectors-list" onKeyDown={handleListArrows}>
                  {connected.map((c) =>
                    renderRow({
                      key: c.id,
                      label: c.label,
                      kind: c.kind,
                      description:
                        c.accountLabel && c.accountLabel !== c.label
                          ? c.accountLabel
                          : "Connected and ready",
                      ...(c.connectedAt ? { meta: `Connected ${relativeTime(c.connectedAt)}` } : {}),
                      action: (
                        <button
                          type="button"
                          className="btn btn-secondary connectors-action"
                          onClick={() => setDisconnectTarget({ id: c.id, label: c.label })}
                        >
                          <Unplug size={16} aria-hidden />
                          Disconnect
                        </button>
                      ),
                    }),
                  )}
                </ul>
              )}
            </section>

            <section aria-label="Available apps">
              <h2 className="connectors-section-title">Available</h2>
              {available.length === 0 && (!composioConfigured || catalogAvailable.length === 0) ? (
                <p className="connectors-section-empty">
                  {catalogLoading ? "Loading available apps…" : "Nothing left to connect."}
                </p>
              ) : (
                <ul className="connectors-list" onKeyDown={handleListArrows}>
                  {available.map((c) =>
                    renderRow({
                      key: c.id,
                      label: c.label,
                      kind: c.kind,
                      description: c.description,
                      pendingNote: pendingConnect === c.id,
                      action: (
                        <button
                          type="button"
                          className="btn btn-primary connectors-action"
                          onClick={() => connect(c.id)}
                        >
                          <Plug size={16} aria-hidden />
                          Connect
                        </button>
                      ),
                    }),
                  )}
                  {composioConfigured
                    ? catalogAvailable.map((item) =>
                        renderRow({
                          key: item.id,
                          label: item.name,
                          kind: "composio_app",
                          description: `Use ${item.name} through Juno.`,
                          pendingNote: pendingConnect === item.id,
                          action: item.managedAuth || item.noAuth ? (
                            <button
                              type="button"
                              className="btn btn-primary connectors-action"
                              onClick={() => connect(item.id)}
                            >
                              <Plug size={16} aria-hidden />
                              Connect
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-secondary connectors-action"
                              onClick={() => setUpInComposio(item.slug)}
                            >
                              <ExternalLink size={16} aria-hidden />
                              Set up in Composio
                            </button>
                          ),
                        }),
                      )
                    : null}
                </ul>
              )}
              {composioConfigured && catalogError ? (
                <div className="connectors-catalog-footer">
                  <p className="connectors-error-text" role="alert">
                    {catalogError}
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void fetchCatalog(null)}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {composioConfigured && catalogCursor ? (
                <div className="connectors-catalog-footer">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void fetchCatalog(catalogCursor)}
                    disabled={catalogLoading}
                  >
                    {catalogLoading ? "Loading…" : "Load more apps"}
                  </button>
                </div>
              ) : null}
            </section>

            {unconfigured.length > 0 ? (
              <section aria-label="Unavailable apps">
                <h2 className="connectors-section-title">Unavailable</h2>
                <ul className="connectors-list" onKeyDown={handleListArrows}>
                  {unconfigured.map((c) =>
                    renderRow({
                      key: c.id,
                      label: c.label,
                      kind: c.kind,
                      description: c.description,
                      meta: "Not configured on the server",
                      muted: true,
                    }),
                  )}
                </ul>
              </section>
            ) : null}

            {loading ? (
              <p className="connectors-refreshing" role="status">
                Refreshing…
              </p>
            ) : null}
          </>
        )}
      </div>

      <Dialog
        title={`Disconnect ${disconnectTarget?.label ?? ""}`}
        open={disconnectTarget !== null}
        onClose={() => {
          if (!disconnectBusy) {
            setDisconnectTarget(null);
            setDisconnectError(null);
          }
        }}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setDisconnectTarget(null);
                setDisconnectError(null);
              }}
              disabled={disconnectBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => void confirmDisconnect()}
              disabled={disconnectBusy}
            >
              {disconnectBusy ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        }
      >
        <p>Juno will lose access to this account. You can reconnect anytime.</p>
        {disconnectError ? (
          <p className="connectors-error-text" role="alert">
            {disconnectError}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
