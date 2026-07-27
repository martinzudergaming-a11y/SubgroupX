import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-runtime-task-dispatcher-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const [persistence, visibility, dispatcherModule, permitModule, supervisorModule] = await Promise.all([
  import("../server/src/persistence/index.ts"),
  import("../server/src/persistence/orchestration-visibility.ts"),
  import("../server/src/orchestration/runtime-task-dispatcher.ts"),
  import("../server/src/orchestration/runtime-task-permits.ts"),
  import("../server/src/orchestration/agent-supervisor.ts"),
]);
const {
  agentNodeDao,
  agentTaskDao,
  agentTurnDao,
  db,
  joinedTaskProgressDao,
  messageDao,
  pendingMessageDao,
  recapJobDao,
  runnableBackgroundCandidatesSql,
  runtimeTaskDao,
  sessionDao,
  taskResultDao,
  teamMailDao,
  teamTaskDao,
  teamTurnOutcomeDao,
  timelineDao,
  userDao,
} = persistence;
const { RuntimeTaskDispatcher } = dispatcherModule;
const { RuntimeTaskPermitPool } = permitModule;
const { AgentSupervisor } = supervisorModule;
const { SESSION_EXECUTABLE_OPEN_CTE } = visibility;

let clock = 2_100_000_000_000;
const now = () => ++clock;

function createUser(id: string): void {
  userDao.create({
    id,
    email: `${id}@example.invalid`,
    password_hash: "x",
    created_at: now(),
  });
}

