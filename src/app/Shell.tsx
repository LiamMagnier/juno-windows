import { useCallback, useEffect, useRef } from "react";
import { useUiStore, SIDEBAR_COMPACT } from "@/state/uiStore";
import { useThreadStore } from "@/state/threadStore";
import { setPendingProjectId } from "@/features/projects/projectContext";
import { startSync, stopSync } from "@/lib/data/syncEngine";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { MainPane } from "@/features/main/MainPane";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { ContextMenuProvider } from "@/components/ContextMenu";
import "./shell.css";

/**
 * The signed-in application frame: resizable sidebar + content pane.
 * Windows keyboard conventions: Ctrl+1/Ctrl+2 switch modes, Ctrl+B toggles
 * the sidebar, F6 cycles regions.
 */
export function Shell() {
  const { mode, setMode, sidebarCollapsed, toggleSidebar, sidebarWidth, setSidebarWidth } =
    useUiStore();
  const shellRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    void startSync();
    return () => stopSync();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (e.key === "1") {
          e.preventDefault();
          setMode("chat");
        } else if (e.key === "2") {
          e.preventDefault();
          setMode("code");
        } else if (e.key.toLowerCase() === "b") {
          e.preventDefault();
          toggleSidebar();
        } else if (e.key.toLowerCase() === "n") {
          e.preventDefault();
          // A stashed "new chat in project" target must not leak into a
          // plain Ctrl+N chat.
          setPendingProjectId(null);
          useUiStore.getState().setView({ kind: "chat" });
          useThreadStore.getState().setActive(null);
        } else if (e.key === ",") {
          e.preventDefault();
          useUiStore.getState().openSettings(true);
        }
      }
      if (e.key === "F6") {
        e.preventDefault();
        cycleRegions(shellRef.current, e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setMode, toggleSidebar]);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarCollapsed) return;
      dragState.current = { startX: e.clientX, startWidth: sidebarWidth };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebarCollapsed, sidebarWidth],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      setSidebarWidth(drag.startWidth + (e.clientX - drag.startX));
    },
    [setSidebarWidth],
  );

  const onResizeEnd = useCallback(() => {
    dragState.current = null;
  }, []);

  const width = sidebarCollapsed ? SIDEBAR_COMPACT : sidebarWidth;

  return (
    <ContextMenuProvider>
    <div className="shell" ref={shellRef}>
      <nav
        className="shell-sidebar"
        style={{ width }}
        data-collapsed={sidebarCollapsed || undefined}
        aria-label="Navigation"
      >
        <Sidebar mode={mode} collapsed={sidebarCollapsed} />
      </nav>
      <div
        className="shell-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setSidebarWidth(sidebarWidth - 16);
          if (e.key === "ArrowRight") setSidebarWidth(sidebarWidth + 16);
        }}
      />
      <main className="shell-main" aria-label={mode === "chat" ? "Chat" : "Code"}>
        <MainPane mode={mode} />
      </main>
      <SettingsDialog />
    </div>
    </ContextMenuProvider>
  );
}

/** F6 / Shift+F6 rotates focus between the app's top-level regions. */
function cycleRegions(root: HTMLElement | null, backwards: boolean) {
  if (!root) return;
  const regions = Array.from(root.querySelectorAll<HTMLElement>(".shell-sidebar, .shell-main"));
  if (regions.length === 0) return;
  const activeIndex = regions.findIndex((r) => r.contains(document.activeElement));
  const next =
    regions[(activeIndex + (backwards ? -1 : 1) + regions.length) % regions.length] ?? regions[0];
  if (!next) return;
  const focusable = next.querySelector<HTMLElement>(
    "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
  );
  (focusable ?? next).focus();
}
