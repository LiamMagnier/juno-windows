import type { AppMode } from "@/state/uiStore";
import { useUiStore } from "@/state/uiStore";
import "./sidebar.css";

/** Sidebar frame: mode switcher + per-mode content. Sections land with their features. */
export function Sidebar({ mode, collapsed }: { mode: AppMode; collapsed: boolean }) {
  const setMode = useUiStore((s) => s.setMode);

  return (
    <div className="sidebar" data-collapsed={collapsed || undefined}>
      <div className="sidebar-modes" role="tablist" aria-label="App mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "chat"}
          className="sidebar-mode"
          onClick={() => setMode("chat")}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "code"}
          className="sidebar-mode"
          onClick={() => setMode("code")}
        >
          Code
        </button>
      </div>
      <div className="sidebar-content" />
    </div>
  );
}
