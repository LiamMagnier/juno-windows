import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Titlebar } from "./Titlebar";
import { SignIn } from "./SignIn";
import { Shell } from "./Shell";
import { attachDeepLinkListener, useAuthStore } from "@/state/authStore";
import { applyThemeToDocument } from "@/state/uiStore";
import "./app.css";

export function App() {
  const status = useAuthStore((s) => s.status);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const cleanupTheme = applyThemeToDocument();
    let cleanupDeepLink: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      cleanupDeepLink = await attachDeepLinkListener();
      await useAuthStore.getState().restore();
      if (cancelled) return;
      setReady(true);
      // The window starts hidden (tauri.conf) so users never see a flash of
      // unstyled/half-restored UI.
      await getCurrentWindow().show();
    })();

    return () => {
      cancelled = true;
      cleanupTheme();
      cleanupDeepLink?.();
    };
  }, []);

  return (
    <div className="app-frame">
      <Titlebar />
      {!ready || status === "restoring" ? (
        <div className="app-restoring" role="status" aria-label="Starting Juno" />
      ) : status === "signedIn" ? (
        <Shell />
      ) : (
        <SignIn />
      )}
    </div>
  );
}
