import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { userDao } from "../persistence/index.ts";
import { sha256Hex } from "./crypto-util.ts";
import { PRODUCT_NAME } from "../config.ts";
import { mailerEnabled, sendEmail, type EmailDispatchResult } from "./mailer.ts";

export type { EmailDispatchResult };

const VERIFY_TTL_MS = 30 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 15 * 60_000;
const RESEND_THROTTLE_MS = 30_000;

const BUILTIN_BLOCKED = [
  "protonmail.com", "proton.me", "pm.me", "tutanota.com", "tutanota.de", "tuta.com", "tutamail.com",
  "mailfence.com", "hushmail.com", "ctemplar.com", "cock.li", "riseup.net", "disroot.org",
  "startmail.com", "danwin1210.de",
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "grr.la",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "tempmail.dev", "throwawaymail.com",
  "getnada.com", "nada.email", "yopmail.com", "trashmail.com", "maildrop.cc", "fakeinbox.com",
  "dispostable.com", "mintemail.com", "mohmal.com", "emailondeck.com", "moakt.com", "tmail.ws",
  "spam4.me", "mailnesia.com", "inboxbear.com", "vomoto.com", "linshiyou.com", "0box.eu",
];
const blocked = new Set(
  [...BUILTIN_BLOCKED, ...(process.env.AGENT_WEB_BLOCKED_EMAIL_DOMAINS || "").split(",")]
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

const BUILTIN_ALLOWED = [
  "qq.com", "vip.qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "188.com",
  "sina.com", "sina.cn", "sohu.com", "aliyun.com", "139.com", "189.cn", "21cn.com",
  "gmail.com", "googlemail.com", "outlook.com", "outlook.com.cn", "hotmail.com", "live.com",
  "live.cn", "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.com.cn",
  "ymail.com", "gmx.com", "mail.com", "aol.com", "zoho.com", "naver.com",
];
const ALLOWED_SUFFIXES = [".edu", ".edu.cn", ".ac.cn"];
const allowedEnv = (process.env.AGENT_WEB_ALLOWED_EMAIL_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const allowlistDisabled = allowedEnv.includes("*");
const allowed = new Set(allowedEnv.length && !allowlistDisabled ? allowedEnv : BUILTIN_ALLOWED);

const NOT_ALLOWED_MSG = "Please sign up with a mainstream email (Gmail, QQ, 163, Outlook, iCloud, Foxmail…). Privacy/disposable and uncommon providers aren't accepted.";

export function assertAllowedEmailDomain(email: string): void {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) throw new Error("invalid email");
  const domain = parts[1] || "";
  if (!domain) throw new Error("invalid email");
  for (const b of blocked) if (domain === b || domain.endsWith("." + b)) throw new Error(NOT_ALLOWED_MSG);
  if (allowlistDisabled) return;
  if (allowed.has(domain)) return;
  if (ALLOWED_SUFFIXES.some((s) => domain.endsWith(s))) return;
  throw new Error(NOT_ALLOWED_MSG);
}

export function emailVerifyEnabled(): boolean {
  return mailerEnabled();
}

export type VerificationPreparation =
  | { status: "ready"; userId: string; email: string; token: string; code: string }
  | {
      status: "skipped";
      userId?: string;
      reason: "unknown_account" | "active_account" | "throttled" | "state_changed";
    };

export async function prepareVerificationEmail(
  email: string,
  now = Date.now(),
): Promise<VerificationPreparation> {
  const normalized = email.trim().toLowerCase();
  const before = userDao.verifyStateByEmail(normalized);
  if (!before) return { status: "skipped", reason: "unknown_account" };
  if (before.email_verified !== 0) {
    return { status: "skipped", userId: before.id, reason: "active_account" };
  }
  const reservation = userDao.reserveVerificationSend(normalized, now, now - RESEND_THROTTLE_MS);
  if (!reservation) {
    const after = userDao.verifyStateByEmail(normalized);
    if (!after) return { status: "skipped", reason: "unknown_account" };
    if (after.email_verified !== 0) {
      return { status: "skipped", userId: after.id, reason: "active_account" };
    }
    return { status: "skipped", userId: after.id, reason: "throttled" };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await bcrypt.hash(code, 10);
  const committed = userDao.commitVerificationPair(
    reservation.id,
    now,
    tokenHash,
    codeHash,
    Date.now() + VERIFY_TTL_MS,
  );
  if (committed !== 1) {
    return { status: "skipped", userId: reservation.id, reason: "state_changed" };
  }
  return { status: "ready", userId: reservation.id, email: reservation.email, token, code };
}

export function consumeVerifyToken(raw: string): string | null {
  if (!raw) return null;
  const hash = sha256Hex(raw);
  return userDao.verifyByToken(hash, Date.now());
}

export type CodeResult = { ok: true } | { ok: false; reason: "invalid" | "expired" | "locked" };

export async function consumeVerifyCode(email: string, code: string): Promise<CodeResult> {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const st = userDao.verifyStateByEmail(email.trim().toLowerCase());
  if (!st || st.email_verified !== 0 || !st.verify_code_hash) return { ok: false, reason: "invalid" };
  const now = Date.now();
  if (st.verify_locked_until && st.verify_locked_until > now) return { ok: false, reason: "locked" };
  if (!st.verify_expires || st.verify_expires <= now) return { ok: false, reason: "expired" };
  const attempts = userDao.bumpVerifyAttempt(st.id, now, now + CODE_LOCK_MS, MAX_CODE_ATTEMPTS);
  if (attempts > MAX_CODE_ATTEMPTS) return { ok: false, reason: "locked" };
  const match = await bcrypt.compare(code, st.verify_code_hash);
  if (!match) return { ok: false, reason: attempts >= MAX_CODE_ATTEMPTS ? "locked" : "invalid" };
  return userDao.claimPendingVerification(st.id) === 1 ? { ok: true } : { ok: false, reason: "invalid" };
}

export function execBlockedForVerification(userId: string): boolean {
  return emailVerifyEnabled() && userDao.emailVerifiedState(userId) === 0;
}

function verifyEmailHtml(link: string, code: string): string {
  const spaced = `${code.slice(0, 3)}&nbsp;${code.slice(3)}`;
  const ink = "#0A0A0A", muted = "#9a978f", line = "rgba(15,15,15,.08)", bg = "#EEEDEA";
  const font = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "'SF Mono',ui-monospace,Menlo,Consolas,monospace";
  return `<!doctype html><html><body style="margin:0;background:${bg};padding:40px 16px;font-family:${font};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid ${line};border-radius:16px;overflow:hidden;">
  <tr><td style="padding:30px 36px 0;font-weight:700;font-size:20px;letter-spacing:-.02em;color:${ink};">${PRODUCT_NAME}</td></tr>
  <tr><td style="padding:18px 36px 8px;">
    <div style="font-size:21px;font-weight:700;letter-spacing:-.02em;color:${ink};margin-bottom:8px;">Confirm your email to start building</div>
    <div style="font-size:14.5px;line-height:1.55;color:#56534d;margin-bottom:16px;">You're one step from running coding agents in your browser. Enter this code on the verification screen:</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${line};border-radius:14px;background:#FAFAF8;"><tr><td align="center" style="padding:18px 20px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${muted};">Verification code</div>
      <div style="font-family:${mono};font-size:34px;font-weight:600;letter-spacing:.34em;color:${ink};margin-top:6px;padding-left:.34em;">${spaced}</div>
      <div style="font-size:12px;color:${muted};margin-top:8px;">Expires in 30 minutes &middot; one-time use</div>
    </td></tr></table>
    <div style="text-align:center;color:#b7b4ad;font-size:12px;margin:20px 0;">or</div>
    <a href="${link}" style="display:block;text-align:center;background:${ink};color:#fff;text-decoration:none;font-size:15px;font-weight:600;border-radius:11px;padding:14px;margin-bottom:14px;">Verify email &rarr;</a>
    <div style="font-size:12.5px;color:${muted};line-height:1.5;">Button not working? Paste this link:<br><a href="${link}" style="color:#56534d;word-break:break-all;">${link}</a></div>
  </td></tr>
  <tr><td style="padding:18px 36px 28px;border-top:1px solid ${line};">
    <div style="font-size:12px;color:${muted};">If you didn't create an ${PRODUCT_NAME} account, you can safely ignore this email.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendVerifyEmail(email: string, link: string, code: string): Promise<EmailDispatchResult> {
  return sendEmail({
    to: email,
    subject: `Your ${PRODUCT_NAME} verification code: ${code}`,
    html: verifyEmailHtml(link, code),
    text:
      `Your ${PRODUCT_NAME} verification code is ${code} (expires in 30 minutes).\n\n` +
      `Or confirm by opening this link:\n${link}\n\n` +
      `If you didn't create an ${PRODUCT_NAME} account, you can ignore this email.`,
  });
}
