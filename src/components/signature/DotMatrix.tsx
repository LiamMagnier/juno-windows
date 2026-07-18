/**
 * The Juno dot-matrix marks: the orbiting-spark logo, deterministic dot
 * identicons, and a dot-fill progress bar. Coral is the only saturated colour
 * in the dot system. Ported from the website's signature layer.
 */

/** The Juno dot-matrix mark: a small orbit/spark rendered from dots. */
export function DotMatrixMark({ size = 20, className }: { size?: number; className?: string }) {
  // 5x5 grid; `1` = coral, `2` = muted dot, `0` = empty. Forms an orbiting spark.
  const grid = [
    [0, 0, 2, 0, 0],
    [0, 2, 0, 2, 0],
    [2, 0, 1, 0, 2],
    [0, 2, 0, 2, 0],
    [0, 0, 2, 0, 0],
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={className}
      style={{ color: "hsl(var(--primary))" }}
      aria-hidden="true"
    >
      {grid.flatMap((row, y) =>
        row.map((v, x) =>
          v === 0 ? null : (
            <circle
              key={`${x}-${y}`}
              cx={2 + x * 4}
              cy={2 + y * 4}
              r={v === 1 ? 1.6 : 1}
              fill="currentColor"
              opacity={v === 1 ? 1 : 0.35}
            />
          ),
        ),
      )}
    </svg>
  );
}

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic dot-matrix identicon (5x5, horizontally symmetric) from a seed. */
export function DotIdenticon({ seed, size = 28, className }: { seed: string; size?: number; className?: string }) {
  const h = hash(seed || "juno");
  const cells: boolean[][] = [];
  for (let y = 0; y < 5; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < 3; x++) row.push(((h >> (y * 3 + x)) & 1) === 1);
    cells.push([row[0]!, row[1]!, row[2]!, row[1]!, row[0]!]);
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={className}
      style={{ color: "hsl(var(--primary))" }}
      aria-hidden="true"
    >
      <rect width="20" height="20" rx="6" fill="hsl(var(--secondary))" />
      {cells.flatMap((row, y) =>
        row.map((on, x) =>
          on ? <circle key={`${x}-${y}`} cx={2.5 + x * 3.75} cy={2.5 + y * 3.75} r={1.3} fill="currentColor" /> : null,
        ),
      )}
    </svg>
  );
}

/** Dot-fill progress bar (quota, uploads). */
export function DotFillBar({ value, max, dots = 18, className }: { value: number; max: number; dots?: number; className?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * dots);
  return (
    <div className={className} style={{ display: "flex", alignItems: "center", gap: "3px" }} aria-hidden>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          style={{
            height: "5px",
            width: "5px",
            borderRadius: "999px",
            background: i < filled ? "hsl(var(--primary))" : "hsl(var(--border))",
          }}
        />
      ))}
    </div>
  );
}
