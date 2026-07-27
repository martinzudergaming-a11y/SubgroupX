#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const MAX_OUTPUT = 256 * 1024;
const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 256 * 1024;
const MAX_ACTIVE_PROCESSES = 12;
const SYSTEM_SAMPLE_CACHE_MS = 1_000;
const PS_BINARY = ["/bin/ps", "/usr/bin/ps", "/run/current-system/sw/bin/ps"].find((candidate) => fs.existsSync(candidate)) ?? null;

function fileVersion(st) {
  return crypto.createHash("sha256")
    .update(`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`)
    .digest("base64url");
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function log(event, fields = {}) {
  console.error(asciiJson({ connector: event, ...fields, ts: Date.now() }));
}

function trace(marker, phase, detail) {
  console.error(`[${marker}] ${phase}${detail ? ` — ${detail}` : ""}`);
}

function parseArgs(argv) {
  const out = {
    url: process.env.AGENT_WEB_URL || "http://localhost:4317",
    token: process.env.AGENT_WEB_CONNECTOR_TOKEN || "",
    tokenFile: process.env.AGENT_WEB_CONNECTOR_TOKEN_FILE || path.join(os.homedir(), ".agent-web", "connector.token"),
    pairCode: process.env.AGENT_WEB_CONNECTOR_PAIR_CODE || "",
    name: process.env.AGENT_WEB_CONNECTOR_NAME || os.hostname(),
    nameProvided: Boolean(process.env.AGENT_WEB_CONNECTOR_NAME),
    root: process.env.AGENT_WEB_CONNECTOR_ROOT || path.join(os.homedir(), ".agent-web", "workspaces"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i] || out.url;
    else if (a === "--token") out.token = argv[++i] || out.token;
    else if (a === "--token-file") out.tokenFile = argv[++i] || out.tokenFile;
    else if (a === "--pair-code") out.pairCode = argv[++i] || out.pairCode;
    else if (a === "--name") {
      out.name = argv[++i] || out.name;
      out.nameProvided = true;
    } else if (a === "--root") out.root = argv[++i] || out.root;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/agent-web-connector.mjs --url http://SERVER --pair-code pair_... --token-file ~/.agent-web/connector.token --root ~/.agent-web/workspaces`);
      process.exit(0);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
function expandHome(p) {
  return path.resolve(String(p || "").replace(/^~(?=$|[/\\])/, os.homedir()));
}

const root = expandHome(opts.root);
try {
  fs.mkdirSync(root, { recursive: true });
} catch (e) {
  log("workspace_root_failed", { root, message: e instanceof Error ? e.message : String(e) });
  console.error(
    `\nconnector: cannot create the workspace root '${root}':\n  ${e instanceof Error ? e.message : String(e)}\n` +
      `Re-run with a --root you can write to (the default is ~/.agent-web/workspaces), not a non-writable system path.`,
  );
  process.exit(2);
}
const tokenFile = opts.tokenFile ? expandHome(opts.tokenFile) : "";
const fileToken = tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

let connectorToken = opts.token;

async function redeemPairing() {
  if (!opts.pairCode) return;
  const url = new URL(opts.url);
  url.pathname = "/api/connectors/pair";
  url.search = "";
  trace(".", "pair", "redeeming pairing code with the server");
  const body = { code: opts.pairCode, workspaceRoot: root };
  if (opts.nameProvided) body.name = opts.name;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.token !== "string") {
    throw new Error(json.error || `pairing failed (${res.status})`);
  }
  connectorToken = json.token;
  if (tokenFile) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, connectorToken + "\n", { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
  }
  log("paired", { connectorId: json.connector?.id, name: json.connector?.name || opts.name, tokenFile: tokenFile || "memory" });
  trace("+", "pair", `paired as "${json.connector?.name || opts.name}"`);
}

if (!connectorToken && opts.pairCode) {
  try {
    await redeemPairing();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!fileToken) {
      log("pairing_failed", { message: msg, fallback: false });
      trace("x", "pair", `${msg} — the code may have expired (15 min) or already been used; create a fresh connector and re-run`);
      process.exit(2);
    }
    connectorToken = fileToken;
    log("pairing_failed", { message: msg, fallback: true });
    trace("-", "pair", `${msg} — falling back to the saved token`);
  }
}
if (!connectorToken && fileToken) {
  connectorToken = fileToken;
}
if (!connectorToken) {
  log("missing_credentials", { hasTokenFile: Boolean(tokenFile) });
  trace("x", "pair", "no pairing code and no saved token — re-run the install command from the connector page");
  process.exit(2);
}

function connectorUrl() {
  const u = new URL(opts.url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/connector";
  u.search = "";
  return u.toString();
}

function safeSessionId(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || "default";
}

const forceConfine = /^(1|true|yes|on)$/i.test(process.env.AGENT_WEB_CONNECTOR_CONFINE || "");
const realHome = os.homedir();
const unconfinedOn = (unconfined) => Boolean(unconfined) && !forceConfine;

async function sessionRoot(sessionId, unconfined = false) {
  if (unconfinedOn(unconfined)) return realHome;
  const dir = path.join(root, safeSessionId(sessionId));
  await fsp.mkdir(dir, { recursive: true });
  return await fsp.realpath(dir);
}

async function resolvePath(sessionId, relPath = ".", unconfined = false) {
  if (unconfinedOn(unconfined)) {
    const raw = String(relPath || ".");
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(realHome, raw);
    return { base: realHome, abs };
  }
  const base = await sessionRoot(sessionId);
  const clean = String(relPath || ".").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, clean);
  const inside = (p) => p === base || p.startsWith(base + path.sep);
  if (!inside(abs)) throw new Error(`path escapes workspace: ${relPath}`);

  let existing = abs;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  if (!inside(await fsp.realpath(existing))) {
    throw new Error(`path escapes workspace via symlink: ${relPath}`);
  }
  return { base, abs };
}

function toRel(base, abs) {
  const rel = path.relative(base, abs);
  return rel ? rel.split(path.sep).join("/") : ".";
}

async function openResolvedFile(sessionId, relPath, unconfined = false) {
  const resolved = await resolvePath(sessionId, relPath, unconfined);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const handle = await fsp.open(resolved.abs, fs.constants.O_RDONLY | noFollow | nonBlock);
  try {
    if (!unconfinedOn(unconfined)) {
      const actual = await fsp.realpath(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : resolved.abs);
      if (actual !== resolved.base && !actual.startsWith(resolved.base + path.sep)) {
        throw new Error(`path escapes workspace via symlink: ${relPath}`);
      }
      if (process.platform !== "linux") {
        const [openedStat, namedStat] = await Promise.all([handle.stat(), fsp.stat(actual)]);
        if (openedStat.dev !== namedStat.dev || openedStat.ino !== namedStat.ino) {
          throw new Error(`path changed while opening: ${relPath}`);
        }
      }
    }
    return { ...resolved, handle };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function clampOutput(current, chunk) {
  if (current.length >= MAX_OUTPUT) return current;
  const next = current + chunk.toString();
  return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) : next;
}

function sandboxEnv(cwd, sessionId, term = "dumb") {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: cwd,
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: term,
    AGENT_WEB_CONNECTOR: "1",
    AGENT_WEB_SESSION_ID: String(sessionId ?? ""),
  };
}

const execs = new Map();
const activeRequests = new Map();

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

async function execCommand(rpcId, { sessionId, command, timeoutMs = 60_000, unconfined = false }) {
  const cwd = await sessionRoot(sessionId, unconfined);
  return await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", String(command ?? "")], {
      cwd,
      detached: true,
      env: sandboxEnv(cwd, sessionId),
    });
    log("exec_start", { id: rpcId, sessionId: safeSessionId(sessionId), pid: child.pid ?? null, timeoutMs, commandBytes: Buffer.byteLength(String(command ?? "")) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      execs.delete(rpcId);
      log("exec_exit", { id: rpcId, sessionId: safeSessionId(sessionId), exitCode, timedOut });
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish(124);
    }, Number(timeoutMs) || 60_000);
    execs.set(rpcId, { kill: killTree });
    child.stdout.on("data", (d) => {
      stdout = clampOutput(stdout, d);
    });
    child.stderr.on("data", (d) => {
      stderr = clampOutput(stderr, d);
    });
    child.on("error", (e) => {
      stderr = clampOutput(stderr, Buffer.from(String(e)));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 0));
  });
}

