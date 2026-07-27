import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "verifyflow-"));
process.env.AGENT_WEB_RESEND_KEY = "test_key";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.test>";

const { userDao } = await import("../server/src/persistence/index.ts");
const ev = await import("../server/src/identity/email-verify.ts");
const { signup } = await import("../server/src/identity/auth.ts");

const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");
async function prepare(email: string) {
  const result = await ev.prepareVerificationEmail(email);
  assert.equal(result.status, "ready", `verification prepared for ${email}`);
  if (result.status !== "ready") throw new Error(`verification preparation skipped: ${result.reason}`);
  return result;
}

const u = await signup("vf-a@gmail.com", "password123", { requireEmailVerification: true });
assert.equal(ev.execBlockedForVerification(u.id), true, "pending is durable before pair generation");
const { code } = await prepare(u.email);
assert.match(code, /^\d{6}$/, "code is 6 digits");
assert.equal(ev.execBlockedForVerification(u.id), true, "pending (0) → exec-blocked");
assert.deepEqual(
  await ev.prepareVerificationEmail(u.email),
  { status: "skipped", userId: u.id, reason: "throttled" },
  "resend throttled immediately after issue",
);

const w = wrongOf(code);
for (let i = 1; i <= 4; i++) {
  const r = await ev.consumeVerifyCode("vf-a@gmail.com", w);
  assert.deepEqual(r, { ok: false, reason: "invalid" }, `attempt ${i} → invalid`);
}
const fifth = await ev.consumeVerifyCode("vf-a@gmail.com", w);
assert.deepEqual(fifth, { ok: false, reason: "locked" }, "5th wrong → locked");
assert.deepEqual(await ev.consumeVerifyCode("vf-a@gmail.com", code), { ok: false, reason: "locked" }, "correct code refused during lockout");
console.log("  OK wrong-code attempts → lockout (correct code refused while locked)");

const u2 = await signup("vf-b@gmail.com", "password123", { requireEmailVerification: true });
const { code: code2 } = await prepare(u2.email);
assert.deepEqual(await ev.consumeVerifyCode("vf-b@gmail.com", code2), { ok: true }, "correct code verifies");
assert.equal(ev.execBlockedForVerification(u2.id), false, "verified → not blocked");
assert.deepEqual(await ev.consumeVerifyCode("vf-b@gmail.com", code2), { ok: false, reason: "invalid" }, "code is single-use (cleared on verify)");
console.log("  OK correct code verifies + single-use");

const u3 = await signup("vf-c@gmail.com", "password123", { requireEmailVerification: true });
const { token } = await prepare(u3.email);
assert.equal(ev.consumeVerifyToken("bogus"), null, "bad token rejected");
assert.equal(ev.consumeVerifyToken(token), "vf-c@gmail.com", "valid magic-link token verifies + returns email");
assert.equal(ev.execBlockedForVerification(u3.id), false, "verified via link → not blocked");
assert.equal(ev.consumeVerifyToken(token), null, "magic-link token single-use");
console.log("  OK magic-link token verifies + single-use");

assert.deepEqual(await ev.consumeVerifyCode("vf-b@gmail.com", "12ab"), { ok: false, reason: "invalid" }, "non-6-digit code rejected");
console.log("  OK malformed code rejected");

const legacy = await signup("vf-legacy@gmail.com", "password123");
assert.equal(ev.execBlockedForVerification(legacy.id), false, "legacy NULL-state user not blocked");

console.log("all verify-flow checks passed");
