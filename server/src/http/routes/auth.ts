import type express from "express";
import { type Request, type Response } from "express";
import {
  signup,
  login,
  changePassword,
  userHasPassword,
  issueToken,
  githubConfigured,
  githubAuthorizeUrl,
  githubStepupAuthorizeUrl,
  parseOAuthState,
  issuePasswordSetupToken,
  verifyPasswordSetupToken,
  githubExchange,
  githubUpsert,
  googleConfigured,
  googleAuthorizeUrl,
  googleStepupAuthorizeUrl,
  googleExchange,
  googleUpsert,
  type AuthedUser,
} from "../../identity/auth.ts";
import { userDao } from "../../persistence/index.ts";
import {
  emailVerifyEnabled,
  prepareVerificationEmail,
  consumeVerifyToken,
  consumeVerifyCode,
  sendVerifyEmail,
  type EmailDispatchResult,
  type VerificationPreparation,
} from "../../identity/email-verify.ts";
import {
  passwordResetEnabled,
  preparePasswordReset,
  completePasswordReset,
  sendResetEmail,
  sendResetOauthOnlyEmail,
} from "../../identity/password-reset.ts";
import { isAdminEmail } from "../../config.ts";
import { bannedReason } from "../../identity/ban.ts";
import { disposeUserRuntimesEverywhere } from "../../runtime/runtime-client.ts";
import { errorKind as auditErrorKind, getAuditRequestId, hashForAudit, logAudit } from "../../observability/audit-log.ts";
import {
  type AuthedRequest,
  requireAuth,
  authAllowed,
  authClear,
  isLoopback,
  publicOrigin,
} from "../route-helpers.ts";

const PENDING_MSG = "Check your inbox if this address needs verification, or use its existing sign-in method.";
function pendingResponse(res: Response, email: string): void {
  res.json({ state: "PENDING_VERIFY", emailVerificationPending: true, pendingEmail: email, message: PENDING_MSG });
}
function fullAppResponse(res: Response, user: AuthedUser): void {
  res.json({ state: "FULL_APP", token: issueToken(user), user: { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email), hasPassword: userHasPassword(user.id) } });
}
const verifyLink = (req: AuthedRequest, token: string) => `${publicOrigin(req)}/api/auth/verify?token=${token}`;

type VerificationTrigger = "signup" | "duplicate_signup" | "login_refresh" | "resend";
type EmailDispatchSkipReason =
  | Extract<VerificationPreparation, { status: "skipped" }>["reason"]
  | "feature_disabled"
  | "rate_limited";

function dispatchAuditData(trigger: VerificationTrigger, result: EmailDispatchResult): Record<string, unknown> {
  const common = { kind: "verification", provider: "resend", trigger, outcome: result.outcome, durationMs: result.durationMs };
  switch (result.outcome) {
    case "accepted": return { ...common, providerStatus: result.httpStatus };
    case "rejected": return { ...common, providerStatus: result.httpStatus, providerCode: result.providerCode };
    case "failed": return { ...common, errorKind: result.errorKind };
    case "disabled": return common;
  }
}

function auditSkippedEmailDispatch(
  req: AuthedRequest,
  trigger: VerificationTrigger,
  reason: EmailDispatchSkipReason,
  userId?: string,
): void {
  logAudit("auth_email_dispatch", {
    level: "info",
    requestId: getAuditRequestId(req),
    userId,
    data: { kind: "verification", provider: "resend", trigger, outcome: "skipped", reason },
  });
}

async function dispatchVerificationEmail(
  req: AuthedRequest,
  email: string,
  trigger: VerificationTrigger,
): Promise<void> {
  let prepared: Awaited<ReturnType<typeof prepareVerificationEmail>>;
  try {
    prepared = await prepareVerificationEmail(email);
  } catch (error) {
    logAudit("auth_email_dispatch", {
      level: "error",
      requestId: getAuditRequestId(req),
      data: {
        kind: "verification",
        provider: "resend",
        trigger,
        outcome: "failed",
        stage: "prepare",
        errorKind: auditErrorKind(error),
      },
    });
    return;
  }
  if (prepared.status === "skipped") {
    auditSkippedEmailDispatch(req, trigger, prepared.reason, prepared.userId);
    return;
  }
  const dispatched = await sendVerifyEmail(
    prepared.email,
    verifyLink(req, prepared.token),
    prepared.code,
  );
  logAudit("auth_email_dispatch", {
    level: dispatched.outcome === "accepted" ? "info" : "warn",
    requestId: getAuditRequestId(req),
    userId: prepared.userId,
    targetId: dispatched.outcome === "accepted" ? dispatched.providerId ?? undefined : undefined,
    data: dispatchAuditData(trigger, dispatched),
  });
}

