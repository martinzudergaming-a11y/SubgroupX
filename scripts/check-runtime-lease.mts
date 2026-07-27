import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startWsHeartbeat } from "../server/src/transport/ws-util.ts";

const INTERVAL = 60;
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws)));
const serverConns: { ws: WebSocket; closed: boolean }[] = [];
wss.on("connection", (ws) => {
  const entry = { ws, closed: false };
  ws.on("close", () => { entry.closed = true; });
  serverConns.push(entry);
});
startWsHeartbeat(wss, INTERVAL);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

try {
  const healthy = await connect();
  const dead = await connect();
  await wait(20);
  assert.equal(serverConns.length, 2, "both peers connected server-side");
  const healthyConn = serverConns[0];
  const deadConn = serverConns[1];

  dead.pause();
  (dead as unknown as { _socket?: { pause(): void } })._socket?.pause();

  await wait(INTERVAL * 4);

  assert.equal(deadConn.closed, true, "host terminates the half-open peer (its runtimes get released)");
  assert.equal(healthyConn.closed, false, "host keeps the responsive peer");
  assert.equal(healthyConn.ws.readyState, WebSocket.OPEN, "responsive server-side connection still open");

  console.log("OK runtime-lease: heartbeat keeps a responsive peer + terminates a half-open one (releases its runtimes)");
} finally {
  for (const c of serverConns) { try { c.ws.terminate(); } catch {  } }
  wss.close();
  server.close();
}
await wait(100);
process.exit(0);
