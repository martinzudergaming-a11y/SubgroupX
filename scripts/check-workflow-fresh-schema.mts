import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-workflow-fresh-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
const { agentNodeDao, db, sessionDao, userDao, workflowDao } = await import(
  "../server/src/persistence/index.ts"
);
const now = 1_910_000_000_000;
userDao.create({ id: "fresh_user", email: "fresh@example.invalid", password_hash: "x", created_at: now });
sessionDao.create({
  id: "fresh_session",
  user_id: "fresh_user",
  title: "Fresh",
  provider: "mock",
  model: "mock",
  sandbox_mode: "workspace-write",
  sandbox_kind: "local",
  sandbox_id: null,
  sandbox_target_id: null,
  e2b_snapshot_id: null,
  mode: "coding",
  approval_policy: "never",
  status: "idle",
  thinking_level: "medium",
  cwd: ".",
  created_at: now,
  updated_at: now,
});
const root = agentNodeDao.create({
  id: "fresh_root",
  userId: "fresh_user",
  sessionId: "fresh_session",
  rootAgentId: "fresh_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now,
});
const executor = agentNodeDao.create({
  id: "fresh_executor",
  userId: "fresh_user",
  sessionId: "fresh_session",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/workflow",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: now,
});
workflowDao.create({
  id: "fresh_workflow",
  userId: "fresh_user",
  ownerSessionId: "fresh_session",
  rootAgentId: root.id,
  name: "Fresh graph",
  nodes: [{
    id: "fresh_node",
    name: "Fresh node",
    kind: "work",
    payload: { message: "Check the fresh graph." },
    effect: "pure_readonly",
    cachePolicy: "none",
    maxAttempts: 1,
    executorAgentId: executor.id,
  }],
  edges: [],
  createdAt: now,
});
const rootForeignKey = (db.prepare("PRAGMA foreign_key_list(workflows)").all() as Array<{
  table: string;
  from: string;
  to: string;
  on_delete: string;
}>).find((entry) => entry.from === "root_agent_id");
assert.deepEqual(rootForeignKey && {
  table: rootForeignKey.table,
  to: rootForeignKey.to,
  onDelete: rootForeignKey.on_delete,
}, { table: "agent_nodes", to: "id", onDelete: "CASCADE" });
db.prepare("DELETE FROM agent_nodes WHERE id = ?").run(root.id);
assert.equal(workflowDao.snapshot("fresh_user", "fresh_workflow"), undefined);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("  ✓ fresh Workflow schema keeps native ownership cascades and checks");
