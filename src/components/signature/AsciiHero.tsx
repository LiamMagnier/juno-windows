import "./signature.css";

/** A slowly drifting halftone sun/orbit rendered from dots — the welcome hero. */
export function AsciiHero({ size = 132, className }: { size?: number; className?: string }) {
  const rings = [
    { radius: 34, count: 10, op: 0.9 },
    { radius: 58, count: 18, op: 0.6 },
    { radius: 82, count: 26, op: 0.42 },
    { radius: 106, count: 34, op: 0.28 },
    { radius: 130, count: 42, op: 0.16 },
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="-150 -150 300 300"
      className={className ? `juno-hero ${className}` : "juno-hero"}
      style={{ color: "hsl(var(--primary))", animation: "juno-drift 18s ease-in-out infinite" }}
      aria-hidden="true"
    >
      <circle cx="0" cy="0" r="16" fill="currentColor" />
      <circle cx="0" cy="0" r="24" fill="currentColor" opacity="0.18" />
      {rings.flatMap((ring) =>
        Array.from({ length: ring.count }).map((_, i) => {
          const a = (i / ring.count) * Math.PI * 2 + ring.radius * 0.04;
          const x = Math.cos(a) * ring.radius;
          const y = Math.sin(a) * ring.radius;
          const r = ring.radius < 70 ? 2 : 1.5;
          return (
            <circle key={`${ring.radius}-${i}`} cx={x.toFixed(2)} cy={y.toFixed(2)} r={r} fill="currentColor" opacity={ring.op} />
          );
        }),
      )}
    </svg>
  );
}
