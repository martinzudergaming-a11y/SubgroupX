import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-setsandbox-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "setsandbox-check-secret-32chars!!";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const { userDao, connectorDao, sshTargetDao } = await import("../server/src/persistence/index.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");

const now = Date.now();
userDao.create({ id: "u_A", email: "a@test", password_hash: "x", created_at: now } as any);
userDao.create({ id: "u_B", email: "b@test", password_hash: "x", created_at: now } as any);
connectorDao.create({ id: "conn_B", user_id: "u_B", name: "B-box", token_hash: "hB", workspace_root: "/home/b/.agent-web/workspaces", capabilities_json: "[]", last_seen_at: now, created_at: now } as any);
connectorDao.create({ id: "conn_A", user_id: "u_A", name: "A-box", token_hash: "hA", workspace_root: "/home/a/.agent-web/workspaces", capabilities_json: "[]", last_seen_at: now, created_at: now } as any);
sshTargetDao.create({ id: "ssh_B", user_id: "u_B", label: "b-host", host: "10.0.0.9", port: 22, username: "root", enc_key: "x", host_fp: null, key_protected: 0, created_at: now } as any);

const session = await sessionManager.createSession({ id: "u_A", email: "a@test" } as any, {
  provider: "mock", model: "mock-coder", sandboxMode: "danger-full-access", sandboxKind: "local", approvalPolicy: "never",
});

let passed = 0;
const ok = async (label: string, fn: () => Promise<void>) => { await fn(); console.log("  OK " + label); passed++; };

await ok("setSandbox to ANOTHER user's connector is refused", async () => {
  const r = await sessionManager.setSandbox("u_A", session.id, "connector", "conn_B");
  assert.equal(r.ok, false, "must refuse a foreign connector");
});
await ok("setSandbox to ANOTHER user's SSH target is refused", async () => {
  const r = await sessionManager.setSandbox("u_A", session.id, "ssh", "ssh_B");
  assert.equal(r.ok, false, "must refuse a foreign ssh target");
});
await ok("setSandbox to a connector with NO id is refused", async () => {
  const r = await sessionManager.setSandbox("u_A", session.id, "connector", null);
  assert.equal(r.ok, false, "must refuse a null connector id");
});
await ok("setSandbox to a NON-EXISTENT connector id is refused", async () => {
  const r = await sessionManager.setSandbox("u_A", session.id, "connector", "conn_ghost");
  assert.equal(r.ok, false, "must refuse an unknown connector id");
});
await ok("setSandbox to the user's OWN connector passes the ownership gate", async () => {
  const r = await sessionManager.setSandbox("u_A", session.id, "connector", "conn_A");
  assert.ok(r.ok || (!r.ok && r.reason !== "not found"), `owned connector must pass ownership gate (got ${JSON.stringify(r)})`);
});

console.log(`\nall set-sandbox-owner checks passed (${passed})`);
