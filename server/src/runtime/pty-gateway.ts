import { WebSocket } from "ws";
import { errorMessage } from "../foundation/errors.ts";
import { RUNTIME_PTY_PROTOCOL_VERSION, type RuntimePtyServerControl } from "./runtime-pty-protocol.ts";
import { runtimeClient } from "./manager.ts";
import { RUNTIME_SOCKET } from "../config.ts";
import { safeCloseWs } from "../transport/ws-util.ts";

export interface PtyAttachOpts {
  cols: number;
  rows: number;
  create: boolean;
  onData: (chunk: Uint8Array) => void;
  onControl: (ev: RuntimePtyServerControl) => void;
  onClose: (code: number, reason: string) => void;
}

export interface PtyGateway {
  attach(opts: PtyAttachOpts): Promise<void>;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  close(): void;
}

export class LocalPtyGateway implements PtyGateway {
  private viewer = 0;
  private detached = false;

  constructor(
    private userId: string,
    private sessionId: string,
  ) {}

  async attach(opts: PtyAttachOpts): Promise<void> {
    const rt = runtimeClient.getRuntime(this.userId, this.sessionId);
    if (!rt) {
      opts.onControl({ type: "error", message: "session not found" });
      return;
    }
    try {
      const { viewer, status } = await rt.attachPty({
        cols: opts.cols,
        rows: opts.rows,
        create: opts.create,
        onData: opts.onData,
        onExit: (code) => opts.onControl({ type: "exit", code }),
      });
      if (status === "none") {
        opts.onControl({ type: "no_terminal" });
        return;
      }
      this.viewer = viewer;
      if (this.detached) {
        rt.detachPty(viewer);
        return;
      }
      opts.onControl({ type: "ready" });
    } catch (e) {
      opts.onControl({ type: "error", message: errorMessage(e) });
    }
  }

  write(data: Uint8Array): void {
    if (!this.viewer) return;
    runtimeClient.getRuntime(this.userId, this.sessionId)?.writePty(this.viewer, data);
  }

  resize(cols: number, rows: number): void {
    if (!this.viewer) return;
    runtimeClient.getRuntime(this.userId, this.sessionId)?.resizePty(this.viewer, cols, rows);
  }

  detach(): void {
    this.detached = true;
    if (this.viewer) runtimeClient.getRuntime(this.userId, this.sessionId)?.detachPty(this.viewer);
  }

  close(): void {
    this.detach();
  }
}

export function createPtyGateway(userId: string, sessionId: string): PtyGateway {
  return RUNTIME_SOCKET
    ? new RemotePtyGateway(userId, sessionId, RUNTIME_SOCKET)
    : new LocalPtyGateway(userId, sessionId);
}

const HANDSHAKE_MS = 5000;

export class RemotePtyGateway implements PtyGateway {
  private ws: WebSocket | null = null;
  private opts: PtyAttachOpts | null = null;
  private handshook = false;
  private closed = false;
  private hsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private userId: string,
    private sessionId: string,
    private socketPath: string,
  ) {}

  attach(opts: PtyAttachOpts): Promise<void> {
    this.opts = opts;
    const qs = new URLSearchParams({
      userId: this.userId,
      sessionId: this.sessionId,
      create: opts.create ? "1" : "0",
      cols: String(opts.cols),
      rows: String(opts.rows),
    });
    const ws = new WebSocket(`ws+unix://${this.socketPath}:/runtime/pty?${qs.toString()}`, { perMessageDeflate: false });
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    this.hsTimer = setTimeout(() => this.fail("pty handshake timeout"), HANDSHAKE_MS);

    ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on("error", (e) => {
      const msg = errorMessage(e);
      if (this.handshook) this.onClose(1011, msg);
      else this.fail(msg);
    });
    ws.on("close", (code, reason) => this.onClose(code || 1006, reason.toString()));
    return Promise.resolve();
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      if (this.handshook) this.opts?.onData(new Uint8Array(data));
      return;
    }
    let ev: RuntimePtyServerControl;
    try {
      ev = JSON.parse(data.toString("utf8")) as RuntimePtyServerControl;
    } catch {
      return;
    }
    if (!this.handshook) {
      if (ev.type !== "hello") return;
      clearTimeout(this.hsTimer);
      if (ev.runtimePtyProtocolVersion !== RUNTIME_PTY_PROTOCOL_VERSION) {
        this.fail("pty protocol mismatch");
        return;
      }
      this.handshook = true;
      return;
    }
    if (ev.type === "hello") return;
    this.opts?.onControl(ev);
  }

  write(data: Uint8Array): void {
    if (this.handshook && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data, { binary: true });
  }

  resize(cols: number, rows: number): void {
    this.sendControl({ type: "resize", cols, rows });
  }

  detach(): void {
    this.sendControl({ type: "detach" });
  }

  private sendControl(ev: { type: string; [k: string]: unknown }): void {
    if (this.handshook && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private fail(message: string): void {
    if (this.closed) return;
    if (!this.handshook) this.opts?.onControl({ type: "error", message });
    this.teardown(1011, message);
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    const wasLive = this.handshook;
    this.teardown(code, reason);
    if (wasLive) this.opts?.onClose(code, reason);
  }

  private teardown(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hsTimer);
    if (this.ws) safeCloseWs(this.ws, code, reason);
  }

  close(): void {
    if (!this.closed) {
      this.detach();
      this.teardown(1000, "client closing");
    }
  }
}
