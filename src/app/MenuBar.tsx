/**
 * Windows application menu bar (File · Edit · View · Conversation · Window ·
 * Help), rendered inside the custom titlebar. Items are wired to the app's real
 * stores and Tauri window commands — no dead entries. Standard menu-bar
 * behaviour: click to open, hover to switch once open, Escape / click-away to
 * close, Alt underlines deferred to the OS.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUiStore } from "@/state/uiStore";
import { useAuthStore } from "@/state/authStore";
import { startNewChat } from "@/features/sidebar/conversationActions";
import { backendBaseUrl } from "@/lib/backend/config";
import "./menubar.css";

interface MenuItem {
  label: string;
  shortcut?: string;
  run?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}
interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

/** Insert text at the caret of the focused input/textarea/contenteditable. */
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
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSettings = useUiStore((s) => s.openSettings);

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
        { label: "New code session", shortcut: "Ctrl+Shift+N", run: () => setMode("code") },
        { label: "Open Quick composer", shortcut: "Ctrl+Space", separatorBefore: true, run: () => void invoke("quick_show").catch(() => {}) },
        { label: "Settings", shortcut: "Ctrl+,", separatorBefore: true, run: () => openSettings(true) },
        { label: "Sign out", separatorBefore: true, danger: true, run: () => void useAuthStore.getState().signOut() },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "Ctrl+Z", run: () => document.execCommand("undo") },
        { label: "Redo", shortcut: "Ctrl+Y", run: () => document.execCommand("redo") },
        { label: "Cut", shortcut: "Ctrl+X", separatorBefore: true, run: () => document.execCommand("cut") },
        { label: "Copy", shortcut: "Ctrl+C", run: () => document.execCommand("copy") },
        { label: "Paste", shortcut: "Ctrl+V", run: () => void pasteFromClipboard() },
        { label: "Select all", shortcut: "Ctrl+A", run: () => document.execCommand("selectAll") },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        { label: "Toggle sidebar", shortcut: "Ctrl+B", run: () => toggleSidebar() },
        { label: "Light theme", separatorBefore: true, run: () => setTheme("light") },
        { label: "Dark theme", run: () => setTheme("dark") },
        { label: "Match system", run: () => setTheme("system") },
        { label: "Go to Chats", shortcut: "Ctrl+1", separatorBefore: true, run: () => setMode("chat") },
        { label: "Go to Code", shortcut: "Ctrl+2", run: () => setMode("code") },
      ],
    },
    {
      id: "conversation",
      label: "Conversation",
      items: [
        { label: "New chat", shortcut: "Ctrl+N", run: () => startNewChat() },
        { label: "Memory", separatorBefore: true, run: () => useUiStore.getState().setView({ kind: "memory" }) },
        { label: "Connectors", run: () => useUiStore.getState().setView({ kind: "connectors" }) },
        { label: "Scheduled tasks", run: () => useUiStore.getState().setView({ kind: "tasks" }) },
      ],
    },
    {
      id: "window",
      label: "Window",
      items: [
        { label: "Minimize", run: () => void win.minimize() },
        { label: "Maximize / Restore", run: () => void win.toggleMaximize() },
        { label: "Close window", shortcut: "Ctrl+W", separatorBefore: true, run: () => void win.close() },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        { label: "Juno help", run: () => void openUrl(`${backendBaseUrl()}/help`) },
        { label: "Keyboard shortcuts", run: () => void openUrl(`${backendBaseUrl()}/help/shortcuts`) },
        { label: "What's new", run: () => void openUrl(`${backendBaseUrl()}/changelog`) },
        { label: "About Juno for Windows", separatorBefore: true, run: () => void openUrl(backendBaseUrl()) },
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
                  <div key={item.label} role="none">
                    {item.separatorBefore && i > 0 ? <div className="menubar-sep" role="separator" /> : null}
                    <button
                      type="button"
                      role="menuitem"
                      className={item.danger ? "menubar-row menubar-row-danger" : "menubar-row"}
                      onClick={act(() => item.run?.())}
                    >
                      <span className="menubar-row-label">{item.label}</span>
                      {item.shortcut ? <span className="menubar-row-key">{item.shortcut}</span> : null}
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
