import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { type Request, type Response, type NextFunction } from "express";
import { verifyToken, type AuthedUser } from "../identity/auth.ts";
import { isAdminEmail, publicOriginFor } from "../config.ts";
import { bannedReason } from "../identity/ban.ts";
import { type AccessDenial } from "../identity/access-gate.ts";
import type { SandboxMode, ApprovalPolicy } from "../../../shared/src/protocol.ts";

export interface AuthedRequest<P = Record<string, string>> extends Request<P> {
  user?: AuthedUser;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const reason = bannedReason(user.id);
  if (reason) {
    res.status(403).json({ error: reason, banned: true, reason });
    return;
  }
  req.user = user;
  next();
}

export function sendAccessDenial(res: Response, denial: AccessDenial): void {
  if (denial.kind === "suspended") {
    res.status(denial.httpStatus).json({ error: denial.message, banned: true, reason: denial.message });
  } else {
    res.status(denial.httpStatus).json({ error: denial.message });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user || !isAdminEmail(req.user.email)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

export const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
export const APPROVAL_POLICIES: ApprovalPolicy[] = ["never", "on-request", "untrusted"];

export function forkFailureMessage(reason: string): string {
  switch (reason) {
    case "not found": return "Session not found.";
    case "not-forkable": return "You can only fork from one of your messages.";
    case "compacted": return "Can't fork from a message before a context compaction.";
    case "too-old": return "This message is too old to fork from.";
    default: return reason || "Couldn't fork the conversation.";
  }
}

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX = 12;
const authHits = new Map<string, { count: number; resetAt: number }>();

export function authAllowed(key: string): boolean {
  const now = Date.now();
  if (authHits.size > 5000) {
    for (const [k, v] of authHits) if (now > v.resetAt) authHits.delete(k);
  }
  const e = authHits.get(key);
  if (!e || now > e.resetAt) {
    authHits.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  e.count++;
  return e.count <= AUTH_MAX;
}

export function authClear(key: string): void {
  authHits.delete(key);
}

export function isLoopback(ip: string | undefined): boolean {
  return !ip || ip === "::1" || ip === "127.0.0.1" || ip.endsWith(":127.0.0.1");
}

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_USER_BYTES = 30 * 1024 * 1024;
export const CONNECTOR_DAEMON_SRC = readFileSync(
  new URL("../../../scripts/agent-web-connector.mjs", import.meta.url),
  "utf8",
);
export const CONNECTOR_INSTALLER_SRC = readFileSync(
  new URL("../../../scripts/install-agent-web-connector.sh", import.meta.url),
  "utf8",
);

export const SSH_EXECUTOR_ENABLED = process.env.AGENT_WEB_SSH_EXECUTOR === "1";

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,43}$/;
export function mintShareToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}
const SHARE_WINDOW_MS = 60 * 1000;
const SHARE_MAX = 60;
const shareHits = new Map<string, { count: number; resetAt: number }>();
export function shareAllowed(ip: string): boolean {
  const now = Date.now();
  if (shareHits.size > 5000) {
    for (const [k, v] of shareHits) if (now > v.resetAt) shareHits.delete(k);
  }
  const e = shareHits.get(ip);
  if (!e || now > e.resetAt) {
    shareHits.set(ip, { count: 1, resetAt: now + SHARE_WINDOW_MS });
    return true;
  }
  e.count++;
  return e.count <= SHARE_MAX;
}
const PAIR_WINDOW_MS = 60 * 1000;
const PAIR_MAX = 20;
const pairHits = new Map<string, { count: number; resetAt: number }>();
export function pairAllowed(ip: string): boolean {
  const now = Date.now();
  if (pairHits.size > 5000) {
    for (const [k, v] of pairHits) if (now > v.resetAt) pairHits.delete(k);
  }
  const e = pairHits.get(ip);
  if (!e || now > e.resetAt) {
    pairHits.set(ip, { count: 1, resetAt: now + PAIR_WINDOW_MS });
    return true;
  }
  e.count++;
  return e.count <= PAIR_MAX;
}
export function setShareSecurityHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

export const publicOrigin = (req: AuthedRequest): string => publicOriginFor(req.protocol, req.get("host"));
