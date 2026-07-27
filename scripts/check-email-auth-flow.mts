import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "auth-email-flow-"));
process.env.AGENT_WEB_RESEND_KEY = "re_test_only";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.invalid>";
process.env.AGENT_WEB_PUBLIC_URL = "https://example.invalid";
process.env.AGENT_WEB_SECRET = "auth-email-flow-secret-at-least-32-bytes";
process.env.AGENT_WEB_KEY_SECRET = "auth-email-flow-key-secret-at-least-32";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

type ProviderCall = { to: string[]; subject: string };
const providerCalls: ProviderCall[] = [];
let providerMode: "accept" | "reject" = "accept";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.resend.com/emails") return nativeFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as ProviderCall;
  providerCalls.push(body);
  if (providerMode === "reject") {
    return new Response(JSON.stringify({ name: "validation_error", message: "test rejection" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ id: `email_${String(providerCalls.length).padStart(8, "0")}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const [{ registerAuthRoutes }, { auditHttpMiddleware }, persistence, auth, emailVerify] = await Promise.all([
  import("../server/src/http/routes/auth.ts"),
  import("../server/src/observability/audit-log.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/identity/auth.ts"),
  import("../server/src/identity/email-verify.ts"),
]);
const { db, userDao } = persistence;

const app = express();
const router = express.Router();
router.use(auditHttpMiddleware);
router.use(express.json());
registerAuthRoutes(router);
app.use("/api", router);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server has no TCP port");

type HttpResult = { status: number; body: Record<string, unknown> };
function post(path: string, body: Record<string, unknown>): Promise<HttpResult> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: `/api${path}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
      });
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

function deliveryEvents(): Array<{ user_id: string | null; target_id: string | null; data_json: string }> {
  return db.prepare(
    "SELECT user_id, target_id, data_json FROM audit_events WHERE event = 'auth_email_dispatch' ORDER BY ts, rowid",
  ).all() as Array<{ user_id: string | null; target_id: string | null; data_json: string }>;
}

try {
  const freshEmail = "fresh-flow@outlook.com";
  const fresh = await post("/auth/signup", { email: freshEmail, password: "password123" });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.state, "PENDING_VERIFY");
  assert.equal(fresh.body.emailVerificationPending, true);
  assert.equal(providerCalls.length, 1, "fresh signup reaches Resend exactly once");
  const freshRow = userDao.byEmail(freshEmail);
  assert.ok(freshRow, "fresh account exists");
  assert.equal(freshRow.email_verified, 0, "pending state is durable before delivery");
  assert.ok(freshRow.verify_code_hash, "code hash committed before delivery");
  const accepted = JSON.parse(deliveryEvents().at(-1)!.data_json) as Record<string, unknown>;
  assert.deepEqual(
    { outcome: accepted.outcome, trigger: accepted.trigger, providerStatus: accepted.providerStatus },
    { outcome: "accepted", trigger: "signup", providerStatus: 200 },
  );
  assert.match(deliveryEvents().at(-1)!.target_id ?? "", /^email_/);

  const code = providerCalls[0].subject.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, "test transport observed the six-digit code");
  const verified = await post("/auth/verify-code", { email: freshEmail, code });
  assert.equal(verified.body.state, "FULL_APP");

  const callsBeforeRecovery = providerCalls.length;
  const recovered = await post("/auth/signup", { email: freshEmail, password: "password123" });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.state, "FULL_APP", "matching password converts accidental signup to login");
  assert.equal(providerCalls.length, callsBeforeRecovery, "verified password recovery sends no email");

  const oauthEmail = "oauth-flow@outlook.com";
  userDao.create({
    id: "u_oauth_email_flow",
    email: oauthEmail,
    password_hash: "",
    github_id: "gh_email_flow",
    email_verified: 1,
    created_at: Date.now(),
  });
  const activeDuplicate = await post("/auth/signup", { email: oauthEmail, password: "password123" });
  assert.equal(activeDuplicate.status, 200);
  assert.equal(activeDuplicate.body.state, "PENDING_VERIFY");
  assert.deepEqual(
    Object.keys(activeDuplicate.body).sort(),
    Object.keys(fresh.body).sort(),
    "fresh and active duplicate responses keep one non-enumerating shape",
  );
  assert.equal(providerCalls.length, callsBeforeRecovery, "active OAuth account does not receive a fake code");
  const skipped = JSON.parse(deliveryEvents().at(-1)!.data_json) as Record<string, unknown>;
  assert.deepEqual(
    { outcome: skipped.outcome, trigger: skipped.trigger, reason: skipped.reason },
    { outcome: "skipped", trigger: "duplicate_signup", reason: "active_account" },
  );

  const pendingEmail = "pending-flow@outlook.com";
  await post("/auth/signup", { email: pendingEmail, password: "password123" });
  const pendingRow = userDao.byEmail(pendingEmail)!;
  db.prepare("UPDATE users SET verify_sent_at = ? WHERE id = ?").run(Date.now() - 31_000, pendingRow.id);
  const beforeConcurrent = providerCalls.length;
  const [resendA, resendB] = await Promise.all([
    post("/auth/verify/resend", { email: pendingEmail }),
    post("/auth/verify/resend", { email: pendingEmail }),
  ]);
  assert.equal(resendA.status, 200);
  assert.equal(resendB.status, 200);
  assert.equal(providerCalls.length, beforeConcurrent + 1, "parallel resends share one SQLite reservation");
  const concurrentOutcomes = deliveryEvents().slice(-2).map((row) => JSON.parse(row.data_json).outcome).sort();
  assert.deepEqual(concurrentOutcomes, ["accepted", "skipped"]);

  providerMode = "reject";
  const rejectedEmail = "provider-reject@outlook.com";
  const rejected = await post("/auth/signup", { email: rejectedEmail, password: "password123" });
  assert.equal(rejected.status, 200, "provider rejection does not become an account-existence oracle");
  assert.equal(rejected.body.state, "PENDING_VERIFY");
  const rejectionEvent = JSON.parse(deliveryEvents().at(-1)!.data_json) as Record<string, unknown>;
  assert.deepEqual(
    {
      outcome: rejectionEvent.outcome,
      providerStatus: rejectionEvent.providerStatus,
      providerCode: rejectionEvent.providerCode,
    },
    { outcome: "rejected", providerStatus: 422, providerCode: "validation_error" },
  );

  const raceEmail = "state-race@outlook.com";
  const raceUser = await auth.signup(raceEmail, "password123", { requireEmailVerification: true });
  const reservedAt = Date.now() + 1000;
  const reservation = userDao.reserveVerificationSend(raceEmail, reservedAt, reservedAt - 30_000);
  assert.ok(reservation);
  userDao.markVerified(raceUser.id);
  const staleCommit = userDao.commitVerificationPair(raceUser.id, reservedAt, "token", "code", Date.now() + 60_000);
  assert.equal(staleCommit, 0, "a completed verification invalidates the in-flight reservation");
  assert.equal(userDao.emailVerifiedState(raceUser.id), 1, "stale preparation cannot re-pend the account");

  for (const event of deliveryEvents()) {
    assert.doesNotMatch(event.data_json, /@|\b\d{6}\b/, "audit data contains no address or OTP");
  }
  console.log("all auth-email flow checks passed");
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
