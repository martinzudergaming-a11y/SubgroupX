import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const IRRELEVANT_OPEN_TASKS = 50_000;
const SAME_ROOT_MALFORMED_TASKS = 50_000;
const MALFORMED_BASELINE_TASKS = 5_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-scheduler-visibility-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");

try {
  const [persistence, visibility] = await Promise.all([
    import("../server/src/persistence/index.ts"),
    import("../server/src/persistence/orchestration-visibility.ts"),
  ]);
  const { agentNodeDao, db, runtimeTaskDao, sessionDao, userDao } = persistence;
  const now = 1_900_000_000_000;
  const userId = "user_scheduler_profile";
  userDao.create({
    id: userId,
    email: "scheduler-profile@example.invalid",
    password_hash: "x",
    created_at: now,
  });

  const createRoot = (name: string) => {
    const sessionId = `session_${name}`;
    const rootId = `agent_${name}_root`;
    sessionDao.create({
      id: sessionId,
      user_id: userId,
      title: name,
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
      cwd: "/tmp/scheduler-profile",
      created_at: now,
      updated_at: now,
    });
    agentNodeDao.create({
      id: rootId,
      userId,
      sessionId,
      rootAgentId: rootId,
      path: "/root",
      kind: "session",
      status: "idle",
      createdAt: now,
    });
    return { sessionId, rootId };
  };
  const target = createRoot("scheduler_target");
  const irrelevant = createRoot("scheduler_irrelevant");
  const deepAgent = agentNodeDao.create({
    id: "agent_scheduler_deep",
    userId,
    sessionId: target.sessionId,
    rootAgentId: target.rootId,
    parentAgentId: target.rootId,
    path: "/root/deep",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    status: "idle",
    createdAt: now + 1,
  });
  const cycleAgent = agentNodeDao.create({
    id: "agent_scheduler_cycle",
    userId,
    sessionId: target.sessionId,
    rootAgentId: target.rootId,
    parentAgentId: target.rootId,
    path: "/root/cycle",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    status: "idle",
    createdAt: now + 1,
  });
  const joined = agentNodeDao.create({
    id: "agent_scheduler_irrelevant_slot",
    userId,
    sessionId: irrelevant.sessionId,
    rootAgentId: irrelevant.rootId,
    parentAgentId: irrelevant.rootId,
    path: "/root/joined_slot_1",
    label: "Joined delegation slot",
    provider: "mock",
    model: "mock-coder",
    kind: "subagent",
    purpose: "joined_slot",
    status: "idle",
    createdAt: now + 1,
  });
  db.prepare(
    `INSERT INTO agent_nodes
      (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
       provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
     VALUES ('agent_scheduler_irrelevant_hidden', ?, ?, ?, ?, '/root/joined_slot_1/hidden',
       'Hidden', 'mock', 'mock-coder', 'medium', 'subagent', 'addressable', 'idle', 1, ?, ?)`,
  ).run(userId, irrelevant.sessionId, irrelevant.rootId, joined.id, now + 2, now + 2);
  db.prepare(
    `INSERT INTO workflows
      (id, user_id, owner_session_id, root_agent_id, name, status,
       version, created_at, updated_at)
     VALUES ('workflow_scheduler_wrong_root', ?, ?, ?, 'Wrong root', 'running', 1, ?, ?)`,
  ).run(userId, irrelevant.sessionId, irrelevant.rootId, now + 2, now + 2);

  const insertTask = db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
       payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
       activity, wait_reason, lease_generation, version, created_at, updated_at,
       started_at, settled_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'delegation', 'Scheduler profile',
       '{}', 2, ?, 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (let index = 0; index < IRRELEVANT_OPEN_TASKS; index += 1) {
      const at = now + 10 + index;
      insertTask.run(
        `task_irrelevant_${String(index).padStart(5, "0")}`,
        userId,
        irrelevant.sessionId,
        irrelevant.sessionId,
        "agent_scheduler_irrelevant_hidden",
        index + 1,
        null,
        null,
        "queued",
        at,
        at,
        null,
        null,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  let malformedInserted = 0;
  const addMalformedUntil = (targetCount: number): void => {
    db.exec("BEGIN");
    try {
      while (malformedInserted < targetCount) {
        const index = malformedInserted;
        const at = now + 70_000 + index;
        insertTask.run(
          `task_same_root_malformed_${String(index).padStart(5, "0")}`,
          userId,
          target.sessionId,
          target.sessionId,
          deepAgent.id,
          10_000 + index,
          null,
          "workflow_scheduler_wrong_root",
          "queued",
          at,
          at,
          null,
          null,
        );
        malformedInserted += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  let parentTaskId: string | null = null;
  const appendDepth = (from: number, to: number): string => {
    db.exec("BEGIN");
    try {
      for (let depth = from; depth <= to; depth += 1) {
        const id = `task_deep_${String(depth).padStart(4, "0")}`;
        const terminal = depth < to;
        const at = now + 100_000 + depth;
        insertTask.run(
          id,
          userId,
          target.sessionId,
          target.sessionId,
          deepAgent.id,
          depth,
          parentTaskId,
          null,
          terminal ? "succeeded" : "queued",
          at,
          at,
          terminal ? at : null,
          terminal ? at : null,
        );
        parentTaskId = id;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return parentTaskId!;
  };

  const runSample = (depth: number): { listMs: number; countMs: number } => {
    const listStarted = performance.now();
    const open = runtimeTaskDao.listOpenByRoot(userId, target.rootId, 100);
    const listMs = performance.now() - listStarted;
    assert.deepEqual(open.map((task) => task.id), [`task_deep_${String(depth).padStart(4, "0")}`]);
    const countStarted = performance.now();
    assert.equal(runtimeTaskDao.countRunnableByRoot(userId, target.rootId), 1);
    const countMs = performance.now() - countStarted;
    return { listMs, countMs };
  };

  const runnablePlanSql = `${visibility.SESSION_EXECUTABLE_OPEN_CTE}
    SELECT COUNT(*) AS count
    FROM executable_open_tasks visible
    CROSS JOIN runtime_tasks t
    WHERE t.id = visible.id
      AND (t.status IN ('starting', 'running', 'cancel_requested')
       OR (
         t.status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM executable_open_tasks visible_earlier
           CROSS JOIN runtime_tasks earlier
           WHERE earlier.id = visible_earlier.id
             AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
             AND earlier.status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
         )
       ))`;

  appendDepth(1, 200);
  addMalformedUntil(MALFORMED_BASELINE_TASKS);
  const width5k = runSample(200);
  addMalformedUntil(SAME_ROOT_MALFORMED_TASKS);
  const width50k = runSample(200);
  db.prepare(
    `UPDATE runtime_tasks SET status = 'succeeded', started_at = ?, settled_at = ?
     WHERE id = 'task_deep_0200'`,
  ).run(now + 100_200, now + 100_200);
  appendDepth(201, 500);

  for (const [id, ord] of [["task_cycle_a", 1], ["task_cycle_b", 2]] as const) {
    insertTask.run(
      id,
      userId,
      target.sessionId,
      target.sessionId,
      cycleAgent.id,
      ord,
      null,
      null,
      "queued",
      now + 101_000 + ord,
      now + 101_000 + ord,
      null,
      null,
    );
  }
  db.prepare("UPDATE runtime_tasks SET parent_task_id = 'task_cycle_b' WHERE id = 'task_cycle_a'").run();
  db.prepare("UPDATE runtime_tasks SET parent_task_id = 'task_cycle_a' WHERE id = 'task_cycle_b'").run();

  const depth500 = runSample(500);
  assert.ok(width50k.listMs < timeBudgetMs(2_000) && width50k.countMs < timeBudgetMs(2_000));
  assert.ok(depth500.listMs < timeBudgetMs(2_000) && depth500.countMs < timeBudgetMs(2_000));
  assert.ok(
    width50k.listMs / SAME_ROOT_MALFORMED_TASKS
      <= Math.max(0.02, 4 * width5k.listMs / MALFORMED_BASELINE_TASKS),
    "same-root malformed scan grows faster than its candidate corpus",
  );
  assert.ok(
    depth500.listMs / 500 <= Math.max(0.2, 4 * width50k.listMs / 200),
    "deep executable scan grows faster than its parent chain",
  );
  const malformedClaimStarted = performance.now();
  assert.equal(runtimeTaskDao.claim({
    id: "task_same_root_malformed_00000",
    userId,
    expectedVersion: 1,
    at: now + 101_999,
  }), null, "a same-root bad-Workflow Task fails closed at the exact claim boundary");
  const malformedClaimMs = performance.now() - malformedClaimStarted;
  assert.ok(malformedClaimMs < timeBudgetMs(1_000), `malformed exact claim took ${malformedClaimMs.toFixed(1)}ms`);
  assert.equal(runtimeTaskDao.claim({
    id: "task_cycle_a",
    userId,
    expectedVersion: 1,
    at: now + 102_000,
  }), null, "a cyclic Task chain fails closed at the exact claim boundary");

  const claimStarted = performance.now();
  const claimed = runtimeTaskDao.claim({
    id: "task_deep_0500",
    userId,
    expectedVersion: 1,
    at: now + 102_001,
  });
  const claimMs = performance.now() - claimStarted;
  assert.equal(claimed?.status, "starting");
  assert.ok(claimMs < timeBudgetMs(2_000), `500-deep exact claim took ${claimMs.toFixed(1)}ms`);

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${runnablePlanSql}`)
    .all(target.rootId, userId, target.sessionId) as unknown as Array<{ detail: string }>;
  const planText = plan.map((row) => row.detail).join("\n");
  assert.match(planText, /idx_runtime_tasks_agent_open/);
  assert.match(planText, /SEARCH parent USING INDEX sqlite_autoindex_runtime_tasks_1 \(id=\?\)/);

  console.log(JSON.stringify({
    check: "orchestration-scheduler-performance",
    irrelevantOpenTasks: IRRELEVANT_OPEN_TASKS,
    malformedOpenTasks: SAME_ROOT_MALFORMED_TASKS,
    width5k: {
      listMs: Number(width5k.listMs.toFixed(2)),
      countMs: Number(width5k.countMs.toFixed(2)),
    },
    width50k: {
      listMs: Number(width50k.listMs.toFixed(2)),
      countMs: Number(width50k.countMs.toFixed(2)),
      malformedClaimMs: Number(malformedClaimMs.toFixed(2)),
    },
    depth500: {
      listMs: Number(depth500.listMs.toFixed(2)),
      countMs: Number(depth500.countMs.toFixed(2)),
      claimMs: Number(claimMs.toFixed(2)),
    },
  }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
