import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "auth-reset-flow-"));
process.env.AGENT_WEB_RESEND_KEY = "re_test_only";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.invalid>";
process.env.AGENT_WEB_PUBLIC_URL = "https://example.invalid";
process.env.AGENT_WEB_SECRET = "auth-reset-flow-secret-at-least-32-bytes";
process.env.AGENT_WEB_KEY_SECRET = "auth-reset-flow-key-secret-at-least-32";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

type ProviderCall = { to: string[]; subject: string; text: string };
const providerCalls: ProviderCall[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.resend.com/emails") return nativeFetch(input, init);
  providerCalls.push(JSON.parse(String(init?.body ?? "{}")) as ProviderCall);
  return new Response(JSON.stringify({ id: `email_${String(providerCalls.length).padStart(8, "0")}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const [{ registerAuthRoutes }, { auditHttpMiddleware }, persistence, auth] = await Promise.all([
  import("../server/src/http/routes/auth.ts"),
  import("../server/src/observability/audit-log.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/identity/auth.ts"),
]);
const { db, userDao } = persistence;

const app = express();
app.set("trust proxy", true);
const router = express.Router();
router.use(auditHttpMiddleware);
router.use(express.json());
registerAuthRoutes(router);
app.use("/api", router);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server has no TCP port");

type HttpResult = { status: number; raw: string; body: Record<string, unknown> };
function post(path: string, body: Record<string, unknown>, from?: string): Promise<HttpResult> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: `/api${path}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
        ...(from ? { "x-forwarded-for": from } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, raw, body: raw ? JSON.parse(raw) : {} });
      });
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

function resetEvents(): Array<{ user_id: string | null; data_json: string }> {
  return db.prepare(
    "SELECT user_id, data_json FROM audit_events WHERE event = 'auth_reset_dispatch' ORDER BY ts, rowid",
  ).all() as Array<{ user_id: string | null; data_json: string }>;
}
const lastReset = () => JSON.parse(resetEvents().at(-1)!.data_json) as Record<string, unknown>;
const codeFrom = (call: ProviderCall) => call.subject.match(/\b(\d{6})\b/)?.[1] ?? "";
const ageOutThrottle = (email: string) =>
  db.prepare("UPDATE users SET reset_sent_at = 0 WHERE email = ?").run(email);

try {
  const email = "resetme@outlook.com";
  const created = await auth.signup(email, "originalpw1");
  userDao.markVerified(created.id);

  const real = await post("/auth/forgot", { email });
  assert.equal(real.status, 200);
  assert.equal(providerCalls.length, 1, "a real account receives exactly one email");
  assert.match(providerCalls[0].subject, /password reset code/i);
  assert.deepEqual(providerCalls[0].to, [email]);
  assert.equal(lastReset().outcome, "accepted");
  assert.equal(lastReset().variant, "code");

  const unknown = await post("/auth/forgot", { email: "nobody-here@outlook.com" });
  assert.equal(unknown.status, 200);
  assert.equal(providerCalls.length, 1, "an unknown address sends nothing");
  assert.equal(lastReset().reason, "unknown_account");
  assert.equal(
    real.raw,
    unknown.raw,
    "a known and an unknown address must be byte-identical — the response is the enumeration oracle",
  );
  console.log("  OK forgot-password is non-enumerating (identical status + body)");

  for (const row of resetEvents()) {
    assert.ok(!row.data_json.includes("@"), `audit data must not carry an address: ${row.data_json}`);
    assert.ok(!row.data_json.includes("resetme"), "audit data must not carry a local part");
  }
  const code = codeFrom(providerCalls[0]);
  assert.match(code, /^\d{6}$/, "the transport observed a six-digit code");
  for (const row of resetEvents()) assert.ok(!row.data_json.includes(code), "the code must never be logged");
  console.log("  OK dispatch audit is PII-free and code-free");

  const throttled = await post("/auth/forgot", { email });
  assert.equal(providerCalls.length, 1, "a second request inside the window sends no second email");
  assert.equal(lastReset().reason, "throttled");
  assert.equal(throttled.raw, real.raw, "a throttled request is indistinguishable from a sent one");
  console.log("  OK per-account send throttle is silent");

  const weak = await post("/auth/reset", { email, code, password: "short" });
  assert.equal(weak.status, 400);
  assert.match(String(weak.body.error), /at least 8 characters/);
  assert.equal(
    userDao.resetStateByEmail(email)?.reset_attempts ?? 0,
    0,
    "a rejected password must not consume one of the five code attempts",
  );
  console.log("  OK a weak password costs no attempt");

  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 4; i++) {
    const r = await post("/auth/reset", { email, code: wrong, password: "brandnewpw1" });
    assert.equal(r.status, 400, `attempt ${i} is a plain rejection`);
    assert.equal(String(r.body.error), "That code is invalid or expired.", "failure text is uniform");
  }
  const fifth = await post("/auth/reset", { email, code: wrong, password: "brandnewpw1" });
  assert.equal(fifth.status, 423, "the fifth wrong code locks the record");
  const lockedOutWithTheRightCode = await post("/auth/reset", { email, code, password: "brandnewpw1" });
  assert.equal(lockedOutWithTheRightCode.status, 423, "even the CORRECT code is refused while locked");
  console.log("  OK code attempts are bounded and the lockout holds against the right code");

  const burstEmail = "burst-reset@outlook.com";
  const burstUser = await auth.signup(burstEmail, "originalpw1");
  userDao.markVerified(burstUser.id);
  await post("/auth/forgot", { email: burstEmail });
  const burstCode = codeFrom(providerCalls.at(-1)!);
  db.prepare("UPDATE users SET reset_attempts = 5, reset_locked_until = NULL WHERE email = ?").run(burstEmail);
  const overBudget = await post("/auth/reset", { email: burstEmail, code: burstCode, password: "burstwinnerpw1" });
  assert.equal(overBudget.status, 423, "an attempt slot past the budget is refused BEFORE the compare");
  await assert.rejects(auth.login(burstEmail, "burstwinnerpw1"), /invalid credentials/, "and it changed nothing");
  console.log("  OK an over-budget attempt is rejected before the code is even compared");

  db.prepare("UPDATE users SET reset_locked_until = 1 WHERE email = ?").run(email);
  const staleToken = auth.issueToken(created);
  assert.ok(auth.verifyToken(staleToken), "the pre-reset token is valid up to this point");

  const done = await post("/auth/reset", { email, code, password: "brandnewpw1" });
  assert.equal(done.status, 200);
  assert.equal(done.body.state, "FULL_APP");
  assert.ok(typeof done.body.token === "string" && done.body.token.length > 0, "the user is signed in, not sent back to a form");
  assert.ok(auth.verifyToken(String(done.body.token)), "the returned token works");
  assert.equal(auth.verifyToken(staleToken), null, "a reset invalidates every previously-issued token");
  console.log("  OK a completed reset signs the user in and logs out every other session");

  await assert.rejects(auth.login(email, "originalpw1"), /invalid credentials/, "the old password is dead");
  const back = await auth.login(email, "brandnewpw1");
  assert.equal(back.id, created.id, "the new password signs in as the same account");
  const replay = await post("/auth/reset", { email, code, password: "thirdpassword1" });
  assert.equal(replay.status, 400, "the code is single-use");
  assert.equal((await auth.login(email, "brandnewpw1")).id, created.id, "a replay changed nothing");
  const cleared = userDao.resetStateByEmail(email);
  assert.equal(cleared?.reset_code_hash, null, "the reset record is cleared on success");
  console.log("  OK the code is single-use and the reset record is cleared");

  const raceEmail = "race-reset@outlook.com";
  const raceUser = await auth.signup(raceEmail, "originalpw1");
  userDao.markVerified(raceUser.id);
  await post("/auth/forgot", { email: raceEmail });
  const raceCode = codeFrom(providerCalls.at(-1)!);
  const [a, b] = await Promise.all([
    post("/auth/reset", { email: raceEmail, code: raceCode, password: "racewinnerpw1" }),
    post("/auth/reset", { email: raceEmail, code: raceCode, password: "raceloserpw1" }),
  ]);
  const winners = [a, b].filter((r) => r.status === 200);
  assert.equal(winners.length, 1, "exactly one concurrent submission of the same code may win");
  const survivor = winners[0] === a ? "racewinnerpw1" : "raceloserpw1";
  const loser = survivor === "racewinnerpw1" ? "raceloserpw1" : "racewinnerpw1";
  assert.equal((await auth.login(raceEmail, survivor)).id, raceUser.id, "the winner's password is the one that took");
  await assert.rejects(auth.login(raceEmail, loser), /invalid credentials/, "the loser's password never landed");
  console.log("  OK a concurrent replay cannot overwrite the winning reset");

  ageOutThrottle(email);
  await post("/auth/forgot", { email });
  const secondCode = codeFrom(providerCalls.at(-1)!);
  db.prepare("UPDATE users SET reset_expires = 1 WHERE email = ?").run(email);
  const expired = await post("/auth/reset", { email, code: secondCode, password: "fourthpassword1" });
  assert.equal(expired.status, 400, "an expired code is refused");
  assert.equal((await auth.login(email, "brandnewpw1")).id, created.id, "an expired code changed nothing");
  console.log("  OK expiry is enforced");

  const pendingEmail = "pending-reset@outlook.com";
  const pending = await auth.signup(pendingEmail, "originalpw1", { requireEmailVerification: true });
  assert.equal(userDao.emailVerifiedState(pending.id), 0, "the account starts pending");
  await post("/auth/forgot", { email: pendingEmail });
  const pendingCode = codeFrom(providerCalls.at(-1)!);
  const recovered = await post("/auth/reset", { email: pendingEmail, code: pendingCode, password: "brandnewpw1" });
  assert.equal(recovered.body.state, "FULL_APP");
  assert.equal(
    userDao.emailVerifiedState(pending.id),
    1,
    "typing a code from that inbox proves ownership — the user must not land back on the verify screen",
  );
  console.log("  OK resetting a pending account also verifies it");

  const oauthEmail = "oauth-only@outlook.com";
  userDao.create({
    id: "u_oauth_reset_flow",
    email: oauthEmail,
    password_hash: "",
    github_id: "gh_reset_flow",
    email_verified: 1,
    created_at: Date.now(),
  });
  const callsBefore = providerCalls.length;
  const oauth = await post("/auth/forgot", { email: oauthEmail });
  assert.equal(providerCalls.length, callsBefore + 1, "the mailbox owner is told what is going on");
  assert.match(providerCalls.at(-1)!.subject, /no password to reset/i);
  assert.doesNotMatch(providerCalls.at(-1)!.subject, /\d{6}/, "no code is minted for an account without a password");
  assert.match(providerCalls.at(-1)!.text, /GitHub/, "the email names the method that actually works");
  assert.equal(lastReset().variant, "oauth_only");
  assert.equal(oauth.raw, real.raw, "and the HTTP response still reveals nothing");
  assert.equal(userDao.resetStateByEmail(oauthEmail)?.reset_code_hash ?? null, null, "no reset record exists");
  const noCode = await post("/auth/reset", { email: oauthEmail, code: "123456", password: "brandnewpw1" });
  assert.equal(noCode.status, 400, "there is no code that works on an account with no reset record");
  assert.equal(userDao.byEmail(oauthEmail)?.password_hash, "", "the OAuth account gains no password");
  console.log("  OK an OAuth-only account is answered honestly and stays passwordless");

  const bannedEmail = "banned-reset@outlook.com";
  const bannedUser = await auth.signup(bannedEmail, "originalpw1");
  userDao.markVerified(bannedUser.id);
  ageOutThrottle(bannedEmail);
  await post("/auth/forgot", { email: bannedEmail });
  const bannedCode = codeFrom(providerCalls.at(-1)!);
  userDao.ban(bannedUser.id, "test suspension");
  const bannedReset = await post("/auth/reset", { email: bannedEmail, code: bannedCode, password: "brandnewpw1" });
  assert.equal(bannedReset.status, 400, "a suspended account cannot redeem a code issued before the ban");
  const callsBeforeBanned = providerCalls.length;
  ageOutThrottle(bannedEmail);
  const bannedForgot = await post("/auth/forgot", { email: bannedEmail });
  assert.equal(providerCalls.length, callsBeforeBanned, "and asking again mails nothing");
  assert.equal(lastReset().reason, "suspended");
  assert.equal(bannedForgot.raw, real.raw, "still indistinguishable from every other address");
  console.log("  OK suspension survives the reset path");

  const attacker = "203.0.113.7";
  const victims: string[] = [];
  for (let i = 0; i < 20; i++) {
    const victim = `bomb-${i}@outlook.com`;
    const row = await auth.signup(victim, "originalpw1");
    userDao.markVerified(row.id);
    victims.push(victim);
  }
  const sentBefore = providerCalls.length;
  const bodies = new Set<string>();
  for (const victim of victims) bodies.add((await post("/auth/forgot", { email: victim }, attacker)).raw);
  const mailed = providerCalls.length - sentBefore;
  assert.ok(mailed < victims.length, `a single source must not mail every address it names (mailed ${mailed}/${victims.length})`);
  assert.equal(bodies.size, 1, "and being cut off is invisible in the response");
  assert.equal(lastReset().reason, "rate_limited");
  const otherSource = providerCalls.length;
  await post("/auth/forgot", { email: victims.at(-1)! }, "198.51.100.9");
  assert.equal(providerCalls.length, otherSource + 1, "an unrelated client is not collateral damage");
  console.log(`  OK a single source is cut off after ${mailed} addresses, without knowing it`);

  console.log("all password-reset checks passed");
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
