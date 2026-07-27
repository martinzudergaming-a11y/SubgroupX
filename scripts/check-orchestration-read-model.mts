import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-read-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const express = (await import("express")).default;
const [{ createApiRouter }, auth, persistence, runtime, ipc, providers] = await Promise.all([
  import("../server/src/http/api.ts"),
  import("../server/src/identity/auth.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/runtime/manager.ts"),
  import("../server/src/runtime/runtime-ipc.ts"),
  import("../server/src/runtime/providers.ts"),
]);
providers.registerMockProvider();

const {
  agentNodeDao,
  runtimeTaskDao,
  sessionDao,
  taskResultDao,
  taskResultDeliveryDao,
  PENDING_RESULT_ACK_MAX_PER_DELIVERY_AGENT,
  PENDING_RESULT_ACK_MAX_AGE_MS,
  orchestrationRevisionDao,
  messageDao,
  timelineDao,
  userDao,
  db,
} = persistence;
const now = 1_900_000_000_000;
const userId = "user_read_model";
const otherUserId = "user_read_other";
const settleInvalidations = () => new Promise((resolve) => setTimeout(resolve, 40));
userDao.create({ id: userId, email: "read-model@example.invalid", password_hash: "x", created_at: now });
userDao.create({ id: otherUserId, email: "read-other@example.invalid", password_hash: "x", created_at: now });

function createSession(id: string, owner: string, title = `Session ${id}`): void {
  sessionDao.create({
    id,
    user_id: owner,
    title,
    provider: "mock",
    model: "mock-coder",
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: `/private/never-list/${id}`,
    created_at: now,
    updated_at: now,
  });
}

createSession("session_read", userId);
createSession("session_empty", userId);
createSession("session_other", otherUserId);
createSession("session_title_ingress", userId, "界".repeat(500));
assert.equal(Array.from(sessionDao.byId("session_title_ingress")!.title).length, 120);
sessionDao.setTitle("session_title_ingress", "  Alpha\n\tBeta\u200b🙂  ");
assert.equal(sessionDao.byId("session_title_ingress")!.title, "Alpha Beta 🙂");
assert.throws(
  () => db.prepare(
    `INSERT INTO sessions
       (id, user_id, title, provider, model, sandbox_mode, approval_policy,
        status, cwd, created_at, updated_at)
     VALUES (?, ?, ?, 'mock', 'mock-coder', 'workspace-write', 'never',
       'idle', '/tmp', ?, ?)`,
  ).run("session_title_raw_insert", userId, "x".repeat(121), now, now),
  /session title exceeds bound/,
  "raw INSERT ingress enforces the title cap",
);
assert.throws(
  () => db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("x".repeat(121), "session_read"),
  /session title exceeds bound/,
  "raw DB ingress also enforces the title cap",
);
db.exec("DROP TRIGGER trg_sessions_title_update_bound");
const legacyTitle = "LEGACY_TITLE_".repeat(40_000);
db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(legacyTitle, "session_read");
db.exec(`
  CREATE TRIGGER trg_sessions_title_update_bound
  BEFORE UPDATE OF title ON sessions
  WHEN length(NEW.title) > 120 OR length(CAST(NEW.title AS BLOB)) > 480
  BEGIN
    SELECT RAISE(ABORT, 'session title exceeds bound');
  END;
`);

