import type { WebSocket, WebSocketServer } from "ws";

export function truncateCloseReason(reason: string): string {
  const enc = new TextEncoder();
  if (enc.encode(reason).length <= 123) return reason;
  let out = "";
  for (const ch of reason) {
    if (enc.encode(out + ch).length > 123) break;
    out += ch;
  }
  return out;
}

export function safeCloseWs(ws: WebSocket, code: number, reason = ""): void {
  try {
    ws.close(code, truncateCloseReason(reason));
  } catch {
    try { ws.terminate(); } catch {  }
  }
}

export const RUNTIME_HEARTBEAT_MS = 15_000;

export const BROWSER_HEARTBEAT_MS = 30_000;

export function startWsHeartbeat(wss: WebSocketServer, intervalMs: number): () => void {
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { try { ws.terminate(); } catch {  } continue; }
      alive.delete(ws);
      try { ws.ping(); } catch {  }
    }
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  wss.on("close", stop);
  return stop;
}
