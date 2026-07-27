import crypto from "node:crypto";
import { errorMessage } from "../foundation/errors.ts";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { JWT_SECRET, KEY_ENC_SECRET } from "../config.ts";
import { userDao, type UserRow } from "../persistence/index.ts";
import { assertAllowedEmailDomain } from "./email-verify.ts";

export interface AuthedUser {
  id: string;
  email: string;
  passwordChangedAt?: number;
}

export function isGmailDomain(domain: string): boolean {
  return domain === "gmail.com" || domain === "googlemail.com";
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

export function canonicalizeEmailForUniqueness(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return email;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (isGmailDomain(domain)) {
    const plusIdx = local.indexOf("+");
    if (plusIdx !== -1) local = local.slice(0, plusIdx);
    local = local.replace(/\./g, "");
    if (local.length === 0) return null;
    return `${local}@gmail.com`;
  }
  return email;
}

export async function signup(
  email: string,
  password: string,
  options: { requireEmailVerification?: boolean } = {},
): Promise<AuthedUser> {
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("invalid email");
  assertAllowedEmailDomain(email);
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  if (password.length > 200) throw new Error("password is too long");
  if (userDao.byEmail(email)) throw new Error("email already registered");
  let canonicalEmail: string | null = null;
  if (isGmailDomain(emailDomain(email))) {
    const canonical = canonicalizeEmailForUniqueness(email);
    if (canonical === null) throw new Error("invalid email");
    if (userDao.byCanonicalEmail(canonical)) throw new Error("email already registered");
    canonicalEmail = canonical;
  }
  const row: UserRow = {
    id: "u_" + crypto.randomUUID(),
    email,
    canonical_email: canonicalEmail,
    password_hash: await bcrypt.hash(password, 10),
    created_at: Date.now(),
    email_verified: options.requireEmailVerification ? 0 : null,
  };
  try {
    userDao.create(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error("email already registered");
    throw e;
  }
  return { id: row.id, email: row.email };
}

function isUniqueViolation(e: unknown): boolean {
  const msg = errorMessage(e);
  return /UNIQUE constraint failed/i.test(msg);
}

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("oiia-dummy-not-a-real-password", 10);

export async function login(email: string, password: string): Promise<AuthedUser> {
  email = email.trim().toLowerCase();
  const row = userDao.byEmail(email);
  const ok = await bcrypt.compare(password, row?.password_hash || DUMMY_PASSWORD_HASH);
  if (!row || !ok) throw new Error("invalid credentials");
  return { id: row.id, email: row.email };
}

export function issueToken(user: AuthedUser): string {
  const pwc = userDao.byId(user.id)?.password_changed_at ?? 0;
  return jwt.sign({ sub: user.id, email: user.email, pwc }, JWT_SECRET, { expiresIn: "7d" });
}

export const FILE_PREVIEW_TOKEN_TTL_SECONDS = 30 * 60;
export const FILE_PREVIEW_FULL_TOKEN_TTL_SECONDS = 60;

export type FilePreviewMode = "range" | "media" | "full";

export interface FilePreviewClaims {
  userId: string;
  sessionId: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  version: string;
  backendVersion: string;
  mimeType: string;
  nonce: string;
  mode: FilePreviewMode;
}

export function issueFilePreviewToken(claims: FilePreviewClaims): string {
  const pwc = userDao.byId(claims.userId)?.password_changed_at ?? 0;
  return jwt.sign({
    k: "file_preview",
    uid: claims.userId,
    sid: claims.sessionId,
    path: claims.path,
    name: claims.name,
    size: claims.size,
    mtime: claims.modifiedAt,
    ver: claims.version,
    backend: claims.backendVersion,
    mime: claims.mimeType,
    nonce: claims.nonce,
    mode: claims.mode,
    pwc,
  }, JWT_SECRET, {
    expiresIn: claims.mode === "full" ? FILE_PREVIEW_FULL_TOKEN_TTL_SECONDS : FILE_PREVIEW_TOKEN_TTL_SECONDS,
  });
}

export function verifyFilePreviewToken(token: string, nonce: string): FilePreviewClaims | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    if (
      payload.k !== "file_preview" || payload.nonce !== nonce ||
      typeof payload.uid !== "string" || typeof payload.sid !== "string" ||
      typeof payload.path !== "string" || typeof payload.name !== "string" ||
      typeof payload.size !== "number" || !Number.isSafeInteger(payload.size) || payload.size < 0 ||
      typeof payload.mtime !== "number" || !Number.isSafeInteger(payload.mtime) || payload.mtime < 0 ||
      typeof payload.ver !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(payload.ver) ||
      typeof payload.backend !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.backend) ||
      typeof payload.mime !== "string" ||
      (payload.mode !== undefined && payload.mode !== "range" && payload.mode !== "media" && payload.mode !== "full")
    ) return null;
    const row = userDao.byId(payload.uid);
    if (!row || (payload.pwc ?? 0) !== (row.password_changed_at ?? 0)) return null;
    return {
      userId: payload.uid,
      sessionId: payload.sid,
      path: payload.path,
      name: payload.name,
      size: payload.size,
      modifiedAt: payload.mtime,
      version: payload.ver,
      backendVersion: payload.backend,
      mimeType: payload.mime,
      nonce,
      mode: payload.mode === "range" || payload.mode === "media" || payload.mode === "full"
        ? payload.mode
        : payload.mime === "application/pdf" ? "range" : "media",
    };
  } catch {
    return null;
  }
}