async function listDir({ sessionId, path: relPath, unconfined = false }) {
  const { base, abs } = await resolvePath(sessionId, relPath || ".", unconfined);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name === ".git") continue;
    const child = path.join(abs, d.name);
    let size = 0;
    let modifiedAt = 0;
    let version;
    try {
      const st = await fsp.stat(child);
      size = st.size;
      modifiedAt = Math.max(0, Math.floor(st.mtimeMs));
      version = fileVersion(st);
    } catch {
    }
    entries.push({
      name: d.name,
      path: toRel(base, child),
      kind: d.isDirectory() ? "directory" : "file",
      size,
      modifiedAt,
      version,
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

async function readFile({ sessionId, path: relPath, unconfined = false }) {
  const { handle } = await openResolvedFile(sessionId, relPath, unconfined);
  try { return { content: await handle.readFile("utf8") }; }
  finally { await handle.close(); }
}

async function readFileBytes({ sessionId, path: relPath, unconfined = false }, signal) {
  throwIfAborted(signal);
  const { handle } = await openResolvedFile(sessionId, relPath, unconfined);
  try {
    throwIfAborted(signal);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BINARY_BYTES) throw new Error("file too large");
    throwIfAborted(signal);
    const data = await handle.readFile();
    throwIfAborted(signal);
    return { dataBase64: data.toString("base64") };
  } finally { await handle.close(); }
}

async function statFile({ sessionId, path: relPath, unconfined = false }, signal) {
  let opened;
  try {
    throwIfAborted(signal);
    opened = await openResolvedFile(sessionId, relPath, unconfined);
    throwIfAborted(signal);
    const st = await opened.handle.stat();
    throwIfAborted(signal);
    return {
      found: true,
      entry: {
        name: path.basename(opened.abs),
        path: toRel(opened.base, opened.abs),
        kind: st.isDirectory() ? "directory" : "file",
        size: st.size,
        modifiedAt: Math.max(0, Math.floor(st.mtimeMs)),
        version: fileVersion(st),
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false };
    throw error;
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function readFileRange({ sessionId, path: relPath, start, endExclusive, unconfined = false, expectedVersion }, signal) {
  const from = start;
  const to = endExclusive;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > MAX_RANGE_BYTES) {
    throw new Error("invalid file range");
  }
  throwIfAborted(signal);
  const { handle } = await openResolvedFile(sessionId, relPath, unconfined);
  try {
    throwIfAborted(signal);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    if (expectedVersion && fileVersion(stat) !== expectedVersion) {
      throw new Error("preview file changed before read");
    }
    const data = Buffer.allocUnsafe(to - from);
    let bytesRead = 0;
    while (bytesRead < data.byteLength) {
      throwIfAborted(signal);
      const read = await handle.read(data, bytesRead, data.byteLength - bytesRead, from + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    throwIfAborted(signal);
    return { dataBase64: data.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
}

async function writeFile({ sessionId, path: relPath, content, unconfined = false }) {
  const { abs } = await resolvePath(sessionId, relPath, unconfined);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, String(content ?? ""), "utf8");
  return { ok: true };
}

async function writeFileBytes({ sessionId, path: relPath, dataBase64, unconfined = false }) {
  const { abs } = await resolvePath(sessionId, relPath, unconfined);
  const data = Buffer.from(String(dataBase64 ?? ""), "base64");
  if (data.byteLength > MAX_BINARY_BYTES) throw new Error("file too large");
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data);
  return { ok: true };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

let previousCpuTimes = cpuTimes();

function intervalCpuUsage() {
  const current = cpuTimes();
  const idleDelta = current.idle - previousCpuTimes.idle;
  const totalDelta = current.total - previousCpuTimes.total;
  previousCpuTimes = current;
  if (!(totalDelta > 0) || idleDelta < 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) * 10) / 10;
}

async function memoryUsage(signal) {
  const fallbackTotal = os.totalmem();
  const fallback = { memUsed: Math.max(0, fallbackTotal - os.freemem()), memTotal: fallbackTotal };
  if (process.platform !== "linux") return fallback;
  try {
    const raw = await fsp.readFile("/proc/meminfo", { encoding: "utf8", signal });
    const values = new Map(raw.split("\n").flatMap((line) => {
      const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line);
      return match ? [[match[1], Number(match[2]) * 1024]] : [];
    }));
    const memTotal = values.get("MemTotal") ?? fallback.memTotal;
    const available = values.get("MemAvailable");
    if (!Number.isFinite(memTotal) || !(memTotal > 0) || !Number.isFinite(available)) return fallback;
    return { memUsed: Math.max(0, Math.min(memTotal, memTotal - available)), memTotal };
  } catch {
    return fallback;
  }
}

function parseProcessRows(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuPct = Number(match[3]);
    const memPct = Number(match[4]);
    const rssKb = Number(match[5]);
    if (![pid, ppid, cpuPct, memPct, rssKb].every(Number.isFinite) || pid <= 0) continue;
    const name = path.basename(match[8].trim()).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80);
    if (!name) continue;
    rows.push({
      pid,
      ppid: Math.max(0, ppid),
      name,
      state: match[6].slice(0, 8),
      elapsed: match[7].slice(0, 32),
      cpuPct: Math.max(0, cpuPct),
      memPct: Math.max(0, Math.min(100, memPct)),
      rssBytes: Math.max(0, rssKb) * 1024,
    });
  }
  rows.sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes || a.pid - b.pid);
  return { processCount: rows.length, processes: rows.slice(0, MAX_ACTIVE_PROCESSES) };
}

async function activeProcesses(signal) {
  if ((process.platform !== "linux" && process.platform !== "darwin") || !PS_BINARY) {
    return { processCount: 0, processes: [], processSource: "unavailable" };
  }
  throwIfAborted(signal);
  return await new Promise((resolve) => {
    const child = spawn(PS_BINARY, ["-Ao", "pid=,ppid=,pcpu=,pmem=,rss=,state=,etime=,comm="], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ processCount: 0, processes: [], processSource: "unavailable" });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ processCount: 0, processes: [], processSource: "unavailable" });
    }, 2_000);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      if (output.length >= MAX_PROCESS_OUTPUT) return;
      output += chunk.toString("utf8", 0, Math.max(0, MAX_PROCESS_OUTPUT - output.length));
    });
    child.on("error", () => finish({ processCount: 0, processes: [], processSource: "unavailable" }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ processCount: 0, processes: [], processSource: "unavailable" });
      finish({ ...parseProcessRows(output), processSource: "native" });
    });
  });
}

