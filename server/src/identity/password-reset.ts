import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { userDao } from "../persistence/index.ts";
import { PRODUCT_NAME } from "../config.ts";
import { bannedReason } from "./ban.ts";
import { mailerEnabled, sendEmail, type EmailDispatchResult } from "./mailer.ts";

const RESET_TTL_MS = 30 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 15 * 60_000;
const RESEND_THROTTLE_MS = 60_000;

export function passwordResetEnabled(): boolean {
  return mailerEnabled();
}

export type ResetPreparation =
  | { status: "code"; userId: string; email: string; code: string }
  | { status: "oauth_only"; userId: string; email: string; providers: string[] }
  | { status: "skipped"; userId?: string; reason: "unknown_account" | "throttled" | "suspended" | "state_changed" };

export async function preparePasswordReset(email: string, now = Date.now()): Promise<ResetPreparation> {
  const normalized = email.trim().toLowerCase();
  const before = userDao.resetStateByEmail(normalized);
  if (!before) return { status: "skipped", reason: "unknown_account" };
  if (bannedReason(before.id)) return { status: "skipped", userId: before.id, reason: "suspended" };

  const reservation = userDao.reserveResetSend(normalized, now, now - RESEND_THROTTLE_MS);
  if (!reservation) return { status: "skipped", userId: before.id, reason: "throttled" };

  if (!before.has_password) {
    const providers: string[] = [];
    if (before.github_id) providers.push("GitHub");
    if (before.google_id) providers.push("Google");
    return { status: "oauth_only", userId: before.id, email: reservation.email, providers };
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await bcrypt.hash(code, 10);
  const committed = userDao.commitResetCode(reservation.id, now, codeHash, Date.now() + RESET_TTL_MS);
  if (committed !== 1) return { status: "skipped", userId: reservation.id, reason: "state_changed" };
  return { status: "code", userId: reservation.id, email: reservation.email, code };
}

export type ResetResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "invalid" | "locked" | "weak_password" };

export async function completePasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<ResetResult> {
  if (newPassword.length < 8) return { ok: false, reason: "weak_password" };
  if (newPassword.length > 200) return { ok: false, reason: "weak_password" };
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

  const st = userDao.resetStateByEmail(email.trim().toLowerCase());
  if (!st || !st.reset_code_hash) return { ok: false, reason: "invalid" };
  const now = Date.now();
  if (st.reset_locked_until && st.reset_locked_until > now) return { ok: false, reason: "locked" };
  if (!st.reset_expires || st.reset_expires <= now) return { ok: false, reason: "invalid" };
  if (bannedReason(st.id)) return { ok: false, reason: "invalid" };

  const attempts = userDao.bumpResetAttempt(st.id, now, now + CODE_LOCK_MS, MAX_CODE_ATTEMPTS);
  if (attempts > MAX_CODE_ATTEMPTS) return { ok: false, reason: "locked" };
  const match = await bcrypt.compare(code, st.reset_code_hash);
  if (!match) return { ok: false, reason: attempts >= MAX_CODE_ATTEMPTS ? "locked" : "invalid" };

  const hash = await bcrypt.hash(newPassword, 10);
  const previous = userDao.byId(st.id)?.password_changed_at ?? 0;
  const stamp = Math.max(Date.now(), previous + 1);
  if (!userDao.completeReset(st.id, st.reset_code_hash, hash, stamp)) return { ok: false, reason: "invalid" };
  return { ok: true, userId: st.id, email: st.email };
}

const INK = "#0A0A0A", MUTED = "#9a978f", LINE = "rgba(15,15,15,.08)", BG = "#EEEDEA";
const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',ui-monospace,Menlo,Consolas,monospace";

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:${BG};padding:40px 16px;font-family:${FONT};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
  <tr><td style="padding:30px 36px 0;font-weight:700;font-size:20px;letter-spacing:-.02em;color:${INK};">${PRODUCT_NAME}</td></tr>
  ${inner}
</table></td></tr></table></body></html>`;
}

function resetEmailHtml(code: string): string {
  const spaced = `${code.slice(0, 3)}&nbsp;${code.slice(3)}`;
  return shell(`<tr><td style="padding:18px 36px 8px;">
    <div style="font-size:21px;font-weight:700;letter-spacing:-.02em;color:${INK};margin-bottom:8px;">Reset your password</div>
    <div style="font-size:14.5px;line-height:1.55;color:#56534d;margin-bottom:16px;">Enter this code on the reset screen, then choose a new password:</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:14px;background:#FAFAF8;"><tr><td align="center" style="padding:18px 20px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};">Reset code</div>
      <div style="font-family:${MONO};font-size:34px;font-weight:600;letter-spacing:.34em;color:${INK};margin-top:6px;padding-left:.34em;">${spaced}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:8px;">Expires in 30 minutes &middot; one-time use</div>
    </td></tr></table>
    <div style="font-size:12.5px;color:${MUTED};line-height:1.5;margin-top:16px;">Setting a new password signs you out everywhere else.</div>
  </td></tr>
  <tr><td style="padding:18px 36px 28px;border-top:1px solid ${LINE};">
    <div style="font-size:12px;color:${MUTED};">If you didn't ask to reset your password, ignore this email — nothing has changed, and the code above is useless without access to this inbox.</div>
  </td></tr>`);
}

function oauthOnlyEmailHtml(providers: string[]): string {
  const how = providers.length
    ? `this address signs in with <strong style="color:${INK};">${providers.join(" or ")}</strong>`
    : "this address doesn't have a password set";
  return shell(`<tr><td style="padding:18px 36px 8px;">
    <div style="font-size:21px;font-weight:700;letter-spacing:-.02em;color:${INK};margin-bottom:8px;">There's no password to reset</div>
    <div style="font-size:14.5px;line-height:1.55;color:#56534d;margin-bottom:16px;">Someone asked to reset the password for your ${PRODUCT_NAME} account, but ${how} — so there's no password on it to change. Use that button on the sign-in page and you're in.</div>
    <div style="font-size:13px;line-height:1.55;color:#56534d;">Once you're signed in you can add a password from Settings, if you'd like one.</div>
  </td></tr>
  <tr><td style="padding:18px 36px 28px;border-top:1px solid ${LINE};">
    <div style="font-size:12px;color:${MUTED};">If this wasn't you, nothing has changed and no action is needed.</div>
  </td></tr>`);
}

export async function sendResetEmail(email: string, code: string): Promise<EmailDispatchResult> {
  return sendEmail({
    to: email,
    subject: `Your ${PRODUCT_NAME} password reset code: ${code}`,
    html: resetEmailHtml(code),
    text:
      `Your ${PRODUCT_NAME} password reset code is ${code} (expires in 30 minutes).\n\n` +
      `Enter it on the reset screen, then choose a new password. Setting a new password signs you out everywhere else.\n\n` +
      `If you didn't ask to reset your password, ignore this email — nothing has changed.`,
  });
}

export async function sendResetOauthOnlyEmail(email: string, providers: string[]): Promise<EmailDispatchResult> {
  const how = providers.length ? `this address signs in with ${providers.join(" or ")}` : "this address has no password set";
  return sendEmail({
    to: email,
    subject: `About your ${PRODUCT_NAME} account: there's no password to reset`,
    html: oauthOnlyEmailHtml(providers),
    text:
      `Someone asked to reset the password for your ${PRODUCT_NAME} account, but ${how} — ` +
      `so there's no password on it to change. Use that button on the sign-in page instead.\n\n` +
      `Once you're signed in you can add a password from Settings, if you'd like one.\n\n` +
      `If this wasn't you, nothing has changed and no action is needed.`,
  });
}
