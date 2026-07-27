import assert from "node:assert/strict";

class CountedTarget extends EventTarget {
  private active = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (listener) {
      let set = this.active.get(type);
      if (!set) this.active.set(type, set = new Set());
      set.add(listener);
      const signal = typeof options === "object" ? options.signal : undefined;
      signal?.addEventListener("abort", () => set!.delete(listener), { once: true });
    }
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (listener) this.active.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  count(): number {
    return [...this.active.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

const windowTarget = new CountedTarget() as CountedTarget & typeof globalThis;
Object.assign(windowTarget, { setTimeout, clearTimeout, setInterval, clearInterval });
const documentTarget = new CountedTarget() as CountedTarget & { visibilityState: DocumentVisibilityState };
documentTarget.visibilityState = "visible";

Object.defineProperties(globalThis, {
  window: { value: windowTarget, configurable: true },
  document: { value: documentTarget, configurable: true },
  navigator: { value: { onLine: true }, configurable: true },
  location: { value: { protocol: "http:", host: "localhost" }, configurable: true },
  localStorage: {
    value: { getItem: () => "audit-token", setItem() {}, removeItem() {} },
    configurable: true,
  },
  fetch: { value: async () => ({ ok: false }), configurable: true },
});

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSING; }
}
Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { WsClient } = await import("../web/src/platform/ws.ts");
const client = new WsClient();
const internals = client as unknown as { ws: FakeWebSocket | null };
let connectionEdges = 0;
let handled = 0;
client.onConnect(() => { connectionEdges++; });
client.addHandler(() => { handled++; });
client.connect();
assert.equal(sockets.length, 1, "connect should create one socket");
assert.ok(windowTarget.count() + documentTarget.count() > 0, "lifecycle hooks should install on connect");

client.reconnectNow("while connecting");
assert.equal(sockets.length, 1, "reconnect during CONNECTING must not create a duplicate socket");

const first = sockets[0]!;
first.readyState = FakeWebSocket.CLOSED;
client.reconnectNow("replace closed transport");
const second = sockets[1]!;
assert.ok(second, "a closed transport should be replaced");
first.onclose?.({ code: 1006, reason: "stale" } as CloseEvent);
assert.equal(internals.ws, second, "a stale socket close must not clear the current transport");
first.onmessage?.({ data: JSON.stringify({ type: "pong" }) } as MessageEvent);
assert.equal(handled, 0, "a stale socket message must not reach current handlers");

client.close();
assert.equal(windowTarget.count() + documentTarget.count(), 0, "close must remove every instance lifecycle hook");
assert.equal(connectionEdges, 1, "explicit close publishes one disconnected edge even though stale callbacks are ignored");

client.connect();
assert.equal(windowTarget.count() + documentTarget.count() > 0, true, "a reused client reinstalls one lifecycle-hook set");
client.close();
assert.equal(windowTarget.count() + documentTarget.count(), 0, "a second close removes the reinstalled hooks");

console.log("OK ws-client-lifecycle: one connecting socket + stale-callback guard + listener teardown");
