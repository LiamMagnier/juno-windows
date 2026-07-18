/**
 * In-app auto-update (Tauri updater plugin).
 *
 * Quiet Mac-style UX: background check on launch, optional Settings button,
 * and a "Relaunch to update" chip in the sidebar when a version is downloaded.
 * Never modal-pops the user.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; progress: number }
  | { kind: "ready"; version: string }
  | { kind: "upToDate" }
  | { kind: "error"; message: string };

interface UpdateStore {
  phase: UpdatePhase;
  /** Last successful check (epoch ms). */
  lastCheckedAt: number | null;
  setPhase: (phase: UpdatePhase) => void;
  checkForUpdates: (opts?: { quiet?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  relaunchToUpdate: () => Promise<void>;
}

let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;
let autoStarted = false;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  phase: { kind: "idle" },
  lastCheckedAt: null,

  setPhase: (phase) => set({ phase }),

  checkForUpdates: async (opts) => {
    const quiet = opts?.quiet ?? false;
    const current = get().phase;
    // Don't interrupt an in-flight download or staged ready state.
    if (current.kind === "downloading" || current.kind === "ready" || current.kind === "checking") {
      return;
    }
    set({ phase: { kind: "checking" } });
    try {
      const update = await check();
      set({ lastCheckedAt: Date.now() });
      if (!update) {
        set({ phase: quiet ? { kind: "idle" } : { kind: "upToDate" } });
        pendingUpdate = null;
        return;
      }
      pendingUpdate = update;
      set({
        phase: {
          kind: "available",
          version: update.version,
          notes: update.body ?? null,
        },
      });
      // Quiet path: auto-download so the user only sees "Relaunch to update".
      if (quiet) {
        await get().downloadAndInstall();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Missing pubkey / no network: stay quiet on background checks.
      set({ phase: quiet ? { kind: "idle" } : { kind: "error", message } });
      pendingUpdate = null;
    }
  },

  downloadAndInstall: async () => {
    const update = pendingUpdate;
    if (!update) {
      await get().checkForUpdates({ quiet: false });
      return get().downloadAndInstall();
    }
    const version = update.version;
    set({ phase: { kind: "downloading", version, progress: 0 } });
    try {
      let contentLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const progress =
            contentLength > 0 ? Math.min(1, downloaded / contentLength) : 0;
          set({ phase: { kind: "downloading", version, progress } });
        }
      });
      set({ phase: { kind: "ready", version } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ phase: { kind: "error", message } });
    }
  },

  relaunchToUpdate: async () => {
    if (get().phase.kind !== "ready") return;
    await relaunch();
  },
}));

/** Start the quiet background checker once per session (30 min interval). */
export function startAutomaticUpdateChecks() {
  if (autoStarted) return;
  autoStarted = true;
  // Delay the first check so it never races auth / first paint.
  window.setTimeout(() => {
    void useUpdateStore.getState().checkForUpdates({ quiet: true });
  }, 8_000);
  window.setInterval(
    () => {
      void useUpdateStore.getState().checkForUpdates({ quiet: true });
    },
    30 * 60 * 1000,
  );
}
