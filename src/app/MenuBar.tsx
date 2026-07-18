/**
 * Windows application menu bar (File · Edit · View · Go · Conversation ·
 * Window · Help). Items are wired to real stores/commands — no dead entries.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUiStore } from "@/state/uiStore";
import { useAuthStore } from "@/state/authStore";
import { useUpdateStore } from "@/lib/updater";
import { startNewChat } from "@/features/sidebar/conversationActions";
import { backendBaseUrl } from "@/lib/backend/config";
import "./menubar.css";

interface MenuItem {
  label: string;
  shortcut?: string;
  run?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}
interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

async function pasteFromClipboard() {
  const el = document.activeElement as HTMLElement | null;
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!text || !el) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const baseId = useId();

  const setTheme = useUiStore((s) => s.setTheme);
  const setMode = useUiStore((s) => s.setMode);
  const setView = useUiStore((s) => s.setView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSettings = useUiStore((s) => s.openSettings);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const updatePhase = useUpdateStore((s) => s.phase);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const relaunchToUpdate = useUpdateStore((s) => s.relaunchToUpdate);

  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const win = getCurrentWindow();
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  const menus: Menu[] = [
    {
      id: "file",
      label: "File",
      items: [
        { label: "New chat", shortcut: "Ctrl+N", run: () => startNewChat() },
        {
          label: "New code session",
          shortcut: "Ctrl+Shift+N",
          run: () => {
            setMode("code");
            setView({ kind: "code" });
          },
        },
        {
          label: "New project",
          separatorBefore: true,
          run: () => {
            setMode("chat");
            setView({ kind: "projects" });
          },
        },
        {
          label: "Open Quick composer",
          shortcut: "Ctrl+Space",
          separatorBefore: true,
          run: () => void invoke("quick_show").catch(() => {}),
        },
        {
          label: "Search…",
          shortcut: "Ctrl+K",
          run: () => {
            // Search palette is opened via the same Ctrl+K path in the sidebar.
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
          },
        },
        { label: "Settings", shortcut: "Ctrl+,", separatorBefore: true, run: () => openSettings(true) },
        {
          label: "Sign out",
          separatorBefore: true,
          danger: true,
          run: () => void useAuthStore.getState().signOut(),
        },
        {
          label: "Quit Juno",
          shortcut: "Alt+F4",
          separatorBefore: true,
          run: () => void win.close(),
        },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", run: () => document.execCommand("undo") },
        { label: "Redo", shortcut: "Ctrl+Y", run: () => document.execCommand("redo") },
        {
          label: "Cut",
          shortcut: "Ctrl+X",
          separatorBefore: true,
          run: () => document.execCommand("cut"),
        },
        { label: "Copy", shortcut: "Ctrl+C", run: () => document.execCommand("copy") },
        { label: "Paste", shortcut: "Ctrl+V", run: () => void pasteFromClipboard() },
        {
          label: "Select all",
          shortcut: "Ctrl+A",
          run: () => document.execCommand("selectAll"),
        },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        {
          label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
          shortcut: "Ctrl+B",
          run: () => toggleSidebar(),
        },
        {
          label: "Light theme",
          separatorBefore: true,
          run: () => setTheme("light"),
        },
        { label: "Dark theme", run: () => setTheme("dark") },
        { label: "Match system", run: () => setTheme("system") },
        {
          label: "Zoom in",
          shortcut: "Ctrl+=",
          separatorBefore: true,
          run: () => void invoke("window_zoom", { delta: 0.1 }).catch(() => {
            document.body.style.zoom = String(Math.min(1.4, (Number(document.body.style.zoom) || 1) + 0.1));
          }),
        },
        {
          label: "Zoom out",
          shortcut: "Ctrl+-",
          run: () => {
            document.body.style.zoom = String(Math.max(0.8, (Number(document.body.style.zoom) || 1) - 0.1));
          },
        },
        {
          label: "Reset zoom",
          shortcut: "Ctrl+0",
          run: () => {
            document.body.style.zoom = "1";
          },
        },
      ],
    },
    {
      id: "go",
      label: "Go",
      items: [
        {
          label: "Chats",
          shortcut: "Ctrl+1",
          run: () => {
            setMode("chat");
            setView({ kind: "chat" });
          },
        },
        {
          label: "Code",
          shortcut: "Ctrl+2",
          run: () => {
            setMode("code");
            setView({ kind: "code" });
          },
        },
        {
          label: "Projects",
          separatorBefore: true,
          run: () => {
            setMode("chat");
            setView({ kind: "projects" });
          },
        },
        {
          label: "Memory",
          run: () => {
            setMode("chat");
            setView({ kind: "memory" });
          },
        },
        {
          label: "Connectors",
          run: () => {
            setMode("chat");
            setView({ kind: "connectors" });
          },
        },
        {
          label: "Scheduled tasks",
          run: () => {
            setMode("chat");
            setView({ kind: "tasks" });
          },
        },
      ],
    },
    {
      id: "conversation",
      label: "Conversation",
      items: [
        { label: "New chat", shortcut: "Ctrl+N", run: () => startNewChat() },
        {
          label: "Private chat",
          separatorBefore: true,
          run: () => {
            setMode("chat");
            setView({ kind: "chat" });
            // Private mode is toggled from the composer; open a fresh thread first.
            startNewChat();
          },
        },
        {
          label: "Open settings…",
          separatorBefore: true,
          run: () => openSettings(true),
        },
      ],
    },
    {
      id: "window",
      label: "Window",
      items: [
        { label: "Minimize", run: () => void win.minimize() },
        { label: "Maximize / Restore", run: () => void win.toggleMaximize() },
        {
          label: "Close window",
          shortcut: "Ctrl+W",
          separatorBefore: true,
          run: () => void win.close(),
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        {
          label: updatePhase.kind === "ready" ? `Relaunch to update (${updatePhase.version})` : "Check for updates…",
          run: () => {
            if (updatePhase.kind === "ready") void relaunchToUpdate();
            else void checkForUpdates({ quiet: false });
          },
        },
        {
          label: "Juno on the web",
          separatorBefore: true,
          run: () => void openUrl(backendBaseUrl()),
        },
        {
          label: "Account & plan",
          run: () => void openUrl(`${backendBaseUrl()}/profile`),
        },
        {
          label: "About Juno for Windows",
          separatorBefore: true,
          run: () => void openUrl(backendBaseUrl()),
        },
      ],
    },
  ];

  return (
    <nav ref={rootRef} className="menubar" aria-label="Application menu">
      {menus.map((menu) => {
        const isOpen = open === menu.id;
        return (
          <div key={menu.id} className="menubar-item-wrap">
            <button
              type="button"
              className="menubar-item"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={`${baseId}-${menu.id}`}
              onClick={() => setOpen(isOpen ? null : menu.id)}
              onMouseEnter={() => open && setOpen(menu.id)}
            >
              {menu.label}
            </button>
            {isOpen ? (
              <div id={`${baseId}-${menu.id}`} className="menubar-flyout" role="menu">
                {menu.items.map((item, i) => (
                  <div key={`${menu.id}-${item.label}`} role="none">
                    {item.separatorBefore && i > 0 ? (
                      <div className="menubar-sep" role="separator" />
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      className={item.danger ? "menubar-row menubar-row-danger" : "menubar-row"}
                      disabled={item.disabled}
                      onClick={act(() => item.run?.())}
                    >
                      <span className="menubar-row-label">{item.label}</span>
                      {item.shortcut ? (
                        <span className="menubar-row-key">{item.shortcut}</span>
                      ) : null}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
