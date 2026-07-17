/**
 * Thinking-effort slider — one discrete stop per tier the model supports
 * (Instant · Minimal · Low · Medium · High · Extra high · Max), so the stop
 * count follows the model. A real <input type="range"> sits transparently on
 * top for native keyboard support (arrows/Home/End), drag, and screen-reader
 * semantics; aria-valuetext carries the tier NAME so AT announces "High", not
 * "4". Windows-adapted from the website's reasoning-slider.
 *
 * The top tier of a multi-stop model gets a distinct "ultra" treatment (violet
 * --ultra gradient) because it is the one tier that is materially slower and
 * pricier — a deliberate escalation, not one more notch. All motion is behind
 * prefers-reduced-motion via the .rs-* transitions in chat.css.
 */
import { useEffect, useRef, useState } from "react";
import type { EffortOption } from "./helpers";
import type { ReasoningEffort } from "@/lib/data/entities";

export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
}: {
  options: EffortOption[];
  value: ReasoningEffort | null;
  onChange: (v: ReasoningEffort | null) => void;
  disabled?: boolean;
}) {
  const count = options.length;
  // Exact match: Instant's value is null and null === null, so an Instant
  // selection resolves to stop 0 rather than falling back to it.
  const found = options.findIndex((o) => o.value === value);
  const index = found < 0 ? 0 : found;
  const last = count - 1;
  const isTop = count >= 3 && index === last;
  const frac = last > 0 ? index / last : 0;

  // Re-fire the landing flourish on each fresh arrival at the top tier.
  const [popKey, setPopKey] = useState(0);
  const wasTop = useRef(isTop);
  useEffect(() => {
    if (isTop && !wasTop.current) setPopKey((k) => k + 1);
    wasTop.current = isTop;
  }, [isTop]);

  if (count < 2) return null;
  const current = options[index]!;

  return (
    <div className="rs" data-disabled={disabled || undefined} data-top={isTop || undefined}>
      <div className="rs-head">
        <span className="rs-label">Thinking</span>
        <span className="rs-tier" aria-hidden="true">
          {current.label}
        </span>
      </div>

      <div className="rs-track">
        <div className="rs-lane">
          <div className="rs-fill-carrier" style={{ transform: `translateX(calc((100% - var(--rs-thumb)) * ${frac}))` }}>
            <div className="rs-fill">{isTop ? <span className="rs-fill-ultra" aria-hidden="true" /> : null}</div>
          </div>
        </div>

        {options.map((o, i) => (
          <span
            key={o.label}
            aria-hidden="true"
            className="rs-dot"
            data-state={i === index ? "under" : i < index ? "filled" : "empty"}
            style={{ left: `calc(16px + (100% - 32px) * ${last > 0 ? i / last : 0})` }}
          />
        ))}

        <div className="rs-thumb-carrier" style={{ transform: `translateX(calc((100% - var(--rs-thumb)) * ${frac}))` }}>
          <span key={popKey} className="rs-thumb" aria-hidden="true" />
        </div>

        <input
          type="range"
          className="rs-input"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Thinking effort"
          aria-valuetext={current.label}
          onChange={(e) => {
            const next = options[Number(e.target.value)];
            // Index into options directly — do NOT `?? value`, since Instant's
            // value is null and `null ?? value` would make stop 0 unselectable.
            if (next) onChange(next.value);
          }}
        />
      </div>
    </div>
  );
}
