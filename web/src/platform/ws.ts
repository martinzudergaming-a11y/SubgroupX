import { PROTOCOL_VERSION, type ClientOp, type ServerEvent } from "@shared/protocol";
import { getToken } from "./api.ts";
import { logClient } from "./client-log.ts";
import { PendingMutationRouter } from "./pending-mutation-router.ts";

type Handler = (ev: ServerEvent) => void;

const VERSION_POLL_MS = 90_000;

export interface UpdateAvailable {
  protocol: boolean;
  clientVersion: string;
  serverVersion: string;
}

export type WsState = "connecting" | "open" | "reconnecting" | "offline";

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private eventChars = new WeakMap<ServerEvent, number>();
  private connHandlers = new Set<(connected: boolean) => void>();
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private queue: ClientOp[] = [];
  private pendingMutationRouter = new PendingMutationRouter();
  private _state: WsState = "offline";
  private hooksInstalled = false;
  onState: ((state: WsState) => void) | null = null;
  onUpdateAvailable: ((info: UpdateAvailable) => void) | null = null;
  private updateNotified: string | null = null;
  private versionPollTimer: number | null = null;
  private lifecycleAbort: AbortController | null = null;
  private _serverProtocolVersion = 0;
  get serverProtocolVersion(): number {
    return this._serverProtocolVersion;
  }
  onHello: ((protocolVersion: number) => void) | null = null;
  onSuspended: (() => void) | null = null;

  connect(): void {
    this.closedByUser = false;
    this.installLifecycleHooks();
    this.open();
  }

  addHandler(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onConnect(fn: (connected: boolean) => void): () => void {
    this.connHandlers.add(fn);
    return () => {
      this.connHandlers.delete(fn);
    };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get state(): WsState {
    return this._state;
  }

  eventCharCount(ev: ServerEvent): number {
    return this.eventChars.get(ev) ?? 0;
  }

  private log(...args: unknown[]): void {
    console.info(`[ws ${stamp()}]`, ...args);
  }

  private setState(next: WsState): void {
    if (this._state === next) return;
    this._state = next;
    this.log("state →", next, next === "reconnecting" ? `(attempt ${this.reconnectAttempts})` : "");
    if (next !== "open" && this._serverProtocolVersion !== 0) {
      this._serverProtocolVersion = 0;
      this.onHello?.(0);
    }
    this.onState?.(next);
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    const token = getToken();
    if (!token) {
      this.log("no auth token; staying offline");
      this.setState("offline");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.log("navigator offline; deferring connect until 'online'");
      this.setState("offline");
      return;
    }
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    this.log("opening", url, this.reconnectAttempts > 0 ? `(attempt ${this.reconnectAttempts})` : "");
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}&protocolVersion=${PROTOCOL_VERSION}`);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws || this.closedByUser) {
        ws.close();
        return;
      }
      this.log("open");
      this.reconnectAttempts = 0;
      this.setState("open");
      for (const fn of [...this.connHandlers]) fn(true);
      const pending = this.queue;
      this.queue = [];
      if (pending.length) this.log("flushing", pending.length, "queued op(s)");
      for (const op of pending) this.send(op);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws || this.closedByUser) return;
      try {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (typeof e.data === "string") this.eventChars.set(ev, e.data.length);
        if (ev.type === "hello") {
          this._serverProtocolVersion = ev.protocolVersion;
          this.onHello?.(ev.protocolVersion);
          this.checkVersion(ev.protocolVersion, ev.appVersion);
        }
        this.pendingMutationRouter.observe(ev);
        for (const h of [...this.handlers]) h(ev);
      } catch {
      }
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      this.log("close", `code=${e.code}`, e.reason ? `reason=${e.reason}` : "");
      if (![1000, 1001, 1005, 4003].includes(e.code)) {
        logClient("ws_abnormal_close", `code=${e.code}${e.reason ? ` reason=${e.reason}` : ""}`);
      }
      this.ws = null;
      this.pendingMutationRouter.clear();
      for (const fn of [...this.connHandlers]) fn(false);
      if (e.code === 4003) {
        this.closedByUser = true;
        this.setState("offline");
        this.onSuspended?.();
        return;
      }
      if (this.closedByUser) {
        this.setState("offline");
      } else {
        this.setState("reconnecting");
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.log("error (closing socket to trigger reconnect)");
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectAttempts++;
    this.log("reconnect scheduled in", `${Math.round(delay)}ms`, `(attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  reconnectNow(reason: string): void {
    if (this.closedByUser) return;
    if (this.connected) {
      if (this._state !== "open") {
        this.log("reconnectNow:", reason, "— socket still alive, marking open");
        this.setState("open");
      }
      return;
    }
    this.log("reconnectNow:", reason);
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.open();
  }

  private checkVersion(serverProtocol: number, serverApp: string): void {
    if (this.updateNotified === serverApp) return;
    const clientApp = __APP_VERSION__;
    const protocolMismatch = typeof serverProtocol === "number" && serverProtocol !== PROTOCOL_VERSION;
    const appMismatch = Boolean(serverApp) && serverApp !== "dev" && clientApp !== "dev" && serverApp !== clientApp;
    if (!protocolMismatch && !appMismatch) return;
    this.updateNotified = serverApp;
    this.log("update available", `client=${clientApp} server=${serverApp}`, protocolMismatch ? "(protocol changed)" : "");
    this.onUpdateAvailable?.({ protocol: protocolMismatch, clientVersion: clientApp, serverVersion: serverApp });
  }

  private async checkServedVersion(): Promise<void> {
    try {
      const res = await fetch("/version.txt", { cache: "no-store" });
      if (!res.ok) return;
      const v = (await res.text()).trim();
      if (!v || v.length > 80 || /[<>\s]/.test(v)) return;
      this.checkVersion(PROTOCOL_VERSION, v);
    } catch {  }
  }

  private installLifecycleHooks(): void {
    if (this.hooksInstalled || typeof window === "undefined") return;
    this.hooksInstalled = true;
    const lifecycle = new AbortController();
    this.lifecycleAbort = lifecycle;
    const signal = lifecycle.signal;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.log("tab visible", `(socket ${this.connected ? "alive" : "down"})`);
        this.reconnectNow("tab became visible");
      }
    }, { signal });
    window.addEventListener("pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) {
        this.log("pageshow (bfcache restore)");
        this.reconnectNow("pageshow bfcache restore");
      }
    }, { signal });
    void this.checkServedVersion();
    this.versionPollTimer = window.setInterval(() => void this.checkServedVersion(), VERSION_POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.checkServedVersion();
    }, { signal });
    window.addEventListener("online", () => {
      this.log("network online");
      this.reconnectNow("network came online");
    }, { signal });
    window.addEventListener("offline", () => {
      this.log("network offline");
      this.setState("offline");
    }, { signal });
  }

  send(op: ClientOp): void {
    this.pendingMutationRouter.track(op);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(op));
    } else {
      this.queue.push(op);
    }
  }

  pendingMutationSession(ev: Extract<ServerEvent, { type: "error" }>): string | null {
    if (!ev.code) return null;
    return this.pendingMutationRouter.sessionFor(ev as Extract<ServerEvent, { type: "error" }> & { code: NonNullable<typeof ev.code> });
  }

  close(): void {
    this.closedByUser = true;
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    this.hooksInstalled = false;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.versionPollTimer != null) {
      clearInterval(this.versionPollTimer);
      this.versionPollTimer = null;
    }
    const active = this.ws;
    this.ws = null;
    this.pendingMutationRouter.clear();
    active?.close();
    if (active) {
      for (const fn of [...this.connHandlers]) fn(false);
    }
    this.queue = [];
    this.setState("offline");
  }
}
