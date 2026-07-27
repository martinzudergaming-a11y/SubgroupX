import assert from "node:assert/strict";
import {
  googleConfigured,
  googleAuthorizeUrl,
  googleStepupAuthorizeUrl,
  googleExchange,
  googleUpsert,
  githubUpsert,
  parseOAuthState,
  issuePasswordSetupToken,
  verifyPasswordSetupToken,
  changePassword,
  userHasPassword,
} from "../server/src/identity/auth.ts";
import { userDao } from "../server/src/persistence/index.ts";
import jwt from "jsonwebtoken";

process.env.AGENT_WEB_GOOGLE_CLIENT_ID = "test-client";
process.env.AGENT_WEB_GOOGLE_SECRET = "test-secret";

assert.equal(googleConfigured(), true);
const url = new URL(googleAuthorizeUrl("https://app.example.invalid/api/auth/google/callback"));
assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
assert.equal(url.searchParams.get("response_type"), "code");
assert.equal(url.searchParams.get("scope"), "openid email");
const state = parseOAuthState(url.searchParams.get("state")!);
assert.deepEqual(state, { k: "g_oauth" }, "signed login state round-trips");

const fakeIdToken = (claims: Record<string, unknown>) => jwt.sign(claims, "google-side-secret");
const origFetch = globalThis.fetch;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const body = String(init?.body ?? "");
  assert.ok(body.includes("grant_type=authorization_code"), "token request is form-encoded code exchange");
  return new Response(JSON.stringify({ id_token: fakeIdToken({ sub: "g-sub-1", email: "User.Name+tag@GMAIL.com", email_verified: true }) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
const profile = await googleExchange("code123", "https://app.example.invalid/cb");
assert.deepEqual(profile, { id: "g-sub-1", email: "user.name+tag@gmail.com" }, "sub + lowercased email from the id_token");

globalThis.fetch = (async () =>
  new Response(JSON.stringify({ id_token: fakeIdToken({ sub: "g-sub-2", email: "squat@gmail.com", email_verified: false }) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
await assert.rejects(() => googleExchange("code", "https://cb"), /unverified/, "unverified Google email must never link accounts");
globalThis.fetch = origFetch;

const gh = githubUpsert({ id: "gh-9001", login: "octo", email: "linkme@gmail.com" });
const viaGoogle = googleUpsert({ id: "g-sub-3", email: "link.me+google@gmail.com" });
assert.equal(viaGoogle.id, gh.id, "Gmail-canonical alias links the Google identity to the SAME account");
assert.equal(userDao.byId(gh.id)?.google_id, "g-sub-3");
assert.equal(userDao.byId(gh.id)?.github_id, "gh-9001", "both identities coexist on one account");
const again = googleUpsert({ id: "g-sub-3", email: "whatever@else.invalid" });
assert.equal(again.id, gh.id, "repeat sign-in resolves by google_id before any email logic");

const fresh = googleUpsert({ id: "g-sub-4", email: "solo@example.invalid" });
assert.equal(userHasPassword(fresh.id), false, "OAuth-only account starts passwordless");
const freshRow = userDao.byId(fresh.id)!;
const proof = verifyPasswordSetupToken(issuePasswordSetupToken(freshRow, "g"), fresh.id);
assert.ok(proof && proof.op === "g" && proof.gh === "g-sub-4", "proof binds the google_id under op:g");
await changePassword(fresh.id, "", "a-strong-password", proof!);
assert.equal(userHasPassword(fresh.id), true, "Google step-up proof enrolls a first password");

const solo2 = googleUpsert({ id: "g-sub-5", email: "solo2@example.invalid" });
const wrongProvider = verifyPasswordSetupToken(issuePasswordSetupToken(userDao.byId(solo2.id)!, "gh"), solo2.id);
await assert.rejects(
  () => changePassword(solo2.id, "", "another-strong-pass", wrongProvider ?? undefined),
  /verification required|cannot set a password/,
  "a gh-flavored proof cannot enroll a password on a Google-only account",
);

const stepupState = parseOAuthState(
  new URL(googleStepupAuthorizeUrl("https://cb", userDao.byId(solo2.id)!)).searchParams.get("state")!,
);
assert.deepEqual(stepupState, { k: "g_stepup", uid: solo2.id, gh: "g-sub-5", pwc: 0 });

console.log("check-google-auth: OIDC seam, alias linking and step-up proofs hold");