export function verifyToken(token: string): AuthedUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string; email?: string; pwc?: number; k?: string };
    if (payload.k !== undefined) return null;
    const row = payload.sub ? userDao.byId(payload.sub) : undefined;
    if (!row) return null;
    if ((payload.pwc ?? 0) !== (row.password_changed_at ?? 0)) return null;
    return { id: row.id, email: row.email, passwordChangedAt: row.password_changed_at ?? 0 };
  } catch {
    return null;
  }
}

export function authEpochIsCurrent(user: AuthedUser): boolean {
  if (user.passwordChangedAt === undefined) return false;
  return (userDao.byId(user.id)?.password_changed_at ?? 0) === user.passwordChangedAt;
}

export function userHasPassword(userId: string): boolean {
  return Boolean(userDao.byId(userId)?.password_hash);
}

export interface StepUpProof {
  gh: string;
  op?: "gh" | "g";
  pwc: number;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  setup?: StepUpProof,
): Promise<void> {
  const row = userDao.byId(userId);
  if (!row) throw new Error("user not found");
  if (row.password_hash) {
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) throw new Error("current password is incorrect");
  } else {
    if (!row.github_id && !row.google_id) throw new Error("this account cannot set a password");
    const linkedId = setup?.op === "g" ? row.google_id : row.github_id;
    if (!setup || !linkedId || setup.gh !== linkedId || setup.pwc !== (row.password_changed_at ?? 0)) {
      throw new Error("identity verification required");
    }
  }
  if (newPassword.length < 8) throw new Error("password must be at least 8 characters");
  if (newPassword.length > 200) throw new Error("password is too long");
  const hash = await bcrypt.hash(newPassword, 10);
  const stamp = Math.max(Date.now(), (row.password_changed_at ?? 0) + 1);
  const applied = userDao.updatePassword(userId, hash, stamp, {
    passwordHash: row.password_hash,
    pwc: row.password_changed_at ?? 0,
  });
  if (!applied) throw new Error("password changed concurrently — please retry");
}

export function githubConfigured(): boolean {
  return Boolean(process.env.AGENT_WEB_GITHUB_CLIENT_ID && process.env.AGENT_WEB_GITHUB_SECRET);
}

