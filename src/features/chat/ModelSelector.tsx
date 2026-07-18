/**
 * Website-parity model picker: provider rail, search, modality sections,
 * card grid, hover detail panel (intelligence / speed / context / cost bars,
 * pricing, thinking note), favorites, plan gating, lifecycle badges.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Clock,
  Eye,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  MessageSquare,
  Search,
  Star,
  TriangleAlert,
  Video,
  Zap,
} from "lucide-react";
import type { ModelEntry } from "@/lib/data/entities";
import { ProviderLogo } from "@/components/ProviderLogo";
import { useUiStore } from "@/state/uiStore";
import { ChatPopover } from "./ChatPopover";
import { gateModel, planLabel, planRank } from "./helpers";

type ProviderFilter = "all" | string;
type Modality = "chat" | "image" | "video";

function modalityOf(m: ModelEntry): Modality {
  const out = m.modalities.output.map((x) => x.toLowerCase());
  if (out.some((x) => x.includes("video"))) return "video";
  if (out.some((x) => x.includes("image"))) return "image";
  return "chat";
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatPrice(perMillion: number): string {
  if (!Number.isFinite(perMillion) || perMillion <= 0) return "Free";
  if (perMillion < 0.01) return `$${perMillion.toFixed(3)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(2)}`;
}

/** Approximate 1–10 scores from the manifest (mirrors website bar language). */
function metricScores(m: ModelEntry) {
  const inP = m.pricing.inputPerMillion;
  const outP = m.pricing.outputPerMillion;
  const expensiveness = Math.min(10, Math.max(1, Math.round(Math.log10(Math.max(outP, 0.1) * 10) * 3.2)));
  const intelligence =
    m.pricing.class === "premium" ? 9 : m.pricing.class === "standard" ? 7 : 5;
  const speed =
    m.pricing.class === "economy" ? 9 : m.pricing.class === "standard" ? 6 : 4;
  // log10(128k)≈5.1 → ~8; log10(1M)≈6 → ~10
  const context = Math.min(10, Math.max(1, Math.round(Math.log10(Math.max(m.contextWindowTokens, 8_000)) * 1.65)));
  void inP;
  return {
    intelligence: m.reasoning.supported ? Math.min(10, intelligence + 1) : intelligence,
    speed,
    context,
    cost: expensiveness,
  };
}

