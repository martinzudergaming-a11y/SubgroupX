import http from "node:http";
import { errorMessage } from "../foundation/errors.ts";
import { WebSocketServer, WebSocket } from "ws";
import { sessionManager } from "./manager.ts";
import { RUNTIME_PTY_PROTOCOL_VERSION, type RuntimePtyClientControl } from "./runtime-pty-protocol.ts";
import { startWsHeartbeat, RUNTIME_HEARTBEAT_MS } from "../transport/ws-util.ts";

const PTY_PATH = "/runtime/pty";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PTY_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_DIM = 1000;

function clampDim(v: string | null): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 80;
  return Math.min(n, MAX_DIM);
}

export function attachRuntimePtyHost(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== PTY_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  startWsHeartbeat(wss, RUNTIME_HEARTBEAT_MS);
  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    new RuntimePtyConn(
      ws,
      url.searchParams.get("userId") ?? "",
      url.searchParams.get("sessionId") ?? "",
      url.searchParams.get("create") === "1",
      clampDim(url.searchParams.get("cols")),
      clampDim(url.searchParams.get("rows")),
    );
  });
  return wss;
}

class RuntimePtyConn {
  private viewer = 0;
  private closed = false;

  constructor(
    private ws: WebSocket,
    private userId: string,
    private sessionId: string,
    create: boolean,
    cols: number,
    rows: number,
  ) {
    this.sendControl({ type: "hello", runtimePtyProtocolVersion: RUNTIME_PTY_PROTOCOL_VERSION });
    ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    const onGone = () => {
      this.closed = true;
      if (this.viewer) sessionManager.getRuntime(this.userId, this.sessionId)?.detachPty(this.viewer);
    };
    ws.on("close", onGone);
    ws.on("error", onGone);

    const rt = sessionManager.getRuntime(this.userId, this.sessionId);
    if (!rt) {
      this.sendControl({ type: "error", message: "session not found" });
      this.closeWs();
      return;
    }
    rt.attachPty({
      cols,
      rows,
      create,
      onData: (chunk) => this.sendData(chunk),
      onExit: (code) => {
        this.sendControl({ type: "exit", code });
        this.closeWs();
      },
    })
      .then(({ viewer, status }) => {
        if (status === "none") {
          this.sendControl({ type: "no_terminal" });
          this.closeWs();
          return;
        }
        this.viewer = viewer;
        if (this.closed) {
          rt.detachPty(viewer);
          return;
        }
        this.sendControl({ type: "ready" });
      })
      .catch((e) => {
        this.sendControl({ type: "error", message: errorMessage(e) });
        this.closeWs();
      });
  }

  private sendData(chunk: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_PTY_BUFFER_BYTES) {
      this.closeWs(1013, "pty backpressure");
      return;
    }
    this.ws.send(chunk, { binary: true });
  }

  private sendControl(ev: { type: string; [k: string]: unknown }): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private closeWs(code?: number, reason?: string): void {
    try { this.ws.close(code, reason); } catch {  }
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (!this.viewer) return;
      if (data.length > MAX_INPUT_BYTES) return;
      this.rtByMessage()?.writePty(this.viewer, new Uint8Array(data));
      return;
    }
    let msg: RuntimePtyClientControl;
    try {
      msg = JSON.parse(data.toString("utf8")) as RuntimePtyClientControl;
    } catch {
      return;
    }
    if (msg.type === "resize" && this.viewer) {
      this.rtByMessage()?.resizePty(this.viewer, clampDim(String(msg.cols)), clampDim(String(msg.rows)));
    } else if (msg.type === "detach" && this.viewer) {
      this.rtByMessage()?.detachPty(this.viewer);
      this.viewer = 0;
    }
  }

  private rtByMessage() {
    return sessionManager.getRuntime(this.userId, this.sessionId);
  }
}