let systemSampleCache = null;
let systemSampleInFlight = null;

async function systemSample() {
  if (systemSampleCache?.expiresAt > Date.now()) return systemSampleCache.value;
  if (systemSampleInFlight) return await systemSampleInFlight;
  const pending = (async () => {
    const memory = await memoryUsage();
    const load = os.loadavg();
    const value = {
      cpuPct: intervalCpuUsage(),
      ...memory,
      cpuCores: os.cpus().length || 1,
      loadAvg: [load[0] || 0, load[1] || 0, load[2] || 0],
      cpuKind: "interval",
    };
    systemSampleCache = { expiresAt: Date.now() + SYSTEM_SAMPLE_CACHE_MS, value };
    return value;
  })().finally(() => {
    if (systemSampleInFlight === pending) systemSampleInFlight = null;
  });
  systemSampleInFlight = pending;
  return await pending;
}

async function metrics({ telemetry = false } = {}, signal) {
  if (!telemetry) return await systemSample();
  const [system, processData] = await Promise.all([systemSample(), activeProcesses(signal)]);
  return { ...system, ...processData };
}

let ptyModulePromise = null;
async function loadPtyModule() {
  if (process.env.AGENT_WEB_CONNECTOR_FORCE_PIPE_PTY === "1") return null;
  if (!ptyModulePromise) {
    ptyModulePromise = import("@homebridge/node-pty-prebuilt-multiarch").catch(() => null);
  }
  return await ptyModulePromise;
}