function createSessionRoot(userId: string, suffix: string): { sessionId: string; rootAgentId: string } {
  const sessionId = `session_${suffix}`;
  const rootAgentId = `agt_${suffix}`;
  sessionDao.create({
    id: sessionId,
    user_id: userId,
    title: suffix,
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
  return { sessionId, rootAgentId };
}

function createBackgroundAgent(input: {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  suffix: string;
  message?: string;
  checkpointSafe?: boolean;
}) {
  const agentId = `${input.rootAgentId}_child_${input.suffix}`;
  const taskId = `tsk_${input.rootAgentId}_${input.suffix}`;
  return agentTaskDao.create({
    agent: {
      id: agentId,
      userId: input.userId,
      sessionId: input.sessionId,
      rootAgentId: input.rootAgentId,
      parentAgentId: input.rootAgentId,
      path: `/root/${input.suffix}`,
      label: input.suffix,
      provider: "mock",
      model: "mock",
      thinkingLevel: "off",
      kind: "subagent",
      createdAt: now(),
    },
    task: {
      id: taskId,
      userId: input.userId,
      sessionId: input.sessionId,
      ownerSessionId: input.sessionId,
      agentId,
      kind: "delegation",
      title: input.suffix,
      payload: { message: input.message ?? `finish ${input.suffix}`, context: "none" },
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: input.checkpointSafe ?? false,
      createdAt: now(),
    },
    initialMessages: [],
  });
}

async function until(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fairUser = "user_dispatch_fair";
createUser(fairUser);
const fairRoots: Array<{ sessionId: string; rootAgentId: string }> = [];
for (let index = 0; index < 105; index += 1) {
  const suffix = `fair_${String(index).padStart(3, "0")}`;
  const root = createSessionRoot(fairUser, suffix);
  fairRoots.push(root);
  const count = index === 0 ? 4 : 1;
  for (let task = 0; task < count; task += 1) {
    createBackgroundAgent({ ...root, userId: fairUser, suffix: `task_${task}` });
  }
}

const fairPool = new RuntimeTaskPermitPool(4);
let fairControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
let fairDraining = false;
let maxGlobalActive = 0;
let activeA = 0;
let maxActiveA = 0;
const startOrder: string[] = [];
const fairHost = {
  isDraining: () => fairDraining,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    fairControl = control;
    fairPool.setCapacityListener(() => fairControl?.hint());
    return () => {
      fairControl = undefined;
      fairPool.setCapacityListener(undefined);
      fairPool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => fairPool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (fairDraining) return "draining" as const;
    if (!fairPool.offer(candidate.rootAgentId)) {
      return fairPool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    const release = fairPool.acquire(candidate.rootAgentId);
    if (!release) return "no-capacity" as const;
    const current = runtimeTaskDao.byId(candidate.userId, candidate.taskId);
    const claimed = current && runtimeTaskDao.claim({
      id: current.id,
      userId: current.userId,
      expectedVersion: current.version,
      at: now(),
      eventPayload: { scheduler: "dispatcher_test" },
    });
    if (!claimed) {
      release();
      return "missing" as const;
    }
    const running = runtimeTaskDao.transition({
      id: claimed.id,
      userId: claimed.userId,
      expectedVersion: claimed.version,
      expectedLeaseGeneration: claimed.leaseGeneration,
      nextStatus: "running",
      activity: "model",
      at: now(),
    })!;
    startOrder.push(candidate.rootAgentId);
    if (candidate.rootAgentId === fairRoots[0]!.rootAgentId) {
      activeA += 1;
      maxActiveA = Math.max(maxActiveA, activeA);
    }
    maxGlobalActive = Math.max(maxGlobalActive, fairPool.stats().active);
    const delay = candidate.rootAgentId === fairRoots[0]!.rootAgentId ? 80 : 2;
    setTimeout(() => {
      const latest = runtimeTaskDao.byId(candidate.userId, running.id);
      if (latest?.status === "running") {
        runtimeTaskDao.transition({
          id: latest.id,
          userId: latest.userId,
          expectedVersion: latest.version,
          expectedLeaseGeneration: latest.leaseGeneration,
          nextStatus: "succeeded",
          at: now(),
        });
      }
      if (candidate.rootAgentId === fairRoots[0]!.rootAgentId) activeA -= 1;
      release();
    }, delay).unref?.();
    return "activated" as const;
  },
};
const fairDispatcher = new RuntimeTaskDispatcher(fairHost, {
  truthScanMs: 20,
  scanPageSize: 25,
  scanPagesPerPump: 8,
}).start();
await until(
  () => startOrder.length === 108 && fairPool.stats().active === 0,
  "all fair-dispatch Tasks settle",
);
const rootA = fairRoots[0]!.rootAgentId;
const rootB = fairRoots[1]!.rootAgentId;
assert.ok(startOrder.indexOf(rootB) >= 0 && startOrder.indexOf(rootB) < startOrder.lastIndexOf(rootA));
assert.ok(maxActiveA > 1, "one root may fan out after every root receives a fair first opportunity");
assert.ok(maxGlobalActive <= 4, "global attempt count never exceeds the permit limit");
assert.ok(startOrder.slice(0, 100).filter((root, index, rows) => rows.indexOf(root) === index).length >= 100);
assert.ok(fairDispatcher.stats().hintedUsers <= 1, "dispatcher retains no root queue");
fairDispatcher.stopClaiming();
console.log("  ✓ 105 roots rotate fairly; one root fans out while global active stays <= 4");

const scaleUser = "user_dispatch_scale";
createUser(scaleUser);
function growTruthEpochFixture(from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    const root = createSessionRoot(scaleUser, `scale_${String(index).padStart(4, "0")}`);
    createBackgroundAgent({ ...root, userId: scaleUser, suffix: "probe" });
  }
}

function measureFullTruthEpoch(rootCount: number): number {
  const measure = (): number => {
    let cursor = "";
    let visited = 0;
    const started = performance.now();
    while (true) {
      const page = runtimeTaskDao.scanRunnableBackgroundRoots({
        userId: scaleUser,
        afterRootAgentId: cursor,
        limit: 100,
      });
      visited += page.roots.length;
      if (!page.scannedThrough || page.exhausted) break;
      cursor = page.scannedThrough;
    }
    const elapsed = performance.now() - started;
    assert.equal(visited, rootCount);
    return elapsed;
  };
  measure();
  return [measure(), measure(), measure()].sort((left, right) => left - right)[1]!;
}

const candidateSql = runnableBackgroundCandidatesSql(1);
assert.doesNotMatch(candidateSql, /LEFT JOIN runtime_tasks earlier/);
assert.match(candidateSql, /NOT EXISTS \(\s*SELECT 1 FROM runtime_tasks earlier/);
const candidatePlan = db.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`)
  .all(Date.now(), fairRoots[0]!.rootAgentId) as unknown as Array<{ detail: string }>;
const outerTaskPlan = candidatePlan.filter((row) => /\b(?:SCAN|SEARCH) t\b/.test(row.detail));
assert.ok(
  outerTaskPlan.some((row) => /^SEARCH t USING INDEX idx_runtime_tasks_agent_open \(agent_id=\?\)/.test(row.detail)),
  `candidate Tasks must seek by Agent FIFO:\n${candidatePlan.map((row) => row.detail).join("\n")}`,
);
assert.ok(
  outerTaskPlan.every((row) => !/^SCAN t\b/.test(row.detail)),
  `candidate Tasks must never use an outer scan:\n${candidatePlan.map((row) => row.detail).join("\n")}`,
);
assert.ok(
  candidatePlan.some((row) => row.detail.includes("idx_runtime_tasks_agent_open")),
  "FIFO anti-join must probe the bounded open-Task index",
);
const epochSamples: Array<{ rootCount: number; elapsedMs: number }> = [];
let previousRootCount = 0;
for (const rootCount of [1_000, 2_000, 4_000]) {
  growTruthEpochFixture(previousRootCount, rootCount);
  epochSamples.push({ rootCount, elapsedMs: measureFullTruthEpoch(rootCount) });
  previousRootCount = rootCount;
}
for (let index = 1; index < epochSamples.length; index += 1) {
  const smaller = epochSamples[index - 1]!;
  const larger = epochSamples[index]!;
  assert.ok(
    larger.elapsedMs <= smaller.elapsedMs * 3 + 25,
    `${larger.rootCount}-root epoch ${larger.elapsedMs.toFixed(1)}ms is not near-linear after ${smaller.rootCount}-root ${smaller.elapsedMs.toFixed(1)}ms`,
  );
}
assert.ok(
  epochSamples[2]!.elapsedMs < 1_000,
  `4,000-root truth epoch took ${epochSamples[2]!.elapsedMs.toFixed(1)}ms`,
);
console.log(
  `  ✓ candidate Tasks use Agent-index seeks; full epochs stay near-linear (${epochSamples.map((sample) => `${sample.rootCount}=${sample.elapsedMs.toFixed(1)}ms`).join(", ")})`,
);
db.prepare("DELETE FROM users WHERE id = ?").run(scaleUser);

const historyUser = "user_dispatch_terminal_history";
createUser(historyUser);
const historyRoot = createSessionRoot(historyUser, "terminal_history");
const historyAgentId = `${historyRoot.rootAgentId}_child_history`;
agentNodeDao.create({
  id: historyAgentId,
  userId: historyUser,
  sessionId: historyRoot.sessionId,
  rootAgentId: historyRoot.rootAgentId,
  parentAgentId: historyRoot.rootAgentId,
  path: "/root/history",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  createdAt: now(),
});
const historyRows = 50_000;
const historyAt = now();
db.prepare(
  `WITH RECURSIVE history(n) AS (
     SELECT 1
     UNION ALL SELECT n + 1 FROM history WHERE n < ?
   )
   INSERT INTO runtime_tasks
     (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
      agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json, payload_bytes,
      status, await_policy, cancel_policy, checkpoint_safe, activity, wait_reason,
      lease_generation, version, created_at, updated_at, started_at, settled_at)
   SELECT printf('task_terminal_history_%06d', n), ?, ?, ?, NULL, NULL,
     ?, n, NULL, NULL, 'delegation', 'terminal history', '{}', 2,
     'succeeded', 'background', 'detached', 0, NULL, NULL,
     0, 1, ? + n, ? + n, ? + n, ? + n
   FROM history`,
).run(
  historyRows,
  historyUser,
  historyRoot.sessionId,
  historyRoot.sessionId,
  historyAgentId,
  historyAt,
  historyAt,
  historyAt,
  historyAt,
);
const historyQueued = runtimeTaskDao.create({
  id: "task_terminal_history_queued",
  userId: historyUser,
  sessionId: historyRoot.sessionId,
  ownerSessionId: historyRoot.sessionId,
  agentId: historyAgentId,
  kind: "delegation",
  title: "queued after terminal history",
  payload: { message: "must stay constant-time", context: "none" },
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: historyAt + historyRows + 1,
});
const fifoPlan = db.prepare(
  `EXPLAIN QUERY PLAN
   SELECT t.id
   FROM runtime_tasks t
   LEFT JOIN runtime_tasks earlier
     ON earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
       AND earlier.status IN ('queued','starting','running','waiting','cancel_requested')
   WHERE t.await_policy = 'background' AND t.status = 'queued'
     AND t.agent_id = ? AND earlier.id IS NULL`,
).all(historyAgentId) as unknown as Array<{ detail: string }>;
const fifoPlanText = fifoPlan.map((row) => row.detail).join("\n");
assert.match(fifoPlanText, /idx_runtime_tasks_background_dispatch/);
assert.match(fifoPlanText, /idx_runtime_tasks_agent_open/);
const rootOpenPlan = db.prepare(
  `EXPLAIN QUERY PLAN ${SESSION_EXECUTABLE_OPEN_CTE}
   SELECT t.id FROM executable_open_tasks visible
   CROSS JOIN runtime_tasks t WHERE t.id = visible.id`,
).all(historyRoot.rootAgentId, historyUser, historyRoot.sessionId) as unknown as Array<{ detail: string }>;
const rootOpenPlanText = rootOpenPlan.map((row) => row.detail).join("\n");
assert.match(rootOpenPlanText, /idx_runtime_tasks_agent_open/);
assert.match(rootOpenPlanText, /sqlite_autoindex_runtime_tasks_1 \(id=\?\)/);
const schedulingPlan = db.prepare(
  `EXPLAIN QUERY PLAN ${SESSION_EXECUTABLE_OPEN_CTE}
   SELECT t.id FROM executable_open_tasks visible
   CROSS JOIN runtime_tasks t
   JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
   WHERE t.id = visible.id AND a.kind = 'subagent'
     AND t.kind IN ('delegation','workflow_node')
     AND (
       t.status IN ('starting','running','cancel_requested')
       OR (
         t.status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM executable_open_tasks visible_earlier
           CROSS JOIN runtime_tasks earlier
           WHERE earlier.id = visible_earlier.id
             AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
             AND earlier.status NOT IN ('succeeded','failed','cancelled','interrupted')
         )
       )
     )`,
).all(historyRoot.rootAgentId, historyUser, historyRoot.sessionId) as unknown as Array<{ detail: string }>;
const schedulingPlanText = schedulingPlan.map((row) => row.detail).join("\n");
assert.match(schedulingPlanText, /idx_runtime_tasks_agent_open/);
assert.match(schedulingPlanText, /MATERIALIZE executable_open_tasks/);
const claimPlan = db.prepare(
  `EXPLAIN QUERY PLAN ${SESSION_EXECUTABLE_OPEN_CTE}
   UPDATE runtime_tasks AS t SET updated_at = updated_at
   WHERE id = ? AND user_id = ? AND version = ? AND status = 'queued'
     AND EXISTS (
       SELECT 1 FROM executable_open_tasks candidate
       WHERE candidate.id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM executable_open_tasks visible_active
       CROSS JOIN runtime_tasks active
       WHERE active.id = visible_active.id
         AND active.agent_id = t.agent_id AND active.id <> t.id
         AND active.status IN ('starting','running','waiting','cancel_requested')
     )
     AND NOT EXISTS (
       SELECT 1 FROM executable_open_tasks visible_earlier
       CROSS JOIN runtime_tasks earlier
       WHERE earlier.id = visible_earlier.id
         AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
         AND earlier.status NOT IN ('succeeded','failed','cancelled','interrupted')
     )
     AND (
       t.cancel_policy <> 'linked'
       OR EXISTS (
         SELECT 1 FROM agent_turns owner_turn
         WHERE owner_turn.session_id = t.owner_session_id
           AND owner_turn.id = t.owner_turn_id
           AND owner_turn.status = 'in_progress'
       )
     )`,
).all(
  historyRoot.rootAgentId,
  historyUser,
  historyRoot.sessionId,
  historyQueued.id,
  historyUser,
  historyQueued.version,
) as unknown as Array<{ detail: string }>;
const claimPlanText = claimPlan.map((row) => row.detail).join("\n");
assert.match(claimPlanText, /sqlite_autoindex_runtime_tasks_1/);
assert.match(claimPlanText, /idx_runtime_tasks_agent_open/);
assert.match(claimPlanText, /MATERIALIZE executable_open_tasks/);
runtimeTaskDao.scanRunnableBackgroundRoots({ userId: historyUser, limit: 100 });
const historySamples: number[] = [];
for (let sample = 0; sample < 5; sample += 1) {
  const started = performance.now();
  const page = runtimeTaskDao.scanRunnableBackgroundRoots({ userId: historyUser, limit: 100 });
  historySamples.push(performance.now() - started);
  assert.equal(page.roots[0]?.taskId, historyQueued.id);
}
const historyWorstMs = Math.max(...historySamples);
assert.ok(historyWorstMs < timeBudgetMs(10), `50k terminal-history scan took ${historyWorstMs.toFixed(1)}ms`);
const hotPathSamples: number[] = [];
for (let sample = 0; sample < 5; sample += 1) {
  const started = performance.now();
  assert.equal(runtimeTaskDao.listOpenByRoot(historyUser, historyRoot.rootAgentId, 100).length, 1);
  assert.equal(runtimeTaskDao.listSchedulingAgentWorkerByRoot(historyUser, historyRoot.rootAgentId, 100).length, 1);
  assert.equal(runtimeTaskDao.countOpenByRoot(historyUser, historyRoot.rootAgentId), 1);
  assert.equal(runtimeTaskDao.countOpenByAgent(historyUser, historyAgentId), 1);
  assert.equal(runtimeTaskDao.listOpenByAgent(historyUser, historyAgentId, 100).length, 1);
  assert.equal(runtimeTaskDao.countRunnableByRoot(historyUser, historyRoot.rootAgentId), 1);
  assert.equal(runtimeTaskDao.countRunnableAgentWorkerByRoot(historyUser, historyRoot.rootAgentId), 1);
  hotPathSamples.push(performance.now() - started);
}
const hotPathMedianMs = [...hotPathSamples].sort((left, right) => left - right)[2]!;
assert.ok(hotPathMedianMs < timeBudgetMs(50), `50k terminal-history hot paths took ${hotPathMedianMs.toFixed(1)}ms`);
const claimStarted = performance.now();
assert.ok(runtimeTaskDao.claim({
  id: historyQueued.id,
  userId: historyUser,
  expectedVersion: historyQueued.version,
  at: now(),
}));
const claimElapsedMs = performance.now() - claimStarted;
assert.ok(claimElapsedMs < timeBudgetMs(10), `50k terminal-history claim took ${claimElapsedMs.toFixed(1)}ms`);
const deleteStarted = performance.now();
sessionDao.delete(historyRoot.sessionId);
const deleteElapsedMs = performance.now() - deleteStarted;
assert.ok(deleteElapsedMs < timeBudgetMs(10_000), `50k-Task Session delete took ${deleteElapsedMs.toFixed(1)}ms`);
console.log(
  `  ✓ 50k terminal rows stay outside FIFO/open scans `
  + `(scan ${historyWorstMs.toFixed(2)}ms, hot ${hotPathMedianMs.toFixed(2)}ms, `
  + `claim ${claimElapsedMs.toFixed(2)}ms, delete ${deleteElapsedMs.toFixed(1)}ms)`,
);

const sparseUser = "user_dispatch_sparse";
createUser(sparseUser);
const sparseSessions: string[] = [];
for (let index = 0; index < 1_000; index += 1) {
  sparseSessions.push(createSessionRoot(
    sparseUser,
    `zz_sparse_${String(index).padStart(4, "0")}`,
  ).sessionId);
}
const sparseTail = createSessionRoot(sparseUser, "zz_sparse_tail");
sparseSessions.push(sparseTail.sessionId);
const sparseTask = createBackgroundAgent({ ...sparseTail, userId: sparseUser, suffix: "tail" });
const sparsePool = new RuntimeTaskPermitPool(1);
let sparseControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
const sparseStarts: string[] = [];
const sparseHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    sparseControl = control;
    sparsePool.setCapacityListener(() => sparseControl?.hint());
    return () => {
      sparseControl = undefined;
      sparsePool.setCapacityListener(undefined);
      sparsePool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => sparsePool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!sparsePool.offer(candidate.rootAgentId)) {
      return sparsePool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    const release = sparsePool.acquire(candidate.rootAgentId);
    if (!release) return "no-capacity" as const;
    sparseStarts.push(candidate.taskId);
    const task = runtimeTaskDao.byId(candidate.userId, candidate.taskId)!;
    const claimed = runtimeTaskDao.claim({
      id: task.id,
      userId: task.userId,
      expectedVersion: task.version,
      at: now(),
    })!;
    const running = runtimeTaskDao.transition({
      id: claimed.id,
      userId: claimed.userId,
      expectedVersion: claimed.version,
      expectedLeaseGeneration: claimed.leaseGeneration,
      nextStatus: "running",
      at: now(),
    })!;
    runtimeTaskDao.transition({
      id: running.id,
      userId: running.userId,
      expectedVersion: running.version,
      expectedLeaseGeneration: running.leaseGeneration,
      nextStatus: "succeeded",
      at: now(),
    });
    release();
    return "activated" as const;
  },
};
const sparseDispatcher = new RuntimeTaskDispatcher(sparseHost, {
  truthScanMs: 60_000,
  scanPageSize: 100,
  scanPagesPerPump: 16,
}).start();
await until(() => sparseStarts.includes(sparseTask.task.id), "tail work after 1,000 idle roots", 500);
sparseDispatcher.stopClaiming();
for (const sessionId of sparseSessions) sessionDao.delete(sessionId);
console.log("  ✓ one pump crosses 1,000 idle roots and finds tail work");

const hintedHotUser = "user_dispatch_hint_hot";
const missedColdUser = "user_dispatch_hint_cold";
createUser(hintedHotUser);
createUser(missedColdUser);
const hintedHotRoots = Array.from({ length: 8 }, (_, index) => createSessionRoot(
  hintedHotUser,
  `hint_quota_hot_${String(index).padStart(2, "0")}`,
));
const missedColdRoot = createSessionRoot(missedColdUser, "hint_quota_cold");
const hintPool = new RuntimeTaskPermitPool(8);
let hintControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
const hintStarts: string[] = [];
const hintRuns: Array<{ userId: string; taskId: string; release: () => void }> = [];
const hintHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    hintControl = control;
    hintPool.setCapacityListener((signal) => {
      if (signal === "offer-consumed") hintControl?.continueScan();
      else hintControl?.hint();
    });
    return () => {
      hintControl = undefined;
      hintPool.setCapacityListener(undefined);
      hintPool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => hintPool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!hintPool.offer(candidate.rootAgentId)) {
      return hintPool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    const release = hintPool.acquire(candidate.rootAgentId);
    if (!release) return "no-capacity" as const;
    const task = runtimeTaskDao.byId(candidate.userId, candidate.taskId)!;
    const claimed = runtimeTaskDao.claim({
      id: task.id,
      userId: task.userId,
      expectedVersion: task.version,
      at: now(),
    });
    if (!claimed) {
      release();
      return "missing" as const;
    }
    const running = runtimeTaskDao.transition({
      id: claimed.id,
      userId: claimed.userId,
      expectedVersion: claimed.version,
      expectedLeaseGeneration: claimed.leaseGeneration,
      nextStatus: "running",
      at: now(),
    })!;
    hintStarts.push(candidate.rootAgentId);
    hintRuns.push({ userId: running.userId, taskId: running.id, release });
    return "activated" as const;
  },
};
const hintDispatcher = new RuntimeTaskDispatcher(hintHost, { truthScanMs: 60_000 }).start();
await new Promise((resolve) => setTimeout(resolve, 20));
for (let index = 0; index < hintedHotRoots.length; index += 1) {
  createBackgroundAgent({
    ...hintedHotRoots[index]!,
    userId: hintedHotUser,
    suffix: `hinted_${index}`,
  });
}
createBackgroundAgent({ ...missedColdRoot, userId: missedColdUser, suffix: "missed" });
hintDispatcher.hint(hintedHotUser);
await until(() => hintStarts.length === 8, "hint quota fills first wave");
assert.ok(
  hintStarts.includes(missedColdRoot.rootAgentId),
  "the global cursor admits a missed-hint account in the first wave",
);
hintDispatcher.stopClaiming();
for (const run of hintRuns) {
  const current = runtimeTaskDao.byId(run.userId, run.taskId);
  if (current?.status === "running") {
    runtimeTaskDao.transition({
      id: current.id,
      userId: current.userId,
      expectedVersion: current.version,
      expectedLeaseGeneration: current.leaseGeneration,
      nextStatus: "succeeded",
      at: now(),
    });
  }
  run.release();
}
for (const root of [...hintedHotRoots, missedColdRoot]) sessionDao.delete(root.sessionId);
console.log("  ✓ one hinted root cannot starve the global fair cursor");

const fanoutUser = "user_dispatch_offer_fanout";
createUser(fanoutUser);
const fanoutRoot = createSessionRoot(fanoutUser, "offer_fanout");
for (let index = 0; index < 4; index += 1) {
  createBackgroundAgent({ ...fanoutRoot, userId: fanoutUser, suffix: `fanout_${index}` });
}
const fanoutPool = new RuntimeTaskPermitPool(8);
let fanoutControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
const fanoutStarts: string[] = [];
const fanoutResolvers: Array<(value: { summary: string }) => void> = [];
const fanoutSupervisor = new AgentSupervisor({
  userId: fanoutUser,
  sessionId: fanoutRoot.sessionId,
  rootAgentId: fanoutRoot.rootAgentId,
  workerFactory: () => ({
    run: ({ task }) => new Promise<{ summary: string }>((resolve) => {
      fanoutStarts.push(task.id);
      fanoutResolvers.push(resolve);
    }),
  }),
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => fanoutPool.acquire(fanoutRoot.rootAgentId),
  rejectBackgroundPermit: () => {
    if (fanoutPool.revoke(fanoutRoot.rootAgentId)) fanoutControl?.reject(fanoutRoot.rootAgentId);
  },
  limits: { maxActiveAgents: 8, maxActivePerParent: 8 },
  closeTimeoutMs: 40,
});
const fanoutHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    fanoutControl = control;
    fanoutPool.setCapacityListener((signal) => {
      if (signal === "offer-consumed") fanoutControl?.continueScan();
      else fanoutControl?.hint();
    });
    return () => {
      fanoutControl = undefined;
      fanoutPool.setCapacityListener(undefined);
      fanoutPool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => fanoutPool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!fanoutPool.offer(candidate.rootAgentId)) {
      return fanoutPool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    fanoutSupervisor.poke();
    return "activated" as const;
  },
};
const fanoutStartedAt = performance.now();
const fanoutDispatcher = new RuntimeTaskDispatcher(fanoutHost, { truthScanMs: 60_000 }).start();
await until(() => fanoutStarts.length === 4, "single-root fanout starts without truth tick", 500);
const fanoutElapsedMs = performance.now() - fanoutStartedAt;
assert.ok(fanoutElapsedMs < timeBudgetMs(250), "four Tasks start before the 250ms fanout budget");
assert.equal(fanoutPool.stats().active, 4);
fanoutDispatcher.stopClaiming();
for (const resolve of fanoutResolvers) resolve({ summary: "done" });
await until(() => fanoutPool.stats().active === 0, "fanout Tasks release permits");
await fanoutSupervisor.close();
sessionDao.delete(fanoutRoot.sessionId);
console.log(`  ✓ offer consumption fills one root's permits without a truth tick (${fanoutElapsedMs.toFixed(1)}ms)`);

const rejectUser = "user_dispatch_reject_loop";
createUser(rejectUser);
const rejectA = createSessionRoot(rejectUser, "reject_loop_a");
const rejectB = createSessionRoot(rejectUser, "reject_loop_b");
createBackgroundAgent({ ...rejectA, userId: rejectUser, suffix: "saturated" });
createBackgroundAgent({ ...rejectB, userId: rejectUser, suffix: "ready" });
const rejectPool = new RuntimeTaskPermitPool(1);
let rejectControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
let rejectedActivations = 0;
let rejectTimerFired = false;
let rejectRun: { taskId: string; release: () => void } | undefined;
const rejectHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    rejectControl = control;
    rejectPool.setCapacityListener((signal) => {
      if (signal === "offer-consumed") rejectControl?.continueScan();
      else rejectControl?.hint();
    });
    return () => {
      rejectControl = undefined;
      rejectPool.setCapacityListener(undefined);
      rejectPool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => rejectPool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!rejectPool.offer(candidate.rootAgentId)) {
      return rejectPool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    if (candidate.rootAgentId === rejectA.rootAgentId) {
      rejectedActivations += 1;
      queueMicrotask(() => {
        if (rejectPool.revoke(candidate.rootAgentId)) rejectControl?.reject(candidate.rootAgentId);
      });
      return "activated" as const;
    }
    const release = rejectPool.acquire(candidate.rootAgentId);
    if (!release) return "no-capacity" as const;
    const task = runtimeTaskDao.byId(candidate.userId, candidate.taskId)!;
    const claimed = runtimeTaskDao.claim({
      id: task.id,
      userId: task.userId,
      expectedVersion: task.version,
      at: now(),
    })!;
    const running = runtimeTaskDao.transition({
      id: claimed.id,
      userId: claimed.userId,
      expectedVersion: claimed.version,
      expectedLeaseGeneration: claimed.leaseGeneration,
      nextStatus: "running",
      at: now(),
    })!;
    rejectRun = { taskId: running.id, release };
    return "activated" as const;
  },
};
setTimeout(() => { rejectTimerFired = true; }, 25).unref?.();
const rejectDispatcher = new RuntimeTaskDispatcher(rejectHost, { truthScanMs: 60_000 }).start();
await until(() => Boolean(rejectRun), "root B starts after root A rejects its offer", 500);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(rejectTimerFired, true, "offer rejection does not starve event-loop timers");
assert.equal(rejectedActivations, 1, "one unchanged saturated root is tried once per observation epoch");
assert.equal(rejectDispatcher.stats().rejectedRoots, 1);
rejectDispatcher.stopClaiming();
if (rejectRun) {
  const run = rejectRun as { taskId: string; release: () => void };
  const current = runtimeTaskDao.byId(rejectUser, run.taskId)!;
  runtimeTaskDao.transition({
    id: current.id,
    userId: current.userId,
    expectedVersion: current.version,
    expectedLeaseGeneration: current.leaseGeneration,
    nextStatus: "succeeded",
    at: now(),
  });
  run.release();
}
sessionDao.delete(rejectA.sessionId);
sessionDao.delete(rejectB.sessionId);
console.log("  ✓ an offer nack is bounded and immediately yields its slot to another root");

const failureUser = "user_dispatch_activation_failure";
createUser(failureUser);
const failureRoot = createSessionRoot(failureUser, "activation_failure");
createBackgroundAgent({ ...failureRoot, userId: failureUser, suffix: "fails" });
const failurePool = new RuntimeTaskPermitPool(1);
let failureControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
let failureActivations = 0;
let failureTimerFired = false;
const failureHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    failureControl = control;
    failurePool.setCapacityListener((signal) => {
      if (signal === "offer-consumed") failureControl?.continueScan();
      else failureControl?.hint();
    });
    return () => {
      failureControl = undefined;
      failurePool.setCapacityListener(undefined);
      failurePool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => failurePool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!failurePool.offer(candidate.rootAgentId)) return "no-capacity" as const;
    failureActivations += 1;
    failurePool.revoke(candidate.rootAgentId);
    throw new Error("persistent activation fixture");
  },
};
setTimeout(() => { failureTimerFired = true; }, 25).unref?.();
const failureDispatcher = new RuntimeTaskDispatcher(failureHost, {
  truthScanMs: 60_000,
  onError: () => {},
}).start();
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(failureTimerFired, true, "persistent activation failure does not starve timers");
assert.equal(failureActivations, 1, "persistent activation failure waits for a new truth epoch");
failureDispatcher.stopClaiming();
sessionDao.delete(failureRoot.sessionId);
console.log("  ✓ persistent activation failure backs off to the next truth epoch");

