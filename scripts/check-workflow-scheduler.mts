import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-workflow-scheduler-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const {
  agentNodeDao,
  runtimeTaskDao,
  sessionDao,
  userDao,
  workflowDao,
} = await import("../server/src/persistence/index.ts");
const { AgentSupervisor } = await import("../server/src/orchestration/agent-supervisor.ts");
const { WorkflowCoordinator } = await import("../server/src/orchestration/workflow-engine.ts");
const { WorkflowScheduler, startWorkflowScheduler } = await import(
  "../server/src/orchestration/workflow-scheduler.ts"
);

type WorkflowCancellationTarget = import(
  "../server/src/persistence/workflow.ts"
).WorkflowCancellationTarget;
type WorkflowSchedulerControl = import(
  "../server/src/orchestration/workflow-scheduler.ts"
).WorkflowSchedulerControl;
type NodeSpec = import("../shared/src/orchestration.ts").WorkflowNodeDefinition;

let clock = 2_100_000_000_000;
const now = () => ++clock;
const userId = "user_workflow_scheduler";
const sessionId = "session_workflow_scheduler";
const rootId = "agent_workflow_scheduler_root";
const childId = "agent_workflow_scheduler_child";

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

userDao.create({
  id: userId,
  email: "workflow-scheduler@example.invalid",
  password_hash: "x",
  created_at: now(),
});
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "Workflow scheduler",
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
  updated_at: clock,
});
agentNodeDao.create({
  id: rootId,
  userId,
  sessionId,
  rootAgentId: rootId,
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now(),
});
agentNodeDao.create({
  id: childId,
  userId,
  sessionId,
  rootAgentId: rootId,
  parentAgentId: rootId,
  path: "/root/workflow",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});

const work = (id: string): NodeSpec => ({
  id,
  name: id,
  kind: "work",
  payload: { message: id },
  effect: "workspace_read",
  cachePolicy: "none",
  maxAttempts: 1,
  executorAgentId: childId,
});
const gate = (id: string): NodeSpec => ({
  id,
  name: id,
  kind: "gate",
  payload: {},
  effect: "pure_readonly",
  cachePolicy: "none",
  maxAttempts: 1,
  signal: `signal:${id}`,
});

let control: WorkflowSchedulerControl | undefined;
let supervisor: InstanceType<typeof AgentSupervisor> | undefined;
const runtimeHints: string[] = [];
const cancellationTargets: WorkflowCancellationTarget[] = [];
const workflowInvalidations: Array<{ id: string; version: number }> = [];
const host = {
  isDraining: () => false,
  attachWorkflowScheduler(value: WorkflowSchedulerControl) {
    control = value;
    return () => {
      if (control === value) control = undefined;
    };
  },
  hintRuntimeTasks(owner: string) {
    runtimeHints.push(owner);
  },
  notifyWorkflowChanged(workflow: { id: string; version: number }) {
    workflowInvalidations.push({ id: workflow.id, version: workflow.version });
  },
  interruptWorkflowTask(target: WorkflowCancellationTarget) {
    cancellationTargets.push(target);
    return supervisor?.interruptTask(target.taskId, target.expectedTaskLeaseGeneration) ?? false;
  },
};

const coordinator = new WorkflowCoordinator({ userId, now });
let chain = coordinator.create({
  id: "workflow_scheduler_chain",
  ownerSessionId: sessionId,
  rootAgentId: rootId,
  name: "Scheduler chain",
  nodes: [work("first"), work("second")],
  edges: [{ from: "first", to: "second", condition: "success" }],
});
chain = coordinator.start(chain.workflow.id, chain.workflow.version)!;

const scheduler = new WorkflowScheduler(host, {
  truthScanMs: 60_000,
  pageSize: 4,
  pagesPerPump: 1,
  dispatchPerWorkflow: 4,
}).start();
await until(
  () => workflowDao.snapshot(userId, chain.workflow.id)?.attempts.length === 1,
  "startup truth scan materializes first Task",
);
assert.deepEqual(runtimeHints, [userId]);
let chainSnapshot = workflowDao.snapshot(userId, chain.workflow.id)!;
assert.ok(workflowInvalidations.some((entry) =>
  entry.id === chain.workflow.id && entry.version === chainSnapshot.workflow.version
));
const firstTask = chainSnapshot.attempts[0]!;
let task = runtimeTaskDao.byId(userId, firstTask.taskId)!;
task = runtimeTaskDao.claim({ id: task.id, userId, expectedVersion: task.version, at: now() })!;
task = runtimeTaskDao.transition({
  id: task.id,
  userId,
  expectedVersion: task.version,
  expectedLeaseGeneration: task.leaseGeneration,
  nextStatus: "running",
  at: now(),
})!;
assert.ok(workflowDao.settleExecution({
  id: `result_${task.id}`,
  taskId: task.id,
  userId,
  summary: "first complete",
  body: {},
  artifacts: [],
  expectedTaskVersion: task.version,
  expectedLeaseGeneration: task.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now(),
}));
control!.hint(userId, chain.workflow.id);
await until(
  () => workflowDao.snapshot(userId, chain.workflow.id)?.attempts.length === 2,
  "settlement hint materializes downstream Task",
);
chainSnapshot = workflowDao.snapshot(userId, chain.workflow.id)!;
assert.equal(chainSnapshot.nodes.find((node) => node.id === "second")?.status, "queued");
const secondAttempt = chainSnapshot.attempts.find((attempt) => attempt.nodeId === "second")!;
task = runtimeTaskDao.byId(userId, secondAttempt.taskId)!;
task = runtimeTaskDao.claim({ id: task.id, userId, expectedVersion: task.version, at: now() })!;
task = runtimeTaskDao.transition({
  id: task.id,
  userId,
  expectedVersion: task.version,
  expectedLeaseGeneration: task.leaseGeneration,
  nextStatus: "running",
  at: now(),
})!;
assert.ok(workflowDao.settleExecution({
  id: `result_${task.id}`,
  taskId: task.id,
  userId,
  summary: "second complete",
  body: {},
  artifacts: [],
  expectedTaskVersion: task.version,
  expectedLeaseGeneration: task.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now(),
}));
console.log("  ✓ startup recovery scan and settlement hint materialize the durable DAG");

