import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BASE_TASK_COUNT = 2_500;
const SCALE_TASK_COUNT = 5_000;
const TASK_PAYLOAD_BYTES = 32 * 1024;
const MAX_BASE_ELAPSED_MS = 1_500;
const MAX_SCALE_ELAPSED_MS = 3_000;
const MAX_RSS_DELTA_BYTES = 48 * 1024 * 1024;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-delete-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");

try {
  const {
    agentNodeDao,
    db,
    detachWorkflowTasksOwnedBySessionInTransaction,
    runInTransaction,
    sessionDao,
    userDao,
    WORKFLOW_TASK_DETACH_EVENT_INSERT_SQL,
  } = await import("../server/src/persistence/index.ts");
  db.exec("PRAGMA cache_size = -8192;");

  const now = 1_900_000_000_000;
  const userId = "user_delete_profile";
  const ownerSessionId = "session_delete_profile_owner";
  const scaleOwnerSessionId = "session_delete_profile_scale_owner";
  const executionSessionId = "session_delete_profile_execution";
  userDao.create({
    id: userId,
    email: "delete-profile@example.invalid",
    password_hash: "x",
    created_at: now,
  });
  const createSession = (id: string): void => sessionDao.create({
    id,
    user_id: userId,
    title: "Delete profile",
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
    cwd: "/tmp/delete-profile",
    created_at: now,
    updated_at: now,
  });
  createSession(ownerSessionId);
  createSession(scaleOwnerSessionId);
  createSession(executionSessionId);
  const root = agentNodeDao.create({
    id: "agent_delete_profile_root",
    userId,
    sessionId: executionSessionId,
    rootAgentId: "agent_delete_profile_root",
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now,
  });
  const child = agentNodeDao.create({
    id: "agent_delete_profile_child",
    userId,
    sessionId: executionSessionId,
    rootAgentId: root.id,
    parentAgentId: root.id,
    path: "/root/profile",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    status: "idle",
    createdAt: now + 1,
  });
  const insertWorkflow = db.prepare(
    `INSERT INTO workflows
      (id, user_id, owner_session_id, root_agent_id, name, status,
       version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Delete profile', 'running', 1, ?, ?)`,
  );
  const baseWorkflowId = "workflow_delete_profile_base";
  const scaleWorkflowId = "workflow_delete_profile_scale";
  assert.throws(
    () => insertWorkflow.run(baseWorkflowId, userId, ownerSessionId, root.id, now + 2, now + 2),
    /invalid Workflow ownership or limits/,
    "new Workflows cannot split their owner and Agent-root Sessions",
  );
  const workflowInsertTrigger = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'workflows_validate_graph_insert'",
  ).get() as { sql: string };
  db.exec("DROP TRIGGER workflows_validate_graph_insert");
  try {
    insertWorkflow.run(baseWorkflowId, userId, ownerSessionId, root.id, now + 2, now + 2);
    insertWorkflow.run(scaleWorkflowId, userId, scaleOwnerSessionId, root.id, now + 3, now + 3);
  } finally {
    db.exec(workflowInsertTrigger.sql);
  }

  const emptyPayloadBytes = Buffer.byteLength(JSON.stringify({ history: "" }), "utf8");
  const payloadJson = JSON.stringify({
    history: "x".repeat(TASK_PAYLOAD_BYTES - emptyPayloadBytes),
  });
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  assert.equal(payloadBytes, TASK_PAYLOAD_BYTES);
  const statuses = [
    "queued",
    "starting",
    "running",
    "waiting",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ] as const;
  const insertTask = db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, kind, title,
       payload_json, payload_bytes, status, await_policy, cancel_policy,
       checkpoint_safe, activity, wait_reason, lease_generation, version,
       created_at, updated_at, started_at, settled_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?,
       'workflow_node', 'Delete profile row', ?, ?, ?, 'background', 'detached',
       0, 'model', 'signal', 3, 7, ?, ?, ?, ?)`,
  );
  const insertSeedEvent = db.prepare(
    `INSERT INTO task_events
      (task_id, seq, task_version, lease_generation, type, payload_json, payload_bytes, created_at)
     VALUES (?, 1, 7, 3, 'task:seeded', '{}', 2, ?)`,
  );
  const seedTasks = (input: {
    count: number;
    prefix: string;
    workflowId: string;
    agentOrdStart: number;
  }): void => {
    db.exec("BEGIN");
    try {
      for (let index = 0; index < input.count; index += 1) {
        const id = `${input.prefix}${String(index).padStart(4, "0")}`;
        const status = statuses[index % statuses.length];
        const updatedAt = now + 10 + index;
        const terminal = status === "succeeded" || status === "failed"
          || status === "cancelled" || status === "interrupted";
        insertTask.run(
          id,
          userId,
          executionSessionId,
          executionSessionId,
          child.id,
          input.agentOrdStart + index,
          input.workflowId,
          payloadJson,
          payloadBytes,
          status,
          updatedAt - 1,
          updatedAt,
          status === "queued" ? null : updatedAt - 1,
          terminal ? updatedAt : null,
        );
        insertSeedEvent.run(id, updatedAt);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const basePrefix = "task_delete_profile_base_";
  const scalePrefix = "task_delete_profile_scale_";
  seedTasks({
    count: BASE_TASK_COUNT,
    prefix: basePrefix,
    workflowId: baseWorkflowId,
    agentOrdStart: 0,
  });

  const baseDetachedAt = now + BASE_TASK_COUNT + 100;
  const planEvent = JSON.stringify([[
    `${basePrefix}0000`,
    8,
    3,
    "workflow:cancelled",
    "{}",
    2,
    baseDetachedAt,
  ]]);
  const eventPlan = db.prepare(`EXPLAIN QUERY PLAN ${WORKFLOW_TASK_DETACH_EVENT_INSERT_SQL}`)
    .all(planEvent) as unknown as Array<{ detail: string }>;
  const eventPlanText = eventPlan.map((row) => row.detail).join("\n");
  assert.match(
    eventPlanText,
    /SEARCH task USING INDEX sqlite_autoindex_runtime_tasks_1 \(id=\?\)/,
    "detach event batches must probe their 128 exact Task ids",
  );
  assert.doesNotMatch(
    eventPlanText,
    /SEARCH task USING INDEX idx_runtime_tasks_workflow_fk/,
    "workflow_id IS NULL must not drive a growing rescan",
  );

  assert.equal(typeof globalThis.gc, "function", "run this check with --expose-gc");
  const measureDetach = (input: {
    ownerSessionId: string;
    count: number;
    detachedAt: number;
  }): {
    elapsedMs: number;
    rssDeltaBytes: number;
    heapDeltaBytes: number;
  } => {
    globalThis.gc?.();
    const before = process.memoryUsage();
    const started = performance.now();
    const changed = runInTransaction(() =>
      detachWorkflowTasksOwnedBySessionInTransaction(input.ownerSessionId, input.detachedAt));
    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    const rssDeltaBytes = Math.max(0, after.rss - before.rss);
    const heapDeltaBytes = Math.max(0, after.heapUsed - before.heapUsed);
    assert.equal(changed, input.count);
    assert.ok(
      rssDeltaBytes < MAX_RSS_DELTA_BYTES,
      `Workflow detach retained ${(rssDeltaBytes / 1024 / 1024).toFixed(1)} MiB RSS`,
    );
    return { elapsedMs, rssDeltaBytes, heapDeltaBytes };
  };

  const base = measureDetach({
    ownerSessionId,
    count: BASE_TASK_COUNT,
    detachedAt: baseDetachedAt,
  });
  assert.ok(
    base.elapsedMs < MAX_BASE_ELAPSED_MS,
    `2.5k Workflow detach took ${base.elapsedMs.toFixed(1)}ms`,
  );

  const summary = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(workflow_id IS NULL) AS detached,
            SUM(version = 8) AS versioned,
            SUM(updated_at = ?) AS updated,
            SUM(activity IS NULL AND wait_reason IS NULL) AS cleared
     FROM runtime_tasks
     WHERE user_id = ? AND session_id = ? AND id GLOB ?`,
  ).get(baseDetachedAt, userId, executionSessionId, `${basePrefix}*`) as {
    total: number;
    detached: number;
    versioned: number;
    updated: number;
    cleared: number;
  };
  assert.deepEqual(
    Object.values(summary).map(Number),
    [BASE_TASK_COUNT, BASE_TASK_COUNT, BASE_TASK_COUNT, BASE_TASK_COUNT, BASE_TASK_COUNT],
  );
  const eventSummary = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(event.seq = 2 AND event.task_version = 8 AND event.lease_generation = 3) AS versioned
     FROM task_events event
     JOIN runtime_tasks task ON task.id = event.task_id
     WHERE event.type LIKE 'workflow:%' AND task.id GLOB ?`,
  ).get(`${basePrefix}*`) as { total: number; versioned: number };
  assert.equal(Number(eventSummary.total), BASE_TASK_COUNT);
  assert.equal(Number(eventSummary.versioned), BASE_TASK_COUNT);

  for (let index = 0; index < statuses.length; index += 1) {
    const priorStatus = statuses[index];
    const expectedStatus = priorStatus === "queued"
      ? "cancelled"
      : priorStatus === "starting" || priorStatus === "running"
        || priorStatus === "waiting" || priorStatus === "cancel_requested"
        ? "interrupted"
        : priorStatus;
    const terminal = priorStatus === "succeeded" || priorStatus === "failed"
      || priorStatus === "cancelled" || priorStatus === "interrupted";
    const id = `${basePrefix}${String(index).padStart(4, "0")}`;
    const row = db.prepare(
      `SELECT status, settled_at FROM runtime_tasks WHERE id = ?`,
    ).get(id) as { status: string; settled_at: number | null };
    assert.equal(row.status, expectedStatus);
    assert.equal(row.settled_at, terminal ? now + 10 + index : baseDetachedAt);
    const event = db.prepare(
      `SELECT type, payload_json, created_at FROM task_events WHERE task_id = ? AND seq = 2`,
    ).get(id) as { type: string; payload_json: string; created_at: number };
    assert.equal(event.type, terminal ? "workflow:detached" : `workflow:${expectedStatus}`);
    assert.deepEqual(JSON.parse(event.payload_json), {
      workflowId: baseWorkflowId,
      reason: "owner_session_deleted",
      priorStatus,
      status: expectedStatus,
    });
    assert.equal(event.created_at, baseDetachedAt);
  }

  seedTasks({
    count: SCALE_TASK_COUNT,
    prefix: scalePrefix,
    workflowId: scaleWorkflowId,
    agentOrdStart: BASE_TASK_COUNT,
  });
  const scaleDetachedAt = now + 100_000;
  const scale = measureDetach({
    ownerSessionId: scaleOwnerSessionId,
    count: SCALE_TASK_COUNT,
    detachedAt: scaleDetachedAt,
  });
  assert.ok(
    scale.elapsedMs < MAX_SCALE_ELAPSED_MS,
    `5k Workflow detach took ${scale.elapsedMs.toFixed(1)}ms`,
  );
  assert.ok(
    scale.elapsedMs <= Math.max(900, base.elapsedMs * 3),
    `doubling Task count grew detach from ${base.elapsedMs.toFixed(1)}ms to ${scale.elapsedMs.toFixed(1)}ms`,
  );
  const scaleSummary = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(workflow_id IS NULL AND version = 8 AND updated_at = ?) AS detached
     FROM runtime_tasks WHERE id GLOB ?`,
  ).get(scaleDetachedAt, `${scalePrefix}*`) as { total: number; detached: number };
  assert.deepEqual(
    [Number(scaleSummary.total), Number(scaleSummary.detached)],
    [SCALE_TASK_COUNT, SCALE_TASK_COUNT],
  );

  console.log(JSON.stringify({
    check: "orchestration-delete-performance",
    payloadKiB: TASK_PAYLOAD_BYTES / 1024,
    planIndex: "sqlite_autoindex_runtime_tasks_1",
    base: {
      tasks: BASE_TASK_COUNT,
      elapsedMs: Number(base.elapsedMs.toFixed(2)),
      rssDeltaMiB: Number((base.rssDeltaBytes / 1024 / 1024).toFixed(2)),
      heapDeltaMiB: Number((base.heapDeltaBytes / 1024 / 1024).toFixed(2)),
    },
    scale: {
      tasks: SCALE_TASK_COUNT,
      elapsedMs: Number(scale.elapsedMs.toFixed(2)),
      rssDeltaMiB: Number((scale.rssDeltaBytes / 1024 / 1024).toFixed(2)),
      heapDeltaMiB: Number((scale.heapDeltaBytes / 1024 / 1024).toFixed(2)),
    },
  }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
