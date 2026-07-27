import assert from "node:assert";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "evtest-"));
process.env.AGENT_WEB_RESEND_KEY = "test_key";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.test>";

const { userDao } = await import("../server/src/persistence/index.ts");
const ev = await import("../server/src/identity/email-verify.ts");
const { signup } = await import("../server/src/identity/auth.ts");

for (const bad of ["a@proton.me", "b@protonmail.com", "c@mailinator.com", "d@sub.tutanota.com", "e@10minutemail.com"])
  assert.throws(() => ev.assertAllowedEmailDomain(bad), /mainstream/, `must block ${bad}`);
for (const ok of ["a@gmail.com", "b@qq.com", "c@163.com", "d@outlook.com", "e@icloud.com", "f@foxmail.com", "g@163.net"])
  assert.doesNotThrow(() => ev.assertAllowedEmailDomain(ok), `must allow ${ok}`);
for (const niche of ["a@randomcorp.io", "b@my-startup.dev", "c@duck.com"])
  assert.throws(() => ev.assertAllowedEmailDomain(niche), /mainstream/, `allowlist must reject ${niche}`);
for (const bad of ["a@gmail.com@proton.me", "x@@gmail.com", "noatsign"])
  assert.throws(() => ev.assertAllowedEmailDomain(bad), /invalid email|mainstream/, `must reject malformed ${bad}`);
console.log("  OK domain policy (allowlist: mainstream + edu allowed, privacy/disposable/niche rejected)");

await assert.rejects(signup("x@proton.me", "password123"), /mainstream/, "signup must reject proton.me");
console.log("  OK signup rejects privacy domain");

assert.equal(ev.emailVerifyEnabled(), true, "enabled when RESEND_KEY+EMAIL_FROM set");

const u = await signup("real@gmail.com", "password123", { requireEmailVerification: true });
assert.equal(userDao.emailVerifiedState(u.id), 0, "pending is durable in the account insert");
const prepared = await ev.prepareVerificationEmail(u.email);
assert.equal(prepared.status, "ready", "pending user reserves one verification dispatch");
if (prepared.status !== "ready") throw new Error("verification preparation unexpectedly skipped");
const raw = prepared.token;
assert.equal(userDao.emailVerifiedState(u.id), 0, "pending after pair preparation");
assert.equal(ev.execBlockedForVerification(u.id), true, "pending user is exec-blocked");

assert.equal(ev.consumeVerifyToken("bogus-token"), null, "bad token rejected");
const verifiedEmail = ev.consumeVerifyToken(raw);
assert.equal(verifiedEmail, "real@gmail.com", "valid token verifies + returns email");
assert.equal(userDao.emailVerifiedState(u.id), 1, "verified after consume");
assert.equal(ev.execBlockedForVerification(u.id), false, "verified user not blocked");
assert.equal(ev.consumeVerifyToken(raw), null, "token is single-use (cleared on verify)");
console.log("  OK magic-link token round-trip + single-use + exec gating");

const legacy: any = { id: "u_legacy", email: "old@gmail.com", password_hash: "x", created_at: Date.now() };
userDao.create(legacy);
assert.equal(userDao.emailVerifiedState("u_legacy"), null, "legacy user is NULL state");
assert.equal(ev.execBlockedForVerification("u_legacy"), false, "legacy (NULL) user is NOT blocked");
console.log("  OK legacy NULL-state users are grandfathered (not blocked)");

console.log("all email-verify checks passed");
