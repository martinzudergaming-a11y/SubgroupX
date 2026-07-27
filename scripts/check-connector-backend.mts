import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-connector-check-"));
const dataDir = path.join(tmp, "data");
const connectorRoot = path.join(tmp, "connector-workspaces");

type JsonObject = Record<string, unknown>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

function capture(child: ChildProcess, name: string, lines: string[]): void {
  child.stdout?.on("data", (chunk) => lines.push(`[${name}] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk) => lines.push(`[${name}:err] ${chunk.toString()}`));
}

function killProcessTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function assertAsciiOnly(label: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    assert.ok(code <= 0x7f, `${label} contains non-ascii code unit 0x${code.toString(16)} at offset ${i}`);
  }
}

function assertConnectorLogsAscii(lines: string[]): void {
  const connectorLines = lines.join("").split(/\r?\n/).filter((line) => line.includes('{"connector":'));
  assert.ok(connectorLines.length > 0, "expected connector logs");
  for (let i = 0; i < connectorLines.length; i++) assertAsciiOnly(`connector log line ${i}`, connectorLines[i] ?? "");
}

async function waitFor(name: string, fn: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${name} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function httpJson<T>(base: string, method: string, apiPath: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${apiPath} ${res.status}: ${(json as { error?: string }).error ?? res.statusText}`);
  return json as T;
}

function websocketUrl(base: string, pathname: string, params: Record<string, string>): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function runChatTurn(base: string, token: string, sessionId: string): Promise<void> {
  const ws = new WebSocket(websocketUrl(base, "/ws", { token }));
  const waiters = new Set<(msg: JsonObject) => void>();
  ws.on("message", (data) => {
    let msg: JsonObject;
    try {
      msg = JSON.parse(data.toString("utf8")) as JsonObject;
    } catch {
      return;
    }
    for (const waiter of [...waiters]) waiter(msg);
  });
  await waitOpen(ws);

  const next = (pred: (msg: JsonObject) => boolean, timeoutMs = 20_000) =>
    new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onMessage);
        reject(new Error("ws event timed out"));
      }, timeoutMs);
      const onMessage = (msg: JsonObject) => {
        if (!pred(msg)) return;
        clearTimeout(timer);
        waiters.delete(onMessage);
        resolve(msg);
      };
      waiters.add(onMessage);
    });

  ws.send(JSON.stringify({ type: "subscribe", sessionId, reqId: "sub" }));
  await next((msg) => msg.type === "ack" && msg.reqId === "sub");
  ws.send(JSON.stringify({ type: "send_message", sessionId, reqId: "run", text: "/bash printf 'from-connector\\n' > proof.txt && pwd" }));
  await next((msg) => msg.type === "ack" && msg.reqId === "run");
  await next((msg) => {
    if (msg.type !== "agent_event") return false;
    const event = msg.event as JsonObject | undefined;
    return event?.t === "tool_end" && event.status === "success";
  }, 30_000);
  ws.close();
}

async function runPtyTurn(base: string, token: string, sessionId: string): Promise<void> {
  const ws = new WebSocket(websocketUrl(base, "/pty", { token, sessionId, create: "1", cols: "80", rows: "24" }));
  await waitOpen(ws);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pty ready timed out")), 15_000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString("utf8")) as JsonObject;
      if (msg.type === "ready") {
        clearTimeout(timer);
        resolve();
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(String(msg.message)));
      }
    });
  });
  await ready;
  ws.send(Buffer.from("printf 'pty-connector\\n' > pty.txt\nexit\n"));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pty exit timed out")), 15_000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString("utf8")) as JsonObject;
      if (msg.type === "exit") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logs: string[] = [];
const unicodeConnectorName = "local-check-" + String.fromCharCode(0x6d4b, 0x8bd5);
let server: ChildProcess | null = null;
let daemon: ChildProcess | null = null;