function MetricBars({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="chat-model-metric">
      <div className="chat-model-metric-head">
        <span>{label}</span>
        <span>{value}/10</span>
      </div>
      <div className="chat-model-metric-bars" aria-hidden>
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className="chat-model-metric-bar"
            style={i < value ? { background: accent } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function RowChip({
  icon: Icon,
  label,
  warn,
  tint,
}: {
  icon: typeof Brain;
  label: string;
  warn?: boolean;
  tint?: boolean;
}) {
  return (
    <span
      className={`chat-model-chip${warn ? " is-warn" : ""}${tint ? " is-tint" : ""}`}
      title={label}
    >
      <Icon size={10} aria-hidden />
      {label}
    </span>
  );
}

export function ModelSelector({
  models,
  selectedId,
  plan,
  favorites,
  disabled,
  onSelect,
  onToggleFavorite,
}: {
  models: ModelEntry[];
  selectedId: string | null;
  plan: string;
  favorites: string[];
  disabled: boolean;
  onSelect(modelId: string): void;
  onToggleFavorite(modelId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = models.find((m) => m.id === selectedId) ?? null;
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) map.set(m.provider.id, m.provider.displayName);
    return [...map.entries()].map(([id, displayName]) => ({ id, displayName }));
  }, [models]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return models.filter((m) => {
      if (filter !== "all" && m.provider.id !== filter) return false;
      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        m.provider.displayName.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [models, filter, q]);

  const favoritesVisible = useMemo(
    () => visible.filter((m) => favoriteSet.has(m.id)),
    [visible, favoriteSet],
  );

  const groups: { key: Modality; label: string; icon: typeof Brain; items: ModelEntry[] }[] = [
    { key: "chat", label: "Chat", icon: MessageSquare, items: [] },
    { key: "image", label: "Image", icon: ImageIcon, items: [] },
    { key: "video", label: "Video", icon: Video, items: [] },
  ];
  for (const m of visible) {
    if (favoriteSet.has(m.id) && !q) continue; // favorites section owns them when not searching
    const g = groups.find((x) => x.key === modalityOf(m));
    g?.items.push(m);
  }

  const hovered =
    visible.find((m) => m.id === hoveredId) ??
    visible.find((m) => m.id === selectedId) ??
    selected ??
    visible[0] ??
    null;

  useEffect(() => {
    if (open) {
      setQuery("");
      setFilter("all");
      setHoveredId(selectedId);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, selectedId]);

  const pick = (m: ModelEntry) => {
    const gate = gateModel(m, plan);
    if (!gate.selectable) return;
    onSelect(m.id);
    setOpen(false);
  };

  const showUpgrade = planRank(plan) < planRank("max");

  return (
    <div className="chat-pop-wrap">
      <button
        type="button"
        className="chat-control-pill chat-model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={selected ? `Model: ${selected.displayName}` : "Choose model"}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <ProviderLogo
            providerId={selected.provider.id}
            className="chat-model-trigger-logo"
            title={selected.provider.displayName}
          />
        ) : null}
        <span className="chat-control-pill-label">
          {selected?.displayName ?? "Choose model"}
        </span>
        <ChevronDown size={14} aria-hidden className={open ? "is-open" : undefined} />
      </button>

      <ChatPopover open={open} onClose={() => setOpen(false)} label="Choose model" width={720}>
        <div className="chat-model-picker">
          {showUpgrade ? (
            <button
              type="button"
              className="chat-model-upgrade"
              onClick={() => {
                setOpen(false);
                useUiStore.getState().openSettings(true);
              }}
            >
              <span className="chat-model-upgrade-copy">
                <Zap size={16} aria-hidden /> Unlock every model
              </span>
              <span className="chat-model-upgrade-cta">Upgrade</span>
            </button>
          ) : null}

          <div className="chat-model-picker-body">
            {/* Provider rail */}
            <div className="chat-model-rail" role="tablist" aria-label="Filter by provider">
              <button
                type="button"
                role="tab"
                aria-selected={filter === "all"}
                className={`chat-model-rail-btn${filter === "all" ? " is-active" : ""}`}
                title="All models"
                onClick={() => setFilter("all")}
              >
                <LayoutGrid size={18} aria-hidden />
              </button>
              <span className="chat-model-rail-sep" aria-hidden />
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === p.id}
                  className={`chat-model-rail-btn${filter === p.id ? " is-active" : ""}`}
                  title={p.displayName}
                  onClick={() => setFilter(p.id)}
                >
                  <ProviderLogo providerId={p.id} className="chat-model-rail-logo" title={p.displayName} />
                </button>
              ))}
            </div>

            {/* List */}
            <div className="chat-model-list-pane">
              <div className="chat-model-search">
                <Search size={14} aria-hidden className="chat-model-search-icon" />
                <input
                  ref={searchRef}
                  type="search"
                  className="chat-model-search-input"
                  placeholder="Search models…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search models"
                />
              </div>

              <div className="chat-model-scroll">
                {visible.length === 0 ? (
                  <p className="chat-model-empty">No models found.</p>
                ) : (
                  <>
                    {favoritesVisible.length > 0 && !q ? (
                      <section className="chat-model-section">
                        <header className="chat-model-section-label">
                          <Star size={12} aria-hidden /> Favorites
                        </header>
                        <div className="chat-model-cards">
                          {favoritesVisible.map((m) => (
                            <ModelCard
                              key={`fav-${m.id}`}
                              model={m}
                              plan={plan}
                              active={m.id === selectedId}
                              favorite
                              onHover={() => setHoveredId(m.id)}
                              onPick={() => pick(m)}
                              onToggleFavorite={() => onToggleFavorite(m.id)}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {groups.map((g) => {
                      if (g.items.length === 0) return null;
                      const standard = g.items.filter((m) => m.lifecycle === "active");
                      const legacy = g.items.filter((m) => m.lifecycle !== "active");
                      return (
                        <section key={g.key} className="chat-model-section">
                          <header className="chat-model-section-label">
                            <g.icon size={12} aria-hidden /> {g.label}
                          </header>
                          {standard.length > 0 ? (
                            <div className="chat-model-cards">
                              {standard.map((m) => (
                                <ModelCard
                                  key={m.id}
                                  model={m}
                                  plan={plan}
                                  active={m.id === selectedId}
                                  favorite={favoriteSet.has(m.id)}
                                  onHover={() => setHoveredId(m.id)}
                                  onPick={() => pick(m)}
                                  onToggleFavorite={() => onToggleFavorite(m.id)}
                                />
                              ))}
                            </div>
                          ) : null}
                          {legacy.length > 0 ? (
                            <details className="chat-model-legacy" open={!!q}>
                              <summary>
                                Legacy models ({legacy.length})
                                <ChevronDown size={14} aria-hidden />
                              </summary>
                              <div className="chat-model-cards">
                                {legacy.map((m) => (
                                  <ModelCard
                                    key={m.id}
                                    model={m}
                                    plan={plan}
                                    active={m.id === selectedId}
                                    favorite={favoriteSet.has(m.id)}
                                    onHover={() => setHoveredId(m.id)}
                                    onPick={() => pick(m)}
                                    onToggleFavorite={() => onToggleFavorite(m.id)}
                                  />
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </section>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            {/* Detail panel */}
            <ModelDetail model={hovered} />
          </div>
        </div>
      </ChatPopover>
    </div>
  );
}

function ModelCard({
  model,
  plan,
  active,
  favorite,
  onHover,
  onPick,
  onToggleFavorite,
}: {
  model: ModelEntry;
  plan: string;
  active: boolean;
  favorite: boolean;
  onHover(): void;
  onPick(): void;
  onToggleFavorite(): void;
}) {
  const gate = gateModel(model, plan);
  const soon = model.availability === "coming_soon";
  const vision = model.modalities.input.some((x) => x.toLowerCase().includes("image"));
  const mod = modalityOf(model);
  const dollars =
    model.pricing.class === "premium" ? "$$$" : model.pricing.class === "standard" ? "$$" : "$";

  return (
    <div
      className={`chat-model-card${active ? " is-active" : ""}${!gate.selectable ? " is-locked" : ""}${soon ? " is-soon" : ""}`}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <button
        type="button"
        className="chat-model-card-main"
        disabled={!gate.selectable}
        onClick={onPick}
      >
        <div className="chat-model-card-top">
          <ProviderLogo providerId={model.provider.id} className="chat-model-card-logo" />
          <div className="chat-model-card-titles">
            <span className="chat-model-card-name">{model.displayName}</span>
            <span className="chat-model-card-provider">{model.provider.displayName}</span>
          </div>
        </div>
        {model.description ? (
          <p className="chat-model-card-desc">{model.description}</p>
        ) : null}
        <div className="chat-model-card-meta">
          <div className="chat-model-card-chips">
            {model.lifecycle === "deprecated" ? (
              <RowChip icon={TriangleAlert} label="Retiring" warn />
            ) : null}
            {model.lifecycle === "legacy" ? <RowChip icon={Clock} label="Legacy" /> : null}
            {mod === "image" ? <RowChip icon={ImageIcon} label="Image" tint /> : null}
            {mod === "video" ? <RowChip icon={Video} label="Video" tint /> : null}
            {model.reasoning.supported ? <RowChip icon={Brain} label="Reasoning" /> : null}
            {vision ? <RowChip icon={Eye} label="Vision" /> : null}
            {model.capabilities.webSearch ? <RowChip icon={Globe} label="Search" /> : null}
            <span className="chat-model-dollars" aria-label={`${model.pricing.class} pricing`}>
              {dollars}
            </span>
          </div>
          {soon ? (
            <span className="chat-model-status is-soon">
              <Clock size={12} aria-hidden /> Soon
            </span>
          ) : !gate.selectable ? (
            <span className="chat-model-status is-lock">
              <Lock size={12} aria-hidden /> {planLabel(model.minimumPlan)}
            </span>
          ) : active ? (
            <Check size={16} className="chat-model-check" aria-label="Selected" />
          ) : null}
        </div>
      </button>
      <button
        type="button"
        className="chat-model-star"
        aria-label={favorite ? `Unfavorite ${model.displayName}` : `Favorite ${model.displayName}`}
        aria-pressed={favorite}
        data-active={favorite || undefined}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star size={13} fill={favorite ? "currentColor" : "none"} aria-hidden />
      </button>
    </div>
  );
}

function ModelDetail({ model }: { model: ModelEntry | null }) {
  if (!model) {
    return (
      <aside className="chat-model-detail">
        <p className="chat-model-detail-empty">
          Hover a model to compare intelligence, speed, context, and cost.
        </p>
      </aside>
    );
  }
  const scores = metricScores(model);
  const free = model.pricing.inputPerMillion === 0 && model.pricing.outputPerMillion === 0;
  const accent =
    model.pricing.class === "premium"
      ? "hsl(var(--primary))"
      : model.pricing.class === "economy"
        ? "hsl(var(--success))"
        : "hsl(var(--foreground) / 0.55)";
  const vision = model.modalities.input.some((x) => x.toLowerCase().includes("image"));

  return (
    <aside className="chat-model-detail" key={model.id}>
      <div className="chat-model-detail-inner">
        <header className="chat-model-detail-head">
          <div>
            <h3>{model.displayName}</h3>
            <p>
              {model.provider.displayName}
              <span aria-hidden> · </span>
              <span className="font-mono">{formatContext(model.contextWindowTokens)} context</span>
            </p>
          </div>
          <ProviderLogo providerId={model.provider.id} className="chat-model-detail-logo" />
        </header>

        {model.lifecycle === "deprecated" && model.deprecationNote ? (
          <div className="chat-model-detail-warn">
            <TriangleAlert size={12} aria-hidden />
            {model.deprecationNote}
          </div>
        ) : null}

        {model.description ? <p className="chat-model-detail-desc">{model.description}</p> : null}

        <div className="chat-model-detail-caps">
          {vision ? (
            <span className="chat-model-cap">
              <Eye size={12} aria-hidden /> Vision
            </span>
          ) : null}
          {model.reasoning.supported ? (
            <span className="chat-model-cap">
              <Brain size={12} aria-hidden /> Reasoning
            </span>
          ) : null}
          {model.capabilities.webSearch ? (
            <span className="chat-model-cap">
              <Globe size={12} aria-hidden /> Web search
            </span>
          ) : null}
          {model.pricing.class === "economy" ? (
            <span className="chat-model-cap">
              <Zap size={12} aria-hidden /> Fast
            </span>
          ) : null}
        </div>

        <div className="chat-model-detail-metrics">
          <MetricBars label="Intelligence" value={scores.intelligence} accent={accent} />
          <MetricBars label="Speed" value={scores.speed} accent={accent} />
          <MetricBars label="Context" value={scores.context} accent={accent} />
          <MetricBars label="Cost" value={scores.cost} accent={accent} />
        </div>

        <div className="chat-model-detail-pricing">
          <span className="eyebrow">Pricing</span>
          {free ? (
            <p className="chat-model-price-free">Free</p>
          ) : (
            <p className="chat-model-price">
              <strong>{formatPrice(model.pricing.inputPerMillion)}</strong>
              <span> in</span>
              <span className="chat-model-price-sep">·</span>
              <strong>{formatPrice(model.pricing.outputPerMillion)}</strong>
              <span> out</span>
              <span className="chat-model-price-unit"> / MTok</span>
            </p>
          )}
        </div>

        <div className="chat-model-detail-thinking">
          <div className="chat-model-detail-thinking-head">
            <span className="eyebrow">Thinking</span>
            <span className="eyebrow">
              {model.reasoning.supported
                ? model.reasoning.onOffOnly
                  ? "On / off"
                  : model.reasoning.canDisable
                    ? "Selectable"
                    : "Always on"
                : "Instant"}
            </span>
          </div>
          <p>
            {model.reasoning.supported
              ? model.reasoning.canDisable
                ? "Use the thinking slider in the composer to set effort for this model."
                : "This model always reasons — no effort control."
              : "This model replies instantly."}
          </p>
        </div>
      </div>
    </aside>
  );
}
