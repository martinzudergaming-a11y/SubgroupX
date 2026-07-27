import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { connectorDao, connectorPairingDao } from "../persistence/index.ts";
import { sha256Hex } from "../identity/crypto-util.ts";
import { logAudit, asciiJson } from "../observability/audit-log.ts";
import { socketDenial } from "../identity/access-gate.ts";
import type { ConnectorProcessInfo, ConnectorTelemetry, FileEntry } from "../../../shared/src/protocol.ts";
import type { ExecResult, SandboxLoad } from "./sandbox.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RPC_TIMEOUT_MS = 10 * 60_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RpcRequest {
  type: "request";
  id: string;
  method: string;
  params?: Json;
}

interface RpcNotification {
  type: "notification";
  method: string;
  params?: Json;
}

interface RpcResponse {
  type: "response";
  id: string;
  result?: Json;
  error?: string;
}

interface PendingCall {
  resolve: (value: Json) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

interface ConnectorClient {
  id: string;
  generation: string;
  ws: WebSocket;
  pending: Map<string, PendingCall>;
  ptys: Map<string, PtyCallbacks>;
  closed: boolean;
  missedPongs: number;
  daemonCaps: string[] | null;
  telemetryCache: { expiresAt: number; value: ConnectorTelemetry } | null;
  telemetryInFlight: Promise<ConnectorTelemetry | null> | null;
  compatProcesses: {
    expiresAt: number;
    processCount: number;
    processes: ConnectorProcessInfo[];
    source: "compat" | "unavailable";
  } | null;
}

interface PtyCallbacks {
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  workspaceRoot: string;
  capabilities: string[];
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  unconfined: boolean;
  daemonUnconfined: boolean | null;
}

export interface ConnectorPairingInfo {
  id: string;
  name: string;
  workspaceRoot: string;
  expiresAt: number;
  createdAt: number;
}

export interface ConnectorExecParams {
  sessionId: string;
  command: string;
  timeoutMs?: number;
  unconfined?: boolean;
}

export interface ConnectorPtyParams {
  sessionId: string;
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null) => void;
  unconfined?: boolean;
}

export interface ConnectorPtyHandle {
  write(data: Uint8Array): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  kill(): void | Promise<void>;
}

function tokenHash(token: string): string {
  return sha256Hex(token);
}

function pairingCode(): string {
  return `pair_${crypto.randomBytes(18).toString("base64url")}`;
}

function connectorToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

function parseCapabilities(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
  }
  return [];
}

function byteResult(result: Json): Uint8Array {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid byte response");
  const dataBase64 = (result as { dataBase64?: unknown }).dataBase64;
  if (typeof dataBase64 !== "string") throw new Error("invalid byte response");
  return new Uint8Array(Buffer.from(dataBase64, "base64"));
}

const TELEMETRY_CACHE_MS = 2_000;
const COMPAT_PROCESS_CACHE_MS = 12_000;
const MAX_TELEMETRY_PROCESSES = 12;
const LEGACY_PROCESS_COMMAND = "LC_ALL=C command -p ps -Ao pid=,ppid=,pcpu=,pmem=,rss=,state=,etime=,comm=";

function boundedNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function processName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const leaf = value.trim().split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) ?? "";
  return leaf || null;
}

function connectorProcess(value: unknown): ConnectorProcessInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const pid = boundedNumber(row.pid, 1, 2 ** 31 - 1);
  const ppid = boundedNumber(row.ppid, 0, 2 ** 31 - 1);
  const cpuPct = boundedNumber(row.cpuPct, 0, 10_000);
  const memPct = boundedNumber(row.memPct, 0, 100);
  const rssBytes = boundedNumber(row.rssBytes, 0, Number.MAX_SAFE_INTEGER);
  const name = processName(row.name);
  if (pid === null || ppid === null || cpuPct === null || memPct === null || rssBytes === null || !name) return null;
  return {
    pid: Math.round(pid),
    ppid: Math.round(ppid),
    name,
    state: typeof row.state === "string" ? row.state.replace(/[^A-Za-z+<>]/g, "").slice(0, 8) : "",
    elapsed: typeof row.elapsed === "string" ? row.elapsed.replace(/[^0-9:.-]/g, "").slice(0, 32) : "",
    cpuPct,
    memPct,
    rssBytes: Math.round(rssBytes),
  };
}

