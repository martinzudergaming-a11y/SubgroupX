let requested = false;

let lastForeignFocus = 0;
const focusChan: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("oiia-focus") : null;
if (focusChan) {
  focusChan.onmessage = () => { lastForeignFocus = Date.now(); };
  const beat = () => { if (!document.hidden && document.hasFocus()) focusChan.postMessage(1); };
  window.addEventListener("focus", beat);
  document.addEventListener("visibilitychange", beat);
  setInterval(beat, 2000);
}

export function ensureNotifyPermission(): void {
  if (requested || typeof Notification === "undefined") return;
  requested = true;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

export function notifyBackground(title: string, body: string, tag: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return;
  if (Date.now() - lastForeignFocus < 4000) return;
  try {
    const n = new Notification(title, { body, tag, icon: "/favicon-cat-32.png", silent: false });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
  }
}
