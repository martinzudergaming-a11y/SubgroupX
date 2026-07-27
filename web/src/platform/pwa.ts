export const IS_STANDALONE =
  typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches === true;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  const swUrl = `/sw.js?v=${encodeURIComponent(__APP_VERSION__)}`;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn("[pwa] service worker registration failed", err);
    });
  });
}
