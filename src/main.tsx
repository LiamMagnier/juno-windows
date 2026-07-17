import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./design/tokens.css";
import "./design/base.css";

// Each Tauri window loads the same tiny entry, then imports only its surface.
// The Quick webview therefore does not parse or execute the full desktop shell.
const Surface = getCurrentWindow().label === "quick"
  ? lazy(() => import("./quick/QuickApp").then((module) => ({ default: module.QuickApp })))
  : lazy(() => import("./app/App").then((module) => ({ default: module.App })));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Surface />
    </Suspense>
  </React.StrictMode>,
);