const ptys = new Map();

async function openPty(ws, { ptyId, sessionId, cols = 80, rows = 24, unconfined = false }) {
  const cwd = await sessionRoot(sessionId, unconfined);
  log("pty_open", { ptyId, sessionId: safeSessionId(sessionId), cols, rows });
  const pty = await loadPtyModule();
  if (pty) {
    try {
      const proc = pty.spawn("/bin/bash", ["-l"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: sandboxEnv(cwd, sessionId, "xterm-256color"),
      });
      proc.onData((data) => sendNotification(ws, "pty/data", { ptyId, dataBase64: Buffer.from(data).toString("base64") }));
      proc.onExit(({ exitCode }) => {
        ptys.delete(ptyId);
        log("pty_exit", { ptyId, sessionId: safeSessionId(sessionId), exitCode });
        sendNotification(ws, "pty/exit", { ptyId, code: exitCode });
      });
      ptys.set(ptyId, { write: (data) => proc.write(data), resize: (c, r) => proc.resize(c, r), kill: () => proc.kill() });
      return { ok: true, pty: "native" };
    } catch (e) {
      log("pty_native_failed", { ptyId, sessionId: safeSessionId(sessionId), message: e instanceof Error ? e.message : String(e) });
    }
  }

  const safeRows = Number.isInteger(rows) && rows > 0 && rows <= 1000 ? rows : 24;
  const safeCols = Number.isInteger(cols) && cols > 0 && cols <= 1000 ? cols : 80;
  const inner = `stty rows ${safeRows} cols ${safeCols} 2>/dev/null; exec /bin/bash -li`;
  let cmd, args, mode;
  if (hasScript()) {
    mode = "script-pty";
    if (process.platform === "darwin") {
      cmd = "script";
      args = ["-q", "/dev/null", "/bin/sh", "-c", inner];
    } else {
      cmd = "script";
      args = ["-qfc", inner, "/dev/null"];
    }
  } else {
    mode = "pipes";
    cmd = "/bin/bash";
    args = ["-li"];
  }
  log("pty_fallback", { ptyId, sessionId: safeSessionId(sessionId), mode });
  const child = spawn(cmd, args, { cwd, env: sandboxEnv(cwd, sessionId, "xterm-256color") });
  child.stdout.on("data", (data) => sendNotification(ws, "pty/data", { ptyId, dataBase64: Buffer.from(data).toString("base64") }));
  child.stderr.on("data", (data) => sendNotification(ws, "pty/data", { ptyId, dataBase64: Buffer.from(data).toString("base64") }));
  child.on("close", (code) => {
    ptys.delete(ptyId);
    log("pty_exit", { ptyId, sessionId: safeSessionId(sessionId), exitCode: code ?? 0 });
    sendNotification(ws, "pty/exit", { ptyId, code: code ?? 0 });
  });
  ptys.set(ptyId, {
    write: (data) => child.stdin.write(data),
    resize: () => {},
    kill: () => child.kill("SIGTERM"),
  });
  return { ok: true, pty: mode };
}

