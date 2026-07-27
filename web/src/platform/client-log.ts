import { getToken } from "./token";

type ClientEvent = {
  kind: string;
  message: string;
  sessionId?: string;
  path?: string;
};

const queue: ClientEvent[] = [];
const seen = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
const DEDUPE_MS = 30_000;
const MAX_QUEUE = 20;

export function logClient(kind: string, message: unknown, opts: { sessionId?: string; path?: string } = {}): void {
  try {
    const msg = String(message ?? "").slice(0, 500);
    const sig = `${kind}|${msg}|${opts.path ?? ""}`;
    const now = Date.now();
    if ((seen.get(sig) ?? 0) > now - DEDUPE_MS) return;
    seen.set(sig, now);
    if (seen.size > 200) {
      for (const [k, ts] of seen) if (ts < now - DEDUPE_MS) seen.delete(k);
    }
    if (queue.length >= MAX_QUEUE) return;
    queue.push({
      kind: kind.slice(0, 40),
      message: msg,
      sessionId: opts.sessionId?.slice(0, 64),
      path: opts.path?.slice(0, 200),
    });
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, 1500);
    }
  } catch {
  }
}

async function flush(): Promise<void> {
  const events = queue.splice(0, queue.length);
  if (events.length === 0) return;
  const token = getToken();
  try {
    await fetch("/api/client-log", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({ events }),
    });
  } catch {
  }
}

export function installGlobalClientLog(): void {
  window.addEventListener("error", (e) => {
    logClient("window_error", e.message || "script error", {
      path: e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: unknown } | undefined;
    logClient("unhandled_rejection", (r && typeof r === "object" && r.message) || String(e.reason ?? "rejection"));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flush();
  });
}
