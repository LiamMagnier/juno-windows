import "./signature.css";

/**
 * Breathing dot-constellation — the Juno "thinking" signature. Three layered
 * CSS periods per dot (wave 2.1s · tint sweep 3.4s · breathe 5.6s) run out of
 * phase, so the combined motion never reads as a visible loop. Inherits
 * currentColor for the base dots; the tint sweep is always coral.
 */
export function ThinkingDots({ className, label = "Juno is thinking" }: { className?: string; label?: string }) {
  return (
    <span
      className={className ? `juno-tdots ${className}` : "juno-tdots"}
      role="status"
      aria-label={label}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="juno-tdots-breathe" style={{ animationDelay: `${i * -1.1}s` }}>
          <span className="juno-tdots-dot" style={{ animationDelay: `${i * 0.14 - 1.12}s` }}>
            <span className="juno-tdots-tint" aria-hidden="true" style={{ animationDelay: `${i * 0.16}s` }} />
          </span>
        </span>
      ))}
    </span>
  );
}