const claimFaultUser = "user_dispatch_claim_fault";
createUser(claimFaultUser);
const claimFaultRoot = createSessionRoot(claimFaultUser, "claim_fault");
const claimFaultTask = createBackgroundAgent({
  ...claimFaultRoot,
  userId: claimFaultUser,
  suffix: "retry",
});
const claimFaultPool = new RuntimeTaskPermitPool(1);
let claimFaultControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
let claimFaultCalls = 0;
let claimFaultReleases = 0;
const claimFaultPhases: string[] = [];
const claimFaultSupervisor = new AgentSupervisor({
  userId: claimFaultUser,
  sessionId: claimFaultRoot.sessionId,
  rootAgentId: claimFaultRoot.rootAgentId,
  workerFactory: () => ({ run: async () => ({ summary: "recovered" }) }),
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => claimFaultPool.acquire(claimFaultRoot.rootAgentId),
  rejectBackgroundPermit: () => {
    claimFaultPool.revoke(claimFaultRoot.rootAgentId);
    claimFaultControl?.reject(claimFaultRoot.rootAgentId);
  },
  onError: (_error, context) => claimFaultPhases.push(context.phase),
  closeTimeoutMs: 100,
});
const originalClaim = runtimeTaskDao.claim.bind(runtimeTaskDao);
(runtimeTaskDao as unknown as { claim: typeof runtimeTaskDao.claim }).claim = ((
  input: Parameters<typeof runtimeTaskDao.claim>[0],
) => {
  if (input.id === claimFaultTask.task.id) {
    claimFaultCalls += 1;
    if (claimFaultCalls === 1) throw new Error("transient claim fixture");
  }
  return originalClaim(input);
}) as typeof runtimeTaskDao.claim;
const claimFaultHost = {
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl) {
    claimFaultControl = control;
    claimFaultPool.setCapacityListener((signal) => {
      if (signal === "offer-consumed") claimFaultControl?.continueScan();
      else {
        claimFaultReleases += 1;
        claimFaultControl?.hint();
      }
    });
    return () => {
      claimFaultControl = undefined;
      claimFaultPool.setCapacityListener(undefined);
      claimFaultPool.clearOffers();
    };
  },
  runtimeTaskDispatchCapacity: () => claimFaultPool.stats(),
  activateRuntimeTaskRoot(candidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot) {
    if (!claimFaultPool.offer(candidate.rootAgentId)) {
      return claimFaultPool.hasOffer(candidate.rootAgentId) ? "already-active" as const : "no-capacity" as const;
    }
    claimFaultSupervisor.poke();
    return "activated" as const;
  },
};
const claimFaultDispatcher = new RuntimeTaskDispatcher(claimFaultHost, { truthScanMs: 20 }).start();
await until(
  () => runtimeTaskDao.byId(claimFaultUser, claimFaultTask.task.id)?.status === "succeeded",
  "transient claim fault recovers",
  2_000,
);
(runtimeTaskDao as unknown as { claim: typeof runtimeTaskDao.claim }).claim = originalClaim;
assert.equal(claimFaultCalls, 2);
assert.equal(claimFaultReleases, 2, "failed claim and completed attempt each release exactly once");
assert.equal(claimFaultPool.stats().active, 0);
assert.equal(claimFaultSupervisor.hasLiveTasks(), false);
assert.ok(claimFaultPhases.includes("schedule"));
claimFaultDispatcher.stopClaiming();
await claimFaultSupervisor.close();
sessionDao.delete(claimFaultRoot.sessionId);
console.log("  ✓ transient claim failure releases its consumed permit and recovers");

