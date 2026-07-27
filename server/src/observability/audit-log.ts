import crypto from "node:crypto";
import { errorMessage, classifyError } from "../foundation/errors.ts";
import type { NextFunction, Request, Response } from "express";
import { auditEventDao } from "../persistence/index.ts";
import { sha256Hex } from "../identity/crypto-util.ts";

type AuditLevel = "debug" | "info" | "warn" | "error";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface AuditOptions {
  level?: AuditLevel;
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  targetId?: string | null;
  data?: Record<string, unknown>;
  stdout?: boolean;
  persist?: boolean;
}

interface AuditRequest extends Request {
  auditRequestId?: string;
  user?: { id: string };
}

const AUDIT_STDOUT = process.env.AGENT_WEB_AUDIT_STDOUT !== "0";
const AUDIT_DB = process.env.AGENT_WEB_AUDIT_DB !== "0";
const AUDIT_RETENTION_DAYS = readPositiveInt("AGENT_WEB_AUDIT_RETENTION_DAYS", 30);
const AUDIT_MAX_ROWS = readPositiveInt("AGENT_WEB_AUDIT_MAX_ROWS", 200_000);
const AUDIT_DATA_BYTES = readPositiveInt("AGENT_WEB_AUDIT_DATA_BYTES", 2048);
const AUDIT_PRUNE_EVERY = readPositiveInt("AGENT_WEB_AUDIT_PRUNE_EVERY", 250);
const AUDIT_PRUNE_INTERVAL_MS = readPositiveInt("AGENT_WEB_AUDIT_PRUNE_INTERVAL_MS", 10 * 60_000);

const SECRET_KEY_RE = /token|authorization|cookie|password|secret|api[_-]?key|private[_-]?key|pair[_-]?code|enc_key|code_hash/i;
const SECRET_TEXT_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|pair_[A-Za-z0-9_-]{10,}|conn_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{12,})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EVENT_RE = /^[a-z0-9_.:-]+$/;

let writesSincePrune = 0;
let lastPruneAt = 0;

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maybeString(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function cleanEvent(event: string): string {
  const clean = event.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80);
  return clean && EVENT_RE.test(clean) ? clean : "audit_event";
}

function cleanString(value: string): string {
  return value
    .replace(SECRET_TEXT_RE, "[redacted]")
    .replace(EMAIL_RE, "[email]")
    .slice(0, 500);
}

function cleanValue(value: unknown, depth = 0): JsonValue {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return cleanString(value);
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = cleanValue(inner, depth + 1);
      }
    }
    return out;
  }
  return String(value).slice(0, 120);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function dataJson(data: Record<string, unknown> | undefined): string {
  const cleaned = cleanValue(data ?? {}) as Record<string, JsonValue>;
  const encoded = asciiJson(cleaned);
  if (byteLength(encoded) <= AUDIT_DATA_BYTES) return encoded;
  return asciiJson({ truncated: true, originalBytes: byteLength(encoded) });
}

export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function hashForAudit(value: string | null | undefined): string | null {
  if (!value) return null;
  return sha256Hex(value).slice(0, 16);
}

export function auditPrune(force = false): void {
  if (!AUDIT_DB) return;
  const now = Date.now();
  if (!force && writesSincePrune < AUDIT_PRUNE_EVERY && now - lastPruneAt < AUDIT_PRUNE_INTERVAL_MS) return;
  writesSincePrune = 0;
  lastPruneAt = now;
  const olderThan = now - AUDIT_RETENTION_DAYS * 24 * 60 * 60_000;
  try {
    const removed = auditEventDao.prune(olderThan, AUDIT_MAX_ROWS);
    if (force || removed.oldRows > 0 || removed.overflowRows > 0) {
      logAudit("audit_prune", {
        level: "info",
        data: { oldRows: removed.oldRows, overflowRows: removed.overflowRows, retentionDays: AUDIT_RETENTION_DAYS, maxRows: AUDIT_MAX_ROWS },
        persist: false,
      });
    }
  } catch (err) {
    console.error(asciiJson({ ts: now, level: "error", event: "audit_prune_failed", data: { message: errorMessage(err) } }));
  }
}

export function logAudit(event: string, opts: AuditOptions = {}): void {
  const ts = Date.now();
  const level = opts.level ?? "info";
  const clean = cleanEvent(event);
  let data: string;
  let parsedData: JsonValue;
  try {
    data = dataJson(opts.data);
    parsedData = JSON.parse(data) as JsonValue;
  } catch {
    data = asciiJson({ truncated: true, buildError: true });
    parsedData = { truncated: true, buildError: true };
  }
  const line = {
    ts,
    level,
    event: clean,
    request_id: maybeString(opts.requestId),
    user_id: maybeString(opts.userId),
    session_id: maybeString(opts.sessionId),
    target_id: maybeString(opts.targetId),
    data: parsedData,
  };
  if (AUDIT_STDOUT && opts.stdout !== false) {
    const text = asciiJson(line);
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.info(text);
  }
  if (AUDIT_DB && opts.persist !== false) {
    try {
      auditEventDao.add({
        id: "aud_" + crypto.randomUUID(),
        ts,
        level,
        event: clean,
        user_id: maybeString(opts.userId),
        session_id: maybeString(opts.sessionId),
        request_id: maybeString(opts.requestId),
        target_id: maybeString(opts.targetId),
        data_json: data,
      });
      writesSincePrune++;
      auditPrune(false);
    } catch (err) {
      console.error(asciiJson({ ts, level: "error", event: "audit_write_failed", data: { message: errorMessage(err) } }));
    }
  }
}

function routePath(req: Request): string {
  const route = (req as { route?: { path?: unknown } }).route?.path;
  if (typeof route === "string") return `${req.baseUrl}${route}`;
  const raw = req.originalUrl || req.url || "/";
  const path = raw.split("?")[0] || "/";
  return path
    .replace(/\/share\/[A-Za-z0-9_-]{16,}/g, "/share/:token")
    .replace(/\/sessions\/s_[A-Za-z0-9_-]+/g, "/sessions/:id")
    .replace(/\/connectors\/conn_[A-Za-z0-9_-]+/g, "/connectors/:id");
}

export function getAuditRequestId(req: Request): string | null {
  return (req as AuditRequest).auditRequestId ?? null;
}

export function auditHttpMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  const requestId = "req_" + crypto.randomUUID();
  (req as AuditRequest).auditRequestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    const r = req as AuditRequest;
    const status = res.statusCode;
    logAudit("http_request", {
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      requestId,
      userId: r.user?.id,
      persist: status >= 400 || req.method !== "GET",
      data: {
        method: req.method,
        path: routePath(req),
        status,
        durationMs: Date.now() - started,
        contentLength: Number(req.headers["content-length"] ?? 0) || 0,
        ipHash: hashForAudit(req.ip),
      },
    });
  });
  next();
}

export function errorKind(err: unknown): string {
  const { errorKind } = classifyError(err);
  return errorKind === "unknown" ? (err instanceof Error ? err.name : "error") : errorKind;
}
