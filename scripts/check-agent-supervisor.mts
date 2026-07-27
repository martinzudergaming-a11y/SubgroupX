import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskActivityCode } from "../shared/src/orchestration.ts";
import type {
  SupervisedAgentRun,
  SupervisedAgentWorker,
  SupervisedAgentWorkerFactory,
  SupervisedAgentResult,
} from "../server/src/orchestration/agent-supervisor.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-supervisor-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const [
  { AgentSupervisor },
  persistence,
  { stableAgentAliases },
  { WorkflowLaunchService },
  { WorkflowCoordinator },
] = await Promise.all([
  import("../server/src/orchestration/agent-supervisor.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/orchestration/context-digest.ts"),
  import("../server/src/orchestration/workflow-launch.ts"),
  import("../server/src/orchestration/workflow-engine.ts"),
]);
const {
  agentNodeDao,
  agentTaskDao,
  agentTurnDao,
  db,
  joinedTaskProgressDao,
  runtimeTaskDao,
  sessionDao,
  taskResultDao,
  timelineDao,
  userDao,
  workflowDao,
} = persistence;

let tick = 1_900_000_000_000;
const now = () => ++tick;
let idSeq = 0;
const id = (kind: "agent" | "task" | "result") => `${kind}_${++idSeq}`;
const userId = "user_supervisor";
const sessionId = "session_supervisor";
const rootAgentId = "agent_root";

userDao.create({
  id: userId,
  email: "supervisor@example.invalid",
  password_hash: "x",
  created_at: now(),
});
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "Supervisor contract",
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

const atomicRevision = agentNodeDao.roster(userId, rootAgentId)!.revision;
assert.throws(() => agentTaskDao.create({
  agent: {
    id: "agent_atomic_rollback",
    userId,
    sessionId,
    rootAgentId,
    parentAgentId: rootAgentId,
    path: "/root/atomic_rollback",
    provider: "mock",
    model: "mock",
    kind: "subagent",
    createdAt: now(),
  },
  task: {
    id: "task_atomic_rollback",
    userId,
    sessionId,
    ownerSessionId: sessionId,
    agentId: "agent_atomic_rollback",
    kind: "delegation",
    title: "",
    payload: {},
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now(),
  },
}), /must not be empty/);
assert.equal(agentNodeDao.byId(userId, "agent_atomic_rollback"), undefined);
assert.equal(agentNodeDao.roster(userId, rootAgentId)?.revision, atomicRevision);

interface PendingRun {
  input: SupervisedAgentRun;
  resolve: (result: SupervisedAgentResult) => void;
  reject: (error: unknown) => void;
}

class WorkerHarness {
  readonly pending = new Map<string, PendingRun>();
  readonly starts: string[] = [];
  readonly steers: Array<{ agentId: string; message: string }> = [];
  readonly factoryCalls: string[] = [];
  readonly closedAgents: string[] = [];
  active = 0;
  maxActive = 0;

  readonly factory: SupervisedAgentWorkerFactory = ({ agent }): SupervisedAgentWorker => {
    this.factoryCalls.push(agent.id);
    let closed = false;
    return {
      run: (input) => {
        this.starts.push(input.task.id);
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        return new Promise<SupervisedAgentResult>((resolve, reject) => {
          let settled = false;
          const finish = (operation: () => void) => {
            if (settled) return;
            settled = true;
            input.signal.removeEventListener("abort", abort);
            this.pending.delete(input.task.id);
            this.active -= 1;
            operation();
          };
          const abort = () => finish(() => reject(input.signal.reason ?? new Error("aborted")));
          this.pending.set(input.task.id, {
            input,
            resolve: (result) => finish(() => resolve(result)),
            reject: (error) => finish(() => reject(error)),
          });
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        });
      },
      steer: async (message) => {
        if (closed) return false;
        this.steers.push({ agentId: agent.id, message });
        return true;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.closedAgents.push(agent.id);
      },
    };
  };

  complete(taskId: string, summary = `Completed ${taskId}`): void {
    const pending = this.pending.get(taskId);
    assert.ok(pending, `Task ${taskId} must be running`);
    pending.resolve({ summary, body: { taskId }, artifacts: [] });
  }

  activity(taskId: string, activity: TaskActivityCode): void {
    const pending = this.pending.get(taskId);
    assert.ok(pending, `Task ${taskId} must be running`);
    pending.input.updateActivity(activity);
  }
}

