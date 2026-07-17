import type { AppMode } from "@/state/uiStore";

/** Content router. Chat and Code surfaces mount here as they land. */
export function MainPane({ mode }: { mode: AppMode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "hsl(var(--muted-foreground))",
      }}
    >
      {mode === "chat" ? "Chat is loading…" : "Code mode is loading…"}
    </div>
  );
}
