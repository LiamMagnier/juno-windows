import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./titlebar.css";

/**
 * Custom Windows titlebar: drag region + Fluent caption buttons.
 * data-tauri-drag-region gives native drag + double-click maximize + the
 * OS snap behaviors that come with system move (Win+arrows always work).
 */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    // A maximized/snapped window is square-cropped by the OS, so drop the
    // app-frame's rounded corners to match (see app.css --window-radius).
    const sync = (isMax: boolean) => {
      setMaximized(isMax);
      document.documentElement.toggleAttribute("data-maximized", isMax);
    };
    void win.isMaximized().then(sync);
    void win
      .onResized(async () => {
        sync(await win.isMaximized());
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  const minimize = useCallback(() => void getCurrentWindow().minimize(), []);
  const toggleMaximize = useCallback(() => void getCurrentWindow().toggleMaximize(), []);
  const close = useCallback(() => void getCurrentWindow().close(), []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-identity" data-tauri-drag-region>
        <span className="titlebar-title" data-tauri-drag-region>
          Juno
        </span>
      </div>
      <div className="titlebar-captions" role="group" aria-label="Window controls">
        <button type="button" className="caption-button" aria-label="Minimize" onClick={minimize}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="caption-button"
          aria-label={maximized ? "Restore down" : "Maximize"}
          onClick={toggleMaximize}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.5 2.5V1a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H7.5M1 2.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H1a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button type="button" className="caption-button caption-close" aria-label="Close" onClick={close}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
