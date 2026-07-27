import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-quota-check-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "quota-check-fixed-secret-32chars!";

const { userDao, sessionDao, uploadDao, db } = await import("../server/src/persistence/index.ts");
const { WORKSPACES_DIR } = await import("../server/src/config.ts");
const { workspacePathFor } = await import("../server/src/runtime/sandbox.ts");

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { SandboxKind } from "../shared/src/protocol.ts";

let failed = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const NOW = Date.now();
const USER = "u_quota";
userDao.create({ id: USER, email: "quota@test", password_hash: "x", created_at: NOW });

function seedSession(id: string, kind: SandboxKind = "local"): void {
  const row: SessionRow = {
    id,
    user_id: USER,
    title: `Session ${id}`,
    provider: "mock",
    model: "mock-coder",
    sandbox_mode: "workspace-write",
    sandbox_kind: kind,
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: "/tmp",
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
}

let upSeq = 0;
function putUpload(sessionId: string, rel: string, bytes: number): void {
  const abs = path.join(workspacePathFor(USER, sessionId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 0x61));
  uploadDao.add({ id: `up_${upSeq++}`, user_id: USER, session_id: sessionId, rel_path: rel, bytes });
}
function recordOnly(sessionId: string, rel: string, bytes: number): void {
  uploadDao.add({ id: `up_${upSeq++}`, user_id: USER, session_id: sessionId, rel_path: rel, bytes });
}

const MB = 1024 * 1024;

console.log("\n── #195: deleting an uploaded file releases the user's quota ──");

const SID = "s_quota";
seedSession(SID);

check("baseline total is 0 with no uploads", () => {
  assert.equal(uploadDao.totalBytesForUser(USER), 0);
});

check("counts the real on-disk size of all uploads (12MB)", () => {
  putUpload(SID, "uploads/a.png", 5 * MB);
  putUpload(SID, "uploads/b.png", 7 * MB);
  assert.equal(uploadDao.totalBytesForUser(USER), 12 * MB);
});

check("THE BUG FIX: deleting a file (rm-style) DROPS the counted total to 7MB", () => {
  fs.rmSync(path.join(workspacePathFor(USER, SID), "uploads/a.png"));
  assert.equal(uploadDao.totalBytesForUser(USER), 7 * MB);
});

check("the stale ledger row for the deleted file is GC'd", () => {
  const ids = (db.prepare("SELECT id FROM uploads WHERE user_id = ?").all(USER) as { id: string }[]).map((r) => r.id);
  assert.equal(ids.length, 1, "only the surviving upload's row should remain");
});

check("an overwrite that SHRINKS a file lowers the counted total", () => {
  fs.writeFileSync(path.join(workspacePathFor(USER, SID), "uploads/b.png"), Buffer.alloc(1000, 0x62));
  assert.equal(uploadDao.totalBytesForUser(USER), 1000);
});

check("a file GROWN beyond its recorded bytes counts at most the recorded upload bytes", () => {
  fs.writeFileSync(path.join(workspacePathFor(USER, SID), "uploads/b.png"), Buffer.alloc(7 * MB + 10_000, 0x62));
  assert.equal(uploadDao.totalBytesForUser(USER), 7 * MB, "agent-grown output must not inflate quota");
});

check("a path-escaping rel_path is never stat'd and contributes 0", () => {
  recordOnly(SID, "../../../../etc/passwd", 999_999);
  assert.equal(uploadDao.totalBytesForUser(USER), 7 * MB, "escaping rows must be skipped, not counted");
});

check("deleting the whole workspace dir (session delete) frees its bytes", () => {
  fs.rmSync(workspacePathFor(USER, SID), { recursive: true, force: true });
  assert.equal(uploadDao.totalBytesForUser(USER), 0);
});

console.log("\n── remote sandboxes: no host FS to stat → trust the recorded ledger ──");

const RID = "s_remote";
seedSession(RID, "e2b");

check("remote (e2b) uploads count as-recorded even with no local file (no regression)", () => {
  recordOnly(RID, "uploads/r.bin", 4096);
  assert.equal(uploadDao.totalBytesForUser(USER), 4096);
});

check("remote rows are NOT GC'd (a missing local file must not free remote bytes)", () => {
  const ids = (db.prepare("SELECT id FROM uploads WHERE session_id = ?").all(RID) as { id: string }[]).map((r) => r.id);
  assert.equal(ids.length, 1, "remote row preserved across reconcile");
  assert.equal(uploadDao.totalBytesForUser(USER), 4096);
});

fs.rmSync(tmp, { recursive: true, force: true });
void WORKSPACES_DIR;
if (failed > 0) {
  console.error(`\n${failed} quota check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all quota checks passed");
