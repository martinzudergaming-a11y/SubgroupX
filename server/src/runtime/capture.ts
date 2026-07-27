import zlib from "node:zlib";
import { errorMessage } from "../foundation/errors.ts";

export const CAPTURE_BUDGET_BYTES = Math.floor(1.5 * 1024 * 1024);

const REDACTION_MARK = (n: number): string => `«redacted:${n}»`;

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)[-_](?:ant-|proj-|or-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bxai-[A-Za-z0-9-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

export function redactSecrets(json: string): string {
  let out = json;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => REDACTION_MARK(m.length));
  }
  return out;
}

const MAX_ELIDE_DEPTH = 200;

function elideDeep(v: unknown, stringCap: number, collectionCap: number, depth: number): unknown {
  if (depth > MAX_ELIDE_DEPTH) return { __elided_depth__: true };
  if (typeof v === "string") {
    if (v.length <= stringCap) return v;
    const head = v.slice(0, Math.max(0, stringCap - 32));
    return `${head}…«+${v.length - head.length} chars elided»`;
  }
  if (Array.isArray(v)) {
    const kept = v.slice(0, collectionCap).map((x) => elideDeep(x, stringCap, collectionCap, depth + 1));
    if (v.length > collectionCap) kept.push({ __elided_items__: v.length - collectionCap });
    return kept;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as Record<string, unknown>);
    for (const k of keys.slice(0, collectionCap)) {
      out[k] = elideDeep((v as Record<string, unknown>)[k], stringCap, collectionCap, depth + 1);
    }
    if (keys.length > collectionCap) out.__elided_keys__ = keys.length - collectionCap;
    return out;
  }
  return v;
}

const ELISION_PASSES: ReadonlyArray<readonly [number, number]> = [
  [64 * 1024, 1000],
  [16 * 1024, 400],
  [4 * 1024, 150],
  [256, 25],
];

export function boundForCapture(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch (e) {
    return JSON.stringify({ __capture_error__: errorMessage(e) });
  }
  json = redactSecrets(json);
  if (Buffer.byteLength(json, "utf8") <= CAPTURE_BUDGET_BYTES) return json;

  try {
    const parsed: unknown = JSON.parse(json);
    let bounded = json;
    for (const [stringCap, collectionCap] of ELISION_PASSES) {
      bounded = JSON.stringify(elideDeep(parsed, stringCap, collectionCap, 0)) ?? "null";
      if (Buffer.byteLength(bounded, "utf8") <= CAPTURE_BUDGET_BYTES) return bounded;
    }
    return JSON.stringify({
      __oversized__: true,
      originalBytes: Buffer.byteLength(json, "utf8"),
      preview: bounded.slice(0, CAPTURE_BUDGET_BYTES),
    });
  } catch (e) {
    return JSON.stringify({ __capture_error__: errorMessage(e) });
  }
}

const GZIP_PREFIX = "gz:";

const MAX_UNPACK_BYTES = 8 * 1024 * 1024;

export function packCapture(value: unknown): string {
  const json = boundForCapture(value);
  const gz = GZIP_PREFIX + zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");
  return gz.length < json.length ? gz : json;
}

export function unpackCapture(stored: string | null | undefined): unknown {
  if (stored == null) return null;
  try {
    if (stored.startsWith(GZIP_PREFIX)) {
      const buf = zlib.gunzipSync(Buffer.from(stored.slice(GZIP_PREFIX.length), "base64"), {
        maxOutputLength: MAX_UNPACK_BYTES,
      });
      return JSON.parse(buf.toString("utf8"));
    }
    return JSON.parse(stored);
  } catch (e) {
    return { __capture_error__: errorMessage(e) };
  }
}

const SAFE_HEADER_EXACT = new Set([
  "x-request-id",
  "request-id",
  "retry-after",
  "content-type",
  "date",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const SAFE_HEADER_PREFIXES = ["ratelimit-", "x-ratelimit-"];

function isSafeHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (SAFE_HEADER_EXACT.has(n)) return true;
  return SAFE_HEADER_PREFIXES.some((p) => n.startsWith(p));
}

export function allowlistResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (isSafeHeader(k)) out[k.toLowerCase()] = v;
  }
  return out;
}

export interface ResponseMeta {
  status: number;
  headers: Record<string, string>;
}

export function buildResponseMeta(status: number, headers: Record<string, string> | undefined): ResponseMeta {
  return { status, headers: allowlistResponseHeaders(headers) };
}
