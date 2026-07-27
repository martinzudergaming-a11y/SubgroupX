import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "../identity/auth.ts";
import { executionDenial } from "../identity/access-gate.ts";
import { runtimeClient } from "../runtime/manager.ts";
import { createPtyGateway, type PtyGateway } from "../runtime/pty-gateway.ts";
import { RUNTIME_SOCKET } from "../config.ts";
import { safeCloseWs } from "./ws-util.ts";

const MAX_DIM = 1000;
const MAX_INPUT_BYTES = 64 * 1024;

export function createPtyServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const user = verifyToken(url.searchParams.get("token") ?? "");
    if (!user) {
      ws.close(4001, "unauthorized");
      return;
    }
    const denial = executionDenial(user.id, { includeDraining: true });
    if (denial) {
      ws.close(denial.wsCode, denial.kind);
      return;
    }
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!RUNTIME_SOCKET && !runtimeClient.getRuntime(user.id, sessionId)) {
      ws.close(4004, "session not found");
      return;
    }
    const create = url.searchParams.get("create") === "1";
    new PtyConnection(ws, user.id, sessionId, clampDim(url.searchParams.get("cols")), clampDim(url.searchParams.get("rows")), create);
  });

  return wss;
}

function clampDim(v: string | null): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 80;
  return Math.min(n, MAX_DIM);
}

class PtyConnection {
  private gateway: PtyGateway;
  private attached = false;

  constructor(
    private ws: WebSocket,
    userId: string,
    sessionId: string,
    cols: number,
    rows: number,
    create: boolean,
  ) {
    this.gateway = createPtyGateway(userId, sessionId);
    const onGone = () => this.gateway.close();
    ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on("close", onGone);
    ws.on("error", onGone);

    void this.gateway.attach({
      cols,
      rows,
      create,
      onData: (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
      },
      onControl: (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ev.type === "ready") this.attached = true;
        ws.send(JSON.stringify(ev));
        if (ev.type !== "ready") ws.close();
      },
      onClose: (code, reason) => safeCloseWs(ws, code >= 4000 && code < 5000 ? code : 1011, reason),
    });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (!this.attached) return;
      if (data.length > MAX_INPUT_BYTES) return;
      this.gateway.write(new Uint8Array(data));
      return;
    }
    let msg: { type?: string; cols?: number; rows?: number; seq?: number; ts?: number };
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "ping") {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "pong", seq: msg.seq, ts: msg.ts }));
      return;
    }
    if (!this.attached) return;
    if (msg.type === "resize") this.gateway.resize(clampDim(String(msg.cols)), clampDim(String(msg.rows)));
  }
}