function parseLegacyProcesses(raw: string): { processCount: number; processes: ConnectorProcessInfo[] } {
  const rows: ConnectorProcessInfo[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const row = connectorProcess({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPct: Number(match[3]),
      memPct: Number(match[4]),
      rssBytes: Number(match[5]) * 1024,
      state: match[6],
      elapsed: match[7],
      name: match[8],
    });
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes || a.pid - b.pid);
  return { processCount: rows.length, processes: rows.slice(0, MAX_TELEMETRY_PROCESSES) };
}

function logConnector(event: string, fields: Record<string, unknown> = {}): void {
  console.info(asciiJson({ connector: event, ...fields, ts: Date.now() }));
  logAudit(`connector_${event}`, {
    level: event.includes("rejected") || event.includes("cancel") || event.includes("close") ? "warn" : "info",
    userId: typeof fields.userId === "string" ? fields.userId : undefined,
    targetId: typeof fields.connectorId === "string" ? fields.connectorId : undefined,
    data: fields,
    stdout: false,
  });
}

class ConnectorManager {
  private clients = new Map<string, ConnectorClient>();
  private static readonly HEARTBEAT_MS = 30_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  createServer(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    wss.on("connection", (ws: WebSocket, req) => this.accept(ws, req.url ?? "/", req.headers.authorization));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (client.closed) continue;
        client.missedPongs += 1;
        if (client.missedPongs > 2) {
          logConnector("heartbeat_timeout", { connectorId: client.id });
          client.ws.terminate();
          continue;
        }
        try {
          client.ws.ping();
        } catch {
        }
      }
    }, ConnectorManager.HEARTBEAT_MS);
    heartbeat.unref?.();
    this.heartbeatTimer = heartbeat;
    wss.on("close", () => {
      clearInterval(heartbeat);
      if (this.heartbeatTimer === heartbeat) this.heartbeatTimer = null;
    });
    return wss;
  }

  createToken(userId: string, name: string, workspaceRoot: string): { token: string; info: ConnectorInfo } {
    const id = "conn_" + crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const token = connectorToken(id, secret);
    const now = Date.now();
    const row = {
      id,
      user_id: userId,
      name,
      token_hash: tokenHash(token),
      workspace_root: workspaceRoot,
      capabilities_json: JSON.stringify(["exec", "files", "pty", "metrics"]),
      last_seen_at: null,
      created_at: now,
    };
    connectorDao.create(row);
    logConnector("target_created", { connectorId: id, userId });
    return { token, info: this.rowToInfo(row) };
  }

  createPairing(userId: string, name: string, workspaceRoot: string): { code: string; pairing: ConnectorPairingInfo } {
    const now = Date.now();
    const code = pairingCode();
    const row = {
      id: "pair_" + crypto.randomUUID(),
      user_id: userId,
      name,
      workspace_root: workspaceRoot,
      code_hash: tokenHash(code),
      expires_at: now + 15 * 60_000,
      redeemed_at: null,
      connector_id: null,
      created_at: now,
    };
    connectorPairingDao.deleteExpired(now);
    connectorPairingDao.create(row);
    logConnector("pairing_created", { pairingId: row.id, userId, expiresAt: row.expires_at });
    return { code, pairing: this.pairingRowToInfo(row) };
  }

  redeemPairing(code: string, opts: { name?: string; workspaceRoot?: string } = {}): { token: string; info: ConnectorInfo } {
    const row = connectorPairingDao.byCodeHash(tokenHash(code));
    const now = Date.now();
    if (!row || row.redeemed_at || row.expires_at < now) {
      logConnector("pairing_rejected", { reason: !row ? "not_found" : row.redeemed_at ? "redeemed" : "expired" });
      throw new Error("pairing code is invalid or expired");
    }
    if (socketDenial(row.user_id)) {
      logConnector("pairing_rejected", { pairingId: row.id, userId: row.user_id, reason: "suspended" });
      throw new Error("account suspended");
    }
    const created = this.createToken(
      row.user_id,
      (opts.name || row.name).trim().slice(0, 80) || row.name,
      (opts.workspaceRoot || row.workspace_root).trim().slice(0, 512) || row.workspace_root,
    );
    connectorPairingDao.markRedeemed(row.id, created.info.id, now);
    logConnector("pairing_redeemed", { pairingId: row.id, connectorId: created.info.id, userId: row.user_id });
    return created;
  }

  list(userId: string): ConnectorInfo[] {
    return connectorDao.listForUser(userId).map((row) => this.rowToInfo(row));
  }

  isOnline(connectorId: string): boolean {
    return this.clients.get(connectorId)?.ws.readyState === WebSocket.OPEN;
  }

  async exec(connectorId: string, params: ConnectorExecParams, signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.call(connectorId, "exec", params as unknown as Json, {
      timeoutMs: Math.min(MAX_RPC_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, params.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000),
      signal,
      cancelMethod: "exec/cancel",
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid exec response");
    const r = result as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; timedOut?: unknown };
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      exitCode: typeof r.exitCode === "number" ? r.exitCode : 1,
      timedOut: r.timedOut === true,
    };
  }

  async readFile(connectorId: string, sessionId: string, relPath: string, unconfined = false): Promise<string> {
    const result = await this.call(connectorId, "file/read", { sessionId, path: relPath, unconfined });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid read response");
    const content = (result as { content?: unknown }).content;
    if (typeof content !== "string") throw new Error("invalid read response");
    return content;
  }

  async readFileBytes(connectorId: string, sessionId: string, relPath: string, unconfined = false, signal?: AbortSignal, expectedGeneration?: string): Promise<Uint8Array> {
    return byteResult(await this.call(connectorId, "file/readBytes", { sessionId, path: relPath, unconfined }, {
      signal,
      expectedGeneration,
      cancelMethod: signal ? "rpc/cancel" : undefined,
    }));
  }

  async statFile(connectorId: string, sessionId: string, relPath: string, unconfined = false, signal?: AbortSignal, expectedGeneration?: string): Promise<FileEntry | null> {
    const result = await this.call(connectorId, "file/stat", { sessionId, path: relPath, unconfined }, {
      signal,
      expectedGeneration,
      cancelMethod: signal ? "rpc/cancel" : undefined,
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid stat response");
    if ((result as { found?: unknown }).found === false) return null;
    const entry = (result as { entry?: unknown }).entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid stat response");
    const row = entry as Record<string, unknown>;
    if (
      typeof row.name !== "string" || typeof row.path !== "string" ||
      (row.kind !== "file" && row.kind !== "directory") ||
      typeof row.size !== "number" || !Number.isFinite(row.size) || row.size < 0 ||
      typeof row.modifiedAt !== "number" || !Number.isFinite(row.modifiedAt)
    ) throw new Error("invalid stat response");
    if (row.version !== undefined && (typeof row.version !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(row.version))) {
      throw new Error("invalid stat response");
    }
    return {
      name: row.name,
      path: row.path,
      kind: row.kind,
      size: row.size,
      modifiedAt: Math.max(0, row.modifiedAt),
      ...(typeof row.version === "string" ? { version: row.version } : {}),
    };
  }

  async readFileRange(
    connectorId: string,
    sessionId: string,
    relPath: string,
    start: number,
    endExclusive: number,
    unconfined = false,
    signal?: AbortSignal,
    expectedGeneration?: string,
    expectedVersion?: string,
  ): Promise<Uint8Array> {
    return byteResult(await this.call(
      connectorId,
      "file/readRange",
      { sessionId, path: relPath, start, endExclusive, unconfined, ...(expectedVersion ? { expectedVersion } : {}) },
      { signal, expectedGeneration, cancelMethod: signal ? "rpc/cancel" : undefined },
    ));
  }

  async writeFile(connectorId: string, sessionId: string, relPath: string, content: string, unconfined = false): Promise<void> {
    await this.call(connectorId, "file/write", { sessionId, path: relPath, content, unconfined });
  }

  async writeFileBytes(connectorId: string, sessionId: string, relPath: string, data: Uint8Array, unconfined = false): Promise<void> {
    await this.call(connectorId, "file/writeBytes", {
      sessionId,
      path: relPath,
      dataBase64: Buffer.from(data).toString("base64"),
      unconfined,
    });
  }

  async listDir(connectorId: string, sessionId: string, relPath: string, unconfined = false, expectedGeneration?: string): Promise<FileEntry[]> {
    const result = await this.call(connectorId, "file/list", { sessionId, path: relPath, unconfined }, { expectedGeneration });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid list response");
    const entries = (result as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw new Error("invalid list response");
    return entries.flatMap((e): FileEntry[] => {
      if (!e || typeof e !== "object") return [];
      const o = e as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.path !== "string") return [];
      return [{
        name: o.name,
        path: o.path,
        kind: o.kind === "directory" ? "directory" : "file",
        size: typeof o.size === "number" ? o.size : 0,
        modifiedAt: typeof o.modifiedAt === "number" && Number.isFinite(o.modifiedAt) ? Math.max(0, o.modifiedAt) : 0,
        ...(typeof o.version === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(o.version) ? { version: o.version } : {}),
      }];
    });
  }

  async telemetry(connectorId: string): Promise<ConnectorTelemetry | null> {
    const client = this.clientOrThrow(connectorId);
    const now = Date.now();
    if (client.telemetryCache && client.telemetryCache.expiresAt > now) return client.telemetryCache.value;
    if (client.telemetryInFlight) return await client.telemetryInFlight;

    const generation = client.generation;
    const pending = this.collectTelemetry(client, generation)
      .then((value) => {
        if (value && this.clients.get(connectorId) === client && !client.closed && client.generation === generation) {
          client.telemetryCache = { expiresAt: Date.now() + TELEMETRY_CACHE_MS, value };
        }
        return value;
      })
      .finally(() => {
        if (client.telemetryInFlight === pending) client.telemetryInFlight = null;
      });
    client.telemetryInFlight = pending;
    return await pending;
  }

  async metrics(connectorId: string): Promise<SandboxLoad | null> {
    const result = await this.call(connectorId, "metrics", {}, { timeoutMs: 10_000 });
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const row = result as Record<string, unknown>;
    const cpuPct = boundedNumber(row.cpuPct, 0, 100);
    const memTotal = boundedNumber(row.memTotal, 1, Number.MAX_SAFE_INTEGER);
    const memUsed = boundedNumber(row.memUsed, 0, Number.MAX_SAFE_INTEGER);
    if (cpuPct === null || memTotal === null || memUsed === null) return null;
    return { cpuPct, memUsed: Math.min(memTotal, memUsed), memTotal };
  }

  private async collectTelemetry(client: ConnectorClient, generation: string): Promise<ConnectorTelemetry | null> {
    const result = await this.call(client.id, "metrics", { telemetry: true }, { timeoutMs: 10_000, expectedGeneration: generation });
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const row = result as Record<string, unknown>;
    const cpuPct = boundedNumber(row.cpuPct, 0, 100);
    const memTotal = boundedNumber(row.memTotal, 1, Number.MAX_SAFE_INTEGER);
    const rawMemUsed = boundedNumber(row.memUsed, 0, Number.MAX_SAFE_INTEGER);
    if (cpuPct === null || memTotal === null || rawMemUsed === null) return null;

    const nativeProcesses = Array.isArray(row.processes)
      ? row.processes.flatMap((process): ConnectorProcessInfo[] => {
          const parsed = connectorProcess(process);
          return parsed ? [parsed] : [];
        }).sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes || a.pid - b.pid).slice(0, MAX_TELEMETRY_PROCESSES)
      : [];
    const nativeCount = boundedNumber(row.processCount, 0, 10_000_000);
    let processes = nativeProcesses;
    let processCount = nativeCount === null ? nativeProcesses.length : Math.round(nativeCount);
    let processSource: ConnectorTelemetry["processSource"] = row.processSource === "native" ? "native" : "unavailable";

    if (!client.daemonCaps?.includes("telemetry.v1") && row.processSource !== "native") {
      const compat = await this.compatibilityProcesses(client, generation);
      processes = compat.processes;
      processCount = compat.processCount;
      processSource = compat.source;
    }

    const rawLoad = Array.isArray(row.loadAvg) ? row.loadAvg : [];
    const loadAvg: [number, number, number] = [0, 1, 2].map((index) => boundedNumber(rawLoad[index], 0, 1_000_000) ?? 0) as [number, number, number];
    return {
      sampledAt: Date.now(),
      cpuPct,
      memUsed: Math.min(memTotal, rawMemUsed),
      memTotal,
      cpuCores: Math.round(boundedNumber(row.cpuCores, 0, 65_536) ?? 0),
      loadAvg,
      processCount,
      processes,
      cpuKind: row.cpuKind === "interval" ? "interval" : "load",
      processSource,
    };
  }

  private async compatibilityProcesses(
    client: ConnectorClient,
    generation: string,
  ): Promise<NonNullable<ConnectorClient["compatProcesses"]>> {
    if (client.compatProcesses && client.compatProcesses.expiresAt > Date.now()) return client.compatProcesses;
    let next: NonNullable<ConnectorClient["compatProcesses"]>;
    try {
      const result = await this.call(client.id, "exec", {
        sessionId: ".",
        command: LEGACY_PROCESS_COMMAND,
        timeoutMs: 3_000,
      }, { timeoutMs: 8_000, expectedGeneration: generation });
      const row = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
      if (row.exitCode !== 0 || typeof row.stdout !== "string") throw new Error("legacy process sample failed");
      next = { ...parseLegacyProcesses(row.stdout), source: "compat", expiresAt: Date.now() + COMPAT_PROCESS_CACHE_MS };
    } catch {
      next = { processCount: 0, processes: [], source: "unavailable", expiresAt: Date.now() + COMPAT_PROCESS_CACHE_MS };
    }
    if (this.clients.get(client.id) === client && !client.closed && client.generation === generation) client.compatProcesses = next;
    return next;
  }

  async openPty(connectorId: string, params: ConnectorPtyParams): Promise<ConnectorPtyHandle> {
    const client = this.clientOrThrow(connectorId);
    const ptyId = "pty_" + crypto.randomUUID();
    client.ptys.set(ptyId, { onData: params.onData, onExit: params.onExit });
    try {
      await this.call(
        connectorId,
        "pty/open",
        { ptyId, sessionId: params.sessionId, cols: params.cols, rows: params.rows, unconfined: params.unconfined ?? false },
        { timeoutMs: 15_000 },
      );
    } catch (e) {
      client.ptys.delete(ptyId);
      throw e;
    }
    return {
      write: (data) => this.notify(connectorId, "pty/write", { ptyId, dataBase64: Buffer.from(data).toString("base64") }),
      resize: (cols, rows) => this.notify(connectorId, "pty/resize", { ptyId, cols, rows }),
      kill: async () => {
        client.ptys.delete(ptyId);
        await this.notify(connectorId, "pty/kill", { ptyId });
      },
    };
  }

  delete(userId: string, id: string): void {
    const row = connectorDao.byId(userId, id);
    if (!row) return;
    connectorDao.delete(userId, id);
    const client = this.clients.get(id);
    if (client) client.ws.close(4000, "connector deleted");
  }

  private rowToInfo(row: {
    id: string;
    name: string;
    workspace_root: string;
    capabilities_json: string;
    last_seen_at: number | null;
    created_at: number;
    unconfined?: number;
  }): ConnectorInfo {
    const live = this.clients.get(row.id);
    const online = this.isOnline(row.id);
    return {
      id: row.id,
      name: row.name,
      workspaceRoot: row.workspace_root,
      capabilities: parseCapabilities(row.capabilities_json),
      online,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      unconfined: Boolean(row.unconfined),
      daemonUnconfined: online && live ? Boolean(live.daemonCaps?.includes("unconfined")) : null,
    };
  }

  setUnconfined(userId: string, id: string, unconfined: boolean): ConnectorInfo | null {
    connectorDao.setUnconfined(userId, id, unconfined);
    const row = connectorDao.byId(userId, id);
    return row ? this.rowToInfo(row) : null;
  }

  private pairingRowToInfo(row: {
    id: string;
    name: string;
    workspace_root: string;
    expires_at: number;
    created_at: number;
  }): ConnectorPairingInfo {
    return {
      id: row.id,
      name: row.name,
      workspaceRoot: row.workspace_root,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private accept(ws: WebSocket, _rawUrl: string, authorization: string | undefined): void {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const row = token ? connectorDao.byTokenHash(tokenHash(token)) : undefined;
    if (!row) {
      ws.close(4001, "unauthorized");
      return;
    }
    const denial = socketDenial(row.user_id);
    if (denial) {
      logConnector("connection_rejected", { connectorId: row.id, userId: row.user_id });
      ws.close(denial.wsCode, denial.kind);
      return;
    }

    const previous = this.clients.get(row.id);
    if (previous) {
      logConnector("connection_replaced", { connectorId: row.id, userId: row.user_id });
      this.cleanupClient(previous, "connector replaced by a newer connection", false);
      previous.ws.close(4000, "replaced by a newer connector");
    }

    const client: ConnectorClient = {
      id: row.id,
      generation: crypto.randomUUID(),
      ws,
      pending: new Map(),
      ptys: new Map(),
      closed: false,
      missedPongs: 0,
      daemonCaps: null,
      telemetryCache: null,
      telemetryInFlight: null,
      compatProcesses: null,
    };
    this.clients.set(row.id, client);
    connectorDao.setLastSeen(row.id, Date.now());
    logConnector("connection_open", { connectorId: row.id, userId: row.user_id });

    ws.on("pong", () => {
      client.missedPongs = 0;
      connectorDao.setLastSeen(client.id, Date.now());
    });
    ws.on("message", (data) => this.onMessage(client, data.toString("utf8")));
    ws.on("close", () => this.drop(client));
    ws.on("error", () => this.drop(client));
    void this.notify(row.id, "server/hello", { connectorId: row.id, ts: Date.now() }).catch(() => {});
  }

  private drop(client: ConnectorClient): void {
    this.cleanupClient(client, "connector disconnected", true);
  }

  private cleanupClient(client: ConnectorClient, reason: string, removeCurrent: boolean): void {
    if (client.closed) return;
    client.closed = true;
    logConnector("connection_close", { connectorId: client.id, reason, pending: client.pending.size, ptys: client.ptys.size });
    if (removeCurrent && this.clients.get(client.id) === client) this.clients.delete(client.id);
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error(reason));
    }
    client.pending.clear();
    for (const cb of client.ptys.values()) cb.onExit(null);
    client.ptys.clear();
    client.telemetryCache = null;
    client.telemetryInFlight = null;
    client.compatProcesses = null;
  }

  private onMessage(client: ConnectorClient, raw: string): void {
    let msg: RpcResponse | RpcNotification;
    try {
      msg = JSON.parse(raw) as RpcResponse | RpcNotification;
    } catch {
      return;
    }
    if (msg.type === "response") {
      const pending = client.pending.get(msg.id);
      if (!pending) return;
      client.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result ?? null);
      return;
    }
    if (msg.type !== "notification") return;
    if (msg.method === "client/hello") {
      const p = msg.params;
      if (!p || typeof p !== "object" || Array.isArray(p)) return;
      const caps = (p as { capabilities?: unknown }).capabilities;
      if (Array.isArray(caps)) client.daemonCaps = caps.filter((c): c is string => typeof c === "string");
      return;
    }
    if (msg.method === "pty/data") {
      const p = msg.params;
      if (!p || typeof p !== "object" || Array.isArray(p)) return;
      const ptyId = (p as { ptyId?: unknown }).ptyId;
      const dataBase64 = (p as { dataBase64?: unknown }).dataBase64;
      if (typeof ptyId !== "string" || typeof dataBase64 !== "string") return;
      client.ptys.get(ptyId)?.onData(new Uint8Array(Buffer.from(dataBase64, "base64")));
      return;
    }
    if (msg.method === "pty/exit") {
      const p = msg.params;
      if (!p || typeof p !== "object" || Array.isArray(p)) return;
      const ptyId = (p as { ptyId?: unknown }).ptyId;
      const code = (p as { code?: unknown }).code;
      if (typeof ptyId !== "string") return;
      const cb = client.ptys.get(ptyId);
      client.ptys.delete(ptyId);
      cb?.onExit(typeof code === "number" ? code : null);
    }
  }

  connectionGeneration(connectorId: string): string | null {
    const client = this.clients.get(connectorId);
    return client && !client.closed && client.ws.readyState === WebSocket.OPEN ? client.generation : null;
  }

  connectionCapability(connectorId: string, capability: string, expectedGeneration?: string): boolean | null {
    const client = this.clientOrThrow(connectorId, expectedGeneration);
    return client.daemonCaps === null ? null : client.daemonCaps.includes(capability);
  }

  private clientOrThrow(connectorId: string, expectedGeneration?: string): ConnectorClient {
    const client = this.clients.get(connectorId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) throw new Error("connector is offline");
    if (expectedGeneration !== undefined && client.generation !== expectedGeneration) {
      throw new Error("connector connection changed");
    }
    return client;
  }

  private call(
    connectorId: string,
    method: string,
    params: Json,
    opts: { timeoutMs?: number; signal?: AbortSignal; cancelMethod?: "exec/cancel" | "rpc/cancel"; expectedGeneration?: string } = {},
  ): Promise<Json> {
    const client = this.clientOrThrow(connectorId, opts.expectedGeneration);
    const id = "rpc_" + crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const msg: RpcRequest = { type: "request", id, method, params };
    return new Promise<Json>((resolve, reject) => {
      const onAbort = () => {
        const pending = client.pending.get(id);
        if (!pending) return;
        client.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (opts.cancelMethod) void this.notifyClient(client, opts.cancelMethod, { id }).catch(() => {});
        logConnector("rpc_cancel", { connectorId, id, method, reason: "abort" });
        reject(new Error("aborted"));
      };
      const cleanup = () => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        client.pending.delete(id);
        cleanup();
        if (opts.cancelMethod) void this.notifyClient(client, opts.cancelMethod, { id }).catch(() => {});
        logConnector("rpc_cancel", { connectorId, id, method, reason: "timeout" });
        reject(new Error(`connector RPC timed out: ${method}`));
      }, timeoutMs);
      client.pending.set(id, { resolve, reject, timer, cleanup });
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      client.ws.send(JSON.stringify(msg), (err) => {
        if (!err) return;
        const pending = client.pending.get(id);
        if (!pending) return;
        client.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup();
        reject(err);
      });
    });
  }

  private async notify(connectorId: string, method: string, params: Json): Promise<void> {
    const client = this.clients.get(connectorId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;
    await this.notifyClient(client, method, params);
  }

  private async notifyClient(client: ConnectorClient, method: string, params: Json): Promise<void> {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const msg: RpcNotification = { type: "notification", method, params };
    await new Promise<void>((resolve, reject) => {
      client.ws.send(JSON.stringify(msg), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export const connectorManager = new ConnectorManager();
