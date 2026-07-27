import React from "react";
import { removeBootSplash } from "./platform/boot-splash";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LocaleProvider } from "./i18n";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { registerServiceWorker } from "./platform/pwa.ts";
import { watchInstallPrompt } from "./platform/install-app.ts";
import { installGlobalClientLog } from "./platform/client-log.ts";
import { installSystemColorScheme } from "./platform/color-scheme.ts";
import "./index.css";
import "./styles.css";

registerServiceWorker();
watchInstallPrompt();
installSystemColorScheme();
installGlobalClientLog();

try {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/.test(ua)) document.documentElement.classList.add("is-darwin");
} catch {  }

function BootSplashReaper() {
  React.useEffect(() => {
    removeBootSplash();
  }, []);
  return null;
}

function CrashFallback() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "14px",
        padding: "24px",
        background: "var(--app-frame, #F1F4ED)",
        color: "#2B2620",
        fontFamily: "system-ui, -apple-system, sans-serif",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "15px", fontWeight: 600 }}>Something went wrong</div>
      <div style={{ fontSize: "13px", color: "#837B6C", maxWidth: "320px", lineHeight: 1.6 }}>
        The app hit an unexpected error. Reloading usually fixes it — your sessions are saved on the server.
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: "4px",
          padding: "8px 18px",
          borderRadius: "8px",
          border: "none",
          background: "#1C1B15",
          color: "#FAF9F3",
          fontSize: "13px",
          fontWeight: 560,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<CrashFallback />}>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </ErrorBoundary>

    <BootSplashReaper />
  </React.StrictMode>,
);
