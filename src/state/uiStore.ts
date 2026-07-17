/** Window-level UI preferences, persisted locally (not account data). */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";
export type AccentName = "coral" | "teal" | "violet" | "amber" | "sage";
export type AppMode = "chat" | "code";

interface UiState {
  theme: ThemePreference;
  accent: AccentName;
  mode: AppMode;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setTheme(theme: ThemePreference): void;
  setAccent(accent: AccentName): void;
  setMode(mode: AppMode): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
}

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_COMPACT = 64;

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      accent: "coral",
      mode: "chat",
      sidebarCollapsed: false,
      sidebarWidth: 280,
      setTheme: (theme) => set({ theme }),
      setAccent: (accent) => set({ accent }),
      setMode: (mode) => set({ mode }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width))) }),
    }),
    { name: "juno.ui" },
  ),
);

/** Applies theme + accent to <html>; returns a cleanup for the system listener. */
export function applyThemeToDocument(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const { theme, accent } = useUiStore.getState();
    const dark = theme === "dark" || (theme === "system" && media.matches);
    document.documentElement.classList.toggle("dark", dark);
    if (accent === "coral") {
      document.documentElement.removeAttribute("data-accent");
    } else {
      document.documentElement.setAttribute("data-accent", accent);
    }
  };
  apply();
  media.addEventListener("change", apply);
  const unsubscribe = useUiStore.subscribe(apply);
  return () => {
    media.removeEventListener("change", apply);
    unsubscribe();
  };
}
