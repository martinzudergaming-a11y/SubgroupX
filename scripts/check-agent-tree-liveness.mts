import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-tree-liveness-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const persistence = await import("../server/src/persistence/index.ts");
const { agentNodeDao, agentTaskDao, runtimeTaskDao, sessionDao, userDao } = persistence;

let tick = 1_900_000_000_000;
const now = () => ++tick;
const userId = "user_tree";
const sessionId = "session_tree";
const rootAgentId = "agent_tree_root";

userDao.create({ id: userId, email: "tree@example.invalid", password_hash: "x", created_at: now() });
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "tree liveness",
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
  created_at: now(),
  updated_at: now(),
});
agentNodeDao.create({
  id: rootAgentId,
  userId,
  sessionId,
  rootAgentId,
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now(),
});

function spawnChild(suffix: string) {
  return agentTaskDao.create({
    agent: {
      id: `agent_${suffix}`,
      userId,
      sessionId,
      rootAgentId,
      parentAgentId: rootAgentId,
      path: `/root/${suffix}`,
      label: suffix,
      purpose: "addressable",
      provider: "mock",
      model: "mock",
      kind: "subagent",
      createdAt: now(),
    },
    task: {
      id: `task_${suffix}`,
      userId,
      sessionId,
      ownerSessionId: sessionId,
      agentId: `agent_${suffix}`,
      kind: "delegation",
      title: suffix,
      payload: { message: `do ${suffix}`, context: "none" },
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: false,
      createdAt: now(),
    },
    initialMessages: [],
  });
}

function settleChild(suffix: string, outcome: "succeeded" | "failed" | "interrupted") {
  const taskId = `task_${suffix}`;
  const agentId = `agent_${suffix}`;
  let task = runtimeTaskDao.byId(userId, taskId)!;
  task = runtimeTaskDao.claim({
    id: task.id,
    userId,
    expectedVersion: task.version,
    at: now(),
    eventPayload: {},
  })!;
  task = runtimeTaskDao.transition({
    id: task.id,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "running",
    activity: "model",
    at: now(),
  })!;
  runtimeTaskDao.transition({
    id: task.id,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: outcome === "succeeded" ? "succeeded" : outcome === "failed" ? "failed" : "interrupted",
    at: now(),
  });
  const agent = agentNodeDao.byId(userId, agentId)!;
  agentNodeDao.transitionStatus({
    id: agent.id,
    userId,
    expectedVersion: agent.version,
    nextStatus: outcome === "succeeded" ? "idle" : outcome === "failed" ? "error" : "interrupted",
    at: now(),
  });
}

const live = () => agentNodeDao.countLiveByRoot(userId, rootAgentId);
const nonClosed = () => agentNodeDao.countNonClosedByRoot(userId, rootAgentId);

spawnChild("a");
assert.equal(live(), 1, "the queued Child is live (the idle root holds no open work)");
settleChild("a", "succeeded");
assert.equal(live(), 0, "a succeeded Child stops counting against the cap");
assert.equal(nonClosed(), 2, "…while remaining in the tree, addressable for follow-up");
assert.equal(agentNodeDao.byId(userId, "agent_a")!.status, "idle", "settled Child is idle, not closed");

spawnChild("b");
settleChild("b", "failed");
assert.equal(agentNodeDao.byId(userId, "agent_b")!.status, "error");
assert.equal(live(), 0, "an errored Child is dormant, not live");

spawnChild("c");
settleChild("c", "interrupted");
assert.equal(live(), 0, "an interrupted Child is dormant, not live");
console.log("  ✓ settled Children (succeeded/failed/interrupted) release their tree slot");

for (let index = 0; index < 40; index += 1) {
  const suffix = `bulk_${String(index).padStart(3, "0")}`;
  spawnChild(suffix);
  settleChild(suffix, index % 3 === 0 ? "failed" : "succeeded");
}
assert.ok(nonClosed() > 32, `the tree really did accumulate ${nonClosed()} non-closed Agents`);
assert.equal(live(), 0, "none of them count against the live cap");
console.log(`  ✓ ${nonClosed()} lifetime Agents leave the live count at ${live()} (was the 32-Agent wedge)`);

spawnChild("open");
assert.equal(live(), 1, "a queued Task keeps its Agent live");

let openTask = runtimeTaskDao.byId(userId, "task_open")!;
openTask = runtimeTaskDao.claim({
  id: openTask.id, userId, expectedVersion: openTask.version, at: now(), eventPayload: {},
})!;
openTask = runtimeTaskDao.transition({
  id: openTask.id, userId, expectedVersion: openTask.version,
  expectedLeaseGeneration: openTask.leaseGeneration, nextStatus: "running", activity: "model", at: now(),
})!;
openTask = runtimeTaskDao.transition({
  id: openTask.id, userId, expectedVersion: openTask.version,
  expectedLeaseGeneration: openTask.leaseGeneration, nextStatus: "cancel_requested", at: now(),
})!;
assert.equal(live(), 1, "an Agent whose Task is cancel_requested is still live");
runtimeTaskDao.transition({
  id: openTask.id, userId, expectedVersion: openTask.version,
  expectedLeaseGeneration: openTask.leaseGeneration, nextStatus: "cancelled", at: now(),
});
assert.equal(live(), 1, "an Agent still mid-initialization stays live even with no open Task");
const openAgent = agentNodeDao.byId(userId, "agent_open")!;
agentNodeDao.transitionStatus({
  id: openAgent.id, userId, expectedVersion: openAgent.version, nextStatus: "interrupted", at: now(),
});
assert.equal(live(), 0, "…and releases the slot once settle() projects it");
console.log("  ✓ open work, still-settling work, and unsettled Agents all stay counted");

console.log("Agent tree liveness contract passed.");