try {
  server = spawn(path.join(root, "node_modules", ".bin", "tsx"), ["server/src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WEB_DATA_DIR: dataDir,
      AGENT_WEB_SECRET: "connector-check-secret",
      AGENT_WEB_KEY_SECRET: "connector-check-key",
      AGENT_WEB_MCP: "[]",
      AGENT_WEB_ALLOWED_EMAIL_DOMAINS: "*",
      AGENT_WEB_ADMIN_EMAILS: "admin@test.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(server, "server", logs);
  await waitFor("server health", async () => {
    const res = await fetch(`${base}/healthz`).catch(() => null);
    return Boolean(res?.ok);
  }, 60_000);
  console.log("  OK server booted");

  const logoutCleanup = await fetch(`${base}/api/auth/logout`, { method: "POST" });
  assert.equal(logoutCleanup.status, 204);
  assert.equal(logoutCleanup.headers.get("clear-site-data"), '"cookies"');
  console.log("  OK logout clears HttpOnly preview cookies even without a live Bearer");

  const installerRes = await fetch(`${base}/api/connectors/install.sh`);
  assert.equal(installerRes.status, 200);
  assert.match(await installerRes.text(), /agent-web-connector\.mjs/);
  const daemonRes = await fetch(`${base}/api/connectors/agent-web-connector.mjs`);
  assert.equal(daemonRes.status, 200);
  assert.match(await daemonRes.text(), /function parseArgs/);
  console.log("  OK connector bootstrap assets served");

  const signup = await httpJson<{ token: string; user: JsonObject }>(
    base,
    "POST",
    "/api/auth/signup",
    { email: "connector@test.invalid", password: "password123" },
  );
  assert.ok(signup.user);
  console.log("  OK signed up test user");
  const admin = await httpJson<{ token: string }>(
    base,
    "POST",
    "/api/auth/signup",
    { email: "admin@test.invalid", password: "password123" },
  );

  const pairing = await httpJson<{ pairing: { id: string }; code: string }>(
    base,
    "POST",
    "/api/connectors/pairings",
    { name: "local-check", workspaceRoot: connectorRoot },
    signup.token,
  );
  assert.match(pairing.code, /^pair_/);
  console.log("  OK connector pairing code created");

  const tokenFile = path.join(tmp, "connector.token");
  const connectorHome = path.join(tmp, "connector-home");
  fs.mkdirSync(connectorHome, { recursive: true });
  daemon = spawn(
    "sh",
    [
      "-c",
      "curl -fsSL \"$1\" | sh -s -- --url \"$2\" --pair-code \"$3\" --token-file \"$4\" --root \"$5\" --name \"$6\"",
      "connector-installer",
      `${base}/api/connectors/install.sh`,
      base,
      pairing.code,
      tokenFile,
      connectorRoot,
      unicodeConnectorName,
    ],
    {
      cwd: tmp,
      detached: true,
      env: { ...process.env, AGENT_WEB_CONNECTOR_HOME: connectorHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  capture(daemon, "daemon", logs);
  let connectorId = "";
  await waitFor("connector online", async () => {
    const r = await httpJson<{ connectors: { id: string; online: boolean }[] }>(base, "GET", "/api/connectors", undefined, signup.token);
    const online = r.connectors.find((connector) => connector.online);
    connectorId = online?.id ?? "";
    return Boolean(connectorId);
  }, 60_000);
  assert.match(fs.readFileSync(tokenFile, "utf8"), /^conn_/);
  console.log("  OK daemon connected");

  const tested = await httpJson<{ ok: boolean; output?: string; error?: string }>(
    base,
    "POST",
    `/api/connectors/${connectorId}/test`,
    {},
    signup.token,
  );
  assert.equal(tested.ok, true, tested.error ?? tested.output);
  console.log("  OK connector test command ran");

  const telemetryStartedAt = performance.now();
  const telemetryResponse = await fetch(`${base}/api/connectors/${connectorId}/telemetry`, {
    headers: { authorization: `Bearer ${signup.token}` },
  });
  const telemetryLatencyMs = performance.now() - telemetryStartedAt;
  assert.equal(telemetryResponse.status, 200);
  assert.match(telemetryResponse.headers.get("cache-control") ?? "", /no-store/);
  const telemetryText = await telemetryResponse.text();
  const telemetryBytes = Buffer.byteLength(telemetryText);
  assert.ok(telemetryBytes > 0 && telemetryBytes < 256 * 1024, `unexpected telemetry payload: ${telemetryBytes} bytes`);
  const telemetryBody = JSON.parse(telemetryText) as {
    telemetry: {
      sampledAt: number;
      cpuPct: number;
      memUsed: number;
      memTotal: number;
      cpuCores: number;
      cpuKind: string;
      processSource: string;
      processCount: number;
      processes: Array<Record<string, unknown>>;
    };
  };
  const telemetry = telemetryBody.telemetry;
  assert.ok(telemetry.sampledAt > 0);
  assert.ok(telemetry.cpuPct >= 0 && telemetry.cpuPct <= 100);
  assert.ok(telemetry.memTotal > 0 && telemetry.memUsed >= 0 && telemetry.memUsed <= telemetry.memTotal);
  assert.ok(telemetry.cpuCores > 0);
  assert.equal(telemetry.cpuKind, "interval");
  assert.equal(telemetry.processSource, "native");
  assert.ok(telemetry.processCount > 0);
  assert.ok(telemetry.processes.length > 0 && telemetry.processes.length <= 12);
  for (const process of telemetry.processes) {
    assert.deepEqual(
      Object.keys(process).sort(),
      ["cpuPct", "elapsed", "memPct", "name", "pid", "ppid", "rssBytes", "state"].sort(),
      "telemetry must never expose argv/cmdline fields",
    );
  }
  const cachedStartedAt = performance.now();
  const cachedResponse = await fetch(`${base}/api/connectors/${connectorId}/telemetry`, {
    headers: { authorization: `Bearer ${signup.token}` },
  });
  const cachedLatencyMs = performance.now() - cachedStartedAt;
  assert.equal(cachedResponse.status, 200);
  const cachedBody = await cachedResponse.json() as { telemetry: { sampledAt: number } };
  assert.equal(cachedBody.telemetry.sampledAt, telemetry.sampledAt, "immediate request must reuse the live runtime sample");

  const profile = [{ latencyMs: telemetryLatencyMs, bytes: telemetryBytes }];
  for (let sample = 1; sample < 5; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const startedAt = performance.now();
    const response = await fetch(`${base}/api/connectors/${connectorId}/telemetry`, {
      headers: { authorization: `Bearer ${signup.token}` },
    });
    const latencyMs = performance.now() - startedAt;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.text();
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes > 0 && bytes < 256 * 1024, `unexpected telemetry payload: ${bytes} bytes`);
    profile.push({ latencyMs, bytes });
  }
  const sortedLatency = profile.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const p50 = sortedLatency[Math.floor(sortedLatency.length / 2)] ?? 0;
  const p95 = sortedLatency.at(-1) ?? 0;
  const maxBytes = Math.max(...profile.map((sample) => sample.bytes));
  const foreignTelemetry = await fetch(`${base}/api/connectors/${connectorId}/telemetry`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(foreignTelemetry.status, 404);
  console.log(`  OK connector telemetry returns bounded CPU/RAM and argv-free active processes (fresh n=5 p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${maxBytes} bytes; cache ${cachedLatencyMs.toFixed(1)} ms)`);

  const session = await httpJson<{ session: { id: string; sandboxKind: string; sandboxTargetId: string | null } }>(
    base,
    "POST",
    "/api/sessions",
    {
      title: "Connector check",
      provider: "mock",
      model: "mock-coder",
      sandboxMode: "workspace-write",
      sandboxKind: "connector",
      sandboxTargetId: connectorId,
      approvalPolicy: "never",
    },
    signup.token,
  );
  assert.equal(session.session.sandboxKind, "connector");
  assert.equal(session.session.sandboxTargetId, connectorId);
  console.log("  OK connector-backed session created");

  await runChatTurn(base, signup.token, session.session.id);
  const proof = await httpJson<{ content: string }>(
    base,
    "GET",
    `/api/sessions/${session.session.id}/file?path=proof.txt`,
    undefined,
    signup.token,
  );
  assert.equal(proof.content, "from-connector\n");
  console.log("  OK agent /bash executed on connector workspace");

  await httpJson<{ ok: boolean }>(
    base,
    "PUT",
    `/api/sessions/${session.session.id}/file`,
    { path: "api-write.txt", content: "api-file\n" },
    signup.token,
  );
  assert.equal(fs.readFileSync(path.join(connectorRoot, session.session.id, "api-write.txt"), "utf8"), "api-file\n");
  console.log("  OK file API writes through connector sandbox");

  const largePdf = Buffer.concat([Buffer.from("%PDF-", "ascii"), Buffer.alloc(4 * 1024 * 1024 + 137, 0x20)]);
  fs.writeFileSync(path.join(connectorRoot, session.session.id, "large.pdf"), largePdf);
  const mintResponse = await fetch(`${base}/api/sessions/${session.session.id}/file-preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${signup.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: "large.pdf" }),
  });
  assert.equal(mintResponse.status, 200);
  const source = await mintResponse.json() as { url: string; size: number; version: string };
  assert.equal(source.size, largePdf.byteLength);
  assert.match(source.version, /^[A-Za-z0-9_-]{1,96}$/);
  const scopedCookie = (mintResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
  assert.match(scopedCookie, /^oiia_preview_/);
  const missingCookie = await fetch(`${base}${source.url}`, { headers: { range: "bytes=0-4" } });
  assert.equal(missingCookie.status, 401);
  const wrongCookie = await fetch(`${base}${source.url}`, {
    headers: { cookie: "oiia_preview_00000000000000000000000000000000=wrong", range: "bytes=0-4" },
  });
  assert.equal(wrongCookie.status, 401);
  const unsatisfiable = await fetch(`${base}${source.url}`, {
    headers: { cookie: scopedCookie, range: `bytes=${largePdf.byteLength}-` },
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${largePdf.byteLength}`);
  const missingRange = await fetch(`${base}${source.url}`, { headers: { cookie: scopedCookie } });
  assert.equal(missingRange.status, 416);
  const oversizedRange = await fetch(`${base}${source.url}`, {
    headers: { cookie: scopedCookie, range: `bytes=0-${largePdf.byteLength - 1}` },
  });
  assert.equal(oversizedRange.status, 416);
  assert.equal(oversizedRange.headers.get("content-range"), `bytes */${largePdf.byteLength}`);
  console.log("  OK preview cookie, required Range, 4 MiB cap, and unsatisfiable failures are enforced at HTTP level");
  const rangeResponse = await fetch(`${base}${source.url}`, {
    headers: { cookie: scopedCookie, range: `bytes=0-${4 * 1024 * 1024 - 1}` },
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-${4 * 1024 * 1024 - 1}/${largePdf.byteLength}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), largePdf.subarray(0, 4 * 1024 * 1024));

  const fullMintResponse = await fetch(`${base}/api/sessions/${session.session.id}/file-preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${signup.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: "large.pdf", purpose: "full-viewer" }),
  });
  assert.equal(fullMintResponse.status, 200);
  const fullSource = await fullMintResponse.json() as { url: string; expiresInMs: number };
  assert.equal(fullSource.expiresInMs, 60_000);
  const fullCookie = (fullMintResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const fullResponse = await fetch(`${base}${fullSource.url}`, { headers: { cookie: fullCookie } });
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get("accept-ranges"), null);
  assert.match(fullResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.deepEqual(Buffer.from(await fullResponse.arrayBuffer()), largePdf);
  console.log("  OK full viewer uses a 60-second browser-one-shot cookie and splits >4 MiB across bounded connector RPCs");

  killProcessTree(daemon);
  daemon = null;
  await new Promise((resolve) => setTimeout(resolve, 250));
  daemon = spawn(process.execPath, [
    path.join(connectorHome, "agent-web-connector.mjs"),
    "--url", base,
    "--token-file", tokenFile,
    "--root", connectorRoot,
  ], { cwd: connectorHome, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  capture(daemon, "daemon-replacement", logs);
  await waitFor("replacement connector online", async () => {
    const r = await httpJson<{ connectors: { id: string; online: boolean }[] }>(base, "GET", "/api/connectors", undefined, signup.token);
    return r.connectors.some((connector) => connector.id === connectorId && connector.online);
  }, 15_000);
  const staleGeneration = await fetch(`${base}${source.url}`, {
    headers: { cookie: scopedCookie, range: "bytes=0-4" },
  });
  assert.equal(staleGeneration.status, 412);
  console.log("  OK connector replacement invalidates the prior preview generation");

  await runPtyTurn(base, signup.token, session.session.id);
  const ptyProof = await httpJson<{ content: string }>(
    base,
    "GET",
    `/api/sessions/${session.session.id}/file?path=pty.txt`,
    undefined,
    signup.token,
  );
  assert.equal(ptyProof.content, "pty-connector\n");
  console.log("  OK PTY executed on connector workspace");

  await httpJson<{ ok: boolean }>(
    base,
    "POST",
    "/api/admin/users/ban",
    { email: "connector@test.invalid", reason: "preview regression" },
    admin.token,
  );
  const bannedPreview = await fetch(`${base}${source.url}`, {
    headers: { cookie: scopedCookie, range: "bytes=0-4" },
  });
  assert.equal(bannedPreview.status, 401);
  console.log("  OK account suspension invalidates an already-minted preview capability at HTTP level");

  assertConnectorLogsAscii(logs);
  assert.ok(logs.join("").includes("\\u6d4b\\u8bd5"), "daemon log should escape non-ascii connector names");
  console.log("  OK connector logs stayed ascii-only");

  console.log("\nall connector backend checks passed");
} catch (e) {
  console.error(logs.join(""));
  throw e;
} finally {
  killProcessTree(daemon);
  server?.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
}