async function until(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const workers = new WorkerHarness();
const supervisor = new AgentSupervisor({
  userId,
  sessionId,
  rootAgentId,
  workerFactory: workers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  limits: {
    maxActivePerParent: 2,
    maxActiveAgents: 2,
    maxTreeAgents: 6,
    maxDepth: 2,
    maxOpenTasks: 8,
    maxIdleWorkers: 1,
  },
});
assert.throws(
  () => supervisor.followUp({ target: "/root", message: "Do not duplicate the root runtime" }),
  /not a SubAgent follow-up target/,
);

const alpha = supervisor.spawn({ initialMessages: [], taskName: "alpha", message: "Inspect alpha" });
const beta = supervisor.spawn({ initialMessages: [], taskName: "beta", message: "Inspect beta" });
const gamma = supervisor.spawn({ initialMessages: [], taskName: "gamma", message: "Inspect gamma" });
assert.deepEqual([alpha.path, beta.path, gamma.path], ["/root/alpha", "/root/beta", "/root/gamma"]);
assert.equal(workers.starts.length, 0, "spawn returns before worker construction and model I/O");
assert.throws(
  () => supervisor.spawn({ initialMessages: [], taskName: "alpha", message: "Duplicate" }),
  /use followUp/,
  "a stable path never gets a silent numeric suffix",
);
await until(() => workers.pending.has(alpha.taskId) && workers.pending.has(beta.taskId), "two workers start");
assert.equal(runtimeTaskDao.byId(userId, gamma.taskId)?.status, "queued");
assert.equal(supervisor.stats().activeTasks, 2);
assert.equal(supervisor.stats().openTasks, 3);
assert.equal(supervisor.stats().backgroundTasks, 3);
assert.equal(supervisor.hasActiveTasks(), true);
assert.equal(supervisor.hasBackgroundTasks(), true);
assert.equal(workers.maxActive, 2, "tree and parent concurrency are bounded");
console.log("  ✓ spawn persists a stable handle and schedules within both concurrency bounds");

await supervisor.send(alpha.path, "Check the edge case");
assert.deepEqual(workers.steers, [{ agentId: alpha.agentId, message: "Check the edge case" }]);
await assert.rejects(
  supervisor.send(gamma.path, "This must not become a queued user Message"),
  /no active worker/,
);

const beforeActivity = supervisor.roster().revision;
const activityWait = supervisor.waitForChange({
  afterRevision: beforeActivity,
  targets: [alpha.path],
  timeoutMs: 500,
});
workers.activity(alpha.taskId, "tool:read");
const activityChange = await activityWait;
assert.equal(activityChange.changed, true);
assert.equal(activityChange.agents[0]?.id, alpha.agentId);
assert.ok(activityChange.revision > beforeActivity);
console.log("  ✓ send only steers a live worker and wait follows the durable roster revision");

workers.complete(alpha.taskId, "Alpha result");
await until(() => runtimeTaskDao.byId(userId, alpha.taskId)?.status === "succeeded", "alpha settles");
await until(() => workers.pending.has(gamma.taskId), "queued gamma starts after alpha");
assert.equal(taskResultDao.byTask(userId, alpha.taskId)?.summary, "Alpha result");

const alphaFollowUp = supervisor.followUp({ target: alpha.path, message: "Verify alpha again" });
assert.equal(alphaFollowUp.agentId, alpha.agentId, "follow-up keeps the Agent identity");
assert.equal(alphaFollowUp.path, alpha.path);
assert.equal(runtimeTaskDao.byId(userId, alphaFollowUp.taskId)?.status, "queued");

assert.equal(supervisor.interrupt(beta.path), true);
await until(() => runtimeTaskDao.byId(userId, beta.taskId)?.status === "cancelled", "beta cancels");
await until(() => workers.pending.has(alphaFollowUp.taskId), "follow-up starts on the existing Agent");
const staleUnreadWait = await supervisor.waitForChange({ targets: [alpha.path], timeoutMs: 15 });
assert.equal(staleUnreadWait.timedOut, true, "an older unread result cannot complete a running follow-up wait");
assert.equal(supervisor.interrupt(beta.path), false, "interrupt is active-only and idempotent");
workers.complete(gamma.taskId);
workers.complete(alphaFollowUp.taskId);
await until(() => supervisor.stats().openTasks === 0, "first task set settles");
await until(() => supervisor.stats().cachedWorkers <= 1, "idle worker LRU trims");
assert.ok(workers.closedAgents.length >= 2, "the idle worker cache has a strict bound");
assert.equal(workers.factoryCalls.filter((agentId) => agentId === alpha.agentId).length, 1, "follow-up reuses warm context");
console.log("  ✓ follow-up is a new Task, interrupt cancels one active Turn, and worker reuse is bounded");

const child = supervisor.spawn({ initialMessages: [],
  taskName: "child",
  message: "Inspect one nested concern",
  parentAgentId: alpha.agentId,
});
assert.equal(child.path, "/root/alpha/child");
assert.throws(
  () => supervisor.spawn({ initialMessages: [],
    taskName: "too_deep",
    message: "This must fail",
    parentAgentId: child.agentId,
  }),
  /depth limit/,
);
const treeFills = [];
while (agentNodeDao.countLiveByRoot(userId, rootAgentId) < 6) {
  treeFills.push(supervisor.spawn({
    initialMessages: [],
    taskName: `tree_fill_${treeFills.length}`,
    message: "Hold a live tree slot",
  }));
}
assert.ok(treeFills.length > 0, "the live tree had room before it was filled");
assert.throws(
  () => supervisor.spawn({ initialMessages: [], taskName: "tree_overflow", message: "This must fail" }),
  /tree limit/,
);
await until(() => workers.pending.has(child.taskId), "nested child starts");
workers.complete(child.taskId);
await until(() => runtimeTaskDao.byId(userId, child.taskId)?.status === "succeeded", "nested child settles");
for (const treeFill of treeFills) {
  await until(() => workers.pending.has(treeFill.taskId), "tree fill starts");
  workers.complete(treeFill.taskId);
  await until(() => runtimeTaskDao.byId(userId, treeFill.taskId)?.status === "succeeded", "tree fill settles");
}
assert.ok(
  agentNodeDao.countLiveByRoot(userId, rootAgentId) < 6,
  "settling the fill Agents releases their tree slots",
);
assert.equal(workers.maxActive <= 2, true);
console.log("  ✓ tree size and spawn depth reject expansion before a worker is created");

const timeoutRevision = supervisor.roster().revision;
const timeout = await supervisor.waitForChange({ afterRevision: timeoutRevision, targets: [child.path], timeoutMs: 15 });
assert.equal(timeout.changed, false);
assert.equal(timeout.timedOut, true);

const completedBeforeWait = await supervisor.waitForChange({ targets: [child.path], timeoutMs: 500 });
assert.equal(completedBeforeWait.changed, true, "a completion that predates wait returns immediately");
assert.equal(completedBeforeWait.timedOut, false);

const childResult = taskResultDao.byTask(userId, child.taskId)!;
const resultBefore = supervisor.roster().revision;
const resultWait = supervisor.waitForChange({
  afterRevision: resultBefore,
  targets: [child.path],
  timeoutMs: 500,
});
assert.ok(taskResultDao.acknowledge({
  userId,
  taskId: child.taskId,
  expectedVersion: childResult.version,
  at: now(),
}));
assert.equal((await resultWait).changed, true, "targeted wait observes a terminal result edge");

const aliases = stableAgentAliases(supervisor.roster().nodes, supervisor.roster().tasks.map((task) => task.agentId));
const alphaAlias = aliases.get(alpha.agentId)!;
const restartA = supervisor.followUp({ target: alphaAlias, message: "Long restart-sensitive task" });
const restartB = supervisor.followUp({ target: beta.path, message: "Queued across runtime close" });
await until(() => workers.pending.has(restartA.taskId) && workers.pending.has(restartB.taskId), "restart tasks start");

const restartQueued = supervisor.followUp({ target: gamma.path, message: "Resume me in the next runtime" });
assert.equal(runtimeTaskDao.byId(userId, restartQueued.taskId)?.status, "queued");
await supervisor.close();
await until(() => runtimeTaskDao.byId(userId, restartA.taskId)?.status === "interrupted", "restartA fenced to interrupted after close", 10_000);
await until(() => runtimeTaskDao.byId(userId, restartB.taskId)?.status === "interrupted", "restartB fenced to interrupted after close", 10_000);
assert.equal(runtimeTaskDao.byId(userId, restartQueued.taskId)?.status, "queued");
assert.equal(supervisor.hasBackgroundTasks(), true, "queued DB work still pins a replacement runtime");

const replacementWorkers = new WorkerHarness();
const replacement = new AgentSupervisor({
  userId,
  sessionId,
  rootAgentId,
  workerFactory: replacementWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  limits: {
    maxActivePerParent: 1,
    maxActiveAgents: 1,
    maxTreeAgents: 6,
    maxDepth: 2,
    maxOpenTasks: 8,
    maxIdleWorkers: 1,
  },
});
await until(() => replacementWorkers.pending.has(restartQueued.taskId), "replacement resumes queued DB task");

const externalBefore = replacement.roster().revision;
const externalWait = replacement.waitForChange({
  afterRevision: externalBefore,
  targets: [gamma.path],
  timeoutMs: 500,
});
const externallyCurrent = runtimeTaskDao.byId(userId, restartQueued.taskId)!;
const externallyUpdated = runtimeTaskDao.updateActivity({
  id: externallyCurrent.id,
  userId,
  expectedVersion: externallyCurrent.version,
  expectedLeaseGeneration: externallyCurrent.leaseGeneration,
  activity: "tool:search",
  at: now(),
});
assert.ok(externallyUpdated);
const externalChange = await externalWait;
assert.equal(externalChange.changed, true, "polling observes a revision changed outside this process cache");

replacementWorkers.complete(restartQueued.taskId);
await until(() => runtimeTaskDao.byId(userId, restartQueued.taskId)?.status === "succeeded", "replacement task settles");
assert.equal(replacement.hasBackgroundTasks(), false);
await replacement.close();
assert.equal(replacement.stats().cachedWorkers, 0);
console.log("  ✓ close interrupts live leases, leaves queued truth, and a replacement runtime resumes it");

const hangingSessionId = "session_hanging_factory";
const hangingRootId = "agent_hanging_root";
sessionDao.create({
  id: hangingSessionId,
  user_id: userId,
  title: "Hanging worker contract",
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
  id: hangingRootId,
  userId,
  sessionId: hangingSessionId,
  rootAgentId: hangingRootId,
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now(),
});
const hanging = new AgentSupervisor({
  userId,
  sessionId: hangingSessionId,
  rootAgentId: hangingRootId,
  workerFactory: () => new Promise<SupervisedAgentWorker>(() => {}),
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 20,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
const hangingHandle = hanging.spawn({ initialMessages: [], taskName: "hung", message: "Factory never resolves" });
await until(() => runtimeTaskDao.byId(userId, hangingHandle.taskId)?.status === "starting", "hanging Task claims");
const closeStarted = Date.now();
await hanging.close();
assert.ok(Date.now() - closeStarted < 200, "close has a hard Promise-level deadline");
assert.equal(runtimeTaskDao.byId(userId, hangingHandle.taskId)?.status, "interrupted");
assert.equal(agentNodeDao.byId(userId, hangingHandle.agentId)?.status, "interrupted");
assert.equal(hanging.stats().cachedWorkers, 0);
console.log("  ✓ close fences a hung factory and settles durable state before its deadline");

function createIsolatedRoot(label: string): { sessionId: string; rootId: string } {
  const isolatedSessionId = `session_${label}`;
  const rootId = `agent_${label}_root`;
  sessionDao.create({
    id: isolatedSessionId,
    user_id: userId,
    title: label,
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
    thinking_level: "off",
    cwd: ".",
    created_at: now(),
    updated_at: now(),
  });
  agentNodeDao.create({
    id: rootId,
    userId,
    sessionId: isolatedSessionId,
    rootAgentId: rootId,
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now(),
  });
  return { sessionId: isolatedSessionId, rootId };
}

const malformedIds = createIsolatedRoot("malformed_scheduler");
const foreignWorkflowIds = createIsolatedRoot("malformed_scheduler_foreign");
const malformedAgent = agentNodeDao.create({
  id: "agent_malformed_scheduler_child",
  userId,
  sessionId: malformedIds.sessionId,
  rootAgentId: malformedIds.rootId,
  parentAgentId: malformedIds.rootId,
  path: "/root/worker",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
db.prepare(
  `INSERT INTO workflows
    (id, user_id, owner_session_id, root_agent_id, name, status,
     version, created_at, updated_at)
   VALUES ('workflow_malformed_scheduler', ?, ?, ?, 'Wrong root', 'running', 1, ?, ?)`,
).run(userId, foreignWorkflowIds.sessionId, foreignWorkflowIds.rootId, now(), now());
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_malformed_scheduler', ?, ?, ?, NULL, NULL, ?, 1, NULL,
     'workflow_malformed_scheduler', 'workflow_node', 'Must never run', '{}', 2,
     'queued', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(userId, malformedIds.sessionId, malformedIds.sessionId, malformedAgent.id, now(), now());
const validAfterMalformed = runtimeTaskDao.create({
  id: "task_valid_after_malformed",
  userId,
  sessionId: malformedIds.sessionId,
  ownerSessionId: malformedIds.sessionId,
  agentId: malformedAgent.id,
  kind: "delegation",
  title: "Valid work after malformed row",
  payload: {},
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now(),
});
assert.deepEqual(
  runtimeTaskDao.listOpenByRoot(userId, malformedIds.rootId).map((task) => task.id),
  [validAfterMalformed.id],
);
assert.equal(runtimeTaskDao.countRunnableByRoot(userId, malformedIds.rootId), 1);
assert.equal(runtimeTaskDao.claim({
  id: "task_malformed_scheduler",
  userId,
  expectedVersion: 1,
  at: now(),
}), null);
const malformedWorkers = new WorkerHarness();
const malformedSupervisor = new AgentSupervisor({
  userId,
  sessionId: malformedIds.sessionId,
  rootAgentId: malformedIds.rootId,
  workerFactory: malformedWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
await until(() => malformedWorkers.pending.has(validAfterMalformed.id), "valid work bypasses malformed row");
assert.deepEqual(malformedWorkers.starts, [validAfterMalformed.id]);
malformedWorkers.complete(validAfterMalformed.id);
await until(
  () => runtimeTaskDao.byId(userId, validAfterMalformed.id)?.status === "succeeded",
  "valid work after malformed row settles",
);
await malformedSupervisor.close();
console.log("  ✓ malformed queued work is invisible, unclaimable, and never blocks valid work");

const schedulingWindowIds = createIsolatedRoot("scheduling_window");
const schedulingWindowWorkers = new WorkerHarness();
const schedulingWindow = new AgentSupervisor({
  userId,
  sessionId: schedulingWindowIds.sessionId,
  rootAgentId: schedulingWindowIds.rootId,
  workerFactory: schedulingWindowWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  limits: { maxOpenTasks: 64, maxTreeAgents: 100 },
});
for (let index = 0; index < 64; index += 1) {
  const agentId = `agent_scheduling_wait_${index}`;
  const taskId = `task_scheduling_wait_${index}`;
  const created = agentTaskDao.create({
    agent: {
      id: agentId,
      userId,
      sessionId: schedulingWindowIds.sessionId,
      rootAgentId: schedulingWindowIds.rootId,
      parentAgentId: schedulingWindowIds.rootId,
      path: `/root/wait_${index}`,
      provider: "mock",
      model: "mock",
      kind: "subagent",
      createdAt: now(),
    },
    task: {
      id: taskId,
      userId,
      sessionId: schedulingWindowIds.sessionId,
      ownerSessionId: schedulingWindowIds.sessionId,
      agentId,
      kind: "delegation",
      title: `waiting ${index}`,
      payload: { message: "blocked dependency", context: "none" },
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: false,
      createdAt: now(),
    },
    initialMessages: [],
  });
  const claimed = runtimeTaskDao.claim({
    id: created.task.id,
    userId,
    expectedVersion: created.task.version,
    at: now(),
  })!;
  const running = runtimeTaskDao.transition({
    id: claimed.id,
    userId,
    expectedVersion: claimed.version,
    expectedLeaseGeneration: claimed.leaseGeneration,
    nextStatus: "running",
    at: now(),
  })!;
  runtimeTaskDao.transition({
    id: running.id,
    userId,
    expectedVersion: running.version,
    expectedLeaseGeneration: running.leaseGeneration,
    nextStatus: "waiting",
    waitReason: "dependency",
    at: now(),
  });
}
const schedulingTail = agentTaskDao.create({
  agent: {
    id: "agent_scheduling_tail",
    userId,
    sessionId: schedulingWindowIds.sessionId,
    rootAgentId: schedulingWindowIds.rootId,
    parentAgentId: schedulingWindowIds.rootId,
    path: "/root/runnable_tail",
    provider: "mock",
    model: "mock",
    kind: "subagent",
    createdAt: now(),
  },
  task: {
    id: "task_scheduling_tail",
    userId,
    sessionId: schedulingWindowIds.sessionId,
    ownerSessionId: schedulingWindowIds.sessionId,
    agentId: "agent_scheduling_tail",
    kind: "delegation",
    title: "runnable beyond waiting prefix",
    payload: { message: "must run", context: "none" },
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now(),
  },
  initialMessages: [],
});
schedulingWindow.poke();
await until(
  () => schedulingWindowWorkers.pending.has(schedulingTail.task.id),
  "runnable Task beyond 64 waiting rows starts",
);
schedulingWindowWorkers.complete(schedulingTail.task.id);
await until(
  () => runtimeTaskDao.byId(userId, schedulingTail.task.id)?.status === "succeeded",
  "tail Task settles",
);
assert.equal(runtimeTaskDao.countOpenByRoot(userId, schedulingWindowIds.rootId), 64);
await schedulingWindow.close();
sessionDao.delete(schedulingWindowIds.sessionId);
console.log("  ✓ exact scheduling sample cannot hide runnable work behind 64 waiting rows");

const joinedNoSinkIds = createIsolatedRoot("joined_without_sink");
const joinedNoSinkWorkers = new WorkerHarness();
const joinedNoSink = new AgentSupervisor({
  userId,
  sessionId: joinedNoSinkIds.sessionId,
  rootAgentId: joinedNoSinkIds.rootId,
  workerFactory: joinedNoSinkWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
const joinedNoSinkRevision = joinedNoSink.roster().revision;
assert.throws(() => joinedNoSink.spawn({
  initialMessages: [],
  taskName: "joined_slot_1",
  message: "Must not become durable",
  ownerTurnId: "turn_missing_sink",
  ownerStepId: "step_missing_sink",
  awaitPolicy: "join",
  internalPurpose: "joined-slot",
}), /requires a durable Child progress sink/);
assert.equal(joinedNoSink.roster().revision, joinedNoSinkRevision);
assert.equal(runtimeTaskDao.countOpenByRoot(userId, joinedNoSinkIds.rootId), 0);
assert.equal(joinedNoSinkWorkers.starts.length, 0);
await joinedNoSink.close();
sessionDao.delete(joinedNoSinkIds.sessionId);
console.log("  ✓ joined admission rejects a missing durable progress sink before creation");

const joinedIds = createIsolatedRoot("joined_visibility");
const joinedWorkers = new WorkerHarness();
const joinedTurnId = "turn_joined_visibility";
const joinedOwnerSeqs = new Map<string, number>();
const joinedFaults: string[] = [];
agentTurnDao.start({
  id: joinedTurnId,
  sessionId: joinedIds.sessionId,
  startedAt: now(),
  provider: "mock",
  model: "mock",
});
const addJoinedOwnerStep = (id: string, seq: number): void => {
  timelineDao.append(joinedIds.sessionId, {
    kind: "tool",
    id,
    seq,
    name: "spawn_subagent",
    toolKind: "subagent",
    arguments: {},
    status: "running",
    ts: now(),
    turnId: joinedTurnId,
  });
  joinedOwnerSeqs.set(id, seq);
};
const joinedFirstStepId = "step_joined_first";
addJoinedOwnerStep(joinedFirstStepId, 1);
const joined = new AgentSupervisor({
  userId,
  sessionId: joinedIds.sessionId,
  rootAgentId: joinedIds.rootId,
  workerFactory: joinedWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  onError: (error, context) => joinedFaults.push(
    `${context.phase}:${context.taskId ?? "-"}:${error instanceof Error ? error.message : String(error)}`,
  ),
  onJoinedProgress: ({ task, ownerStepId, progressSeq, at, event }) => {
    const ownerTimelineSeq = joinedOwnerSeqs.get(ownerStepId);
    assert.ok(ownerTimelineSeq, `owner Step ${ownerStepId} must have an exact Timeline seq`);
    return joinedTaskProgressDao.commit({
      userId,
      taskId: task.id,
      expectedLeaseGeneration: task.leaseGeneration,
      progressSeq,
      ownerTimelineSeq,
      event,
      at,
    }).kind !== "stale";
  },
});
const joinedPublicRevision = joined.modelRoster().revision;
const joinedFullRevision = joined.roster().revision;
const joinedHandle = joined.spawn({
  initialMessages: [],
  taskName: "joined_slot_1",
  message: "Private joined work",
  awaitPolicy: "join",
  cancelPolicy: "linked",
  ownerTurnId: joinedTurnId,
  ownerStepId: joinedFirstStepId,
  internalPurpose: "joined-slot",
});
assert.ok(joined.roster().revision > joinedFullRevision);
assert.equal(joined.modelRoster().revision, joinedPublicRevision);
assert.equal(joined.modelRoster().nodes.length, 1);
assert.equal(joined.modelRoster().counts.tasks, 0);
assert.throws(() => joined.resolveAddressableTarget(joinedHandle.path), /not found/);
await until(() => joinedWorkers.pending.has(joinedHandle.taskId), "private joined slot starts");
const joinedFirstRun = joinedWorkers.pending.get(joinedHandle.taskId)!;
const joinedFirstChildTurnId = `turn_child_${joinedHandle.taskId}_${joinedFirstRun.input.task.leaseGeneration}`;
assert.equal(joinedFirstRun.input.publishProgress({
  t: "turn_start",
  turnId: joinedFirstChildTurnId,
  startedAt: now(),
}), true);
assert.equal(joinedFirstRun.input.publishProgress({
  t: "turn_end",
  turnId: joinedFirstChildTurnId,
  status: "completed",
  completedAt: now(),
  durationMs: 1,
}), true);
const longJoinedReport = `LONG_START:${"x".repeat(80_000)}:LONG_END`;
joinedFirstRun.resolve({
  summary: longJoinedReport,
  body: { report: longJoinedReport },
  artifacts: [],
});
await until(
  () => runtimeTaskDao.byId(userId, joinedHandle.taskId)?.status === "succeeded",
  "private joined slot settles",
);
assert.equal(joined.modelRoster().revision, joinedPublicRevision);
assert.equal(joined.modelRoster().counts.unread, 0);
const joinedResult = taskResultDao.byTask(userId, joinedHandle.taskId)!;
assert.ok(Buffer.byteLength(joinedResult.summary, "utf8") <= 4_096);
assert.match(joinedResult.summary, /truncated/);
assert.equal((joinedResult.body as { report?: string }).report, longJoinedReport);
assert.ok(taskResultDao.acknowledge({
  userId,
  taskId: joinedHandle.taskId,
  expectedVersion: joinedResult.version,
  at: now(),
}));
assert.equal(joined.modelRoster().revision, joinedPublicRevision);

const joinedFollowUpStepId = "step_joined_followup";
addJoinedOwnerStep(joinedFollowUpStepId, 2);
const joinedFollowUp = joined.followUp({
  target: joinedHandle.path,
  message: "Reuse private slot",
  awaitPolicy: "join",
  cancelPolicy: "linked",
  ownerTurnId: joinedTurnId,
  ownerStepId: joinedFollowUpStepId,
  resetContext: true,
  internalAgentConfig: { provider: "mock-next", model: "mock-small", thinkingLevel: "low" },
});
await until(() => joinedWorkers.pending.has(joinedFollowUp.taskId), "private joined follow-up starts");
const joinedFollowUpRun = joinedWorkers.pending.get(joinedFollowUp.taskId)!;
const joinedFollowUpChildTurnId = `turn_child_${joinedFollowUp.taskId}_${joinedFollowUpRun.input.task.leaseGeneration}`;
assert.equal(joinedFollowUpRun.input.publishProgress({
  t: "turn_start",
  turnId: joinedFollowUpChildTurnId,
  startedAt: now(),
}), true);
assert.equal(joinedFollowUpRun.input.publishProgress({
  t: "turn_end",
  turnId: joinedFollowUpChildTurnId,
  status: "completed",
  completedAt: now(),
  durationMs: 1,
}), true);
joinedWorkers.complete(joinedFollowUp.taskId, "private follow-up result");
await until(
  () => runtimeTaskDao.byId(userId, joinedFollowUp.taskId)?.status === "succeeded",
  "private joined follow-up settles",
);
assert.equal(joined.modelRoster().revision, joinedPublicRevision);
assert.deepEqual(
  [agentNodeDao.byId(userId, joinedHandle.agentId)?.provider, agentNodeDao.byId(userId, joinedHandle.agentId)?.model],
  ["mock-next", "mock-small"],
);

const joinedMissingProgressStepId = "step_joined_missing_progress";
addJoinedOwnerStep(joinedMissingProgressStepId, 3);
const joinedMissingProgress = joined.followUp({
  target: joinedHandle.path,
  message: "Return without progress",
  awaitPolicy: "join",
  cancelPolicy: "linked",
  ownerTurnId: joinedTurnId,
  ownerStepId: joinedMissingProgressStepId,
  resetContext: true,
});
await until(() => joinedWorkers.pending.has(joinedMissingProgress.taskId), "joined omission fixture starts");
joinedWorkers.complete(joinedMissingProgress.taskId, "invalid success without progress");
await until(
  () => runtimeTaskDao.byId(userId, joinedMissingProgress.taskId)?.status === "failed",
  "joined omission terminalizes as failed",
);
assert.match(taskResultDao.byTask(userId, joinedMissingProgress.taskId)!.summary, /cannot succeed without Child progress/);
assert.deepEqual(
  joinedFaults.filter((fault) => fault.includes(joinedMissingProgress.taskId)),
  [`result_settle:${joinedMissingProgress.taskId}:A joined Task cannot succeed without Child progress`],
  "one deterministic invariant failure is reported, then settlement converges",
);
await joined.close();
console.log("  ✓ joined slots stay private and a missing terminal projection fails without retrying forever");

const overflowIds = createIsolatedRoot("roster_overflow");
const overflowTarget = agentTaskDao.create({
  agent: {
    id: "agent_overflow_target",
    userId,
    sessionId: overflowIds.sessionId,
    rootAgentId: overflowIds.rootId,
    parentAgentId: overflowIds.rootId,
    path: "/root/overflow_target",
    provider: "mock",
    model: "mock",
    kind: "subagent",
    status: "idle",
    createdAt: now(),
  },
  task: {
    id: "task_overflow_target",
    userId,
    sessionId: overflowIds.sessionId,
    ownerSessionId: overflowIds.sessionId,
    agentId: "agent_overflow_target",
    kind: "delegation",
    title: "Run omitted target",
    payload: { message: "Run omitted target", context: "none" },
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now(),
  },
  initialMessages: [],
});
for (let index = 0; index < 100; index += 1) {
  agentNodeDao.create({
    id: `agent_overflow_noise_${index}`,
    userId,
    sessionId: overflowIds.sessionId,
    rootAgentId: overflowIds.rootId,
    parentAgentId: overflowIds.rootId,
    path: `/root/overflow_noise_${index}`,
    provider: "mock",
    model: "mock",
    kind: "subagent",
    status: "idle",
    createdAt: now(),
  });
}
assert.equal(
  agentNodeDao.roster(userId, overflowIds.rootId)!.nodes.some((node) => node.id === overflowTarget.agent.id),
  false,
);
const overflowWorkers = new WorkerHarness();
const overflow = new AgentSupervisor({
  userId,
  sessionId: overflowIds.sessionId,
  rootAgentId: overflowIds.rootId,
  workerFactory: overflowWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  limits: { maxTreeAgents: 100 },
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
await until(() => overflowWorkers.pending.has(overflowTarget.task.id), "omitted Agent Task starts");
assert.equal(overflow.resolveAddressableTarget(overflowTarget.agent.path).id, overflowTarget.agent.id);
overflowWorkers.complete(overflowTarget.task.id);
await until(
  () => runtimeTaskDao.byId(userId, overflowTarget.task.id)?.status === "succeeded",
  "omitted Agent Task settles",
);
await overflow.close();
console.log("  ✓ scheduler and exact path control do not depend on the bounded roster sample");

const forcedIds = createIsolatedRoot("forced_cancel");
let forcedWorkerClosed = false;
let releaseForcedWorker: (() => void) | undefined;
const forcedIdle: string[] = [];
const forced = new AgentSupervisor({
  userId,
  sessionId: forcedIds.sessionId,
  rootAgentId: forcedIds.rootId,
  workerFactory: () => ({
    run: () => new Promise<SupervisedAgentResult>((resolve) => {
      releaseForcedWorker = () => resolve({ summary: "late success", body: {}, artifacts: [] });
    }),
    close: () => { forcedWorkerClosed = true; },
  }),
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 20,
  interruptGraceMs: 10,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  onIdle: (outcome) => forcedIdle.push(outcome),
});
const forcedHandle = forced.spawn({ initialMessages: [], taskName: "hung", message: "Ignore AbortSignal" });
await until(() => runtimeTaskDao.byId(userId, forcedHandle.taskId)?.status === "running", "hung worker starts");
assert.equal(forced.interrupt(forcedHandle.path), true);
await until(() => runtimeTaskDao.byId(userId, forcedHandle.taskId)?.status === "cancelled", "hung worker force-cancels");
await until(() => forced.stats().backgroundTasks === 0 && forcedIdle.length === 1, "forced cancel publishes idle");
assert.deepEqual(forcedIdle, ["done"]);
assert.equal(forcedWorkerClosed, true);
releaseForcedWorker?.();
await new Promise((resolve) => setTimeout(resolve, 25));
assert.deepEqual(forcedIdle, ["done"], "late worker settlement cannot publish a second idle edge");
await forced.close();
console.log("  ✓ interrupt has a hard grace and releases a worker that ignores AbortSignal");

const externalFenceIds = createIsolatedRoot("external_terminal_fence");
let externalFenceClosed = false;
let releaseExternalFence: (() => void) | undefined;
const externalFence = new AgentSupervisor({
  userId,
  sessionId: externalFenceIds.sessionId,
  rootAgentId: externalFenceIds.rootId,
  workerFactory: () => ({
    run: () => new Promise<SupervisedAgentResult>((resolve) => {
      releaseExternalFence = () => resolve({ summary: "late external success", body: {}, artifacts: [] });
    }),
    close: () => { externalFenceClosed = true; },
  }),
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 50,
  interruptGraceMs: 10,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
const externalFenceHandle = externalFence.spawn({
  initialMessages: [],
  taskName: "externally_fenced",
  message: "Ignore the Task signal after another transaction settles it",
});
await until(
  () => runtimeTaskDao.byId(userId, externalFenceHandle.taskId)?.status === "running",
  "external-fence worker starts",
);
const externalRunning = runtimeTaskDao.byId(userId, externalFenceHandle.taskId)!;
assert.ok(runtimeTaskDao.transition({
  id: externalRunning.id,
  userId,
  expectedVersion: externalRunning.version,
  expectedLeaseGeneration: externalRunning.leaseGeneration,
  nextStatus: "interrupted",
  at: now(),
  eventType: "external:interrupted",
  eventPayload: {},
}));
assert.equal(externalFence.interruptExternallySettledTask(externalFenceHandle.taskId), true);
await until(() => externalFenceClosed, "external terminal Task force-closes its worker");
assert.equal(runtimeTaskDao.byId(userId, externalFenceHandle.taskId)?.status, "interrupted");
assert.equal(taskResultDao.byTask(userId, externalFenceHandle.taskId), undefined);
releaseExternalFence?.();
await externalFence.close();
console.log("  ✓ an external terminal edge still drives AbortSignal and the hard grace");

const workflowDeleteIds = createIsolatedRoot("workflow_delete_execution");
const workflowDeleteAgent = agentNodeDao.create({
  id: "agent_workflow_delete_live",
  userId,
  sessionId: workflowDeleteIds.sessionId,
  rootAgentId: workflowDeleteIds.rootId,
  parentAgentId: workflowDeleteIds.rootId,
  path: "/root/workflow_delete_live",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const workflowOwnerSessionId = "session_workflow_delete_owner_live";
sessionDao.create({
  id: workflowOwnerSessionId,
  user_id: userId,
  title: "Workflow delete owner",
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
  thinking_level: "off",
  cwd: ".",
  created_at: now(),
  updated_at: now(),
});
const liveWorkflowId = "workflow_delete_live_probe";
const insertLegacyWorkflow = db.prepare(
  `INSERT INTO workflows
    (id, user_id, owner_session_id, root_agent_id, name, status,
     version, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'Live delete probe', 'running', 1, ?, ?)`,
);
assert.throws(
  () => insertLegacyWorkflow.run(
    liveWorkflowId,
    userId,
    workflowOwnerSessionId,
    workflowDeleteIds.rootId,
    now(),
    now(),
  ),
  /invalid Workflow ownership or limits/,
  "new Workflow ingress rejects a cross-Session Agent root",
);
const workflowInsertTrigger = db.prepare(
  "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'workflows_validate_graph_insert'",
).get() as { sql: string };
db.exec("DROP TRIGGER workflows_validate_graph_insert");
try {
  insertLegacyWorkflow.run(
    liveWorkflowId,
    userId,
    workflowOwnerSessionId,
    workflowDeleteIds.rootId,
    now(),
    now(),
  );
} finally {
  db.exec(workflowInsertTrigger.sql);
}
const liveWorkflowTaskId = "task_workflow_delete_live_probe";
const liveWorkflowTaskAt = now();
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, NULL, ?, 'workflow_node',
     'Running shell deletion probe', '{}', 2, 'queued', 'background', 'detached',
     0, NULL, NULL, 0, 1, ?, ?, NULL, NULL)`,
).run(
  liveWorkflowTaskId,
  userId,
  workflowDeleteIds.sessionId,
  workflowDeleteIds.sessionId,
  workflowDeleteAgent.id,
  liveWorkflowId,
  liveWorkflowTaskAt,
  liveWorkflowTaskAt,
);
const liveWorkflowTask = runtimeTaskDao.byId(userId, liveWorkflowTaskId)!;
const sandboxRoot = path.join(tmp, "workflow-delete-live-sandbox");
fs.mkdirSync(sandboxRoot, { recursive: true });
const { LocalSandbox } = await import("../server/src/runtime/sandbox.ts");
const liveSandbox = new LocalSandbox(sandboxRoot, "workspace-write");
const delayedSideEffect = path.join(sandboxRoot, "post-delete-side-effect.txt");
let liveShellStarted = false;
let liveShellFinished = false;
const workflowDeleteSupervisor = new AgentSupervisor({
  userId,
  sessionId: workflowDeleteIds.sessionId,
  rootAgentId: workflowDeleteIds.rootId,
  workerFactory: () => ({
    run: async ({ signal }) => {
      const execution = liveSandbox.exec(
        "sleep 1.2; printf 'POST_DELETE_SIDE_EFFECT\\n' > post-delete-side-effect.txt",
        { signal, timeoutMs: 5_000 },
      );
      liveShellStarted = true;
      const result = await execution;
      liveShellFinished = true;
      if (signal.aborted) throw signal.reason ?? new Error("workflow Task aborted");
      return { summary: `shell exited ${result.exitCode}`, body: {}, artifacts: [] };
    },
  }),
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  interruptGraceMs: 20,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
});
await until(
  () => liveShellStarted && runtimeTaskDao.byId(userId, liveWorkflowTask.id)?.status === "running",
  "cross-Session Workflow shell starts",
);
const { runtimeClient } = await import("../server/src/runtime/manager.ts");
type DeletionRuntimeProbe = {
  userId: string;
  interruptDeletedOrchestrationTask(rootAgentId: string, taskId: string): boolean;
};
const liveRuntimeMap = (runtimeClient as unknown as {
  runtimes: Map<string, DeletionRuntimeProbe>;
}).runtimes;
assert.ok(liveRuntimeMap instanceof Map);
const deleteInterrupts: Array<{ rootAgentId: string; taskId: string }> = [];
liveRuntimeMap.set(workflowDeleteIds.sessionId, {
  userId,
  interruptDeletedOrchestrationTask: (affectedRootAgentId, taskId) => {
    deleteInterrupts.push({ rootAgentId: affectedRootAgentId, taskId });
    const interrupted = workflowDeleteSupervisor.interruptExternallySettledTask(taskId);
    workflowDeleteSupervisor.poke();
    return interrupted;
  },
});
assert.equal(runtimeClient.deleteSession(userId, workflowOwnerSessionId), true);
await until(() => liveShellFinished, "owner deletion aborts the live Sandbox process");
const deletedWorkflowTask = runtimeTaskDao.byId(userId, liveWorkflowTask.id)!;
assert.equal(deletedWorkflowTask.status, "interrupted");
assert.equal(deletedWorkflowTask.workflowId, undefined);
assert.deepEqual(deleteInterrupts, [{
  rootAgentId: workflowDeleteIds.rootId,
  taskId: liveWorkflowTask.id,
}]);
await new Promise((resolve) => setTimeout(resolve, 1_350));
assert.equal(fs.existsSync(delayedSideEffect), false, "the deleted Workflow cannot write a late side effect");
assert.equal(taskResultDao.byTask(userId, liveWorkflowTask.id), undefined, "a late worker cannot create a Result");
liveRuntimeMap.delete(workflowDeleteIds.sessionId);
await workflowDeleteSupervisor.close();
console.log("  ✓ legacy owner deletion aborts a real cross-Session process with no late Result or write");

const retryIds = createIsolatedRoot("schedule_retry");
const retryWorkers = new WorkerHarness();
const originalListSchedulingAgentWorkerByRoot = runtimeTaskDao.listSchedulingAgentWorkerByRoot.bind(runtimeTaskDao);
const retryFaults: string[] = [];
const retrying = new AgentSupervisor({
  userId,
  sessionId: retryIds.sessionId,
  rootAgentId: retryIds.rootId,
  workerFactory: retryWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  onError: (_error, context) => retryFaults.push(context.phase),
});
const retryHandle = retrying.spawn({ initialMessages: [], taskName: "retry", message: "Start after one transient read failure" });
let injectedOpenReadFailures = 1;
(runtimeTaskDao as unknown as {
  listSchedulingAgentWorkerByRoot: typeof runtimeTaskDao.listSchedulingAgentWorkerByRoot;
}).listSchedulingAgentWorkerByRoot = ((
  ...args: Parameters<typeof runtimeTaskDao.listSchedulingAgentWorkerByRoot>
) => {
  if (args[1] === retryIds.rootId && injectedOpenReadFailures-- > 0) throw new Error("transient open Task read");
  return originalListSchedulingAgentWorkerByRoot(...args);
}) as typeof runtimeTaskDao.listSchedulingAgentWorkerByRoot;
await until(() => retryWorkers.pending.has(retryHandle.taskId), "scheduler retries the transient read", 2_000);
(runtimeTaskDao as unknown as {
  listSchedulingAgentWorkerByRoot: typeof runtimeTaskDao.listSchedulingAgentWorkerByRoot;
}).listSchedulingAgentWorkerByRoot = originalListSchedulingAgentWorkerByRoot;
assert.deepEqual(retryFaults, ["schedule"]);
retryWorkers.complete(retryHandle.taskId);
await until(() => runtimeTaskDao.byId(userId, retryHandle.taskId)?.status === "succeeded", "retried Task settles");
await retrying.close();
console.log("  ✓ transient scheduler faults use bounded backoff and do not strand queued Tasks");

const cancelRaceIds = createIsolatedRoot("cancel_result_race");
const cancelRaceWorkers = new WorkerHarness();
let cancelRacePermitReleases = 0;
const cancelRace = new AgentSupervisor({
  userId,
  sessionId: cancelRaceIds.sessionId,
  rootAgentId: cancelRaceIds.rootId,
  workerFactory: cancelRaceWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  acquireBackgroundPermit: () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      cancelRacePermitReleases += 1;
    };
  },
});
const cancelRaceHandle = cancelRace.spawn({
  initialMessages: [],
  taskName: "cancel_result_race",
  message: "Cancel at the result commit edge",
});
await until(() => cancelRaceWorkers.pending.has(cancelRaceHandle.taskId), "cancel-race worker starts");
const originalSettleTaskResult = taskResultDao.settle.bind(taskResultDao);
let cancelRaceSettleCalls = 0;
(taskResultDao as unknown as { settle: typeof taskResultDao.settle }).settle = ((
  input: Parameters<typeof taskResultDao.settle>[0],
) => {
  if (input.taskId !== cancelRaceHandle.taskId) return originalSettleTaskResult(input);
  cancelRaceSettleCalls += 1;
  if (cancelRaceSettleCalls === 1) {
    const current = runtimeTaskDao.byId(userId, cancelRaceHandle.taskId)!;
    const requested = runtimeTaskDao.transition({
      id: current.id,
      userId: current.userId,
      expectedVersion: current.version,
      expectedLeaseGeneration: current.leaseGeneration,
      nextStatus: "cancel_requested",
      at: now(),
      eventType: "cancel:test_race",
      eventPayload: {},
    });
    assert.ok(requested, "cancel request wins the injected result CAS race");
    return undefined;
  }
  return originalSettleTaskResult(input);
}) as typeof taskResultDao.settle;
cancelRaceWorkers.complete(cancelRaceHandle.taskId);
await until(
  () => runtimeTaskDao.byId(userId, cancelRaceHandle.taskId)?.status === "cancelled",
  "cancel-race Task acknowledges cancellation",
);
(taskResultDao as unknown as { settle: typeof taskResultDao.settle }).settle = originalSettleTaskResult;
assert.ok(cancelRaceSettleCalls <= 2, "result settlement does not livelock");
assert.equal(taskResultDao.byTask(userId, cancelRaceHandle.taskId), undefined);
assert.equal(cancelRace.stats().activeTasks, 0);
assert.equal(cancelRace.stats().openTasks, 0);
assert.equal(cancelRacePermitReleases, 1);
await cancelRace.close();
console.log("  ✓ cancel-vs-result CAS race settles cancelled and releases its permit once");

const reclamationIds = createIsolatedRoot("workflow_executor_reclamation");
const reclamationWorkers = new WorkerHarness();
const reclamationLaunch = new WorkflowLaunchService({
  userId,
  sessionId: reclamationIds.sessionId,
  rootAgentId: reclamationIds.rootId,
  maxTreeAgents: 2,
  now,
  id: (kind) => kind === "workflow" ? "workflow_executor_reclamation" : "agent_executor_reclamation",
}).launch({
  name: "Reclaim cached executor",
  provider: "mock",
  model: "mock",
  nodes: [{ id: "work", name: "Work", message: "Return one bounded result." }],
});
const reclamationCoordinator = new WorkflowCoordinator({
  userId,
  now,
  id: (kind) => `${kind}_executor_reclamation`,
});
const reclamationDispatch = reclamationCoordinator.pump(
  reclamationLaunch.snapshot.workflow.id,
).dispatches[0]!;
const reclamationSupervisor = new AgentSupervisor({
  userId,
  sessionId: reclamationIds.sessionId,
  rootAgentId: reclamationIds.rootId,
  workerFactory: reclamationWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 100,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  limits: {
    maxActivePerParent: 1,
    maxActiveAgents: 1,
    maxTreeAgents: 2,
    maxDepth: 2,
    maxOpenTasks: 4,
    maxIdleWorkers: 8,
  },
});
await until(
  () => reclamationWorkers.pending.has(reclamationDispatch.task.id),
  "managed Workflow worker starts",
);
reclamationWorkers.complete(reclamationDispatch.task.id);
await until(
  () => workflowDao.snapshot(userId, reclamationLaunch.snapshot.workflow.id)?.workflow.status === "succeeded",
  "managed Workflow settles",
);
await until(
  () => reclamationWorkers.closedAgents.includes("agent_executor_reclamation"),
  "closed managed executor evicts its worker",
);
assert.equal(agentNodeDao.byId(userId, "agent_executor_reclamation")?.status, "closed");
assert.equal(
  agentNodeDao.countNonClosedByRoot(userId, reclamationIds.rootId),
  1,
  "only the Session root keeps live tree capacity",
);
await reclamationSupervisor.close();
console.log("  ✓ terminal Workflow retirement also closes the cached executor worker");

const deletedIds = createIsolatedRoot("deleted_before_schedule");
const deletedFaults: string[] = [];
const deleted = new AgentSupervisor({
  userId,
  sessionId: deletedIds.sessionId,
  rootAgentId: deletedIds.rootId,
  workerFactory: retryWorkers.factory,
  now,
  id,
  waitPollMs: 5,
  closeTimeoutMs: 20,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  onError: (_error, context) => deletedFaults.push(context.phase),
});
deleted.spawn({ initialMessages: [], taskName: "deleted", message: "The Session disappears before claim" });
sessionDao.delete(deletedIds.sessionId);
await until(() => deletedFaults.includes("schedule"), "deleted roster fault is observed");
await deleted.close();
console.log("  ✓ owner deletion at the scheduler boundary closes cleanly without an uncaught microtask");

assert.throws(
  () => new AgentSupervisor({
    userId,
    sessionId,
    rootAgentId: "missing",
    workerFactory: replacementWorkers.factory,
  }),
  /Session-backed root Agent/,
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("AgentSupervisor contract passed.");
