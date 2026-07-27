import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "client-log-intake-"));
process.env.AGENT_WEB_SECRET = "client-log-intake-secret-at-least-32-by";
process.env.AGENT_WEB_KEY_SECRET = "client-log-intake-key-secret-at-least-32";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const [{ registerAccountRoutes }, { auditHttpMiddleware }, persistence, auth] = await Promise.all([
  import("../server/src/http/routes/account.ts"),
  import("../server/src/observability/audit-log.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/identity/auth.ts"),
]);
const { db, userDao } = persistence;

const app = express();
const router = express.Router();
router.use(auditHttpMiddleware);
router.use(express.json());
registerAccountRoutes(router);
app.use("/api", router);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server has no TCP port");

function post(body: unknown, token?: string): Promise<{ status: number }> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/api/client-log",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
        "user-agent": "checkbot/1.0",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

type Row = { user_id: string | null; session_id: string | null; data_json: string };
const events = (): Row[] =>
  db.prepare("SELECT user_id, session_id, data_json FROM audit_events WHERE event = 'client_error' ORDER BY ts, rowid").all() as Row[];
const last = () => JSON.parse(events().at(-1)!.data_json) as Record<string, unknown>;

try {
  const before = events().length;
  const anon = await post({ events: [{ kind: "api_network_error", message: "TypeError: Load failed", path: "POST /auth/login" }] });
  assert.equal(anon.status, 200);
  assert.equal(events().length, before + 1, "a signed-out failure reaches the log");
  assert.equal(events().at(-1)!.user_id, null, "with no user to attribute it to");
  assert.equal(last().anonymous, true);
  assert.equal(last().kind, "api_network_error");
  assert.equal(last().path, "POST /auth/login", "the failing endpoint is what makes it actionable");
  assert.ok(typeof last().ipHash === "string" && (last().ipHash as string).length > 0, "attributed by ip hash instead");
  assert.ok(!JSON.stringify(last()).includes("127.0.0.1"), "the raw address is hashed, never stored");
  console.log("  OK a signed-out failure is recorded (the gap this closes)");

  const beforeKinds = events().length;
  await post({ events: [{ kind: "arbitrary_note", message: "free-form storage attempt" }] });
  assert.equal(events().length, beforeKinds, "an unknown kind from an anonymous caller is dropped");
  await post({ events: [{ kind: "window_error", message: "boom" }, { kind: "whatever", message: "no" }] });
  assert.equal(events().length, beforeKinds + 1, "allowlisted kinds still pass, one by one");
  console.log("  OK the anonymous kind allowlist holds");

  await post({ events: [{ kind: "ws_abnormal_close", message: "code=1006", sessionId: "s_someone_elses" }] });
  assert.equal(events().at(-1)!.session_id, null, "an anonymous event carries no session attribution");
  console.log("  OK anonymous events cannot claim a session");

  const user = await auth.signup("logger@outlook.com", "password123");
  userDao.markVerified(user.id);
  const token = auth.issueToken(user);
  await post({ events: [{ kind: "preview_failed", message: "pdf worker died", sessionId: "s_mine" }] }, token);
  assert.equal(events().at(-1)!.user_id, user.id, "an authed event is attributed to its user");
  assert.equal(events().at(-1)!.session_id, "s_mine", "and may name its session");
  assert.equal(last().kind, "preview_failed", "an authed caller is not restricted to the anonymous allowlist");
  assert.equal(last().anonymous, undefined);
  console.log("  OK a signed-in report keeps user + session attribution");

  const beforeBadToken = events().length;
  const forged = await post({ events: [{ kind: "window_error", message: "still worth knowing" }] }, "not-a-real-token");
  assert.equal(forged.status, 200, "a bad token must not throw the report away");
  assert.equal(events().length, beforeBadToken + 1);
  assert.equal(events().at(-1)!.user_id, null, "it is treated as anonymous");
  assert.equal(last().anonymous, true);
  console.log("  OK a stale token degrades to the anonymous class");

  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await post({ events: [{ kind: "api_network_error", message: `burst ${i}` }] });
    if (r.status === 429) refused++;
  }
  assert.ok(refused > 0, "an anonymous burst is eventually refused");
  console.log(`  OK the anonymous per-address budget is enforced (${refused}/40 refused)`);

  console.log("all client-log intake checks passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
