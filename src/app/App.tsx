import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Titlebar } from "./Titlebar";
import { SignIn } from "./SignIn";
import { Shell } from "./Shell";
import { AnnouncementBar } from "./AnnouncementBar";
import { attachDeepLinkListener, useAuthStore } from "@/state/authStore";
import { applyThemeToDocument } from "@/state/uiStore";
import { useUiStore } from "@/state/uiStore";
import { useThreadStore } from "@/state/threadStore";
import { startAutomaticUpdateChecks } from "@/lib/updater";
import "./app.css";

export function App() {
  const status = useAuthStore((s) => s.status);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const cleanupTheme = applyThemeToDocument();
    let cleanupDeepLink: (() => void) | undefined;
    let cleanupOpenConversation: (() => void) | undefined;
    let cleanupOpenSettings: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const routeConversation = (conversationId: string) => {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(conversationId)) return;
        useUiStore.getState().setMode("chat");
        useUiStore.getState().setView({ kind: "chat" });
        useThreadStore.getState().setActive(conversationId);
        void useThreadStore.getState().openThread(conversationId);
      };
      cleanupOpenConversation = await listen<string>(
        "juno://open-conversation",
        (event) => routeConversation(event.payload),
      );
      cleanupOpenSettings = await listen("juno://open-settings", () => {
        useUiStore.getState().openSettings(true);
      });
      cleanupDeepLink = await attachDeepLinkListener((url) => {
        try {
          const parsed = new URL(url);
          if (`${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "") === "open/conversation") {
            const id = parsed.searchParams.get("id");
            if (id) routeConversation(id);
          }
        } catch {
          // Ignore malformed non-auth deep links.
        }
      });
      await useAuthStore.getState().restore();
      if (cancelled) return;
      const startup = await invoke<{
        showMain: boolean;
        pendingConversationId: string | null;
      }>("quick_main_startup").catch(() => ({ showMain: true, pendingConversationId: null }));
      if (startup.pendingConversationId) routeConversation(startup.pendingConversationId);
      setReady(true);
      // The window starts hidden (tauri.conf) so users never see a flash of
      // unstyled/half-restored UI.
      if (startup.showMain) await getCurrentWindow().show();
      // Quiet background update checks (Mac-style — chip when ready, no modal).
      startAutomaticUpdateChecks();
    })();

    return () => {
      cancelled = true;
      cleanupTheme();
      cleanupDeepLink?.();
      cleanupOpenConversation?.();
      cleanupOpenSettings?.();
    };
  }, []);

  return (
    <div className="app-frame">
      <Titlebar />
      {!ready || status === "restoring" ? (
        <div className="app-restoring" role="status" aria-label="Starting Juno" />
      ) : status === "signedIn" ? (
        <>
          <AnnouncementBar />
          <Shell />
        </>
      ) : (
        <SignIn />
      )}
    </div>
  );
}
