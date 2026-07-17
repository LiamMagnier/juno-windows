/**
 * Model picker popover: manifest models grouped by provider (manifest order
 * trusted verbatim), favorites pinned on top with a star toggle, pricing-class
 * dot, capability icons, lifecycle badges, and plan gating.
 */
import { useMemo, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  Eye,
  Globe,
  Star,
} from "lucide-react";
import type { ModelEntry } from "@/lib/data/entities";
import { ChatPopover } from "./ChatPopover";
import { gateModel, groupModels } from "./helpers";

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
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => groupModels(models, favorites), [models, favorites]);
  const selected = models.find((m) => m.id === selectedId) ?? null;

  // Flat render plan: favorites section then provider groups.
  const rows = useMemo(() => {
    const out: Array<{ header?: string; model?: ModelEntry }> = [];
    if (grouped.favorites.length > 0) {
      out.push({ header: "Favorites" });
      for (const m of grouped.favorites) out.push({ model: m });
    }
    for (const group of grouped.groups) {
      out.push({ header: group.provider });
      for (const m of group.models) out.push({ model: m });
    }
    return out;
  }, [grouped]);

  const selectableIndexes = useMemo(
    () =>
      rows
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => row.model && gateModel(row.model, plan).selectable)
        .map(({ i }) => i),
    [rows, plan],
  );

  const openPicker = () => {
    if (disabled) return;
    setOpen(true);
    const currentIndex = rows.findIndex((r) => r.model?.id === selectedId);
    const startAt = selectableIndexes.includes(currentIndex)
      ? currentIndex
      : (selectableIndexes[0] ?? 0);
    setFocusIndex(startAt);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  const moveFocus = (delta: number) => {
    if (selectableIndexes.length === 0) return;
    const position = selectableIndexes.indexOf(focusIndex);
    const next =
      selectableIndexes[
        (position + delta + selectableIndexes.length) % selectableIndexes.length
      ]!;
    setFocusIndex(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const model = rows[focusIndex]?.model;
      if (model && gateModel(model, plan).selectable) {
        onSelect(model.id);
        setOpen(false);
      }
    }
  };

  return (
    <div className="chat-pop-wrap">
      <button
        type="button"
        className="chat-control-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <span className="chat-control-pill-label">{selected?.displayName ?? "Choose model"}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <ChatPopover open={open} onClose={() => setOpen(false)} label="Choose model" width={340}>
        <div
          ref={listRef}
          className="chat-model-list"
          role="listbox"
          aria-label="Models"
          aria-activedescendant={
            rows[focusIndex]?.model ? `chat-model-${rows[focusIndex]!.model!.id}` : undefined
          }
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {rows.map((row, index) =>
            row.header ? (
              <div key={`h-${row.header}-${index}`} className="chat-model-group-label">
                {row.header}
              </div>
            ) : (
              <ModelRow
                key={`${row.model!.id}-${index}`}
                model={row.model!}
                index={index}
                plan={plan}
                selected={row.model!.id === selectedId}
                focused={index === focusIndex}
                favorite={favorites.includes(row.model!.id)}
                onHover={() => setFocusIndex(index)}
                onPick={() => {
                  onSelect(row.model!.id);
                  setOpen(false);
                }}
                onToggleFavorite={() => onToggleFavorite(row.model!.id)}
              />
            ),
          )}
          {rows.length === 0 ? (
            <div className="chat-popover-empty">No models available yet</div>
          ) : null}
        </div>
      </ChatPopover>
    </div>
  );
}

function ModelRow({
  model,
  index,
  plan,
  selected,
  focused,
  favorite,
  onHover,
  onPick,
  onToggleFavorite,
}: {
  model: ModelEntry;
  index: number;
  plan: string;
  selected: boolean;
  focused: boolean;
  favorite: boolean;
  onHover(): void;
  onPick(): void;
  onToggleFavorite(): void;
}) {
  const gate = gateModel(model, plan);
  const vision = model.modalities.input.includes("image");

  return (
    <div
      id={`chat-model-${model.id}`}
      className="chat-model-row"
      role="option"
      aria-selected={selected}
      aria-disabled={!gate.selectable || undefined}
      data-row-index={index}
      data-focused={focused || undefined}
      data-selected={selected || undefined}
      data-disabled={!gate.selectable || undefined}
      onPointerEnter={onHover}
    >
      <button
        type="button"
        className="chat-model-row-main"
        tabIndex={-1}
        disabled={!gate.selectable}
        onClick={onPick}
      >
        <span className={`chat-price-dot chat-price-${model.pricing.class}`} aria-hidden />
        <span className="chat-model-name">{model.displayName}</span>
        <span className="chat-model-caps" aria-hidden>
          {vision ? <Eye size={12} /> : null}
          {model.capabilities.webSearch ? <Globe size={12} /> : null}
          {model.reasoning.supported ? <Brain size={12} /> : null}
        </span>
        {model.lifecycle === "legacy" ? <span className="chat-model-badge">Legacy</span> : null}
        {model.lifecycle === "deprecated" ? (
          <span className="chat-model-badge">Deprecated</span>
        ) : null}
        {gate.reason ? <span className="chat-model-reason">{gate.reason}</span> : null}
      </button>
      <button
        type="button"
        className="chat-model-star"
        aria-label={favorite ? `Remove ${model.displayName} from favorites` : `Add ${model.displayName} to favorites`}
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
