import { useEffect, useRef } from "react";
import "./signature.css";

export type OrbStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

const FLOOR: Record<OrbStatus, number> = {
  idle: 0,
  listening: 0.05,
  thinking: 0.16,
  speaking: 0.1,
  error: 0,
};

const BAR_PROFILE = [0.48, 0.78, 1, 0.72, 0.42] as const;

/**
 * A restrained audio mark: one matte blue field and a five-bar waveform. The
 * bars follow the live amplitude (via a ref, no React re-renders) so the mark
 * stays responsive while the transcript scrolls behind it. Matches the website's
 * VoiceOrb. Blue is the one deliberate cool exception to the warm palette.
 */
export function VoiceOrb({
  status,
  levelRef,
  className,
}: {
  status: OrbStatus;
  levelRef?: React.MutableRefObject<number>;
  className?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef(status);
  const liveLevelRef = useRef(levelRef);
  statusRef.current = status;
  liveLevelRef.current = levelRef;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let smooth = FLOOR[statusRef.current];

    const render = (time: number) => {
      const currentStatus = statusRef.current;
      const audio = Math.max(0, Math.min(1, liveLevelRef.current?.current ?? 0));
      const target = Math.max(FLOOR[currentStatus], audio);
      smooth += (target - smooth) * 0.2;

      BAR_PROFILE.forEach((profile, index) => {
        const thinkingWave =
          currentStatus === "thinking" && !reducedMotion ? (Math.sin(time / 190 + index * 0.9) + 1) * 0.9 : 0;
        const height = Math.min(15, 4 + profile * 4 + smooth * 7 * profile + thinkingWave);
        root.style.setProperty(`--voice-bar-${index}`, `${height.toFixed(2)}px`);
      });
      root.style.setProperty("--voice-ring-scale", String(1 + smooth * 0.07));
      root.style.setProperty("--voice-ring-opacity", String(0.2 + smooth * 0.32));
      root.style.setProperty("--voice-orb-scale", String(0.985 + smooth * 0.035));

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-status={status}
      className={className ? `juno-orb ${className}` : "juno-orb"}
    >
      <span className="juno-orb-ring" />
      <span className="juno-orb-core">
        <span className="juno-orb-bars">
          {BAR_PROFILE.map((_, index) => (
            <span key={index} style={{ ["--voice-bar" as string]: `var(--voice-bar-${index}, 6px)` }} />
          ))}
        </span>
      </span>
    </span>
  );
}
