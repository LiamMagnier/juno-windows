import "./signature.css";

/**
 * Reasoning-effort mark: three ascending bars that fill with the tier. This is
 * the Juno-Windows replacement for the brain glyph — one mark shared by the
 * composer thinking pill, the model rows, and the reasoning slider thumb. The
 * top tier picks up the violet "ultra" gradient so escalation is felt.
 */
export function EffortMeter({
  level,
  ultra = false,
  tone,
  className,
  title,
}: {
  /** 0 = instant, 1 = low, 2 = medium, 3 = high/max. */
  level: 0 | 1 | 2 | 3;
  ultra?: boolean;
  /** "on" forces all bars to the accent (e.g. a capability indicator). */
  tone?: "on";
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={className ? `juno-effort ${className}` : "juno-effort"}
      data-level={level}
      data-ultra={ultra || undefined}
      data-tone={tone}
      role="img"
      aria-label={title ?? "reasoning effort"}
      title={title}
    >
      <i />
      <i />
      <i />
    </span>
  );
}