let workerStarted = false;
supervisor = new AgentSupervisor({
  userId,
  sessionId,
  rootAgentId: rootId,
  now,
  interruptGraceMs: 20,
  closeTimeoutMs: 40,
  defaultAgentConfig: { provider: "mock", model: "mock", thinkingLevel: "off" },
  workerFactory: () => ({
    run: () => {
      workerStarted = true;
      return new Promise(() => {});
    },
    close: () => {},
  }),
});
let cancelled = coordinator.create({
  id: "workflow_scheduler_force_cancel",
  ownerSessionId: sessionId,
  rootAgentId: rootId,
  name: "Force cancellation",
  nodes: [work("force_cancel")],
  edges: [],
});
cancelled = coordinator.start(cancelled.workflow.id, cancelled.workflow.version)!;
control!.hint(userId, cancelled.workflow.id);
await until(
  () => workflowDao.snapshot(userId, cancelled.workflow.id)?.attempts.length === 1,
  "cancellation fixture Task materializes",
);
supervisor.poke();
await until(() => workerStarted, "provider attempt starts");
await until(
  () => workflowDao.snapshot(userId, cancelled.workflow.id)?.attempts[0]?.status === "running",
  "Workflow attempt mirrors running Task",
);
cancelled = workflowDao.snapshot(userId, cancelled.workflow.id)!;
cancelled = workflowDao.cancel(userId, cancelled.workflow.id, cancelled.workflow.version, now())!;
assert.equal(cancelled.workflow.status, "cancelling");
const durableCancel = workflowDao.listCancellationTargets(userId, cancelled.workflow.id);
assert.equal(durableCancel.length, 1);
const staleLease = durableCancel[0]!.expectedTaskLeaseGeneration - 1;
assert.equal(supervisor.interruptTask(durableCancel[0]!.taskId, staleLease), false);
control!.hint(userId, cancelled.workflow.id);
await until(
  () => workflowDao.snapshot(userId, cancelled.workflow.id)?.workflow.status === "cancelled",
  "exact wake force-fences provider which ignores AbortSignal",
);
assert.ok(cancellationTargets.some((target) =>
  target.taskId === durableCancel[0]!.taskId
  && target.expectedTaskLeaseGeneration === durableCancel[0]!.expectedTaskLeaseGeneration));
assert.equal(runtimeTaskDao.byId(userId, durableCancel[0]!.taskId)?.status, "cancelled");
console.log("  ✓ cancel commit wakes the exact lease and force-fences an Abort-ignoring provider");

const largeWorkflowCount = 12;
for (let index = 0; index < largeWorkflowCount; index += 1) {
  const nodes = Array.from({ length: 64 }, (_, nodeIndex) => gate(`g_${index}_${nodeIndex}`));
  let value = coordinator.create({
    id: `workflow_scheduler_large_${String(index).padStart(2, "0")}`,
    ownerSessionId: sessionId,
    rootAgentId: rootId,
    name: `Large ${index}`,
    nodes,
    edges: [],
  });
  value = coordinator.start(value.workflow.id, value.workflow.version)!;
  assert.equal(value.workflow.status, "waiting");
}
let eventLoopTurns = 0;
const loopProbe = setInterval(() => { eventLoopTurns += 1; }, 0);
const scannedBefore = scheduler.stats().scanned;
control!.hint();
await until(
  () => scheduler.stats().scanned >= scannedBefore + largeWorkflowCount,
  "bounded scheduler traverses large graphs",
  5_000,
);
clearInterval(loopProbe);
assert.ok(eventLoopTurns >= 2, `scheduler must yield between graph pages; turns=${eventLoopTurns}`);
console.log(
  `  ✓ scheduler yields across ${largeWorkflowCount} maximum-size graphs (${eventLoopTurns} event-loop turns)`,
);

scheduler.stopClaiming();
assert.equal(control, undefined);
const singleton = startWorkflowScheduler(host);
singleton.stopClaiming();
const restarted = startWorkflowScheduler(host);
assert.notEqual(restarted, singleton);
assert.equal(restarted.stats().running, true);
restarted.stopClaiming();
await supervisor.close();
assert.deepEqual(workflowDao.listCancellationTargets(userId, cancelled.workflow.id), []);
console.log("  ✓ scheduler stop/start lifecycle detaches and restarts cleanly");

sessionDao.delete(sessionId);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("Workflow scheduler contract passed.");