const forceUser = "user_dispatch_force";
createUser(forceUser);
const forceRoot = createSessionRoot(forceUser, "force");
const forcePool = new RuntimeTaskPermitPool(1);
const forceStarts: string[] = [];
const ended = new Map<string, number>();
let secondResolve: ((value: { summary: string }) => void) | undefined;
const forceSupervisor = new AgentSupervisor({
  now,
  userId: forceUser,
  sessionId: forceRoot.sessionId,
  rootAgentId: forceRoot.rootAgentId,
  workerFactory: ({ agent }) => ({
    run: ({ task }) => {
      forceStarts.push(task.id);
      if (agent.path.endsWith("/hung")) return new Promise(() => {});
      return new Promise((resolve) => { secondResolve = resolve; });
    },
  }),
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => forcePool.acquire(forceRoot.rootAgentId),
  onAttemptEnd: (taskId) => ended.set(taskId, (ended.get(taskId) ?? 0) + 1),
  interruptGraceMs: 20,
  closeTimeoutMs: 40,
  limits: { maxActiveAgents: 2, maxActivePerParent: 2 },
});
forcePool.offer(forceRoot.rootAgentId);
const hung = forceSupervisor.spawn({ initialMessages: [], taskName: "hung", message: "never settle" });
const next = forceSupervisor.spawn({ initialMessages: [], taskName: "next", message: "run after fence" });
await until(() => forceStarts.includes(hung.taskId), "hung Task starts");
assert.equal(forceSupervisor.interrupt(hung.agentId), true);
await until(() => forcePool.stats().active === 0 && !forceSupervisor.hasLiveTasks(), "force fence releases ownership");
assert.equal(ended.get(hung.taskId), 1);
forcePool.offer(forceRoot.rootAgentId);
forceSupervisor.poke();
await until(() => forceStarts.includes(next.taskId), "next root work starts after force fence");
secondResolve?.({ summary: "next finished" });
await until(() => runtimeTaskDao.byId(forceUser, next.taskId)?.status === "succeeded", "next Task settles");
assert.equal(ended.get(hung.taskId), 1, "force and late cleanup share one ownership edge");
await forceSupervisor.close();
console.log("  ✓ forced detach releases its permit and live-attempt edge exactly once");

const closeUser = "user_dispatch_close_hung";
createUser(closeUser);
const closeRoot = createSessionRoot(closeUser, "close_hung");
const closePool = new RuntimeTaskPermitPool(1);
let closeStarts = 0;
let closeEnds = 0;
const closeSupervisor = new AgentSupervisor({
  userId: closeUser,
  sessionId: closeRoot.sessionId,
  rootAgentId: closeRoot.rootAgentId,
  workerFactory: () => ({ run: () => { closeStarts += 1; return new Promise(() => {}); } }),
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => closePool.acquire(closeRoot.rootAgentId),
  onAttemptEnd: () => { closeEnds += 1; },
  closeTimeoutMs: 30,
});
closePool.offer(closeRoot.rootAgentId);
const closeHung = closeSupervisor.spawn({ initialMessages: [], taskName: "hung", message: "never settle" });
await until(() => closeStarts === 1, "close-hung Task starts");
await closeSupervisor.close();
assert.equal(closePool.stats().active, 0);
assert.equal(closeSupervisor.hasLiveTasks(), false);
assert.equal(closeEnds, 1);
assert.equal(runtimeTaskDao.byId(closeUser, closeHung.taskId)?.status, "interrupted");
sessionDao.delete(closeRoot.sessionId);
assert.equal(closePool.stats().active, 0, "Session deletion after close cannot leak a permit");
assert.equal(closeEnds, 1);
console.log("  ✓ close/delete fences a hung worker and ends permit ownership once");