export function githubAuthorizeUrl(redirectUri: string): string {
  const state = jwt.sign({ k: "gh_oauth", n: crypto.randomBytes(8).toString("hex") }, JWT_SECRET, {
    expiresIn: "10m",
  });
  const params = new URLSearchParams({
    client_id: process.env.AGENT_WEB_GITHUB_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export type OAuthState =
  | { k: "gh_oauth" }
  | { k: "gh_stepup"; uid: string; gh: string; pwc: number }
  | { k: "g_oauth" }
  | { k: "g_stepup"; uid: string; gh: string; pwc: number };

export function parseOAuthState(state: string): OAuthState | null {
  try {
    const p = jwt.verify(state, JWT_SECRET) as { k?: string; uid?: string; gh?: string; pwc?: number };
    if (p.k === "gh_oauth") return { k: "gh_oauth" };
    if (p.k === "g_oauth") return { k: "g_oauth" };
    if ((p.k === "gh_stepup" || p.k === "g_stepup") && typeof p.uid === "string" && typeof p.gh === "string") {
      return { k: p.k, uid: p.uid, gh: p.gh, pwc: typeof p.pwc === "number" ? p.pwc : 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export function githubStepupAuthorizeUrl(redirectUri: string, row: UserRow): string {
  const state = jwt.sign(
    { k: "gh_stepup", uid: row.id, gh: row.github_id, pwc: row.password_changed_at ?? 0, n: crypto.randomBytes(8).toString("hex") },
    JWT_SECRET,
    { expiresIn: "10m" },
  );
  const params = new URLSearchParams({
    client_id: process.env.AGENT_WEB_GITHUB_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function issuePasswordSetupToken(row: UserRow, provider: "gh" | "g" = "gh"): string {
  return jwt.sign(
    {
      k: "pw_setup",
      uid: row.id,
      gh: provider === "g" ? row.google_id : row.github_id,
      op: provider,
      pwc: row.password_changed_at ?? 0,
      n: crypto.randomBytes(8).toString("hex"),
    },
    JWT_SECRET,
    { expiresIn: "10m" },
  );
}

export function verifyPasswordSetupToken(token: string, userId: string): StepUpProof | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as { k?: string; uid?: string; gh?: string; op?: string; pwc?: number };
    if (p.k !== "pw_setup" || p.uid !== userId || typeof p.gh !== "string") return null;
    return { gh: p.gh, op: p.op === "g" ? "g" : "gh", pwc: typeof p.pwc === "number" ? p.pwc : 0 };
  } catch {
    return null;
  }
}

interface GithubProfile {
  id: string;
  login: string;
  email: string;
}

export async function githubExchange(code: string, redirectUri: string): Promise<GithubProfile> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.AGENT_WEB_GITHUB_CLIENT_ID,
      client_secret: process.env.AGENT_WEB_GITHUB_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  const token = tokenJson.access_token;
  if (!token) throw new Error(tokenJson.error || "github token exchange failed");
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "oiia" };
  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error("github user fetch failed");
  const u = (await userRes.json()) as { id: number; login: string; email: string | null };
  let email = u.email;
  if (!email) {
    try {
      const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0])?.email ?? null;
      }
    } catch {
    }
  }
  return { id: String(u.id), login: u.login, email: email || `${u.login}@users.noreply.github.com` };
}

export function githubUpsert(profile: GithubProfile): AuthedUser {
  const existing = userDao.byGithubId(profile.id);
  if (existing) return { id: existing.id, email: existing.email };
  const email = profile.email.toLowerCase();
  const isGmail = isGmailDomain(emailDomain(email));
  const canonical = isGmail ? canonicalizeEmailForUniqueness(email) : null;
  const findLinked = () => userDao.byEmail(email) || (canonical ? userDao.byCanonicalEmail(canonical) : undefined);
  const linked = findLinked();
  if (linked) {
    userDao.linkGithub(linked.id, profile.id);
    userDao.markVerified(linked.id);
    return { id: linked.id, email: linked.email };
  }
  const row: UserRow = {
    id: "u_" + crypto.randomUUID(),
    email,
    canonical_email: canonical,
    password_hash: "",
    created_at: Date.now(),
    github_id: profile.id,
  };
  try {
    userDao.create(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const raced = findLinked();
      if (raced) {
        userDao.linkGithub(raced.id, profile.id);
        userDao.markVerified(raced.id);
        return { id: raced.id, email: raced.email };
      }
    }
    throw e;
  }
  userDao.markVerified(row.id);
  return { id: row.id, email: row.email };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.AGENT_WEB_GOOGLE_CLIENT_ID && process.env.AGENT_WEB_GOOGLE_SECRET);
}

export function googleAuthorizeUrl(redirectUri: string): string {
  const state = jwt.sign({ k: "g_oauth", n: crypto.randomBytes(8).toString("hex") }, JWT_SECRET, {
    expiresIn: "10m",
  });
  const params = new URLSearchParams({
    client_id: process.env.AGENT_WEB_GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function googleStepupAuthorizeUrl(redirectUri: string, row: UserRow): string {
  const state = jwt.sign(
    { k: "g_stepup", uid: row.id, gh: row.google_id, pwc: row.password_changed_at ?? 0, n: crypto.randomBytes(8).toString("hex") },
    JWT_SECRET,
    { expiresIn: "10m" },
  );
  const params = new URLSearchParams({
    client_id: process.env.AGENT_WEB_GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface GoogleProfile {
  id: string;
  email: string;
}

export async function googleExchange(code: string, redirectUri: string): Promise<GoogleProfile> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AGENT_WEB_GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.AGENT_WEB_GOOGLE_SECRET ?? "",
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const tokenJson = (await tokenRes.json()) as { id_token?: string; error?: string };
  if (!tokenJson.id_token) throw new Error(tokenJson.error || "google token exchange failed");
  const payload = jwt.decode(tokenJson.id_token) as { sub?: string; email?: string; email_verified?: boolean } | null;
  if (!payload?.sub || !payload.email) throw new Error("google id_token missing identity");
  if (payload.email_verified === false) throw new Error("google account email is unverified");
  return { id: payload.sub, email: payload.email.toLowerCase() };
}

export function googleUpsert(profile: GoogleProfile): AuthedUser {
  const existing = userDao.byGoogleId(profile.id);
  if (existing) return { id: existing.id, email: existing.email };
  const email = profile.email;
  const isGmail = isGmailDomain(emailDomain(email));
  const canonical = isGmail ? canonicalizeEmailForUniqueness(email) : null;
  const findLinked = () => userDao.byEmail(email) || (canonical ? userDao.byCanonicalEmail(canonical) : undefined);
  const linked = findLinked();
  if (linked) {
    userDao.linkGoogle(linked.id, profile.id);
    userDao.markVerified(linked.id);
    return { id: linked.id, email: linked.email };
  }
  const row: UserRow = {
    id: "u_" + crypto.randomUUID(),
    email,
    canonical_email: canonical,
    password_hash: "",
    created_at: Date.now(),
    google_id: profile.id,
  };
  try {
    userDao.create(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const raced = findLinked();
      if (raced) {
        userDao.linkGoogle(raced.id, profile.id);
        userDao.markVerified(raced.id);
        return { id: raced.id, email: raced.email };
      }
    }
    throw e;
  }
  userDao.markVerified(row.id);
  return { id: row.id, email: row.email };
}

const ENC_KEY = crypto.createHash("sha256").update(KEY_ENC_SECRET).digest();

export function encryptKey(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decryptKey(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