async function dispatchResetEmail(req: AuthedRequest, email: string): Promise<void> {
  const audit = (level: "info" | "warn" | "error", data: Record<string, unknown>, userId?: string, targetId?: string) =>
    logAudit("auth_reset_dispatch", {
      level,
      requestId: getAuditRequestId(req),
      userId,
      targetId,
      data: { kind: "password_reset", provider: "resend", ...data },
    });
  let prepared: Awaited<ReturnType<typeof preparePasswordReset>>;
  try {
    prepared = await preparePasswordReset(email);
  } catch (error) {
    audit("error", { outcome: "failed", stage: "prepare", errorKind: auditErrorKind(error) });
    return;
  }
  if (prepared.status === "skipped") {
    audit("info", { outcome: "skipped", reason: prepared.reason }, prepared.userId);
    return;
  }
  const variant = prepared.status === "code" ? "code" : "oauth_only";
  const dispatched = prepared.status === "code"
    ? await sendResetEmail(prepared.email, prepared.code)
    : await sendResetOauthOnlyEmail(prepared.email, prepared.providers);
  const common = { variant, outcome: dispatched.outcome, durationMs: dispatched.durationMs };
  audit(
    dispatched.outcome === "accepted" ? "info" : "warn",
    dispatched.outcome === "accepted"
      ? { ...common, providerStatus: dispatched.httpStatus }
      : dispatched.outcome === "rejected"
        ? { ...common, providerStatus: dispatched.httpStatus, providerCode: dispatched.providerCode }
        : dispatched.outcome === "failed"
          ? { ...common, errorKind: dispatched.errorKind }
          : common,
    prepared.userId,
    dispatched.outcome === "accepted" ? dispatched.providerId ?? undefined : undefined,
  );
}

function rateLimited(req: Request, res: Response, key: string): boolean {
  if (!isLoopback(req.ip) && !authAllowed(key)) {
    res.status(429).json({ error: "too many attempts — try again later" });
    return true;
  }
  return false;
}