const saturatedUser = "user_dispatch_saturated";
createUser(saturatedUser);
const saturatedA = createSessionRoot(saturatedUser, "saturated_a");
const saturatedB = createSessionRoot(saturatedUser, "saturated_b");
const saturatedPool = new RuntimeTaskPermitPool(1);
const saturatedStarts: string[] = [];
const resolvers = new Map<string, (value: { summary: string }) => void>();
const saturatedFactory = () => ({
  run: ({ task, signal, publishProgress }: import("../server/src/orchestration/agent-supervisor.ts").SupervisedAgentRun) =>
    new Promise<{ summary: string }>((resolve, reject) => {
      saturatedStarts.push(task.id);
      const childTurnId = `turn_child_${task.id}_${task.leaseGeneration}`;
      if (task.awaitPolicy === "join") {
        assert.equal(publishProgress({
          t: "turn_start",
          turnId: childTurnId,
          startedAt: now(),
        }), true);
      }
      resolvers.set(task.id, (value) => {
        if (task.awaitPolicy === "join") {
          assert.equal(publishProgress({
            t: "turn_end",
            turnId: childTurnId,
            status: "completed",
            completedAt: now(),
            durationMs: 1,
          }), true);
        }
        resolve(value);
      });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
});
const saturatedOwnerTurnId = "turn_dispatch_saturated_joined";
const saturatedOwnerStepId = "step_dispatch_saturated_joined";
const saturatedOwnerSeq = 1;
agentTurnDao.start({
  id: saturatedOwnerTurnId,
  sessionId: saturatedA.sessionId,
  startedAt: now(),
  provider: "mock",
  model: "mock",
});
timelineDao.append(saturatedA.sessionId, {
  kind: "tool",
  id: saturatedOwnerStepId,
  seq: saturatedOwnerSeq,
  name: "spawn_subagent",
  toolKind: "subagent",
  arguments: {},
  status: "running",
  ts: now(),
  turnId: saturatedOwnerTurnId,
});
const supervisorA = new AgentSupervisor({
  userId: saturatedUser,
  sessionId: saturatedA.sessionId,
  rootAgentId: saturatedA.rootAgentId,
  workerFactory: saturatedFactory,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => saturatedPool.acquire(saturatedA.rootAgentId),
  rejectBackgroundPermit: () => { saturatedPool.revoke(saturatedA.rootAgentId); },
  onJoinedProgress: ({ task, ownerStepId, progressSeq, at, event }) => {
    assert.equal(ownerStepId, saturatedOwnerStepId);
    return joinedTaskProgressDao.commit({
      userId: saturatedUser,
      taskId: task.id,
      expectedLeaseGeneration: task.leaseGeneration,
      progressSeq,
      ownerTimelineSeq: saturatedOwnerSeq,
      event,
      at,
    }).kind !== "stale";
  },
  limits: { maxActiveAgents: 1, maxActivePerParent: 1 },
  closeTimeoutMs: 40,
});
const supervisorB = new AgentSupervisor({
  userId: saturatedUser,
  sessionId: saturatedB.sessionId,
  rootAgentId: saturatedB.rootAgentId,
  workerFactory: saturatedFactory,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => saturatedPool.acquire(saturatedB.rootAgentId),
  rejectBackgroundPermit: () => { saturatedPool.revoke(saturatedB.rootAgentId); },
  limits: { maxActiveAgents: 1, maxActivePerParent: 1 },
  closeTimeoutMs: 40,
});
const joinedA = supervisorA.spawn({
  initialMessages: [],
  taskName: "joined",
  message: "occupy local slot",
  awaitPolicy: "join",
  cancelPolicy: "linked",
  ownerTurnId: saturatedOwnerTurnId,
  ownerStepId: saturatedOwnerStepId,
});
await until(() => saturatedStarts.includes(joinedA.taskId), "joined Task saturates root A");
const backgroundA = supervisorA.spawn({ initialMessages: [], taskName: "background", message: "wait fairly" });
saturatedPool.offer(saturatedA.rootAgentId);
supervisorA.poke();
await until(() => saturatedPool.stats().offered === 0, "saturated root nacks its offer");
assert.equal(runtimeTaskDao.byId(saturatedUser, backgroundA.taskId)?.status, "queued");
const backgroundB = supervisorB.spawn({ initialMessages: [], taskName: "background", message: "must start" });
saturatedPool.offer(saturatedB.rootAgentId);
supervisorB.poke();
await until(() => saturatedStarts.includes(backgroundB.taskId), "root B starts after root A nack");
assert.equal(saturatedPool.stats().active, 1);
assert.equal(saturatedPool.stats().offered, 0);
resolvers.get(backgroundB.taskId)?.({ summary: "B done" });
resolvers.get(joinedA.taskId)?.({ summary: "joined done" });
await until(
  () => saturatedPool.stats().active === 0
    && runtimeTaskDao.byId(saturatedUser, backgroundB.taskId)?.status === "succeeded"
    && runtimeTaskDao.byId(saturatedUser, joinedA.taskId)?.status === "succeeded",
  "background and joined Tasks settle",
);
agentTurnDao.complete(saturatedA.sessionId, saturatedOwnerTurnId, "completed", now());
await Promise.all([supervisorA.close(), supervisorB.close()]);
console.log("  ✓ local saturation nacks an offer, so another root uses the global slot");

const providers = await import("../server/src/runtime/providers.ts");
providers.registerMockProvider();
const { recoverInterruptedSessions } = await import("../server/src/runtime/recovery.ts");
const { SessionManager } = await import("../server/src/runtime/manager.ts");

const coldUser = "user_dispatch_cold";
createUser(coldUser);
const coldRoot = createSessionRoot(coldUser, "cold");
const coldCreated = createBackgroundAgent({
  ...coldRoot,
  userId: coldUser,
  suffix: "resume",
  message: "/bash printf cold-recovered",
  checkpointSafe: true,
});
const coldClaim = runtimeTaskDao.claim({
  id: coldCreated.task.id,
  userId: coldUser,
  expectedVersion: coldCreated.task.version,
  at: now(),
})!;
runtimeTaskDao.transition({
  id: coldClaim.id,
  userId: coldUser,
  expectedVersion: coldClaim.version,
  expectedLeaseGeneration: coldClaim.leaseGeneration,
  nextStatus: "running",
  activity: "model",
  at: now(),
});
pendingMessageDao.append(coldRoot.sessionId, {
  id: "pending_cold",
  kind: "queue",
  text: "must remain pending",
  ts: now(),
});
recapJobDao.upsert({
  session_id: coldRoot.sessionId,
  turn_id: "turn_cold",
  anchor_seq: 0,
  due_at: 0,
  contract_version: 1,
  payload_json: JSON.stringify({
    previousRequests: [],
    latestRequest: "previous request",
    assistantReply: "previous reply",
    activity: [],
    turnProvider: "mock",
    turnModel: "mock",
  }),
  created_at: now(),
});
recoverInterruptedSessions();
assert.equal(runtimeTaskDao.byId(coldUser, coldCreated.task.id)?.status, "queued");
const realPool = new RuntimeTaskPermitPool(2);
const realManager = new SessionManager({ taskPermits: realPool });
const realDispatcher = new RuntimeTaskDispatcher(realManager, { truthScanMs: 20 }).start();
await until(
  () => runtimeTaskDao.byId(coldUser, coldCreated.task.id)?.status === "succeeded",
  "cold recovered pi Child completes without Session subscribe",
  12_000,
);
assert.equal(pendingMessageDao.listPending(coldRoot.sessionId).length, 1);
assert.ok(recapJobDao.get(coldRoot.sessionId), "headless activation does not run a due Recap");
assert.equal(timelineDao.list(coldRoot.sessionId).some((item) => item.kind === "user" || item.kind === "recap"), false);
console.log("  ✓ cold-start recovery executes durable work without pending Turn or Recap side effects");

const bannedUser = "user_dispatch_banned";
createUser(bannedUser);
const bannedRoot = createSessionRoot(bannedUser, "banned");
const bannedTask = createBackgroundAgent({
  ...bannedRoot,
  userId: bannedUser,
  suffix: "blocked",
  message: "/bash printf admitted",
});
userDao.ban(bannedUser, "fixture suspension");
realDispatcher.hint(bannedUser);
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(runtimeTaskDao.byId(bannedUser, bannedTask.task.id)?.status, "queued");
userDao.unban(bannedUser);
realDispatcher.hint(bannedUser);
await until(
  () => runtimeTaskDao.byId(bannedUser, bannedTask.task.id)?.status === "succeeded",
  "unbanned Task resumes from durable queue",
  12_000,
);
console.log("  ✓ suspension parks durable work; unban plus hint resumes it");

const deletedUser = "user_dispatch_deleted";
createUser(deletedUser);
const deletedRoot = createSessionRoot(deletedUser, "deleted");
const deletedTask = createBackgroundAgent({ ...deletedRoot, userId: deletedUser, suffix: "gone" });
sessionDao.delete(deletedRoot.sessionId);
for (let index = 0; index < 200; index += 1) realDispatcher.hint(deletedUser);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(runtimeTaskDao.byId(deletedUser, deletedTask.task.id), undefined);
assert.equal(realDispatcher.stats().hintedUsers <= 1, true);
console.log("  ✓ Session deletion and duplicate signals leave no durable or in-memory candidate");

const teamUser = "user_dispatch_team";
createUser(teamUser);
const teamOwner = createSessionRoot(teamUser, "team_owner");
const teamWorker = createSessionRoot(teamUser, "team_worker");
const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
let teamSerial = 0;
const teamCoordinator = new TeamCoordinator({
  userId: teamUser,
  actorSessionId: teamOwner.sessionId,
  now,
  id: (kind) => `${kind}_dispatcher_${++teamSerial}`,
});
const team = teamCoordinator.createFromSessions({
  name: "Dispatcher Team",
  members: [
    { sessionId: teamOwner.sessionId, role: "lead" },
    { sessionId: teamWorker.sessionId, role: "worker" },
  ],
  leadSessionId: teamOwner.sessionId,
});
recapJobDao.upsert({
  session_id: teamWorker.sessionId,
  turn_id: "turn_before_team",
  anchor_seq: 0,
  due_at: 0,
  contract_version: 1,
  payload_json: JSON.stringify({
    previousRequests: [],
    latestRequest: "older user request",
    assistantReply: "older reply",
    activity: [],
    turnProvider: "mock",
    turnModel: "mock",
  }),
  created_at: now(),
});
const teamWork = teamCoordinator.assignWork({
  teamId: team.team.id,
  targetMemberId: team.members.find((member) => member.sessionId === teamWorker.sessionId)!.id,
  title: "Complete bounded Team work",
  payload: { request: "Reply with a short completion." },
  idempotencyKey: "dispatcher-team-work",
  deadlineAt: now() + 60_000,
  budget: { maxModelCycles: 2, maxTokens: 100_000 },
});
assert.equal(
  runtimeTaskDao.scanRunnableBackgroundRoots({ userId: teamUser, limit: 100 }).roots[0]?.taskKind,
  "team_turn",
);
realDispatcher.hint(teamUser);
await until(
  () => runtimeTaskDao.byId(teamUser, teamWork.task.id)?.status === "succeeded",
  "Team Turn executes through the shared dispatcher",
  12_000,
);
assert.equal(teamMailDao.byTask(teamUser, teamWork.task.id)?.status, "acknowledged");
assert.ok(taskResultDao.byTask(teamUser, teamWork.task.id));
assert.equal(recapJobDao.get(teamWorker.sessionId), null, "Team admission obsoletes the prior user Recap job");
assert.equal(timelineDao.list(teamWorker.sessionId).some((item) => item.kind === "recap"), false);
assert.equal(realPool.stats().active <= realPool.limit, true);
console.log("  ✓ Team Turn uses the shared permit pool and Session executor");

const linkedUser = "user_dispatch_linked";
createUser(linkedUser);
const linkedRoot = createSessionRoot(linkedUser, "linked");
agentTurnDao.start({
  id: "turn_linked_owner",
  sessionId: linkedRoot.sessionId,
  startedAt: now(),
  provider: "mock",
  model: "mock",
});
const linked = agentTaskDao.create({
  agent: {
    id: `${linkedRoot.rootAgentId}_child`,
    userId: linkedUser,
    sessionId: linkedRoot.sessionId,
    rootAgentId: linkedRoot.rootAgentId,
    parentAgentId: linkedRoot.rootAgentId,
    path: "/root/linked",
    provider: "mock",
    model: "mock",
    kind: "subagent",
    createdAt: now(),
  },
  task: {
    id: "tsk_linked_orphan",
    userId: linkedUser,
    sessionId: linkedRoot.sessionId,
    ownerSessionId: linkedRoot.sessionId,
    ownerTurnId: "turn_linked_owner",
    agentId: `${linkedRoot.rootAgentId}_child`,
    kind: "delegation",
    title: "linked orphan",
    payload: { message: "must cancel", context: "none" },
    awaitPolicy: "background",
    cancelPolicy: "linked",
    checkpointSafe: false,
    createdAt: now(),
  },
  initialMessages: [],
});
agentTurnDao.complete(linkedRoot.sessionId, "turn_linked_owner", "completed", now());
realDispatcher.hint(linkedUser);
await until(
  () => runtimeTaskDao.byId(linkedUser, linked.task.id)?.status === "cancelled",
  "cold linked orphan is cancelled without runtime hydration",
);
console.log("  ✓ truth scan cancels linked orphan work which can no longer be claimed");

const drainUser = "user_dispatch_drain";
createUser(drainUser);
const drainRoot = createSessionRoot(drainUser, "drain");
const drainFirst = createBackgroundAgent({
  ...drainRoot,
  userId: drainUser,
  suffix: "first",
  message: "/bash sleep 0.2; printf drain-first",
});
const drainSecond = runtimeTaskDao.create({
  id: "tsk_drain_second",
  userId: drainUser,
  sessionId: drainRoot.sessionId,
  ownerSessionId: drainRoot.sessionId,
  agentId: drainFirst.agent.id,
  kind: "delegation",
  title: "second",
  payload: { message: "/bash printf must-not-start", context: "none" },
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now(),
});
realDispatcher.hint(drainUser);
await until(
  () => ["starting", "running"].includes(runtimeTaskDao.byId(drainUser, drainFirst.task.id)?.status ?? ""),
  "drain first Task owns a live attempt",
);
realManager.setDraining();
const drainStarted = Date.now();
const drained = await realManager.drainTurns({ waitMs: 2_000, settleMs: 200 });
assert.ok(Date.now() - drainStarted >= 100, "drain waited for the live child attempt");
assert.equal(drained.interrupted, 0);
assert.equal(runtimeTaskDao.byId(drainUser, drainFirst.task.id)?.status, "succeeded");
assert.equal(runtimeTaskDao.byId(drainUser, drainSecond.id)?.status, "queued");
assert.equal(realDispatcher.stats().running, false);
assert.equal(realPool.stats().active, 0);
console.log("  ✓ drain waits for live work, freezes new claims, and preserves queued work");

const backlogUser = "user_dispatch_open_backlog";
createUser(backlogUser);
const backlogRoot = createSessionRoot(backlogUser, "open_backlog");
const backlogAgentId = `${backlogRoot.rootAgentId}_child`;
agentNodeDao.create({
  id: backlogAgentId,
  userId: backlogUser,
  sessionId: backlogRoot.sessionId,
  rootAgentId: backlogRoot.rootAgentId,
  parentAgentId: backlogRoot.rootAgentId,
  path: "/root/open_backlog",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const insertBacklogTask = db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title,
     payload_json, payload_bytes, status, await_policy, cancel_policy,
     checkpoint_safe, activity, wait_reason, lease_generation, version,
     created_at, updated_at, started_at, settled_at)
   VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 'delegation',
     'Open backlog', '{}', 2, 'queued', 'background', 'detached',
     0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
);
const backlogAt = now();
const backlogTaskId = (index: number): string =>
  `task_open_backlog_${String(index).padStart(5, "0")}`;
const insertBacklogRange = (start: number, end: number): void => {
  db.exec("BEGIN");
  try {
    for (let index = start; index < end; index += 1) {
      insertBacklogTask.run(
        backlogTaskId(index),
        backlogUser,
        backlogRoot.sessionId,
        backlogRoot.sessionId,
        backlogAgentId,
        index + 1,
        backlogAt + index,
        backlogAt + index,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
const sampleBacklog = (): { coldMs: number; hotMedianMs: number; hotWorstMs: number } => {
  const coldStarted = performance.now();
  const cold = runtimeTaskDao.scanRunnableBackgroundRoots({ userId: backlogUser, limit: 100 });
  const coldMs = performance.now() - coldStarted;
  assert.equal(cold.roots.length, 1);
  assert.equal(cold.roots[0]?.taskId, backlogTaskId(0));
  const hotSamples: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    const page = runtimeTaskDao.scanRunnableBackgroundRoots({ userId: backlogUser, limit: 100 });
    hotSamples.push(performance.now() - started);
    assert.equal(page.roots[0]?.taskId, backlogTaskId(0));
  }
  const sorted = [...hotSamples].sort((left, right) => left - right);
  return {
    coldMs,
    hotMedianMs: sorted[2]!,
    hotWorstMs: sorted.at(-1)!,
  };
};

insertBacklogRange(0, 5_000);
const backlog5k = sampleBacklog();
insertBacklogRange(5_000, 50_000);
const backlog50k = sampleBacklog();
assert.ok(backlog5k.coldMs < timeBudgetMs(500), `5k open-root cold scan took ${backlog5k.coldMs.toFixed(1)}ms`);
assert.ok(backlog50k.coldMs < timeBudgetMs(2_000), `50k open-root cold scan took ${backlog50k.coldMs.toFixed(1)}ms`);
assert.ok(
  backlog50k.coldMs <= Math.max(500, backlog5k.coldMs * 20),
  `10x backlog grew cold scan from ${backlog5k.coldMs.toFixed(1)}ms to ${backlog50k.coldMs.toFixed(1)}ms`,
);
assert.ok(
  backlog50k.hotMedianMs <= Math.max(400, backlog5k.hotMedianMs * 20),
  `10x backlog grew hot scan from ${backlog5k.hotMedianMs.toFixed(1)}ms to ${backlog50k.hotMedianMs.toFixed(1)}ms`,
);
const backlogPlan = db.prepare(`EXPLAIN QUERY PLAN ${runnableBackgroundCandidatesSql(1)}`)
  .all(backlogRoot.rootAgentId) as unknown as Array<{ detail: string }>;
const backlogPlanText = backlogPlan.map((row) => row.detail).join("\n");
assert.match(
  backlogPlanText,
  /SEARCH t USING INDEX idx_runtime_tasks_agent_open \(agent_id=\?\)/,
);
assert.match(
  backlogPlanText,
  /idx_runtime_tasks_agent_open \(agent_id=\? AND agent_ord<\?\)/,
);
assert.doesNotMatch(backlogPlanText, /SCAN earlier/);
assert.equal(runtimeTaskDao.claim({
  id: backlogTaskId(49_999),
  userId: backlogUser,
  expectedVersion: 1,
  at: now(),
}), null, "an exact tail claim cannot bypass its Agent FIFO head");
assert.equal(runtimeTaskDao.claim({
  id: backlogTaskId(0),
  userId: backlogUser,
  expectedVersion: 1,
  at: now(),
})?.status, "starting", "the scanned FIFO head remains exactly claimable");
assert.equal(
  runtimeTaskDao.scanRunnableBackgroundRoots({ userId: backlogUser, limit: 100 }).roots.length,
  0,
  "an active FIFO head blocks every queued successor",
);
console.log(
  `  ✓ same-root open backlog stays near-linear and exact `
  + `(5k cold/hot ${backlog5k.coldMs.toFixed(2)}/${backlog5k.hotMedianMs.toFixed(2)}ms; `
  + `50k ${backlog50k.coldMs.toFixed(2)}/${backlog50k.hotMedianMs.toFixed(2)}ms)`,
);

const childTeamUser = "user_dispatch_team_child";
createUser(childTeamUser);
const childTeamOwner = createSessionRoot(childTeamUser, "team_child_owner");
const childTeamWorker = createSessionRoot(childTeamUser, "team_child_worker");
let childTeamSerial = 0;
const childTeamCoordinator = new TeamCoordinator({
  userId: childTeamUser,
  actorSessionId: childTeamOwner.sessionId,
  now,
  id: (kind) => `${kind}_child_team_${++childTeamSerial}`,
});
const childTeam = childTeamCoordinator.createFromSessions({
  name: "Child isolation",
  members: [
    { sessionId: childTeamOwner.sessionId, role: "lead" },
    { sessionId: childTeamWorker.sessionId, role: "worker" },
  ],
  leadSessionId: childTeamOwner.sessionId,
});
const liveChild = createBackgroundAgent({
  ...childTeamWorker,
  userId: childTeamUser,
  suffix: "keepalive",
  message: "/bash sleep 0.25; printf child-survived",
});
const parkedTeamWork = childTeamCoordinator.assignWork({
  teamId: childTeam.team.id,
  targetMemberId: childTeam.members.find((member) => member.sessionId === childTeamWorker.sessionId)!.id,
  title: "Wait behind live Child",
  payload: { request: "Reply after the Child finishes." },
  idempotencyKey: "child-isolation-team-work",
  deadlineAt: now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const childPool = new RuntimeTaskPermitPool(2);
const childManager = new SessionManager({ taskPermits: childPool });
const childCandidate = runtimeTaskDao.scanRunnableBackgroundRoots({ userId: childTeamUser, limit: 10 })
  .roots.find((candidate) => candidate.taskId === liveChild.task.id)!;
assert.equal(childManager.activateRuntimeTaskRoot(childCandidate), "activated");
await until(
  () => ["starting", "running"].includes(runtimeTaskDao.byId(childTeamUser, liveChild.task.id)?.status ?? ""),
  "same-Session Child starts",
);
const parkedCandidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot = {
  userId: childTeamUser,
  sessionId: childTeamWorker.sessionId,
  rootAgentId: childTeamWorker.rootAgentId,
  taskId: parkedTeamWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: parkedTeamWork.task.createdAt,
};
assert.equal(childManager.activateRuntimeTaskRoot(parkedCandidate), "activated");
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(runtimeTaskDao.byId(childTeamUser, parkedTeamWork.task.id)?.status, "queued");
assert.ok(["starting", "running", "succeeded"].includes(
  runtimeTaskDao.byId(childTeamUser, liveChild.task.id)?.status ?? "",
));
await until(
  () => runtimeTaskDao.byId(childTeamUser, liveChild.task.id)?.status === "succeeded",
  "same-Session Child survives Team admission",
  12_000,
);
await until(() => childPool.stats().active === 0, "parked Team and Child release permits");
assert.equal(childManager.activateRuntimeTaskRoot(parkedCandidate), "activated");
await until(
  () => runtimeTaskDao.byId(childTeamUser, parkedTeamWork.task.id)?.status === "succeeded",
  "parked Team resumes after Child completion",
  12_000,
);
console.log("  ✓ live same-Session Child completes before the parked Team resumes");

const topCompat = await import("@earendil-works/pi-ai/compat");
const topPi = await import("@earendil-works/pi-ai");
const nestedDist = path.join(
  process.cwd(),
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist",
);
const nestedCompat = await import(pathToFileURL(path.join(nestedDist, "compat.js")).href) as typeof topCompat;
const nestedPi = await import(pathToFileURL(path.join(nestedDist, "index.js")).href) as typeof topPi;
type TestPiStream = ReturnType<typeof topPi.createAssistantMessageEventStream>;
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function pushTestAssistant(stream: TestPiStream, text: string): void {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "mock" as const,
    provider: "mock",
    model: "mock-coder",
    usage: ZERO_USAGE,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: { ...message, content: [{ type: "text", text: "" }] },
  });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
}

function pushTestToolBatch(
  stream: TestPiStream,
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): void {
  const content = calls.map((call) => ({ type: "toolCall" as const, ...call }));
  const message = {
    role: "assistant" as const,
    content,
    api: "mock" as const,
    provider: "mock",
    model: "mock-coder",
    usage: ZERO_USAGE,
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
  const partial = { ...message, content: [] as typeof content };
  stream.push({ type: "start", partial });
  for (let index = 0; index < content.length; index += 1) {
    const call = content[index]!;
    partial.content = [...partial.content, { ...call, arguments: {} }];
    stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
    partial.content[index] = call;
    stream.push({
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(call.arguments),
      partial: { ...partial },
    });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: { ...partial } });
  }
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end(message);
}

let hungProviderCalls = 0;
let hungProviderStream: TestPiStream | undefined;
const hungProvider = () => {
  hungProviderCalls += 1;
  hungProviderStream = topPi.createAssistantMessageEventStream();
  return hungProviderStream;
};
topCompat.registerApiProvider({ api: "mock", stream: hungProvider, streamSimple: hungProvider }, "dispatcher-hung-team");
nestedCompat.registerApiProvider({ api: "mock", stream: hungProvider, streamSimple: hungProvider }, "dispatcher-hung-team");

const hungUser = "user_dispatch_hung_team";
createUser(hungUser);
const hungOwner = createSessionRoot(hungUser, "hung_team_owner");
const hungWorker = createSessionRoot(hungUser, "hung_team_worker");
const nextWorker = createSessionRoot(hungUser, "hung_team_next");
let hungSerial = 0;
const hungCoordinator = new TeamCoordinator({
  userId: hungUser,
  actorSessionId: hungOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_hung_team_${++hungSerial}`,
});
const hungTeam = hungCoordinator.createFromSessions({
  name: "Hung provider",
  members: [
    { sessionId: hungOwner.sessionId, role: "lead" },
    { sessionId: hungWorker.sessionId, role: "worker" },
    { sessionId: nextWorker.sessionId, role: "worker" },
  ],
  leadSessionId: hungOwner.sessionId,
});
const hungWork = hungCoordinator.assignWork({
  teamId: hungTeam.team.id,
  targetMemberId: hungTeam.members.find((member) => member.sessionId === hungWorker.sessionId)!.id,
  title: "Expire abort-insensitive request",
  payload: {},
  idempotencyKey: "hung-provider-work",
  deadlineAt: Date.now() + 500,
  budget: { maxModelCycles: 1, maxTokens: 4_000_000 },
});
const nextWork = hungCoordinator.assignWork({
  teamId: hungTeam.team.id,
  targetMemberId: hungTeam.members.find((member) => member.sessionId === nextWorker.sessionId)!.id,
  title: "Continue after detached request",
  payload: {},
  idempotencyKey: "next-provider-work",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const hungPool = new RuntimeTaskPermitPool(1);
const hungManager = new SessionManager({
  taskPermits: hungPool,
  teamAttemptDetachGraceMs: 40,
});
const hungRoots = runtimeTaskDao.scanRunnableBackgroundRoots({ userId: hungUser, limit: 10 }).roots;
const hungCandidate = hungRoots.find((candidate) => candidate.taskId === hungWork.task.id)!;
const nextCandidate = hungRoots.find((candidate) => candidate.taskId === nextWork.task.id)!;
assert.equal(hungManager.activateRuntimeTaskRoot(hungCandidate), "activated");
await until(() => hungProviderCalls === 1, "abort-insensitive Team provider starts");
assert.equal(hungManager.activateRuntimeTaskRoot(nextCandidate), "no-capacity");
await until(
  () => runtimeTaskDao.byId(hungUser, hungWork.task.id)?.status === "interrupted",
  "hung Team deadline exact-fences its Task",
  5_000,
);
await until(() => hungPool.stats().active === 0, "hung Team permit detaches after bounded grace", 5_000);
const deadlineOutcome = teamTurnOutcomeDao.byTask(hungUser, hungWork.task.id)!;
assert.equal(deadlineOutcome.summary, "Team Turn deadline reached");
assert.deepEqual(deadlineOutcome.body, {
  recovery: "runtime_retirement",
  reason: "Team Turn deadline reached",
});
assert.deepEqual(deadlineOutcome.usage, { modelCycles: 0, tokens: 0 });
assert.deepEqual(teamTaskDao.usageByTask(hungUser, hungWork.task.id), { modelCycles: 0, tokens: 0 });
assert.equal(taskResultDao.byTask(hungUser, hungWork.task.id)!.summary, "Team Turn deadline reached");

const successProvider = () => {
  const stream = topPi.createAssistantMessageEventStream();
  queueMicrotask(() => pushTestAssistant(stream, "Second root completed."));
  return stream;
};
topCompat.registerApiProvider({ api: "mock", stream: successProvider, streamSimple: successProvider }, "dispatcher-success-team");
nestedCompat.registerApiProvider({ api: "mock", stream: successProvider, streamSimple: successProvider }, "dispatcher-success-team");
assert.equal(hungManager.activateRuntimeTaskRoot(nextCandidate), "activated");
await until(
  () => runtimeTaskDao.byId(hungUser, nextWork.task.id)?.status === "succeeded",
  "another root continues after hung Team detach",
  8_000,
);
const firstState = () => JSON.stringify({
  task: runtimeTaskDao.byId(hungUser, hungWork.task.id),
  mail: teamMailDao.byTask(hungUser, hungWork.task.id),
  result: taskResultDao.byTask(hungUser, hungWork.task.id),
  outcome: teamTurnOutcomeDao.byTask(hungUser, hungWork.task.id),
  turn: agentTurnDao.byTeamTask(hungWorker.sessionId, hungWork.task.id),
  session: sessionDao.byId(hungWorker.sessionId),
  timeline: timelineDao.list(hungWorker.sessionId),
  messages: messageDao.list(hungWorker.sessionId),
});
const beforeLateCompletion = firstState();
pushTestAssistant(hungProviderStream!, "Late stale completion.");
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(firstState(), beforeLateCompletion, "late provider completion cannot write or revive the fenced Turn");
assert.equal(hungPool.stats().active, 0);
console.log("  ✓ exact Team deadline refunds usage; hung provider detaches and late completion is inert");

let artifactProviderCalls = 0;
const artifactProvider = () => {
  const stream = topPi.createAssistantMessageEventStream();
  const call = artifactProviderCalls++;
  queueMicrotask(() => {
    if (call > 0) {
      pushTestAssistant(stream, "Artifact batch complete.");
      return;
    }
    const longDirectory = "p".repeat(120);
    pushTestToolBatch(stream, Array.from({ length: 128 }, (_, index) => ({
      id: `artifact-tool-${index}`,
      name: "write_file",
      arguments: {
        path: ["artifact-proof", String(index), longDirectory, longDirectory, longDirectory, longDirectory, "file.txt"].join("/"),
        content: `artifact ${index}`,
      },
    })));
  });
  return stream;
};
topCompat.registerApiProvider({ api: "mock", stream: artifactProvider, streamSimple: artifactProvider }, "dispatcher-artifact-team");
nestedCompat.registerApiProvider({ api: "mock", stream: artifactProvider, streamSimple: artifactProvider }, "dispatcher-artifact-team");
const artifactUser = "user_dispatch_artifact_team";
createUser(artifactUser);
const artifactOwner = createSessionRoot(artifactUser, "artifact_team_owner");
const artifactWorker = createSessionRoot(artifactUser, "artifact_team_worker");
let artifactSerial = 0;
const artifactCoordinator = new TeamCoordinator({
  userId: artifactUser,
  actorSessionId: artifactOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_artifact_team_${++artifactSerial}`,
});
const artifactTeam = artifactCoordinator.createFromSessions({
  name: "Artifact bounds",
  members: [
    { sessionId: artifactOwner.sessionId, role: "lead" },
    { sessionId: artifactWorker.sessionId, role: "worker" },
  ],
  leadSessionId: artifactOwner.sessionId,
});
const artifactWork = artifactCoordinator.assignWork({
  teamId: artifactTeam.team.id,
  targetMemberId: artifactTeam.members.find((member) => member.sessionId === artifactWorker.sessionId)!.id,
  title: "Bound artifact JSON",
  payload: {},
  idempotencyKey: "artifact-bound-work",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 2, maxTokens: 4_000_000 },
});
const artifactPool = new RuntimeTaskPermitPool(1);
const artifactManager = new SessionManager({ taskPermits: artifactPool });
const artifactCandidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot = {
  userId: artifactUser,
  sessionId: artifactWorker.sessionId,
  rootAgentId: artifactWorker.rootAgentId,
  taskId: artifactWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: artifactWork.task.createdAt,
};
assert.equal(artifactManager.activateRuntimeTaskRoot(artifactCandidate), "activated");
await until(
  () => runtimeTaskDao.byId(artifactUser, artifactWork.task.id)?.status === "succeeded",
  "oversized artifact batch completes",
  30_000,
);
const boundedArtifacts = teamTurnOutcomeDao.byTask(artifactUser, artifactWork.task.id)!.artifacts as unknown[];
assert.ok(boundedArtifacts.length > 0 && boundedArtifacts.length < 128);
assert.ok(Buffer.byteLength(JSON.stringify(boundedArtifacts), "utf8") <= 64 * 1024);
assert.notEqual(agentTurnDao.byTeamTask(artifactWorker.sessionId, artifactWork.task.id)?.status, "in_progress");
assert.equal(artifactManager.getRuntime(artifactUser, artifactWorker.sessionId)!.isBusy(), false);
const artifactFollowUp = artifactCoordinator.assignWork({
  teamId: artifactTeam.team.id,
  targetMemberId: artifactTeam.members.find((member) => member.sessionId === artifactWorker.sessionId)!.id,
  title: "Run after artifact batch",
  payload: {},
  idempotencyKey: "artifact-follow-up",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 4_000_000 },
});
assert.equal(artifactManager.activateRuntimeTaskRoot({
  ...artifactCandidate,
  taskId: artifactFollowUp.task.id,
  createdAt: artifactFollowUp.task.createdAt,
}), "activated");
await until(
  () => runtimeTaskDao.byId(artifactUser, artifactFollowUp.task.id)?.status === "succeeded",
  "Session runs after bounded artifact settlement",
  8_000,
);
console.log("  ✓ Team artifacts stay below 64 KiB and the real Session remains reusable");

const faultUser = "user_dispatch_outcome_fault";
createUser(faultUser);
const faultOwner = createSessionRoot(faultUser, "outcome_fault_owner");
const faultWorker = createSessionRoot(faultUser, "outcome_fault_worker");
let faultSerial = 0;
const faultCoordinator = new TeamCoordinator({
  userId: faultUser,
  actorSessionId: faultOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_outcome_fault_${++faultSerial}`,
});
const faultTeam = faultCoordinator.createFromSessions({
  name: "Outcome fault",
  members: [
    { sessionId: faultOwner.sessionId, role: "lead" },
    { sessionId: faultWorker.sessionId, role: "worker" },
  ],
  leadSessionId: faultOwner.sessionId,
});
const faultWork = faultCoordinator.assignWork({
  teamId: faultTeam.team.id,
  targetMemberId: faultTeam.members.find((member) => member.sessionId === faultWorker.sessionId)!.id,
  title: "Inject outcome write fault",
  payload: {},
  idempotencyKey: "outcome-write-fault",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const normalSuccessProvider = () => {
  const stream = topPi.createAssistantMessageEventStream();
  queueMicrotask(() => pushTestAssistant(stream, "Provider completed before outbox fault."));
  return stream;
};
topCompat.registerApiProvider({ api: "mock", stream: normalSuccessProvider, streamSimple: normalSuccessProvider }, "dispatcher-outcome-fault");
nestedCompat.registerApiProvider({ api: "mock", stream: normalSuccessProvider, streamSimple: normalSuccessProvider }, "dispatcher-outcome-fault");
const faultPool = new RuntimeTaskPermitPool(1);
const faultManager = new SessionManager({ taskPermits: faultPool });
const faultCandidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot = {
  userId: faultUser,
  sessionId: faultWorker.sessionId,
  rootAgentId: faultWorker.rootAgentId,
  taskId: faultWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: faultWork.task.createdAt,
};
const originalOutcomeRecord = teamTurnOutcomeDao.record;
teamTurnOutcomeDao.record = (() => { throw new Error("injected Team outcome write fault"); }) as typeof originalOutcomeRecord;
try {
  assert.equal(faultManager.activateRuntimeTaskRoot(faultCandidate), "activated");
  await until(
    () => runtimeTaskDao.byId(faultUser, faultWork.task.id)?.status === "interrupted",
    "outbox fault fences Team Task",
    8_000,
  );
  await until(() => faultPool.stats().active === 0, "outbox fault releases permit");
} finally {
  teamTurnOutcomeDao.record = originalOutcomeRecord;
}
assert.equal(teamTurnOutcomeDao.byTask(faultUser, faultWork.task.id), undefined);
assert.equal(taskResultDao.byTask(faultUser, faultWork.task.id)!.summary, "Team Turn runtime was lost.");
assert.equal(agentTurnDao.byTeamTask(faultWorker.sessionId, faultWork.task.id)?.status, "interrupted");
assert.equal(sessionDao.byId(faultWorker.sessionId)?.status, "idle");
assert.equal(faultManager.getRuntime(faultUser, faultWorker.sessionId)!.isBusy(), false);
console.log("  ✓ injected outcome failure fences work and releases the real Session lifecycle");

const stopUser = "user_dispatch_team_stop";
createUser(stopUser);
const stopOwner = createSessionRoot(stopUser, "team_stop_owner");
const stopWorker = createSessionRoot(stopUser, "team_stop_worker");
let stopSerial = 0;
const stopCoordinator = new TeamCoordinator({
  userId: stopUser,
  actorSessionId: stopOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_team_stop_${++stopSerial}`,
});
const stopTeam = stopCoordinator.createFromSessions({
  name: "Typed Stop",
  members: [
    { sessionId: stopOwner.sessionId, role: "lead" },
    { sessionId: stopWorker.sessionId, role: "worker" },
  ],
  leadSessionId: stopOwner.sessionId,
});
const stopWork = stopCoordinator.assignWork({
  teamId: stopTeam.team.id,
  targetMemberId: stopTeam.members.find((member) => member.sessionId === stopWorker.sessionId)!.id,
  title: "Stop at assistant terminal edge",
  payload: {},
  idempotencyKey: "typed-user-stop",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
topCompat.registerApiProvider({ api: "mock", stream: normalSuccessProvider, streamSimple: normalSuccessProvider }, "dispatcher-team-stop");
nestedCompat.registerApiProvider({ api: "mock", stream: normalSuccessProvider, streamSimple: normalSuccessProvider }, "dispatcher-team-stop");
const stopPool = new RuntimeTaskPermitPool(1);
const stopManager = new SessionManager({ taskPermits: stopPool });
const stopRuntime = stopManager.getRuntime(stopUser, stopWorker.sessionId)!;
let stopIssued = false;
const unsubscribeStop = stopRuntime.subscribe((event) => {
  if (
    !stopIssued
    && event.type === "agent_event"
    && event.event.t === "assistant_end"
  ) {
    stopIssued = true;
    stopRuntime.interrupt();
  }
});
const stopCandidate: import("../server/src/persistence/orchestration.ts").RunnableBackgroundRoot = {
  userId: stopUser,
  sessionId: stopWorker.sessionId,
  rootAgentId: stopWorker.rootAgentId,
  taskId: stopWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: stopWork.task.createdAt,
};
assert.equal(stopManager.activateRuntimeTaskRoot(stopCandidate), "activated");
await until(
  () => runtimeTaskDao.byId(stopUser, stopWork.task.id)?.status === "cancelled",
  "user Stop settles Team outcome as cancelled",
  8_000,
);
unsubscribeStop();
const stopOutcome = teamTurnOutcomeDao.byTask(stopUser, stopWork.task.id)!;
assert.equal(stopIssued, true);
assert.equal(stopOutcome.status, "cancelled");
assert.equal(stopOutcome.summary, "Team Turn cancelled by the user.");
assert.deepEqual(stopOutcome.body, {
  terminalStatus: "cancelled",
  reason: "Team Turn cancelled by the user.",
});
assert.doesNotMatch(stopOutcome.summary, /Provider completed/i);

let drainProviderCalls = 0;
const drainProvider = (
  _model: unknown,
  _context: unknown,
  options?: { signal?: AbortSignal },
) => {
  drainProviderCalls += 1;
  const stream = topPi.createAssistantMessageEventStream();
  const finish = () => {
    const message = {
      role: "assistant" as const,
      content: [],
      api: "mock" as const,
      provider: "mock",
      model: "mock-coder",
      usage: ZERO_USAGE,
      stopReason: "aborted" as const,
      errorMessage: "aborted by drain",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "error", reason: "aborted", error: message });
    stream.end(message);
  };
  if (options?.signal?.aborted) queueMicrotask(finish);
  else options?.signal?.addEventListener("abort", finish, { once: true });
  return stream;
};
topCompat.registerApiProvider({ api: "mock", stream: drainProvider, streamSimple: drainProvider }, "dispatcher-team-drain");
nestedCompat.registerApiProvider({ api: "mock", stream: drainProvider, streamSimple: drainProvider }, "dispatcher-team-drain");
const typedDrainUser = "user_dispatch_typed_drain";
createUser(typedDrainUser);
const typedDrainOwner = createSessionRoot(typedDrainUser, "typed_drain_owner");
const typedDrainWorker = createSessionRoot(typedDrainUser, "typed_drain_worker");
let typedDrainSerial = 0;
const typedDrainCoordinator = new TeamCoordinator({
  userId: typedDrainUser,
  actorSessionId: typedDrainOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_typed_drain_${++typedDrainSerial}`,
});
const typedDrainTeam = typedDrainCoordinator.createFromSessions({
  name: "Typed drain",
  members: [
    { sessionId: typedDrainOwner.sessionId, role: "lead" },
    { sessionId: typedDrainWorker.sessionId, role: "worker" },
  ],
  leadSessionId: typedDrainOwner.sessionId,
});
const typedDrainWork = typedDrainCoordinator.assignWork({
  teamId: typedDrainTeam.team.id,
  targetMemberId: typedDrainTeam.members.find((member) => member.sessionId === typedDrainWorker.sessionId)!.id,
  title: "Interrupt during deploy drain",
  payload: {},
  idempotencyKey: "typed-drain-work",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const typedDrainPool = new RuntimeTaskPermitPool(1);
const typedDrainManager = new SessionManager({ taskPermits: typedDrainPool });
assert.equal(typedDrainManager.activateRuntimeTaskRoot({
  userId: typedDrainUser,
  sessionId: typedDrainWorker.sessionId,
  rootAgentId: typedDrainWorker.rootAgentId,
  taskId: typedDrainWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: typedDrainWork.task.createdAt,
}), "activated");
await until(() => drainProviderCalls === 1, "typed drain provider starts");
typedDrainManager.setDraining();
await typedDrainManager.drainTurns({ waitMs: 0, settleMs: 1_000 });
await until(
  () => runtimeTaskDao.byId(typedDrainUser, typedDrainWork.task.id)?.status === "interrupted",
  "deploy drain settles Team outcome as interrupted",
  8_000,
);
const typedDrainOutcome = teamTurnOutcomeDao.byTask(typedDrainUser, typedDrainWork.task.id)!;
assert.equal(typedDrainOutcome.status, "interrupted");
assert.equal(typedDrainOutcome.summary, "Team Turn interrupted by server drain.");
assert.deepEqual(typedDrainOutcome.body, {
  terminalStatus: "interrupted",
  reason: "Team Turn interrupted by server drain.",
});

drainProviderCalls = 0;
const ownerDeleteUser = "user_dispatch_owner_delete";
createUser(ownerDeleteUser);
const deleteOwner = createSessionRoot(ownerDeleteUser, "owner_delete_owner");
const deleteSource = createSessionRoot(ownerDeleteUser, "owner_delete_source");
const deleteWorker = createSessionRoot(ownerDeleteUser, "owner_delete_worker");
let ownerDeleteSerial = 0;
const ownerDeleteCoordinator = new TeamCoordinator({
  userId: ownerDeleteUser,
  actorSessionId: deleteOwner.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_owner_delete_${++ownerDeleteSerial}`,
});
const ownerDeleteTeam = ownerDeleteCoordinator.createFromSessions({
  name: "Owner delete",
  members: [
    { sessionId: deleteOwner.sessionId, role: "lead" },
    { sessionId: deleteSource.sessionId, role: "dispatcher" },
    { sessionId: deleteWorker.sessionId, role: "worker" },
  ],
  leadSessionId: deleteOwner.sessionId,
});
const sourceCoordinator = new TeamCoordinator({
  userId: ownerDeleteUser,
  actorSessionId: deleteSource.sessionId,
  now: Date.now,
  id: (kind) => `${kind}_owner_delete_source_${++ownerDeleteSerial}`,
});
const ownerDeleteWork = sourceCoordinator.assignWork({
  teamId: ownerDeleteTeam.team.id,
  targetMemberId: ownerDeleteTeam.members.find((member) => member.sessionId === deleteWorker.sessionId)!.id,
  title: "Cancel when owner disappears",
  payload: {},
  idempotencyKey: "owner-delete-active-work",
  deadlineAt: Date.now() + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const ownerDeletePool = new RuntimeTaskPermitPool(1);
const ownerDeleteManager = new SessionManager({ taskPermits: ownerDeletePool });
assert.equal(ownerDeleteManager.activateRuntimeTaskRoot({
  userId: ownerDeleteUser,
  sessionId: deleteWorker.sessionId,
  rootAgentId: deleteWorker.rootAgentId,
  taskId: ownerDeleteWork.task.id,
  taskKind: "team_turn",
  agentKind: "session",
  createdAt: ownerDeleteWork.task.createdAt,
}), "activated");
await until(() => drainProviderCalls === 1, "owner-delete Team provider starts");
assert.equal(ownerDeleteManager.deleteSession(ownerDeleteUser, deleteOwner.sessionId), true);
await until(
  () => runtimeTaskDao.byId(ownerDeleteUser, ownerDeleteWork.task.id)?.status === "cancelled",
  "owner deletion cancels the exact Team Turn",
  8_000,
);
const ownerDeleteOutcome = teamTurnOutcomeDao.byTask(ownerDeleteUser, ownerDeleteWork.task.id)!;
assert.equal(ownerDeleteOutcome.status, "cancelled");
assert.equal(ownerDeleteOutcome.summary, "Team Turn cancelled because the Team owner Session was deleted.");
assert.deepEqual(ownerDeleteOutcome.body, {
  recovery: "runtime_retirement",
  reason: "Team Turn cancelled because the Team owner Session was deleted.",
  origin: "owner_session_deleted",
});
assert.equal(sessionDao.byId(deleteOwner.sessionId), undefined);
assert.equal(ownerDeleteTeam.team.id, runtimeTaskDao.byId(ownerDeleteUser, ownerDeleteWork.task.id)?.teamId);
console.log("  ✓ user Stop, deploy drain, and owner deletion persist distinct typed Team outcomes");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("RuntimeTaskDispatcher contract passed.");
