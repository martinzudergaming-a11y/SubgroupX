import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-approval-persist-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "approval-persist-check-secret-32ch";

const { sessionDao, userDao, db } = await import("../server/src/persistence/index.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { registerMockProvider } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ApprovalPolicy } from "../shared/src/protocol.ts";

registerMockProvider();

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
function check(name: string, fn: () => void): void {
  try {
    fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const now = Date.now();
userDao.create({ id: "u_approve", email: "approve@test", password_hash: "x", created_at: now });

let seq = 0;
function makeRow(policy: ApprovalPolicy): SessionRow {
  const row: SessionRow = {
    id: `s_approve_${++seq}`,
    user_id: "u_approve",
    title: "approval-check",
    provider: "mock",
    model: "mock-coder",
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: policy,
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: now,
    updated_at: now,
  };
  sessionDao.create(row);
  return row;
}

function needsApproval(rt: InstanceType<typeof AgentSessionRuntime>, tool: string): boolean {
  return (rt as unknown as { needsApproval(name: string): boolean }).needsApproval(tool);
}
const rebuild = (id: string) => new AgentSessionRuntime(sessionDao.byId(id)!);

check("setApprovedTools stores a JSON array and reads back", () => {
  const row = makeRow("on-request");
  sessionDao.setApprovedTools(row.id, ["bash", "write_file"]);
  assert.equal(sessionDao.byId(row.id)!.approved_tools, JSON.stringify(["bash", "write_file"]));
});

check("an empty approval list stores NULL (fresh == cleared)", () => {
  const row = makeRow("on-request");
  sessionDao.setApprovedTools(row.id, ["bash"]);
  sessionDao.setApprovedTools(row.id, []);
  assert.equal(sessionDao.byId(row.id)!.approved_tools, null);
});

check("a REBUILT runtime honors stored session approvals under on-request", () => {
  const row = makeRow("on-request");
  const before = rebuild(row.id);
  assert.equal(needsApproval(before, "bash"), true, "bash must gate before any approval");
  before.close();
  sessionDao.setApprovedTools(row.id, ["bash"]);
  const after = rebuild(row.id);
  assert.equal(needsApproval(after, "bash"), false, "stored approval must survive the rebuild");
  assert.equal(needsApproval(after, "spawn_subagent"), true, "an unapproved GATED tool still gates");
  after.close();
});

check("stored approvals also apply under the untrusted policy's gate", () => {
  const row = makeRow("untrusted");
  sessionDao.setApprovedTools(row.id, ["read_file"]);
  const rt = rebuild(row.id);
  assert.equal(needsApproval(rt, "read_file"), false);
  assert.equal(needsApproval(rt, "bash"), true);
  rt.close();
});

check("a malformed approved_tools column boots with no approvals", () => {
  const row = makeRow("on-request");
  db.prepare("UPDATE sessions SET approved_tools = ? WHERE id = ?").run("{not json", row.id);
  const rt = rebuild(row.id);
  assert.equal(needsApproval(rt, "bash"), true, "corrupt data must fail closed (re-prompt)");
  rt.close();
});

check("manager.setApprovalPolicy('untrusted') clears stored approvals", () => {
  const row = makeRow("on-request");
  sessionDao.setApprovedTools(row.id, ["bash"]);
  const info = sessionManager.setApprovalPolicy("u_approve", row.id, "untrusted");
  assert.ok(info, "policy change must succeed");
  assert.equal(sessionDao.byId(row.id)!.approved_tools, null, "approvals must be revoked");
  const rt = rebuild(row.id);
  assert.equal(needsApproval(rt, "bash"), true, "a rebuilt runtime prompts again");
  rt.close();
});

if (failed > 0) {
  console.error(`\n${failed} approval-persist check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all approval-persist checks passed");
process.exit(0);