export function registerAuthRoutes(r: express.Router): void {
  r.post("/auth/logout", (_req, res) => {
    res.setHeader("Clear-Site-Data", '"cookies"');
    res.status(204).end();
  });

  r.post("/auth/signup", async (req, res) => {
    const { email, password } = req.body ?? {};
    const addr = String(email ?? "").trim().toLowerCase();
    const pass = String(password ?? "");
    const key = `signup:${req.ip}`;
    if (rateLimited(req, res, key)) return;
    if (!emailVerifyEnabled()) {
      try {
        const user = await signup(addr, pass);
        authClear(key);
        logAudit("auth_signup_success", { requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip) } });
        fullAppResponse(res, user);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : "signup failed" });
      }
      return;
    }
    try {
      let user: AuthedUser;
      try {
        user = await signup(addr, pass, { requireEmailVerification: true });
      } catch (e) {
        if (e instanceof Error && e.message === "email already registered") {
          const existing = userDao.byEmail(addr);
          if (existing && userDao.emailVerifiedState(existing.id) !== 0) {
            const authenticated = await login(addr, pass).catch(() => null);
            if (authenticated) {
              const reason = bannedReason(authenticated.id);
              if (reason) {
                logAudit("auth_login_banned", {
                  level: "warn",
                  requestId: getAuditRequestId(req),
                  userId: authenticated.id,
                  data: { ipHash: hashForAudit(req.ip), via: "signup_recovery" },
                });
                res.status(403).json({ error: reason, banned: true, reason });
                return;
              }
              authClear(key);
              logAudit("auth_signup_existing_login", {
                requestId: getAuditRequestId(req),
                userId: authenticated.id,
                data: { ipHash: hashForAudit(req.ip) },
              });
              fullAppResponse(res, authenticated);
              return;
            }
          }
          await dispatchVerificationEmail(req as AuthedRequest, existing?.email ?? addr, "duplicate_signup");
          pendingResponse(res, existing?.email ?? addr);
          return;
        }
        throw e;
      }
      authClear(key);
      await dispatchVerificationEmail(req as AuthedRequest, user.email, "signup");
      logAudit("auth_signup_success", { requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip) } });
      pendingResponse(res, user.email);
    } catch (e) {
      logAudit("auth_signup_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason: e instanceof Error ? e.message : "signup failed" } });
      res.status(400).json({ error: e instanceof Error ? e.message : "signup failed" });
    }
  });

  r.post("/auth/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    const key = `login:${req.ip}:${String(email ?? "").toLowerCase()}`;
    if (rateLimited(req, res, key)) return;
    let user: AuthedUser;
    try {
      user = await login(String(email ?? ""), String(password ?? ""));
    } catch {
      logAudit("auth_login_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason: "invalid credentials" } });
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    authClear(key);
    const reason = bannedReason(user.id);
    if (reason) {
      logAudit("auth_login_banned", { level: "warn", requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip) } });
      res.status(403).json({ error: reason, banned: true, reason });
      return;
    }
    if (emailVerifyEnabled() && userDao.emailVerifiedState(user.id) === 0) {
      const st = userDao.verifyStateByEmail(user.email);
      const needsFresh = !st?.verify_code_hash || !st?.verify_expires || st.verify_expires <= Date.now();
      if (needsFresh) {
        await dispatchVerificationEmail(req as AuthedRequest, user.email, "login_refresh");
      }
      logAudit("auth_login_pending", { requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip) } });
      pendingResponse(res, user.email);
      return;
    }
    logAudit("auth_login_success", { requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip) } });
    fullAppResponse(res, user);
  });

  r.get("/auth/verify", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const email = consumeVerifyToken(token);
    const base = publicOrigin(req as AuthedRequest);
    if (!email) { res.redirect(`${base}/?verify_error=1`); return; }
    logAudit("auth_email_verified", { requestId: getAuditRequestId(req), data: { ipHash: hashForAudit(req.ip), via: "link" } });
    const user = userDao.byEmail(email);
    if (user && !bannedReason(user.id)) {
      const jwt = issueToken({ id: user.id, email: user.email });
      res.redirect(`${base}/?verified=1&auth_token=${encodeURIComponent(jwt)}`);
    } else {
      res.redirect(`${base}/?verified=1`);
    }
  });

  r.post("/auth/verify-code", async (req, res) => {
    const { email, code } = req.body ?? {};
    const addr = String(email ?? "").trim().toLowerCase();
    const key = `verifycode:${req.ip}:${addr}`;
    if (rateLimited(req, res, key)) return;
    const result = await consumeVerifyCode(addr, String(code ?? ""));
    if (!result.ok) {
      if (result.reason === "locked") { res.status(423).json({ error: "Too many incorrect codes — try again in a few minutes." }); return; }
      res.status(400).json({ error: "That code is invalid or expired." });
      return;
    }
    authClear(key);
    const user = userDao.byEmail(addr);
    if (!user) { res.status(400).json({ error: "That code is invalid or expired." }); return; }
    const reason = bannedReason(user.id);
    if (reason) { res.status(403).json({ error: reason, banned: true, reason }); return; }
    logAudit("auth_email_verified", { requestId: getAuditRequestId(req), userId: user.id, data: { ipHash: hashForAudit(req.ip), via: "code" } });
    fullAppResponse(res, { id: user.id, email: user.email });
  });

  r.post("/auth/verify/resend", async (req, res) => {
    const addr = String((req.body ?? {}).email ?? "").trim().toLowerCase();
    const key = `resend:${req.ip}:${addr}`;
    if (!emailVerifyEnabled()) {
      auditSkippedEmailDispatch(req as AuthedRequest, "resend", "feature_disabled");
    } else if (isLoopback(req.ip) || authAllowed(key)) {
      await dispatchVerificationEmail(req as AuthedRequest, addr, "resend");
    } else {
      auditSkippedEmailDispatch(req as AuthedRequest, "resend", "rate_limited");
    }
    res.json({ ok: true });
  });

  r.post("/auth/forgot", async (req, res) => {
    const addr = String((req.body ?? {}).email ?? "").trim().toLowerCase();
    if (!passwordResetEnabled()) {
      res.status(501).json({ error: "Password reset isn't available on this server — contact the operator." });
      return;
    }
    const key = `forgot:${req.ip}:${addr}`;
    const sourceKey = `forgot:${req.ip}`;
    if (isLoopback(req.ip) || (authAllowed(key) && authAllowed(sourceKey))) {
      await dispatchResetEmail(req as AuthedRequest, addr);
    } else {
      logAudit("auth_reset_dispatch", {
        level: "info",
        requestId: getAuditRequestId(req),
        data: { kind: "password_reset", provider: "resend", outcome: "skipped", reason: "rate_limited" },
      });
    }
    res.json({ ok: true });
  });

  r.post("/auth/reset", async (req, res) => {
    const { email, code, password } = req.body ?? {};
    const addr = String(email ?? "").trim().toLowerCase();
    const key = `reset:${req.ip}:${addr}`;
    if (rateLimited(req, res, key)) return;
    const result = await completePasswordReset(addr, String(code ?? ""), String(password ?? ""));
    if (!result.ok) {
      if (result.reason === "locked") { res.status(423).json({ error: "Too many incorrect codes — try again in a few minutes." }); return; }
      if (result.reason === "weak_password") { res.status(400).json({ error: "password must be at least 8 characters" }); return; }
      logAudit("auth_password_reset_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason: "invalid_code", ipHash: hashForAudit(req.ip) } });
      res.status(400).json({ error: "That code is invalid or expired." });
      return;
    }
    authClear(key);
    const dropped = await disposeUserRuntimesEverywhere(result.userId);
    logAudit("auth_password_reset", { requestId: getAuditRequestId(req), userId: result.userId, data: { ipHash: hashForAudit(req.ip), runtimesDropped: dropped } });
    fullAppResponse(res, { id: result.userId, email: result.email });
  });

  r.get("/me", requireAuth, (req: AuthedRequest, res) => {
    const pending = emailVerifyEnabled() && userDao.emailVerifiedState(req.user!.id) === 0;
    res.json({ user: { ...req.user, isAdmin: isAdminEmail(req.user!.email), hasPassword: userHasPassword(req.user!.id), emailVerificationPending: pending } });
  });

  r.post("/auth/change-password", requireAuth, async (req: AuthedRequest, res) => {
    const key = `chpw:${req.user!.id}`;
    if (rateLimited(req, res, key)) return;
    const { currentPassword, newPassword, stepupToken } = req.body ?? {};
    try {
      const setup =
        typeof stepupToken === "string" && stepupToken
          ? verifyPasswordSetupToken(stepupToken, req.user!.id) ?? undefined
          : undefined;
      await changePassword(req.user!.id, String(currentPassword ?? ""), String(newPassword ?? ""), setup);
      authClear(key);
      const dropped = await disposeUserRuntimesEverywhere(req.user!.id);
      logAudit("auth_password_changed", { requestId: getAuditRequestId(req), userId: req.user!.id, data: { ipHash: hashForAudit(req.ip), runtimesDropped: dropped } });
      res.json({ ok: true, token: issueToken(req.user!) });
    } catch (e) {
      logAudit("auth_password_change_failed", {
        level: "warn",
        requestId: getAuditRequestId(req),
        userId: req.user!.id,
        data: { reason: e instanceof Error ? e.message : "change failed" },
      });
      res.status(400).json({ error: e instanceof Error ? e.message : "change failed" });
    }
  });

  r.get("/auth/config", (_req, res) => {
    res.json({ github: githubConfigured(), google: googleConfigured() });
  });

  r.get("/auth/github", (req: AuthedRequest, res) => {
    if (!githubConfigured()) {
      res.redirect(`/auth/login?auth_error=${encodeURIComponent("github_not_configured")}`);
      return;
    }
    const redirectUri = `${publicOrigin(req)}/api/auth/github/callback`;
    res.redirect(githubAuthorizeUrl(redirectUri));
  });

  r.get("/auth/github/stepup", requireAuth, (req: AuthedRequest, res) => {
    if (rateLimited(req, res, `ghstepup:${req.user!.id}`)) return;
    if (!githubConfigured()) {
      res.status(400).json({ error: "github_not_configured" });
      return;
    }
    const row = userDao.byId(req.user!.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (row.password_hash) {
      res.status(400).json({ error: "account already has a password — use the current-password flow" });
      return;
    }
    if (!row.github_id) {
      res.status(400).json({ error: "this account isn't linked to GitHub and can't set a password" });
      return;
    }
    res.json({ url: githubStepupAuthorizeUrl(`${publicOrigin(req)}/api/auth/github/callback`, row) });
  });

  r.get("/auth/github/callback", async (req: AuthedRequest, res) => {
    const code = String(req.query.code ?? "");
    const parsed = parseOAuthState(String(req.query.state ?? ""));
    const errParam = parsed?.k === "gh_stepup" ? "pw_error" : "auth_error";
    if (!githubConfigured() || !code || !parsed) {
      const reason = !githubConfigured() ? "not_configured" : !code ? "missing_code" : "invalid_state";
      logAudit("auth_github_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason } });
      const path = errParam === "pw_error" ? "/settings" : "/auth/login";
      res.redirect(`${path}?${errParam}=${encodeURIComponent("github_failed")}`);
      return;
    }
    if (parsed.k === "gh_stepup" && !isLoopback(req.ip) && !authAllowed(`ghstepupcb:${req.ip}`)) {
      res.redirect(`/settings?pw_error=${encodeURIComponent("rate_limited")}`);
      return;
    }
    try {
      const profile = await githubExchange(code, `${publicOrigin(req)}/api/auth/github/callback`);
      if (parsed.k === "gh_stepup") {
        const row = userDao.byId(parsed.uid);
        const ok =
          row &&
          !row.password_hash &&
          row.github_id === parsed.gh &&
          (row.password_changed_at ?? 0) === parsed.pwc &&
          profile.id === row.github_id;
        if (!ok) {
          logAudit("auth_stepup_failed", { level: "warn", requestId: getAuditRequestId(req), data: { githubIdHash: hashForAudit(profile.id) } });
          res.redirect(`/settings?pw_error=${encodeURIComponent("github_stepup_failed")}`);
          return;
        }
        logAudit("auth_stepup_success", { requestId: getAuditRequestId(req), userId: row.id, data: { githubIdHash: hashForAudit(profile.id) } });
        res.redirect(`/settings?pw_setup=${encodeURIComponent(issuePasswordSetupToken(row))}`);
        return;
      }
      if (parsed.k !== "gh_oauth") {
        res.redirect(`/auth/login?auth_error=${encodeURIComponent("github_failed")}`);
        return;
      }
      const user = githubUpsert(profile);
      if (bannedReason(user.id)) {
        logAudit("auth_github_banned", { level: "warn", requestId: getAuditRequestId(req), userId: user.id, data: { githubIdHash: hashForAudit(profile.id) } });
        res.redirect(`/?banned=1`);
        return;
      }
      logAudit("auth_github_success", { requestId: getAuditRequestId(req), userId: user.id, data: { githubIdHash: hashForAudit(profile.id) } });
      res.redirect(`/?gh_token=${encodeURIComponent(issueToken(user))}`);
    } catch (e) {
      console.error("[auth] github callback failed:", e instanceof Error ? e.message : e);
      logAudit("auth_github_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason: e instanceof Error ? e.message : "github_failed" } });
      const path = errParam === "pw_error" ? "/settings" : "/auth/login";
      res.redirect(`${path}?${errParam}=${encodeURIComponent("github_failed")}`);
    }
  });

  r.get("/auth/google", (req: AuthedRequest, res) => {
    if (!googleConfigured()) {
      res.redirect(`/auth/login?auth_error=${encodeURIComponent("google_not_configured")}`);
      return;
    }
    const redirectUri = `${publicOrigin(req)}/api/auth/google/callback`;
    res.redirect(googleAuthorizeUrl(redirectUri));
  });

  r.get("/auth/stepup", requireAuth, (req: AuthedRequest, res) => {
    if (rateLimited(req, res, `stepup:${req.user!.id}`)) return;
    const row = userDao.byId(req.user!.id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (row.password_hash) {
      res.status(400).json({ error: "account already has a password — use the current-password flow" });
      return;
    }
    if (row.github_id && githubConfigured()) {
      res.json({ url: githubStepupAuthorizeUrl(`${publicOrigin(req)}/api/auth/github/callback`, row) });
      return;
    }
    if (row.google_id && googleConfigured()) {
      res.json({ url: googleStepupAuthorizeUrl(`${publicOrigin(req)}/api/auth/google/callback`, row) });
      return;
    }
    res.status(400).json({ error: "this account isn't linked to a configured OAuth provider and can't set a password" });
  });

  r.get("/auth/google/callback", async (req: AuthedRequest, res) => {
    const code = String(req.query.code ?? "");
    const parsed = parseOAuthState(String(req.query.state ?? ""));
    const errParam = parsed?.k === "g_stepup" ? "pw_error" : "auth_error";
    if (!googleConfigured() || !code || !parsed) {
      const reason = !googleConfigured() ? "not_configured" : !code ? "missing_code" : "invalid_state";
      logAudit("auth_google_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason } });
      const path = errParam === "pw_error" ? "/settings" : "/auth/login";
      res.redirect(`${path}?${errParam}=${encodeURIComponent("google_failed")}`);
      return;
    }
    if (parsed.k === "g_stepup" && !isLoopback(req.ip) && !authAllowed(`gstepupcb:${req.ip}`)) {
      res.redirect(`/settings?pw_error=${encodeURIComponent("rate_limited")}`);
      return;
    }
    try {
      const profile = await googleExchange(code, `${publicOrigin(req)}/api/auth/google/callback`);
      if (parsed.k === "g_stepup") {
        const row = userDao.byId(parsed.uid);
        const ok =
          row &&
          !row.password_hash &&
          row.google_id === parsed.gh &&
          (row.password_changed_at ?? 0) === parsed.pwc &&
          profile.id === row.google_id;
        if (!ok) {
          logAudit("auth_stepup_failed", { level: "warn", requestId: getAuditRequestId(req), data: { googleIdHash: hashForAudit(profile.id) } });
          res.redirect(`/settings?pw_error=${encodeURIComponent("google_stepup_failed")}`);
          return;
        }
        logAudit("auth_stepup_success", { requestId: getAuditRequestId(req), userId: row.id, data: { googleIdHash: hashForAudit(profile.id) } });
        res.redirect(`/settings?pw_setup=${encodeURIComponent(issuePasswordSetupToken(row, "g"))}`);
        return;
      }
      if (parsed.k !== "g_oauth") {
        res.redirect(`/auth/login?auth_error=${encodeURIComponent("google_failed")}`);
        return;
      }
      const user = googleUpsert(profile);
      if (bannedReason(user.id)) {
        logAudit("auth_google_banned", { level: "warn", requestId: getAuditRequestId(req), userId: user.id, data: { googleIdHash: hashForAudit(profile.id) } });
        res.redirect(`/?banned=1`);
        return;
      }
      logAudit("auth_google_success", { requestId: getAuditRequestId(req), userId: user.id, data: { googleIdHash: hashForAudit(profile.id) } });
      res.redirect(`/?auth_token=${encodeURIComponent(issueToken(user))}`);
    } catch (e) {
      console.error("[auth] google callback failed:", e instanceof Error ? e.message : e);
      logAudit("auth_google_failed", { level: "warn", requestId: getAuditRequestId(req), data: { reason: e instanceof Error ? e.message : "google_failed" } });
      const path = errParam === "pw_error" ? "/settings" : "/auth/login";
      res.redirect(`${path}?${errParam}=${encodeURIComponent("google_failed")}`);
    }
  });
}
