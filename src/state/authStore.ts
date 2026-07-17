/**
 * Account/session state machine for the whole app.
 *
 * restoring -> signedOut -> authorizing -> signedIn
 *                   ^------------------------|  (sign-out / revocation)
 *
 * Credentials live in Rust; this store only tracks status + profile.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  beginSignIn,
  cancelSignIn,
  completeSignIn,
  configureTransport,
  fetchSession,
  signOut as signOutBackend,
} from "@/lib/backend/auth";
import { hasStoredSession, onSessionRevoked } from "@/lib/backend/tokens";
import { purgeLocalData } from "@/lib/data/syncEngine";
import { BackendError, type DeviceSession, type Profile } from "@/lib/backend/types";

export type AuthStatus = "restoring" | "signedOut" | "authorizing" | "signedIn";

interface AuthState {
  status: AuthStatus;
  profile: Profile | null;
  deviceSession: DeviceSession | null;
  /** User-facing error from the latest failed sign-in attempt. */
  error: string | null;
  signIn(): Promise<void>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
  restore(): Promise<void>;
  handleDeepLink(url: string): Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "restoring",
  profile: null,
  deviceSession: null,
  error: null,

  async restore() {
    await configureTransport();
    await onSessionRevoked(() => {
      void purgeLocalData();
      set({ status: "signedOut", profile: null, deviceSession: null });
    });
    try {
      if (!(await hasStoredSession())) {
        set({ status: "signedOut" });
        return;
      }
      const session = await fetchSession();
      set({
        status: "signedIn",
        profile: session.profile,
        deviceSession: session.deviceSession,
        error: null,
      });
    } catch (err) {
      if (err instanceof BackendError && err.isAuthError) {
        set({ status: "signedOut", profile: null, deviceSession: null });
      } else {
        // Offline with a stored session: keep the user signed in; data layers
        // handle their own retries against the local cache.
        set({ status: (await hasStoredSession()) ? "signedIn" : "signedOut" });
      }
    }
  },

  async signIn() {
    set({ status: "authorizing", error: null });
    try {
      await configureTransport();
      await beginSignIn();
    } catch (err) {
      set({
        status: "signedOut",
        error: err instanceof Error ? err.message : "Couldn't open the browser to sign in.",
      });
    }
  },

  cancelSignIn() {
    cancelSignIn();
    if (get().status === "authorizing") set({ status: "signedOut" });
  },

  async handleDeepLink(url: string): Promise<boolean> {
    let result;
    try {
      result = await completeSignIn(url);
    } catch (err) {
      set({
        status: "signedOut",
        error: err instanceof Error ? err.message : "Sign-in failed.",
      });
      return true;
    }
    if (!result) return false;
    try {
      const session = await fetchSession();
      set({
        status: "signedIn",
        profile: session.profile,
        deviceSession: session.deviceSession,
        error: null,
      });
    } catch {
      set({
        status: "signedIn",
        deviceSession: result.deviceSession,
        error: null,
      });
    }
    return true;
  },

  async signOut() {
    await signOutBackend();
    await purgeLocalData();
    set({ status: "signedOut", profile: null, deviceSession: null, error: null });
  },
}));

/**
 * Wire the Rust deep-link event to the store. Non-auth deep links are
 * forwarded to `onOtherDeepLink` (e.g. future juno://open/... routes).
 */
export async function attachDeepLinkListener(
  onOtherDeepLink?: (url: string) => void,
): Promise<() => void> {
  return listen<string[]>("juno://deep-link", async (event) => {
    for (const url of event.payload) {
      const handled = await useAuthStore.getState().handleDeepLink(url);
      if (!handled) onOtherDeepLink?.(url);
    }
  });
}
