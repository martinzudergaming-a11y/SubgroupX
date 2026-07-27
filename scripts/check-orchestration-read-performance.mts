import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-read-profile-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");

try {
  const [persistence, readModel] = await Promise.all([
    import("../server/src/persistence/index.ts"),
    import("../server/src/orchestration/read-model.ts"),
  ]);
  const { db, userDao, sessionDao, agentNodeDao, teamDao } = persistence;
  const now = 1_900_000_000_000;

  function createProfile(input: {
    suffix: string;
    email: string;
  }): { userId: string; sessionId: string; rootId: string; childId: string } {
    const userId = `user_${input.suffix}`;
    const sessionId = `session_${input.suffix}`;
    const rootId = `agent_${input.suffix}_root`;
    const childId = `agent_${input.suffix}_child`;
    userDao.create({
      id: userId,
      email: input.email,
      password_hash: "x",
      created_at: now,
    });
    sessionDao.create({
      id: sessionId,
      user_id: userId,
      title: "Read profile",
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
      cwd: "/tmp/read-profile",
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
    agentNodeDao.create({
      id: childId,
      userId,
      sessionId,
      rootAgentId: rootId,
      parentAgentId: rootId,
      path: "/root/profile",
      provider: "mock",
      model: "mock-coder",
      kind: "subagent",
      status: "idle",
      createdAt: now + 1,
    });
    return { userId, sessionId, rootId, childId };
  }

  function medianReadMs(read: () => void, iterations = 8): number {
    read();
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      for (let iteration = 0; iteration < iterations; iteration += 1) read();
      samples.push((performance.now() - started) / iterations);
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)]!;
  }

  const width = createProfile({
    suffix: "count_profile",
    email: "count-profile@example.invalid",
  });
  const widthTeamId = "team_count_profile";
  const widthMemberId = "member_count_profile";
  const widthTeamTaskId = "task_count_team";
  teamDao.create({
    id: widthTeamId,
    userId: width.userId,
    ownerSessionId: width.sessionId,
    actorSessionId: width.sessionId,
    rootAgentId: width.rootId,
    name: "Count profile Team",
    members: [{
      id: widthMemberId,
      sessionId: width.sessionId,
      agentId: width.rootId,
      role: "profile",
    }],
    leadMemberId: widthMemberId,
    createdAt: now + 2,
  });
  db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, team_id, kind, title,
       payload_json, payload_bytes, status, await_policy, cancel_policy,
       checkpoint_safe, activity, wait_reason, lease_generation, version,
       created_at, updated_at, started_at, settled_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, NULL, NULL, ?, 'team_turn', 'Profile Team Task',
       '{}', 2, 'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1,
       ?, ?, ?, ?)`,
  ).run(
    widthTeamTaskId,
    width.userId,
    width.sessionId,
    width.sessionId,
    width.rootId,
    widthTeamId,
    now + 3,
    now + 3,
    now + 3,
    now + 3,
  );
  const countParams = [
    width.rootId,
    width.userId,
    width.sessionId,
    width.userId,
    width.sessionId,
    width.rootId,
  ] as const;
  const countPlan = db.prepare(`EXPLAIN QUERY PLAN ${readModel.SESSION_RUN_COUNT_SQL}`)
    .all(...countParams) as unknown as Array<{ detail: string }>;
  const countPlanText = countPlan.map((row) => row.detail).join("\n");
  assert.match(
    countPlanText,
    /idx_agent_nodes_visible_children \(user_id=\? AND root_agent_id=\? AND parent_agent_id=\?\)/,
  );
  assert.match(
    countPlanText,
    /idx_runtime_tasks_visible_children \(user_id=\? AND session_id=\? AND parent_task_id=\?\)/,
  );

  const insertWide = db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, kind, title,
       payload_json, payload_bytes, status, await_policy, cancel_policy,
       checkpoint_safe, activity, wait_reason, lease_generation, version,
       created_at, updated_at, started_at, settled_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 'delegation', 'Count row',
       '{}', 2, 'queued', 'background', 'detached', 0, NULL, NULL, 0, 1,
       ?, ?, NULL, NULL)`,
  );
  let widthRows = 0;
  const addWidthUntil = (target: number): void => {
    db.exec("BEGIN");
    try {
      while (widthRows < target) {
        const ordinal = widthRows + 1;
        insertWide.run(
          `task_count_${String(ordinal).padStart(5, "0")}`,
          width.userId,
          width.sessionId,
          width.sessionId,
          width.childId,
          ordinal,
          now + ordinal,
          now + ordinal,
        );
        widthRows += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const widthSamples: Array<{ rows: number; countMs: number; teamRunMs: number }> = [];
  for (const rows of [5_000, 50_000]) {
    addWidthUntil(rows);
    const started = performance.now();
    const count = db.prepare(readModel.SESSION_RUN_COUNT_SQL).get(...countParams) as { tasks: number };
    const countMs = performance.now() - started;
    assert.equal(Number(count.tasks), rows + 1);
    const teamRunMs = medianReadMs(() => {
      const snapshot = readModel.orchestrationReadModel.sessionRun(
        width.userId,
        width.sessionId,
        { agentLimit: 40, taskLimit: 40 },
      );
      assert.equal(snapshot?.counts.tasks, rows + 1);
      assert.equal(snapshot?.tasks.items.length, 40);
      assert.equal(snapshot?.latestTeamTask?.id, widthTeamTaskId);
    }, 2);
    widthSamples.push({ rows, countMs, teamRunMs });
  }
  assert.ok(widthSamples[0].countMs < timeBudgetMs(1_000), `5k exact count took ${widthSamples[0].countMs.toFixed(1)}ms`);
  assert.ok(widthSamples[1].countMs < timeBudgetMs(4_000), `50k exact count took ${widthSamples[1].countMs.toFixed(1)}ms`);
  assert.ok(
    widthSamples[1].countMs / widthSamples[1].rows
      <= Math.max(0.1, 4 * widthSamples[0].countMs / widthSamples[0].rows),
    "exact count growth is not linear",
  );
  assert.ok(widthSamples[0].teamRunMs < timeBudgetMs(2_000), `5k Team Run took ${widthSamples[0].teamRunMs.toFixed(1)}ms`);
  assert.ok(widthSamples[1].teamRunMs < timeBudgetMs(8_000), `50k Team Run took ${widthSamples[1].teamRunMs.toFixed(1)}ms`);
  assert.ok(
    widthSamples[1].teamRunMs / widthSamples[1].rows
      <= Math.max(0.2, 4 * widthSamples[0].teamRunMs / widthSamples[0].rows),
    "Team Run growth is not linear",
  );

  const depth = createProfile({
    suffix: "depth_profile",
    email: "depth-profile@example.invalid",
  });
  const accountPlan = db.prepare(
    `EXPLAIN QUERY PLAN ${readModel.ACCOUNT_VISIBLE_ORCHESTRATION_CTE}
     SELECT task.id
     FROM visible_tasks visible_task
     JOIN runtime_tasks task ON task.id = visible_task.id
     ORDER BY task.updated_at DESC, task.id DESC LIMIT 41`,
  ).all(depth.userId, depth.userId) as unknown as Array<{ detail: string }>;
  const accountPlanText = accountPlan.map((row) => row.detail).join("\n");
  assert.match(accountPlanText, /idx_agent_nodes_visible_roots/);
  assert.match(accountPlanText, /idx_agent_nodes_visible_children/);
  assert.match(accountPlanText, /idx_runtime_tasks_visible_roots/);
  assert.match(accountPlanText, /idx_runtime_tasks_visible_children/);
  assert.doesNotMatch(
    accountPlanText,
    /CORRELATED SCALAR SUBQUERY[^\n]*visible_task_chain/,
    "Activity must not start one ancestry walk per list row",
  );

  const sessionPlan = db.prepare(
    `EXPLAIN QUERY PLAN ${readModel.SESSION_VISIBLE_ORCHESTRATION_CTE}
     SELECT task.id
     FROM visible_tasks visible_task
     JOIN runtime_tasks task ON task.id = visible_task.id
     ORDER BY task.updated_at DESC, task.id DESC LIMIT 41`,
  ).all(
    depth.rootId,
    depth.userId,
    depth.sessionId,
    depth.userId,
    depth.sessionId,
  ) as unknown as Array<{ detail: string }>;
  const sessionPlanText = sessionPlan.map((row) => row.detail).join("\n");
  assert.match(sessionPlanText, /idx_agent_nodes_visible_children/);
  assert.match(sessionPlanText, /idx_runtime_tasks_visible_children/);
  assert.doesNotMatch(
    sessionPlanText,
    /CORRELATED SCALAR SUBQUERY[^\n]*visible_task_chain/,
    "Run must not start one ancestry walk per list row",
  );

  const detailPlan = db.prepare(
    `EXPLAIN QUERY PLAN ${readModel.TASK_DETAIL_VISIBILITY_CTE}
     SELECT target.id FROM target_task target
     WHERE EXISTS (
       SELECT 1 FROM visible_task_chain chain_root
       WHERE chain_root.parent_task_id IS NULL
     )`,
  ).all(depth.userId, "task_depth_00001") as unknown as Array<{ detail: string }>;
  const detailPlanText = detailPlan.map((row) => row.detail).join("\n");
  assert.match(detailPlanText, /CO-ROUTINE visible_task_chain/);
  assert.match(detailPlanText, /SEARCH parent USING INDEX sqlite_autoindex_runtime_tasks_1 \(id=\?\)/);
  assert.match(detailPlanText, /idx_agent_nodes_visible_children/);

  const insertDeep = db.prepare(
    `INSERT INTO runtime_tasks
      (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
       agent_id, agent_ord, parent_task_id, workflow_id, kind, title,
       payload_json, payload_bytes, status, await_policy, cancel_policy,
       checkpoint_safe, activity, wait_reason, lease_generation, version,
       created_at, updated_at, started_at, settled_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, 'delegation', 'Depth row',
       '{}', 2, 'queued', 'background', 'detached', 0, NULL, NULL, 0, 1,
       ?, ?, NULL, NULL)`,
  );
  let depthRows = 0;
  let depthParent: string | null = null;
  const addDepthUntil = (target: number): string => {
    db.exec("BEGIN");
    try {
      while (depthRows < target) {
        const ordinal = depthRows + 1;
        const id = `task_depth_${String(ordinal).padStart(5, "0")}`;
        insertDeep.run(
          id,
          depth.userId,
          depth.sessionId,
          depth.sessionId,
          depth.childId,
          ordinal,
          depthParent,
          now + ordinal,
          now + ordinal,
        );
        depthParent = id;
        depthRows += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return depthParent!;
  };

  const depthSamples: Array<{
    rows: number;
    activityMs: number;
    runMs: number;
    detailMs: number;
  }> = [];
  for (const rows of [200, 500]) {
    const deepestTaskId = addDepthUntil(rows);
    const activityMs = medianReadMs(() => {
      const page = readModel.orchestrationReadModel.activity(depth.userId, { limit: 40 });
      assert.equal(page.items.length, 40);
    });
    const runMs = medianReadMs(() => {
      const snapshot = readModel.orchestrationReadModel.sessionRun(
        depth.userId,
        depth.sessionId,
        { agentLimit: 40, taskLimit: 40 },
      );
      assert.equal(snapshot?.counts.tasks, rows);
      assert.equal(snapshot?.tasks.items.length, 40);
    });
    const detailMs = medianReadMs(() => {
      assert.equal(
        readModel.orchestrationReadModel.taskDetail(depth.userId, deepestTaskId)?.id,
        deepestTaskId,
      );
    });
    depthSamples.push({ rows, activityMs, runMs, detailMs });
  }

  const depthCaps = { activityMs: 750, runMs: 1_500, detailMs: 750 } as const;
  for (const [name, cap] of Object.entries(depthCaps) as Array<
    [keyof typeof depthCaps, number]
  >) {
    assert.ok(depthSamples[1]![name] < cap, `500-depth ${name} took ${depthSamples[1]![name].toFixed(1)}ms`);
    assert.ok(
      depthSamples[1]![name] / depthSamples[1]!.rows
        <= Math.max(0.25, 4 * depthSamples[0]![name] / depthSamples[0]!.rows),
      `${name} growth is not linear`,
    );
  }

  console.log(JSON.stringify({
    check: "orchestration-read-performance",
    width: widthSamples.map((sample) => ({
      rows: sample.rows,
      countMs: Number(sample.countMs.toFixed(2)),
      teamRunMs: Number(sample.teamRunMs.toFixed(2)),
    })),
    depth: depthSamples.map((sample) => ({
      rows: sample.rows,
      activityMs: Number(sample.activityMs.toFixed(2)),
      runMs: Number(sample.runMs.toFixed(2)),
      detailMs: Number(sample.detailMs.toFixed(2)),
    })),
  }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