let scriptAvailable = null;
function hasScript() {
  if (scriptAvailable === null) {
    try {
      const probe =
        process.platform === "darwin"
          ? spawnSync("script", ["-q", "/dev/null", "true"], { timeout: 3000 })
          : spawnSync("script", ["-qfc", "true", "/dev/null"], { timeout: 3000 });
      scriptAvailable = !probe.error && probe.status === 0;
    } catch {
      scriptAvailable = false;
    }
  }
  return scriptAvailable;
}

function sendNotification(ws, method, params) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "notification", method, params }));
  }
}

async function handleRequest(ws, id, method, params, signal) {
  switch (method) {
    case "exec":
      return await execCommand(id, params);
    case "file/list":
      return await listDir(params);
    case "file/read":
      return await readFile(params);
    case "file/readBytes":
      return await readFileBytes(params, signal);
    case "file/stat":
      return await statFile(params, signal);
    case "file/readRange":
      return await readFileRange(params, signal);
    case "file/write":
      return await writeFile(params);
    case "file/writeBytes":
      return await writeFileBytes(params);
    case "metrics":
      return await metrics(params, signal);
    case "pty/open":
      return await openPty(ws, params);
    default:
      throw new Error(`unknown connector method: ${method}`);
  }
}

function handleNotification(ws, method, params = {}) {
  if (method === "exec/cancel") {
    const exec = execs.get(params.id);
    execs.delete(params.id);
    if (exec) {
      log("exec_cancel", { id: params.id });
      exec.kill();
    }
  } else if (method === "rpc/cancel") {
    const active = activeRequests.get(params.id);
    if (active?.ws === ws) {
      activeRequests.delete(params.id);
      log("rpc_cancel", { id: params.id });
      active.controller.abort(new Error("RPC cancelled"));
    }
  } else if (method === "pty/write") {
    const pty = ptys.get(params.ptyId);
    if (pty) pty.write(Buffer.from(String(params.dataBase64 ?? ""), "base64").toString("utf8"));
  } else if (method === "pty/resize") {
    const pty = ptys.get(params.ptyId);
    if (pty) pty.resize(Number(params.cols) || 80, Number(params.rows) || 24);
  } else if (method === "pty/kill") {
    const pty = ptys.get(params.ptyId);
    ptys.delete(params.ptyId);
    if (pty) {
      log("pty_kill", { ptyId: params.ptyId });
      pty.kill();
    }
  }
}

function closeReason(code, reason) {
  const r = (reason || "").toString();
  if (code === 4001) return "rejected: bad or expired token — create a fresh connector and re-run";
  if (code === 4003) return "rejected: this account is suspended";
  if (code === 4000) return "replaced by a newer connection for the same connector";
  if (code === 1006) return "abnormal close (no close frame) — network drop, TLS reset, or wrong host/port";
  if (code === 1011 || code === 1012 || code === 1013) return "server error / restart — will retry";
  return r || "closed";
}