const root = agentNodeDao.create({
  id: "agent_read_root",
  userId,
  sessionId: "session_read",
  rootAgentId: "agent_read_root",
  path: "/root",
  label: "Current session",
  kind: "session",
  status: "idle",
  createdAt: now,
});
const child = agentNodeDao.create({
  id: "agent_read_child",
  userId,
  sessionId: "session_read",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/private_agent_address",
  label: "Research",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  status: "idle",
  createdAt: now + 1,
});
const joined = agentNodeDao.create({
  id: "agent_joined_hidden",
  userId,
  sessionId: "session_read",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/joined_slot_1",
  label: "Joined delegation slot",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  purpose: "joined_slot",
  status: "idle",
  createdAt: now + 2,
});
assert.throws(() => agentNodeDao.create({
  id: "agent_visible_under_hidden_rejected",
  userId,
  sessionId: "session_read",
  rootAgentId: root.id,
  parentAgentId: joined.id,
  path: "/root/joined_slot_1/visible_rejected",
  label: "Must reject",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  purpose: "addressable",
  status: "idle",
  createdAt: now + 3,
}), /addressable parent/);
db.prepare(
  `INSERT INTO agent_nodes
    (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
     provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
).run(
  "agent_visible_under_hidden",
  userId,
  "session_read",
  root.id,
  joined.id,
  "/root/joined_slot_1/visible_corrupt",
  "Corrupt visible child",
  "mock",
  "mock-coder",
  "medium",
  "subagent",
  "addressable",
  "idle",
  now + 3,
  now + 3,
);
assert.throws(() => agentNodeDao.create({
  id: "agent_deep_visible_under_hidden_rejected",
  userId,
  sessionId: "session_read",
  rootAgentId: root.id,
  parentAgentId: "agent_visible_under_hidden",
  path: "/root/joined_slot_1/visible_corrupt/deep",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  purpose: "addressable",
  status: "idle",
  createdAt: now + 4,
}), /addressable parent/);
db.prepare(
  `INSERT INTO agent_nodes
    (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
     provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, NULL, 'mock', 'mock-coder', 'medium',
     'subagent', 'addressable', 'idle', 1, ?, ?)`,
).run(
  "agent_deep_visible_under_hidden",
  userId,
  "session_read",
  root.id,
  "agent_visible_under_hidden",
  "/root/joined_slot_1/visible_corrupt/deep_raw",
  now + 4,
  now + 4,
);
assert.throws(() => runtimeTaskDao.create({
  id: "task_visible_under_hidden_rejected",
  userId,
  sessionId: "session_read",
  ownerSessionId: "session_read",
  agentId: "agent_visible_under_hidden",
  kind: "delegation",
  title: "Must reject hidden parent",
  payload: {},
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now + 4,
}), /visible Agent parent/);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, NULL, NULL, 'delegation', ?, '{}', 2,
     'queued', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(
  "task_visible_under_hidden",
  userId,
  "session_read",
  "session_read",
  "agent_visible_under_hidden",
  "Corrupt hidden-parent Task",
  now + 4,
  now + 4,
);
db.prepare(
  `INSERT INTO task_results
    (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
   VALUES ('result_hidden_ack_probe', 'task_visible_under_hidden',
     'HIDDEN_RESULT_SECRET', '{}', '{}', 1, ?, NULL)`,
).run(now + 5);
const otherRoot = agentNodeDao.create({
  id: "agent_other_root",
  userId: otherUserId,
  sessionId: "session_other",
  rootAgentId: "agent_other_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now,
});
createSession("session_same_user_other_root", userId);
const sameUserOtherRoot = agentNodeDao.create({
  id: "agent_same_user_other_root",
  userId,
  sessionId: "session_same_user_other_root",
  rootAgentId: "agent_same_user_other_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now + 5,
});
db.prepare(
  `INSERT INTO workflows
    (id, user_id, owner_session_id, root_agent_id, name, status,
     version, created_at, updated_at)
   VALUES ('workflow_same_user_other_root', ?, 'session_same_user_other_root', ?,
     'Wrong root workflow', 'running', 1, ?, ?)`,
).run(userId, sameUserOtherRoot.id, now + 5, now + 5);
assert.throws(() => runtimeTaskDao.create({
  id: "task_same_user_other_root_rejected",
  userId,
  sessionId: "session_read",
  ownerSessionId: "session_read",
  agentId: child.id,
  workflowId: "workflow_same_user_other_root",
  kind: "workflow_node",
  title: "Wrong root Workflow",
  payload: {},
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now + 6,
}), /trusted orchestration creator/);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_same_user_other_root_corrupt', ?, 'session_read', 'session_read',
     NULL, NULL, ?, 12, NULL, 'workflow_same_user_other_root', 'workflow_node',
     'Wrong root Workflow', '{}', 2, 'succeeded', 'background', 'detached', 0,
     NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 6, now + 6);
db.prepare(
  `INSERT INTO agent_nodes
    (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
     provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
   VALUES ('agent_cross_tenant_root_corrupt', ?, 'session_read', ?, NULL,
     '/cross-tenant-root', NULL, 'mock', 'mock-coder', 'medium', 'subagent',
     'addressable', 'idle', 1, ?, ?)`,
).run(userId, otherRoot.id, now + 5, now + 5);
db.prepare(
  `INSERT INTO agent_nodes
    (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
     provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
   VALUES ('agent_fake_self_root', ?, 'session_read', 'agent_fake_self_root', NULL,
     '/fake-root', NULL, 'mock', 'mock-coder', 'medium', 'subagent',
     'addressable', 'idle', 1, ?, ?)`,
).run(userId, now + 6, now + 6);
assert.throws(() => agentNodeDao.create({
  id: "agent_fake_root_child_rejected",
  userId,
  sessionId: "session_read",
  rootAgentId: "agent_fake_self_root",
  parentAgentId: "agent_fake_self_root",
  path: "/fake-root/child",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  status: "idle",
  createdAt: now + 7,
}), /root is not owned/);

db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_bad_owner_parent', ?, 'session_read', 'session_other', NULL, NULL,
     ?, 8, NULL, NULL, 'delegation', 'Bad owner parent', '{}', 2, 'succeeded',
     'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 36, now + 36);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_child_of_bad_owner', ?, 'session_read', 'session_read', NULL, NULL,
     ?, 9, 'task_bad_owner_parent', NULL, 'delegation', 'Child of bad owner', '{}', 2,
     'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 37, now + 37);

db.prepare(
  `INSERT INTO workflows
    (id, user_id, owner_session_id, root_agent_id, name, status,
     version, created_at, updated_at)
   VALUES ('workflow_other_visibility', ?, 'session_other', ?, 'Other workflow',
     'running', 1, ?, ?)`,
).run(otherUserId, otherRoot.id, now + 38, now + 38);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_bad_workflow_parent', ?, 'session_read', 'session_read', NULL, NULL,
     ?, 10, NULL, 'workflow_other_visibility', 'delegation', 'Bad workflow parent',
     '{}', 2, 'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 39, now + 39);
db.prepare(
  `INSERT INTO task_results
    (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
   VALUES ('result_bad_workflow_hidden', 'task_bad_workflow_parent',
     'HIDDEN_WORKFLOW_SUMMARY', '{}', '{}', 1, ?, NULL)`,
).run(now + 39);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_bad_workflow_queued', ?, 'session_read', 'session_read', NULL, NULL,
     ?, 13, NULL, 'workflow_other_visibility', 'workflow_node', 'Hidden queued workflow',
     '{}', 2, 'queued', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 39, now + 39);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_child_of_bad_workflow', ?, 'session_read', 'session_read', NULL, NULL,
     ?, 11, 'task_bad_workflow_parent', NULL, 'delegation', 'Child of bad workflow',
     '{}', 2, 'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 40, now + 40);

function createTask(id: string, agentId: string, at: number) {
  return runtimeTaskDao.create({
    id,
    userId,
    sessionId: "session_read",
    ownerSessionId: "session_read",
    ownerStepId: `step_${id}`,
    agentId,
    kind: "delegation",
    title: `Task ${id}`,
    payload: { assignment: `PAYLOAD_SECRET_${id}` },
    awaitPolicy: agentId === joined.id ? "join" : "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: at,
  });
}

function settleTask(id: string, at: number, summary = `Result ${id}`) {
  let task = createTask(id, child.id, at);
  task = runtimeTaskDao.claim({ id, userId, expectedVersion: task.version, at: at + 1 })!;
  task = runtimeTaskDao.transition({
    id,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "running",
    at: at + 2,
  })!;
  return taskResultDao.settle({
    id: `result_${id}`,
    taskId: id,
    userId,
    summary,
    body: { text: `RESULT_BODY_SECRET_${id}` },
    artifacts: { path: `/private/artifact/${id}` },
    expectedTaskVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "succeeded",
    createdAt: at + 3,
  })!;
}

const first = settleTask("task_first", now + 10, "x".repeat(600));
const second = settleTask("task_second", now + 20);
const third = settleTask("task_third", now + 24);
const fourth = settleTask("task_fourth", now + 28);
const delivery = settleTask("task_delivery", now + 32);
const hiddenJoinedTask = createTask("task_hidden_joined", joined.id, now + 30);
runtimeTaskDao.claim({
  id: hiddenJoinedTask.id,
  userId,
  expectedVersion: hiddenJoinedTask.version,
  at: now + 31,
});
assert.throws(() => runtimeTaskDao.create({
  id: "task_visible_with_hidden_parent_rejected",
  userId,
  sessionId: "session_read",
  ownerSessionId: "session_read",
  agentId: child.id,
  parentTaskId: hiddenJoinedTask.id,
  kind: "delegation",
  title: "Must reject hidden Task parent",
  payload: {},
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now + 33,
}), /addressable parent Task/);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES (?, ?, ?, ?, NULL, NULL, ?, 6, ?, NULL, 'delegation', ?, '{}', 2,
     'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(
  "task_hidden_parent_corrupt",
  userId,
  "session_read",
  "session_read",
  child.id,
  hiddenJoinedTask.id,
  "Corrupt hidden Task parent",
  now + 34,
  now + 34,
);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_deep_hidden_parent_corrupt', ?, 'session_read', 'session_read',
     NULL, NULL, ?, 7, 'task_hidden_parent_corrupt', NULL, 'delegation',
     'Deep corrupt hidden Task parent', '{}', 2, 'queued', 'background',
     'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, child.id, now + 35, now + 35);
runtimeTaskDao.create({
  id: "task_other",
  userId: otherUserId,
  sessionId: "session_other",
  ownerSessionId: "session_other",
  agentId: otherRoot.id,
  kind: "delegation",
  title: "Other owner Task",
  payload: { secret: "OTHER_USER_SECRET" },
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now + 40,
});
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES (?, ?, ?, ?, NULL, NULL, ?, 2, NULL, NULL, 'delegation', ?, '{}', 2,
     'queued', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(
  "task_cross_tenant_corrupt",
  userId,
  "session_other",
  "session_other",
  otherRoot.id,
  "Cross tenant corruption",
  now + 41,
  now + 41,
);

const addressableRoster = agentNodeDao.roster(userId, root.id, { addressableOnly: true })!;
const addressableJson = JSON.stringify(addressableRoster);
assert.doesNotMatch(
  addressableJson,
  /agent_visible_under_hidden|task_visible_under_hidden|task_bad_workflow|HIDDEN_WORKFLOW_SUMMARY/,
  "the model capsule uses the same recursive Agent, Task, and Workflow closure",
);
assert.deepEqual(
  agentNodeDao.directTargets(userId, root.id, "agent_visible_under_hidden", { addressableOnly: true }),
  [],
);
assert.deepEqual(
  agentNodeDao.labelTargets(userId, root.id, "Corrupt visible child", { addressableOnly: true }),
  [],
);
assert.doesNotMatch(
  JSON.stringify(runtimeTaskDao.listDigestsByAgent(userId, child.id, 100)),
  /task_bad_workflow|HIDDEN_WORKFLOW_SUMMARY/,
  "get_agent detail cannot recover a Task rejected by the model capsule",
);
const executableOpenIds = runtimeTaskDao.listOpenByRoot(userId, root.id, 100).map((task) => task.id);
assert.equal(executableOpenIds.includes("task_visible_under_hidden"), false);
assert.equal(executableOpenIds.includes("task_bad_workflow_queued"), false);
assert.equal(runtimeTaskDao.claim({
  id: "task_bad_workflow_queued",
  userId,
  expectedVersion: 1,
  at: now + 42,
}), null, "the exact claim boundary rejects a malformed queued Workflow Task");

const app = express();
app.use("/api", createApiRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
const base = `http://127.0.0.1:${address.port}/api`;
const token = auth.issueToken({ id: userId, email: "read-model@example.invalid" });
const otherToken = auth.issueToken({ id: otherUserId, email: "read-other@example.invalid" });

async function api(
  route: string,
  options: RequestInit = {},
  bearer = token,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

try {
  const readModelSource = fs.readFileSync(
    new URL("../server/src/orchestration/read-model.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(readModelSource, /SELECT\s+(?:\$\{)?[at]\.\*/i, "collections select explicit safe columns");
  assert.ok(
    (db.prepare("PRAGMA index_list('runtime_tasks')").all() as Array<{ name: string }>)
      .some((index) => index.name === "idx_runtime_tasks_user_updated"),
    "global Activity has a user/keyset index",
  );
  assert.ok(
    (db.prepare("PRAGMA index_list('runtime_tasks')").all() as Array<{ name: string }>)
      .some((index) => index.name === "idx_runtime_tasks_visible_children"),
    "visible Task closures have a Session parent-chain index",
  );
  assert.ok(
    (db.prepare("PRAGMA index_list('runtime_tasks')").all() as Array<{ name: string }>)
      .some((index) => index.name === "idx_runtime_tasks_visible_roots"),
    "account Activity has a root Task index",
  );
  assert.ok(
    (db.prepare("PRAGMA index_list('agent_nodes')").all() as Array<{ name: string }>)
      .some((index) => index.name === "idx_agent_nodes_visible_children"),
    "visible Agent closures have a child index",
  );
  assert.ok(
    (db.prepare("PRAGMA index_list('agent_nodes')").all() as Array<{ name: string }>)
      .some((index) => index.name === "idx_agent_nodes_visible_roots"),
    "account Activity has a root Agent index",
  );
  const rootDeliveryPlan = (db.prepare(
    `EXPLAIN QUERY PLAN SELECT 1 FROM messages
     WHERE session_id = ? AND json_valid(msg_json)
       AND json_extract(msg_json, '$.role') = 'toolResult'
       AND json_extract(msg_json, '$.toolCallId') = ?
       AND json_extract(msg_json, '$.isError') = 0`,
  ).all("session_read", "step_probe") as Array<{ detail: string }>)
    .map((row) => row.detail).join("\n");
  assert.match(rootDeliveryPlan, /idx_messages_tool_result_delivery/);
  const activityPlan = (db.prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM runtime_tasks
     WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 41`,
  ).all(userId) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  assert.match(activityPlan, /idx_runtime_tasks_user_updated/);
  const sessionPlan = (db.prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM runtime_tasks
     WHERE user_id = ? AND session_id = ?
     ORDER BY updated_at DESC, id DESC LIMIT 41`,
  ).all(userId, "session_read") as Array<{ detail: string }>).map((row) => row.detail).join("\n");
  assert.match(sessionPlan, /idx_runtime_tasks_session_updated/);
  const unauthorized = await fetch(`${base}/orchestration/activity`);
  assert.equal(unauthorized.status, 401);
  const createdTitle = await api("/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "C".repeat(10_000),
      provider: "mock",
      model: "mock-coder",
      sandboxMode: "workspace-write",
      sandboxKind: "local",
      approvalPolicy: "never",
    }),
  });
  assert.equal(createdTitle.status, 200);
  assert.equal(Array.from(createdTitle.json.session.title).length, 120);
  assert.equal(Array.from(sessionDao.byId(createdTitle.json.session.id)!.title).length, 120);
  const renamedTitle = await api(`/sessions/${createdTitle.json.session.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "R".repeat(10_000) }),
  });
  assert.equal(renamedTitle.status, 200);
  assert.equal(Array.from(renamedTitle.json.session.title).length, 120);

  assert.deepEqual(runtime.runtimeClient.liveSessionStatuses(userId), []);
  const empty = await api("/sessions/session_empty/run");
  assert.equal(empty.status, 200);
  assert.equal(empty.json.revision, 0);
  assert.deepEqual(empty.json.agents.items, []);
  assert.deepEqual(runtime.runtimeClient.liveSessionStatuses(userId), []);
  assert.equal(agentNodeDao.listBySession(userId, "session_empty").length, 0);

  const activityOne = await api("/orchestration/activity?limit=1");
  assert.equal(activityOne.status, 200);
  assert.equal(activityOne.json.items.length, 1);
  assert.ok(activityOne.json.nextCursor);
  const activityTwo = await api(`/orchestration/activity?limit=1&cursor=${activityOne.json.nextCursor}`);
  assert.equal(activityTwo.status, 200);
  assert.equal(activityTwo.json.items.length, 1);
  assert.notEqual(activityOne.json.items[0].task.id, activityTwo.json.items[0].task.id);
  const renameAfterCursor = await api(`/sessions/${createdTitle.json.session.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Cursor rename" }),
  });
  assert.equal(renameAfterCursor.status, 200);
  assert.equal(
    (await api(`/orchestration/activity?limit=1&cursor=${activityOne.json.nextCursor}`)).status,
    409,
    "Session rename invalidates Activity pages that carry normalized titles",
  );
  const activityAll = await api("/orchestration/activity?limit=100");
  assert.equal(activityAll.status, 200);
  const firstPreview = activityAll.json.items
    .find((item: any) => item.task.id === "task_first").task.result;
  assert.equal(firstPreview.summary.length, 512);
  assert.equal(firstPreview.summaryTruncated, true);
  assert.equal(activityAll.json.sessions.length, 1, "one normalized Session map replaces repeated titles");
  assert.equal(Array.from(activityAll.json.sessions[0].title).length, 120, "legacy title is truncated on egress");
  assert.ok(JSON.stringify(activityAll.json).length < 100_000, "legacy title cannot amplify each Activity row");
  assert.ok(activityAll.json.items.every((item: any) => item.session === undefined));
  const sessionsList = await api("/sessions");
  assert.equal(
    Array.from(sessionsList.json.sessions.find((session: any) => session.id === "session_read").title).length,
    120,
  );
  const collectionJson = JSON.stringify([activityOne.json, activityTwo.json, activityAll.json]);
  assert.doesNotMatch(collectionJson, /PAYLOAD_SECRET|RESULT_BODY_SECRET|private_agent_address|private\/artifact|never-list/);
  assert.doesNotMatch(collectionJson, /task_hidden_joined|task_hidden_parent_corrupt|task_visible_under_hidden|task_cross_tenant_corrupt|OTHER_USER_SECRET/);

  const run = await api("/sessions/session_read/run?agentLimit=1&taskLimit=1");
  assert.equal(run.status, 200);
  assert.equal(run.json.rootAgentId, root.id);
  assert.equal(run.json.agents.items.length, 1);
  assert.equal(run.json.tasks.items.length, 1);
  assert.ok(run.json.agents.nextCursor);
  assert.ok(run.json.tasks.nextCursor);
  assert.equal(run.json.counts.tasks, 5, "internal and malformed hidden-parent Tasks stay outside the read model");
  assert.doesNotMatch(JSON.stringify(run.json), /PAYLOAD_SECRET|RESULT_BODY_SECRET|private_agent_address/);

  const agentDetail = await api(`/orchestration/agents/${child.id}`);
  assert.equal(agentDetail.status, 200);
  assert.equal(agentDetail.json.agent.path, "/root/private_agent_address");
  assert.equal((await api(`/orchestration/agents/${joined.id}`)).status, 404);
  assert.equal((await api("/orchestration/agents/agent_visible_under_hidden")).status, 404);
  assert.equal((await api("/orchestration/agents/agent_deep_visible_under_hidden")).status, 404);
  assert.equal((await api("/orchestration/agents/agent_cross_tenant_root_corrupt")).status, 404);
  assert.equal((await api("/orchestration/agents/agent_fake_self_root")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_visible_under_hidden")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_hidden_parent_corrupt")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_deep_hidden_parent_corrupt")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_bad_owner_parent")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_child_of_bad_owner")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_bad_workflow_parent")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_child_of_bad_workflow")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_same_user_other_root_corrupt")).status, 404);
  assert.equal((await api("/orchestration/tasks/task_cross_tenant_corrupt")).status, 404);
  const hiddenAck = await api("/orchestration/tasks/task_visible_under_hidden/result/ack", {
    method: "POST",
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(hiddenAck.status, 404);
  assert.equal(taskResultDao.byTask(userId, "task_visible_under_hidden")!.acknowledgedAt, undefined);

  const taskDetail = await api(`/orchestration/tasks/${second.task.id}`);
  assert.equal(taskDetail.status, 200);
  assert.equal(taskDetail.json.task.payload.assignment, "PAYLOAD_SECRET_task_second");
  assert.equal(taskDetail.json.task.result.body, undefined);
  const resultDetail = await api(`/orchestration/tasks/${second.task.id}/result`);
  assert.equal(resultDetail.status, 200);
  assert.equal(resultDetail.json.result.body.text, "RESULT_BODY_SECRET_task_second");
  assert.equal(resultDetail.json.result.artifacts.path, "/private/artifact/task_second");

  assert.equal((await api(`/orchestration/tasks/${second.task.id}`, {}, otherToken)).status, 404);
  assert.equal((await api("/sessions/session_read/run", {}, otherToken)).status, 404);
  assert.equal((await api("/orchestration/activity?cursor=not-json")).status, 400);

  createTask("task_cursor_new", child.id, now + 50);
  const staleActivityPage = await api(
    `/orchestration/activity?limit=1&cursor=${activityOne.json.nextCursor}`,
  );
  assert.equal(staleActivityPage.status, 409);
  assert.deepEqual(staleActivityPage.json, { error: "cursor_stale", restart: true });
  const staleRunPage = await api(
    `/sessions/session_read/run?taskLimit=1&taskCursor=${run.json.tasks.nextCursor}`,
  );
  assert.equal(staleRunPage.status, 409);
  const restarted = await api("/orchestration/activity?limit=100");
  assert.ok(restarted.json.items.some((item: any) => item.task.id === "task_cursor_new"));
  assert.ok(restarted.json.items.some((item: any) => item.task.id === "task_first"));

  const invalidations: unknown[] = [];
  const unsubscribe = runtime.runtimeClient.subscribeUserStatus(userId, (event) => invalidations.push(event));
  const ack = await api(`/orchestration/tasks/${second.task.id}/result/ack`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: second.result.version }),
  });
  await settleInvalidations();
  unsubscribe();
  assert.equal(ack.status, 200);
  assert.equal(ack.json.result.version, second.result.version + 1);
  assert.ok(ack.json.result.acknowledgedAt);
  assert.ok(invalidations.some((event: any) =>
    event.type === "orchestration_invalidated"
    && event.resource === "session_run"
    && event.sessionId === "session_read"
    && event.revision === ack.json.revision
  ));
  assert.ok(invalidations.some((event: any) =>
    event.type === "orchestration_invalidated"
    && event.resource === "activity"
    && event.revision === ack.json.activityRevision
  ));
  assert.ok(invalidations.some((event: any) =>
    event.type === "orchestration_invalidation_snapshot" && event.snapshot.stale === true
  ));
  const staleAck = await api(`/orchestration/tasks/${second.task.id}/result/ack`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: second.result.version }),
  });
  assert.equal(staleAck.status, 409);

  let throwingCalls = 0;
  const stopThrowing = runtime.runtimeClient.subscribeUserStatus(userId, () => {
    throwingCalls += 1;
    throw new Error("listener probe");
  });
  const burstEvents: any[] = [];
  const stopBurst = runtime.runtimeClient.subscribeUserStatus(userId, (event) => burstEvents.push(event));
  burstEvents.length = 0;
  const thirdAck = runtime.runtimeClient.acknowledgeTaskResult(userId, third.task.id, third.result.version);
  const fourthAck = runtime.runtimeClient.acknowledgeTaskResult(userId, fourth.task.id, fourth.result.version);
  assert.equal(thirdAck.ok, true);
  assert.equal(fourthAck.ok, true, "a throwing listener cannot turn post-commit success into an error");
  await settleInvalidations();
  stopThrowing();
  stopBurst();
  assert.ok(throwingCalls >= 2);
  const burstSession = burstEvents.filter((event) =>
    event.type === "orchestration_invalidated" && event.resource === "session_run"
  );
  const burstActivity = burstEvents.filter((event) =>
    event.type === "orchestration_invalidated" && event.resource === "activity"
  );
  assert.equal(burstSession.length, 1, "same-resource burst is coalesced");
  assert.equal(burstActivity.length, 1, "account Activity burst is coalesced");
  if (fourthAck.ok) {
    assert.equal(burstSession[0].revision, fourthAck.revision);
    assert.equal(burstActivity[0].revision, fourthAck.activityRevision);
  }

  const managerState = runtime.runtimeClient as any;
  const overflowEvents: any[] = [];
  const stopOverflow = runtime.runtimeClient.subscribeUserStatus(
    "user_overflow_probe",
    (event) => overflowEvents.push(event),
  );
  overflowEvents.length = 0;
  for (let index = 0; index < 300; index += 1) {
    managerState.markOrchestrationDirty("user_overflow_probe", {
      resource: "session_run",
      sessionId: `session_overflow_${index}`,
      revision: index + 1,
    });
  }
  await settleInvalidations();
  assert.equal(overflowEvents.length, 1, "an oversized synchronous dirty burst becomes one stale edge");
  assert.equal(overflowEvents[0].type, "orchestration_invalidation_snapshot");
  assert.equal(overflowEvents[0].snapshot.stale, true);
  stopOverflow();
  for (let index = 0; index < 300; index += 1) {
    const stop = runtime.runtimeClient.subscribeUserStatus(`transient_user_${index}`, () => {});
    stop();
  }
  managerState.markOrchestrationDirty("no_listener_probe", { resource: "activity", revision: 1 });
  await settleInvalidations();
  assert.equal(managerState.orchestrationDirty.size, 0);
  assert.equal(managerState.orchestrationFlushTimers.size, 0);
  assert.equal(managerState.orchestrationSnapshotDirty.size, 0);
  assert.equal(managerState.orchestrationPublished.size, 0, "unsubscribed accounts leave no latch state");

  taskResultDeliveryDao.stage({
    userId,
    sessionId: "session_read",
    deliveryAgentId: root.id,
    deliveryStepId: "step_delivery_probe",
    results: [{ taskId: delivery.task.id, expectedVersion: delivery.result.version }],
    at: now + 60,
  });
  assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 1);
  assert.equal(taskResultDao.byTask(userId, delivery.task.id)!.acknowledgedAt, undefined);
  assert.deepEqual(taskResultDeliveryDao.commitPersisted(userId, "session_read", now + 61), []);
  assert.equal(taskResultDao.byTask(userId, delivery.task.id)!.acknowledgedAt, undefined);
  for (let index = 0; index < PENDING_RESULT_ACK_MAX_PER_DELIVERY_AGENT + 8; index += 1) {
    taskResultDeliveryDao.stage({
      userId,
      sessionId: "session_read",
      deliveryAgentId: root.id,
      deliveryStepId: `step_delivery_burst_${index}`,
      results: [{ taskId: delivery.task.id, expectedVersion: delivery.result.version }],
      at: now + 61,
    });
  }
  assert.equal(
    taskResultDeliveryDao.countPending(userId, root.id),
    PENDING_RESULT_ACK_MAX_PER_DELIVERY_AGENT,
    "one Agent cannot retain an unbounded number of pending delivery stages",
  );
  timelineDao.append("session_read", {
    kind: "tool",
    id: "step_delivery_probe",
    seq: timelineDao.maxSeq("session_read") + 1,
    name: "get_agent",
    toolKind: "subagent",
    arguments: { target: child.id },
    status: "success",
    resultText: "delivered result",
    isError: false,
    ts: now + 62,
  });
  assert.deepEqual(
    taskResultDeliveryDao.commitPersisted(userId, "session_read", now + 63),
    [],
    "Timeline Step success is not durable parent model context",
  );
  assert.equal(taskResultDao.byTask(userId, delivery.task.id)!.acknowledgedAt, undefined);
  messageDao.replaceAll("session_read", [{
    role: "toolResult",
    toolCallId: "step_delivery_probe",
    toolName: "get_agent",
    content: [{ type: "text", text: "delivered result" }],
    details: {},
    isError: false,
    timestamp: now + 62,
  }]);
  const deliveredChanges = taskResultDeliveryDao.commitPersisted(userId, "session_read", now + 63);
  assert.equal(deliveredChanges.length, 1);
  assert.ok(taskResultDao.byTask(userId, delivery.task.id)!.acknowledgedAt);
  assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 0);

  taskResultDeliveryDao.stage({
    userId,
    sessionId: "session_read",
    deliveryAgentId: root.id,
    deliveryStepId: "step_failed_delivery",
    results: [{ taskId: first.task.id, expectedVersion: first.result.version }],
    at: now + 63,
  });
  messageDao.replaceAll("session_read", [{
    role: "toolResult",
    toolCallId: "step_failed_delivery",
    toolName: "get_agent",
    content: [{ type: "text", text: "failed" }],
    details: {},
    isError: true,
    timestamp: now + 63,
  }]);
  assert.deepEqual(taskResultDeliveryDao.commitPersisted(userId, "session_read", now + 64), []);
  assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 0);
  assert.equal(taskResultDao.byTask(userId, first.task.id)!.acknowledgedAt, undefined);

  taskResultDeliveryDao.stage({
    userId,
    sessionId: "session_read",
    deliveryAgentId: root.id,
    deliveryStepId: "step_expired_delivery",
    results: [{ taskId: first.task.id, expectedVersion: first.result.version }],
    at: now - PENDING_RESULT_ACK_MAX_AGE_MS - 1,
  });
  assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 1);
  assert.deepEqual(taskResultDeliveryDao.commitPersisted(userId, "session_read", now + 64), []);
  assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 0);
  assert.equal(taskResultDao.byTask(userId, first.task.id)!.acknowledgedAt, undefined);

  taskResultDeliveryDao.stage({
    userId,
    sessionId: "session_read",
    deliveryAgentId: root.id,
    deliveryStepId: "step_superseded_by_http_ack",
    results: [{ taskId: first.task.id, expectedVersion: first.result.version }],
    at: now + 64,
  });
  const socket = path.join(tmp, "runtime.sock");
  const host = ipc.createRuntimeHost(runtime.runtimeClient, socket);
  await new Promise<void>((resolve) => host.once("listening", resolve));
  try {
    const split = ipc.makeRuntimeHttpClient(socket);
    const splitAck = await split.acknowledgeTaskResult(userId, first.task.id, first.result.version);
    assert.equal(splitAck.ok, true);
    if (splitAck.ok) assert.equal(splitAck.result.version, first.result.version + 1);
    assert.equal(taskResultDeliveryDao.countPending(userId, root.id), 0);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }

  const coldEvents: any[] = [];
  const stopCold = runtime.runtimeClient.subscribeUserStatus(userId, (event) => coldEvents.push(event));
  const initialColdSnapshot = coldEvents.find((event) => event.type === "orchestration_invalidation_snapshot");
  assert.ok(initialColdSnapshot);
  assert.equal(
    initialColdSnapshot.snapshot.sessionRuns.some((entry: any) => entry.sessionId === "session_empty"),
    false,
  );
  runtime.runtimeClient.getRuntime(userId, "session_empty");
  await settleInvalidations();
  assert.ok(coldEvents.some((event) =>
    event.type === "orchestration_invalidated"
    && event.resource === "session_run"
    && event.sessionId === "session_empty"
  ));
  stopCold();
  runtime.runtimeClient.disposeUserRuntimes(userId);
  const reconnectEvents: any[] = [];
  const stopReconnect = runtime.runtimeClient.subscribeUserStatus(userId, (event) => reconnectEvents.push(event));
  stopReconnect();
  const reconnectSnapshot = reconnectEvents.find((event) => event.type === "orchestration_invalidation_snapshot");
  assert.equal(reconnectSnapshot.snapshot.stale, true);
  assert.ok(reconnectSnapshot.snapshot.sessionRuns.some((entry: any) =>
    entry.sessionId === "session_empty" && entry.revision >= 1
  ));

  createSession("session_delete_root_two", userId);
  createSession("session_delete_member", userId);
  const rootTwo = agentNodeDao.create({
    id: "agent_delete_root_two",
    userId,
    sessionId: "session_delete_root_two",
    rootAgentId: "agent_delete_root_two",
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now + 70,
  });
  const childTwo = agentNodeDao.create({
    id: "agent_delete_child_two",
    userId,
    sessionId: "session_delete_root_two",
    rootAgentId: rootTwo.id,
    parentAgentId: rootTwo.id,
    path: "/root/delete_probe",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    status: "idle",
    createdAt: now + 71,
  });
  runtimeTaskDao.create({
    id: "task_delete_owner_one",
    userId,
    sessionId: "session_read",
    ownerSessionId: "session_delete_member",
    agentId: child.id,
    kind: "delegation",
    title: "Deletion root one",
    payload: {},
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now + 72,
  });
  runtimeTaskDao.create({
    id: "task_delete_owner_two",
    userId,
    sessionId: "session_delete_root_two",
    ownerSessionId: "session_delete_member",
    agentId: childTwo.id,
    kind: "delegation",
    title: "Deletion root two",
    payload: {},
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now + 73,
  });
  const beforeDeleteOne = agentNodeDao.addressableRosterRevision(userId, root.id)!;
  const beforeDeleteTwo = agentNodeDao.addressableRosterRevision(userId, rootTwo.id)!;
  const beforeDeleteActivity = orchestrationRevisionDao.activity(userId);
  const deleteEvents: any[] = [];
  const stopDelete = runtime.runtimeClient.subscribeUserStatus(userId, (event) => deleteEvents.push(event));
  deleteEvents.length = 0;
  assert.equal(runtime.runtimeClient.deleteSession(userId, "session_delete_member"), true);
  await settleInvalidations();
  stopDelete();
  assert.equal(agentNodeDao.addressableRosterRevision(userId, root.id), beforeDeleteOne + 1);
  assert.equal(agentNodeDao.addressableRosterRevision(userId, rootTwo.id), beforeDeleteTwo + 1);
  assert.ok(orchestrationRevisionDao.activity(userId) > beforeDeleteActivity);
  const deletedRootEvents = deleteEvents.filter((event) =>
    event.type === "orchestration_invalidated" && event.resource === "session_run"
  );
  assert.deepEqual(
    new Set(deletedRootEvents.map((event) => event.sessionId)),
    new Set(["session_read", "session_delete_root_two"]),
  );
  assert.equal(
    deleteEvents.filter((event) =>
      event.type === "orchestration_invalidated" && event.resource === "activity"
    ).length,
    1,
  );
  assert.equal(runtimeTaskDao.byId(userId, "task_delete_owner_one"), undefined);
  assert.equal(runtimeTaskDao.byId(userId, "task_delete_owner_two"), undefined);

  createSession("session_workflow_controller_delete", userId);
  const workflowController = agentNodeDao.create({
    id: "agent_workflow_controller_delete",
    userId,
    sessionId: "session_workflow_controller_delete",
    rootAgentId: "agent_workflow_controller_delete",
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now + 78,
  });
  assert.throws(() => db.prepare(
    `INSERT INTO workflows
      (id, user_id, owner_session_id, root_agent_id, controller_agent_id, name, status,
       version, created_at, updated_at)
     VALUES ('workflow_controller_delete_probe', ?, 'session_read', ?, ?,
       'Controller ownership probe', 'running', 1, ?, ?)`,
  ).run(userId, root.id, workflowController.id, now + 79, now + 79),
  /invalid Workflow ownership or limits/);
  sessionDao.delete("session_workflow_controller_delete");

  createSession("session_team_lead_delete", userId);
  const teamLead = agentNodeDao.create({
    id: "agent_team_lead_delete",
    userId,
    sessionId: "session_team_lead_delete",
    rootAgentId: "agent_team_lead_delete",
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now + 79,
  });
  db.prepare(
    `INSERT INTO teams
      (id, user_id, owner_session_id, root_agent_id, owner_session_ref,
       root_agent_ref, lead_agent_id, name, status,
       version, created_at, updated_at)
     VALUES ('team_lead_delete_probe', ?, 'session_read', ?, 'session_read', ?, ?,
       'Lead delete probe', 'active', 1, ?, ?)`,
  ).run(userId, root.id, root.id, teamLead.id, now + 79, now + 79);
  const teamDeleteEvents: any[] = [];
  const stopTeamDelete = runtime.runtimeClient.subscribeUserStatus(
    userId,
    (event) => teamDeleteEvents.push(event),
  );
  teamDeleteEvents.length = 0;
  assert.equal(runtime.runtimeClient.deleteSession(userId, "session_team_lead_delete"), true);
  await settleInvalidations();
  stopTeamDelete();
  const leadCleared = db.prepare(
    "SELECT lead_agent_id, version FROM teams WHERE id = 'team_lead_delete_probe'",
  ).get() as { lead_agent_id: string | null; version: number };
  assert.equal(leadCleared.lead_agent_id, null);
  assert.equal(leadCleared.version, 2);
  assert.ok(teamDeleteEvents.some((event) =>
    event.type === "orchestration_invalidated"
    && event.resource === "team"
    && event.teamId === "team_lead_delete_probe"
    && event.version === 2
  ));

  createSession("session_workflow_owner_delete", userId);
  const workflowDeleteRoot = agentNodeDao.create({
    id: "agent_workflow_owner_delete_root",
    userId,
    sessionId: "session_workflow_owner_delete",
    rootAgentId: "agent_workflow_owner_delete_root",
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now + 80,
  });
  const workflowDeleteChild = agentNodeDao.create({
    id: "agent_workflow_owner_delete_child",
    userId,
    sessionId: "session_workflow_owner_delete",
    rootAgentId: workflowDeleteRoot.id,
    parentAgentId: workflowDeleteRoot.id,
    path: "/root/worker",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    status: "idle",
    createdAt: now + 80,
  });
  db.prepare(
    `INSERT INTO workflows
      (id, user_id, owner_session_id, root_agent_id, name, status,
       version, created_at, updated_at)
     VALUES ('workflow_delete_probe', ?, 'session_workflow_owner_delete', ?,
       'Delete probe', 'running', 1, ?, ?)`,
  ).run(userId, workflowDeleteRoot.id, now + 80, now + 80);
  db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
       payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
       activity, wait_reason, lease_generation, version, created_at, updated_at,
       started_at, settled_at)
     VALUES ('task_workflow_owner_delete', ?, 'session_workflow_owner_delete',
       'session_workflow_owner_delete', NULL, NULL, ?, 1, NULL,
       'workflow_delete_probe', 'workflow_node', 'Workflow owner deletion', '{}', 2,
       'queued', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
  ).run(userId, workflowDeleteChild.id, now + 81, now + 81);
  const beforeWorkflowDeleteActivity = orchestrationRevisionDao.activity(userId);
  const workflowDeleteEvents: any[] = [];
  const stopWorkflowDelete = runtime.runtimeClient.subscribeUserStatus(
    userId,
    (event) => workflowDeleteEvents.push(event),
  );
  workflowDeleteEvents.length = 0;
  assert.equal(runtime.runtimeClient.deleteSession(userId, "session_workflow_owner_delete"), true);
  await settleInvalidations();
  stopWorkflowDelete();
  assert.equal(runtimeTaskDao.byId(userId, "task_workflow_owner_delete"), undefined);
  assert.equal(
    db.prepare("SELECT 1 FROM workflows WHERE id = 'workflow_delete_probe'").get(),
    undefined,
  );
  assert.ok(orchestrationRevisionDao.activity(userId) > beforeWorkflowDeleteActivity);
  assert.ok(workflowDeleteEvents.some((event) =>
    event.type === "orchestration_invalidated"
    && event.resource === "activity"
  ));

  runtimeTaskDao.create({
    id: "task_delete_root_self",
    userId,
    sessionId: "session_delete_root_two",
    ownerSessionId: "session_delete_root_two",
    agentId: childTwo.id,
    kind: "delegation",
    title: "Delete complete root",
    payload: {},
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now + 74,
  });
  const rootDeleteEvents: any[] = [];
  const stopRootDelete = runtime.runtimeClient.subscribeUserStatus(userId, (event) => rootDeleteEvents.push(event));
  rootDeleteEvents.length = 0;
  assert.equal(runtime.runtimeClient.deleteSession(userId, "session_delete_root_two"), true);
  await settleInvalidations();
  stopRootDelete();
  assert.ok(rootDeleteEvents.some((event) =>
    event.type === "orchestration_invalidated" && event.resource === "activity"
  ));
  assert.equal(rootDeleteEvents.some((event) =>
    event.type === "orchestration_invalidated"
    && event.resource === "session_run"
    && event.sessionId === "session_delete_root_two"
  ), false, "a deleted root has no surviving Run resource to invalidate");

  console.log("OK orchestration-read-model: hardened ownership + cursors + delivery CAS + invalidation");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
