import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { WebSocket } from "ws";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `oiia-rt-connector-data-${process.pid}-`));
process.env.AGENT_WEB_DATA_DIR = dataDir;
const sock = path.join(os.tmpdir(), `oiia-rt-connector-${process.pid}.sock`);
process.env.AGENT_WEB_RUNTIME_SOCKET = sock;

process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
  if (e?.code === "EPIPE") return;
  console.error(e);
  process.exit(1);
});

const { RUNTIME_SOCKET } = await import("../server/src/config.ts");
const { createRuntimeHost } = await import("../server/src/runtime/runtime-ipc.ts");
const { runtimeClient } = await import("../server/src/runtime/manager.ts");
const { attachRuntimeConnectorHost } = await import("../server/src/runtime/runtime-connector-host.ts");
const { connectorManager } = await import("../server/src/runtime/connector-manager.ts");
const { proxyConnectorUpgrade } = await import("../server/src/transport/connector-proxy.ts");
const { signup } = await import("../server/src/identity/auth.ts");

assert.equal(RUNTIME_SOCKET, sock, "config.RUNTIME_SOCKET reflects the env set before import");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try { fs.unlinkSync(sock); } catch {  }
const runtime = createRuntimeHost(runtimeClient, sock);
attachRuntimeConnectorHost(runtime);
await new Promise<void>((r) => runtime.once("listening", () => r()));

const web = http.createServer();
web.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/connector") {
    proxyConnectorUpgrade(req, socket, head, sock);
  } else {
    socket.destroy();
  }
});
await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
const addr = web.address();
assert.ok(addr && typeof addr === "object", "web server bound a TCP port");
const webPort = addr.port;

let client: WebSocket | null = null;
try {
  const cuid = (await signup(`conn-tunnel-${process.pid}@gmail.com`, "password123")).id;
  const created = await runtimeClient.connectorCreateToken(cuid, "tunnel-test", "~/.agent-web/workspaces");
  assert.ok(created.token && created.info?.id, "connectorCreateToken minted a token+info");
  const connectorId = created.info.id;
  assert.equal(connectorManager.isOnline(connectorId), false, "connector starts offline (no daemon connected)");

  const frames: string[] = [];
  let metricsCalls = 0;
  let compatExecCalls = 0;
  client = new WebSocket(`ws://127.0.0.1:${webPort}/connector`, {
    headers: { authorization: `Bearer ${created.token}` },
  });
  client.on("message", (d) => {
    const raw = d.toString("utf8");
    frames.push(raw);
    const msg = JSON.parse(raw) as { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
    if (msg.type !== "request" || typeof msg.id !== "string") return;
    if (msg.method === "metrics") {
      metricsCalls += 1;
      client?.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: { cpuPct: 31, memUsed: 6 * 1024 ** 3, memTotal: 16 * 1024 ** 3 },
      }));
      return;
    }
    if (msg.method === "exec") {
      compatExecCalls += 1;
      assert.equal(msg.params?.sessionId, ".", "old-daemon telemetry does not create a session directory");
      assert.equal(
        msg.params?.command,
        "LC_ALL=C command -p ps -Ao pid=,ppid=,pcpu=,pmem=,rss=,state=,etime=,comm=",
        "old-daemon telemetry uses one fixed argv-free command",
      );
      client?.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: {
          stdout: [
            "4102 1 24.6 3.2 522240 R+ 12:48 /usr/local/bin/node",
            "982 1 8.1 1.5 245760 Ss 04:21:09 /System/Library/CoreServices/WindowServer",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timed out — handshake did not cross the tunnel")), 5_000);
    client!.on("open", () => { clearTimeout(t); resolve(); });
    client!.on("error", (e) => { clearTimeout(t); reject(e); });
    client!.on("close", (code) => { clearTimeout(t); reject(new Error(`ws closed before open (code ${code})`)); });
  });
  client.send(JSON.stringify({
    type: "notification",
    method: "client/hello",
    params: { version: 3, capabilities: ["exec", "metrics"] },
  }));

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !connectorManager.isOnline(connectorId)) await wait(30);
  assert.equal(connectorManager.isOnline(connectorId), true, "connector is ONLINE in the runtime's connectorManager (handshake+token crossed the tunnel)");
  assert.ok(connectorManager.list(cuid).some((c) => c.id === connectorId && c.online), "connector shows online in connectorManager.list");

  const helloDeadline = Date.now() + 2_000;
  while (Date.now() < helloDeadline && !frames.some((f) => f.includes("server/hello"))) await wait(30);
  const hello = frames.find((f) => f.includes("server/hello"));
  assert.ok(hello, "runtime's server/hello frame round-trips back to the daemon through the tunnel");
  const parsed = JSON.parse(hello) as { type?: string; method?: string; params?: { connectorId?: string } };
  assert.equal(parsed.method, "server/hello", "the tunneled frame is the connector server/hello notification");
  assert.equal(parsed.params?.connectorId, connectorId, "server/hello carries the right connectorId end-to-end");

  const capDeadline = Date.now() + 2_000;
  while (Date.now() < capDeadline && connectorManager.connectionCapability(connectorId, "telemetry.v1") === null) await wait(20);
  assert.equal(connectorManager.connectionCapability(connectorId, "telemetry.v1"), false, "v3 daemon does not advertise telemetry.v1");
  const telemetry = await runtimeClient.connectorTelemetry(connectorId);
  assert.equal(telemetry?.cpuKind, "load");
  assert.equal(telemetry?.processSource, "compat");
  assert.equal(telemetry?.cpuPct, 31);
  assert.deepEqual(telemetry?.processes.map((p) => p.name), ["node", "WindowServer"]);
  assert.equal(compatExecCalls, 1, "one compatibility process sample runs");
  await runtimeClient.connectorTelemetry(connectorId);
  assert.equal(metricsCalls, 1, "the short telemetry cache deduplicates immediate requests");
  assert.equal(compatExecCalls, 1, "the compatibility process cache deduplicates immediate requests");
  await wait(2_100);
  await runtimeClient.connectorTelemetry(connectorId);
  assert.equal(metricsCalls, 2, "CPU/RAM refresh after the short cache expires");
  assert.equal(compatExecCalls, 1, "old-daemon ps stays on the colder cache");
  const lightLoad = await connectorManager.metrics(connectorId);
  assert.deepEqual(lightLoad, { cpuPct: 31, memUsed: 6 * 1024 ** 3, memTotal: 16 * 1024 ** 3 });
  assert.equal(compatExecCalls, 1, "the session load path never requests a process scan");

  console.log("OK runtime-connector-tunnel: daemon WS tunnel + server hello + bounded v3 telemetry compatibility path");
} finally {
  try { client?.terminate(); } catch {  }
  try { web.close(); } catch {  }
  try { runtime.close(); } catch {  }
  try { fs.unlinkSync(sock); } catch {  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {  }
}
await wait(200);
process.exit(0);