let stopped = false;
let reconnectAttempts = 0;
const DIAL_TIMEOUT_MS = 15000;
function connect(delayMs = 0) {
  if (stopped) return;
  setTimeout(() => {
    if (stopped) return;
    trace(".", "dial", `connecting to ${connectorUrl()}`);
    const ws = new WebSocket(connectorUrl(), {
      headers: { authorization: `Bearer ${connectorToken}` },
      perMessageDeflate: false,
    });
    let heartbeat = null;
    let missedPongs = 0;
    let opened = false;
    const dialTimer = setTimeout(() => {
      if (opened) return;
      trace("0", "dial", `no response in ${DIAL_TIMEOUT_MS / 1000}s — server unreachable? check the URL/port, TLS, or network/proxy`);
      log("dial_timeout", { url: opts.url, timeoutMs: DIAL_TIMEOUT_MS });
      try { ws.terminate(); } catch {  }
    }, DIAL_TIMEOUT_MS);
    dialTimer.unref?.();
    ws.on("pong", () => { missedPongs = 0; });
    ws.on("open", () => {
      opened = true;
      reconnectAttempts = 0;
      clearTimeout(dialTimer);
      log("connected", { url: opts.url, root });
      trace("o", "online", `connected to ${opts.url} (root ${root})`);
      ws.send(JSON.stringify({
        type: "notification",
        method: "client/hello",
        params: {
          version: 4,
          capabilities: [
            "exec", "files", "file.stat.v1", "file.range.v1", "rpc.cancel.v1",
            "pty", "metrics", "telemetry.v1", ...(forceConfine ? [] : ["unconfined"]),
          ],
          canonicalRoot: root,
          maxRangeBytes: MAX_RANGE_BYTES,
        },
      }));
      heartbeat = setInterval(() => {
        missedPongs += 1;
        if (missedPongs > 2) { ws.terminate(); return; }
        try { ws.ping(); } catch {  }
      }, 30000);
      heartbeat.unref?.();
    });
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (msg.type === "request") {
        const controller = new AbortController();
        activeRequests.set(msg.id, { ws, controller });
        try {
          const result = await handleRequest(ws, msg.id, msg.method, msg.params ?? {}, controller.signal);
          if (!controller.signal.aborted && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", id: msg.id, result }));
          }
        } catch (e) {
          if (!controller.signal.aborted && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", id: msg.id, error: e instanceof Error ? e.message : String(e) }));
          }
        } finally {
          const active = activeRequests.get(msg.id);
          if (active?.controller === controller) activeRequests.delete(msg.id);
        }
      } else if (msg.type === "notification") {
        handleNotification(ws, msg.method, msg.params ?? {});
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(dialTimer);
      if (heartbeat) clearInterval(heartbeat);
      for (const pty of ptys.values()) pty.kill();
      ptys.clear();
      for (const exec of execs.values()) exec.kill();
      execs.clear();
      for (const [id, active] of activeRequests) {
        if (active.ws !== ws) continue;
        activeRequests.delete(id);
        active.controller.abort(new Error("connector disconnected"));
      }
      const human = closeReason(code, reason);
      if (code === 4003) {
        log("suspended", { code, reason: reason.toString() || "account suspended", reconnect: false });
        trace("x", "offline", `${human} (code ${code}) — not retrying`);
        return;
      }
      if (!stopped) {
        const delay = Math.min(30000, 1500 * 2 ** reconnectAttempts);
        reconnectAttempts += 1;
        log("disconnected", { code, reason: reason.toString() || "closed", reconnect: true, retryInMs: delay });
        trace("-", "offline", `${human} (code ${code}) — reconnecting in ${Math.round(delay / 1000)}s`);
        connect(delay);
      }
    });
    ws.on("error", (e) => {
      log("error", { message: e instanceof Error ? e.message : String(e) });
      trace("x", "dial", e instanceof Error ? e.message : String(e));
    });
  }, delayMs);
}

function stop() {
  stopped = true;
  for (const exec of execs.values()) exec.kill();
  for (const pty of ptys.values()) pty.kill();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

trace("+", "daemon", "ready — connecting the reverse link  [legend: . working  + done  o online  - retrying  0 timeout  x failed]");
connect();
