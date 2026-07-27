import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-workflow-engine-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
const legacy = new DatabaseSync(path.join(tmp, "agent-web.db"));
legacy.exec(`
  CREATE TABLE agent_nodes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    root_agent_id TEXT NOT NULL,
    parent_agent_id TEXT,
    path TEXT NOT NULL,
    label TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (root_agent_id, path)
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    owner_session_id TEXT NOT NULL,
    controller_agent_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflow_nodes (
    workflow_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    effect TEXT NOT NULL,
    cache_policy TEXT NOT NULL,
    status TEXT NOT NULL,
    signal_name TEXT,
    depth INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    expanded_by_node_id TEXT,
    output_digest TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER,
    PRIMARY KEY (workflow_id, id)
  );
  INSERT INTO agent_nodes
    (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
     kind, status, version, created_at, updated_at)
  VALUES
    ('legacy_placeholder_controller', 'legacy_placeholder_user',
     'legacy_placeholder_session', 'legacy_placeholder_missing_root', NULL,
     '/root/controller', 'Legacy placeholder controller', 'subagent', 'idle', 1, 1, 1);
  INSERT INTO workflows
    (id, user_id, owner_session_id, controller_agent_id, name, status,
     version, created_at, updated_at)
  VALUES
    ('legacy_rootless_placeholder', 'legacy_placeholder_user',
     'legacy_placeholder_owner', 'legacy_placeholder_controller',
     'Legacy rootless placeholder', 'running', 1, 1, 1);
`);
legacy.close();

const {
  agentNodeDao,
  db,
  runtimeTaskDao,
  sessionDao,
  taskEventDao,
  taskResultDao,
  userDao,
  workflowDao,
} = await import("../server/src/persistence/index.ts");
const { WorkflowCoordinator, WorkflowEngine } = await import("../server/src/orchestration/workflow-engine.ts");
const { AgentSupervisor } = await import("../server/src/orchestration/agent-supervisor.ts");

const legacyPlaceholder = db.prepare(
  "SELECT root_agent_id, controller_agent_id FROM workflows WHERE id = ?",
).get("legacy_rootless_placeholder") as {
  root_agent_id: string | null;
  controller_agent_id: string | null;
};
assert.equal(legacyPlaceholder.root_agent_id, null);
assert.equal(
  legacyPlaceholder.controller_agent_id,
  null,
  "upgrade detaches the controller from an inert pre-DAG Workflow placeholder",
);
assert.throws(
  () => db.prepare("UPDATE workflows SET status = 'queued' WHERE id = ?")
    .run("legacy_rootless_placeholder"),
  /invalid Workflow ownership or limits/,
  "an inert placeholder cannot bypass the current Workflow update contract",
);
userDao.create({
  id: "legacy_placeholder_user",
  email: "legacy-placeholder@example.invalid",
  password_hash: "x",
  created_at: 2,
});
sessionDao.create({
  id: "legacy_placeholder_session",
  user_id: "legacy_placeholder_user",
  title: "Legacy placeholder controller",
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
  created_at: 2,
  updated_at: 2,
});
assert.doesNotThrow(
  () => sessionDao.delete("legacy_placeholder_session"),
  "deleting the old controller Session must not roll back on an inert placeholder",
);
assert.equal(sessionDao.byId("legacy_placeholder_session"), undefined);
assert.equal(
  (db.prepare(
    "SELECT controller_agent_id FROM workflows WHERE id = ?",
  ).get("legacy_rootless_placeholder") as { controller_agent_id: string | null })
    .controller_agent_id,
  null,
);
db.prepare("DELETE FROM workflows WHERE id = ?").run("legacy_rootless_placeholder");
db.prepare("DELETE FROM users WHERE id = ?").run("legacy_placeholder_user");
console.log("  ✓ upgrade detaches inert pre-DAG controllers without weakening graph validation");

type NodeSpec = import("../shared/src/orchestration.ts").WorkflowNodeDefinition;
type Snapshot = import("../server/src/persistence/workflow.ts").WorkflowSnapshot;

let clock = 1_900_000_000_000;
const at = () => ++clock;
async function until(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const userId = "user_workflow";
const otherUserId = "user_workflow_other";
userDao.create({ id: userId, email: "workflow@example.invalid", password_hash: "x", created_at: at() });
userDao.create({ id: otherUserId, email: "workflow-other@example.invalid", password_hash: "x", created_at: at() });

function createSession(id: string, owner = userId): void {
  sessionDao.create({
    id,
    user_id: owner,
    title: id,
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
    created_at: at(),
    updated_at: clock,
  });
}
createSession("session_workflow");
createSession("session_other", otherUserId);
const root = agentNodeDao.create({
  id: "agent_workflow_root",
  userId,
  sessionId: "session_workflow",
  rootAgentId: "agent_workflow_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: at(),
});
const otherRoot = agentNodeDao.create({
  id: "agent_workflow_other",
  userId: otherUserId,
  sessionId: "session_other",
  rootAgentId: "agent_workflow_other",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: at(),
});
const child = agentNodeDao.create({
  id: "agent_workflow_child",
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/workflow",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});
const worker2 = agentNodeDao.create({
  id: "agent_workflow_worker_2",
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/workflow-2",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});

assert.throws(() => runtimeTaskDao.create({
  id: "forged_workflow_task",
  userId,
  sessionId: "session_workflow",
  ownerSessionId: "session_workflow",
  agentId: root.id,
  workflowId: "forged_workflow",
  kind: "workflow_node",
  title: "Forged Workflow node",
  payload: {},
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: true,
  createdAt: at(),
}), /trusted orchestration creator/);

const work = (
  id: string,
  options: Partial<Omit<NodeSpec, "id" | "name" | "kind" | "payload" | "effect" | "cachePolicy" | "maxAttempts">> & {
    effect?: NodeSpec["effect"];
    cachePolicy?: NodeSpec["cachePolicy"];
    maxAttempts?: number;
    executorAgentId?: string;
  } = {},
): NodeSpec => ({
  id,
  name: id,
  kind: "work",
  payload: { message: id },
  effect: options.effect ?? "workspace_read",
  cachePolicy: options.cachePolicy ?? "none",
  maxAttempts: options.maxAttempts ?? 1,
  executorAgentId: options.executorAgentId ?? child.id,
});
const join = (id: string): NodeSpec => ({
  id, name: id, kind: "join", payload: {}, effect: "pure_readonly", cachePolicy: "none", maxAttempts: 1,
});
const gate = (id: string, signal: string): NodeSpec => ({
  id, name: id, kind: "gate", payload: {}, effect: "pure_readonly", cachePolicy: "none", maxAttempts: 1, signal,
});
const controller = (id: string, executorAgentId = child.id): NodeSpec => ({
  id, name: id, kind: "controller", payload: { message: id }, effect: "pure_readonly", cachePolicy: "none", maxAttempts: 1, executorAgentId,
});

assert.throws(() => workflowDao.create({
  id: "workflow_root_executor_forbidden",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Invalid root executor",
  nodes: [work("invalid_root_executor", { executorAgentId: root.id })],
  edges: [],
  createdAt: at(),
}), /Child Agent with pinned model provenance/);

function node(snapshot: Snapshot, id: string) {
  const value = snapshot.nodes.find((candidate) => candidate.id === id);
  assert.ok(value, `node ${id} exists`);
  return value;
}

function dispatch(snapshot: Snapshot, nodeId: string, taskId: string, cache?: {
  evidence?: import("../server/src/persistence/workflow.ts").WorkflowCacheEvidence;
  hit?: { key: string; evidence: import("../server/src/persistence/workflow.ts").WorkflowCacheEvidence };
  resultId?: string;
}) {
  const value = workflowDao.claim({
    workflowId: snapshot.workflow.id,
    userId,
    nodeId,
    taskId,
    expectedVersion: snapshot.workflow.version,
    ...(cache?.evidence === undefined ? {} : { cacheEvidence: cache.evidence }),
    ...(cache?.hit === undefined ? {} : { cacheHit: cache.hit }),
    ...(cache?.resultId === undefined ? {} : { resultId: cache.resultId }),
    at: at(),
  });
  assert.ok(value, `dispatch ${nodeId}`);
  return value;
}

function terminalTask(
  taskId: string,
  outcome: "succeeded" | "failed" | "interrupted",
  resultId?: string,
  options: Pick<import("../server/src/persistence/workflow.ts").SettleWorkflowExecutionInput,
    "tokensUsed" | "costUsedMicros" | "cacheAttestation"> = {},
) {
  let task = runtimeTaskDao.byId(userId, taskId)!;
  if (task.status === "queued") {
    const claimed = runtimeTaskDao.claim({ id: taskId, userId, expectedVersion: task.version, at: at() });
    assert.ok(claimed, `${taskId} claims from ${task.status} v${task.version}`);
    task = claimed;
  }
  if (task.status === "starting") {
    task = runtimeTaskDao.transition({
      id: taskId,
      userId,
      expectedVersion: task.version,
      expectedLeaseGeneration: task.leaseGeneration,
      nextStatus: "running",
      at: at(),
    })!;
  }
  assert.equal(task.status, "running", `${taskId} must be running before settlement`);
  if (task.kind === "workflow_node" && (resultId !== undefined || outcome === "failed")) {
    const settled = workflowDao.settleExecution({
      id: resultId ?? `result_auto_${taskId}`,
      taskId,
      userId,
      summary: `result:${taskId}`,
      body: { taskId },
      artifacts: [],
      expectedTaskVersion: task.version,
      expectedLeaseGeneration: task.leaseGeneration,
      nextStatus: outcome === "failed" ? "failed" : "succeeded",
      eventType: `worker:${outcome}`,
      eventPayload: {},
      createdAt: at(),
      ...options,
    });
    assert.ok(settled, `atomic Workflow settlement ${taskId}`);
    return settled.task;
  }
  task = runtimeTaskDao.transition({
    id: taskId,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: outcome,
    at: at(),
  })!;
  if (resultId !== undefined) {
    const result = taskResultDao.create({
      id: resultId,
      taskId,
      userId,
      summary: `result:${taskId}`,
      body: { taskId },
      artifacts: [],
      expectedTaskVersion: task.version,
      expectedLeaseGeneration: task.leaseGeneration,
      createdAt: at(),
    });
    assert.ok(result);
  }
  return runtimeTaskDao.byId(userId, taskId)!;
}

function startTask(taskId: string) {
  let task = runtimeTaskDao.byId(userId, taskId)!;
  task = runtimeTaskDao.claim({ id: taskId, userId, expectedVersion: task.version, at: at() })!;
  task = runtimeTaskDao.transition({
    id: taskId,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "running",
    at: at(),
  })!;
  return task;
}

function forceTerminalWithoutResult(taskId: string) {
  const task = runtimeTaskDao.byId(userId, taskId)!;
  assert.equal(task.status, "running");
  db.prepare(
    `UPDATE runtime_tasks SET status = 'succeeded', settled_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND user_id = ? AND version = ?`,
  ).run(at(), at(), taskId, userId, task.version);
}

function forceSucceededWithResult(taskId: string, resultId: string, settledAt: number) {
  const task = runtimeTaskDao.byId(userId, taskId)!;
  assert.equal(task.status, "running");
  db.prepare(
    `UPDATE runtime_tasks SET status = 'succeeded', settled_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND user_id = ? AND version = ?`,
  ).run(settledAt, settledAt, taskId, userId, task.version);
  db.prepare(
    `INSERT INTO task_results
       (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
     VALUES (?, ?, ?, '{}', '[]', 1, ?, NULL)`,
  ).run(resultId, taskId, `result:${taskId}`, settledAt);
}

function settle(snapshot: Snapshot, nodeId: string, taskId: string, usage = {}) {
  const task = runtimeTaskDao.byId(userId, taskId)!;
  const value = workflowDao.settle({
    workflowId: snapshot.workflow.id,
    userId,
    nodeId,
    taskId,
    expectedTaskLeaseGeneration: task.leaseGeneration,
    expectedVersion: snapshot.workflow.version,
    ...usage,
    at: at(),
  });
  if (value) return value;
  const current = workflowDao.snapshot(userId, snapshot.workflow.id);
  const attempt = current?.attempts.find((candidate) => candidate.taskId === taskId);
  assert.ok(current && attempt && attempt.status !== "running" && attempt.status !== "cancel_requested", `settle ${nodeId}`);
  return current;
}

let topology = workflowDao.create({
  id: "workflow_topology",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Parallel topology",
  nodes: [work("a"), work("b", { executorAgentId: worker2.id }), join("join"), work("publish")],
  edges: [
    { from: "a", to: "join", condition: "success" },
    { from: "b", to: "join", condition: "success" },
    { from: "join", to: "publish", condition: "success" },
  ],
  createdAt: at(),
});
topology = workflowDao.start(userId, topology.workflow.id, topology.workflow.version, at())!;
assert.deepEqual(topology.nodes.filter((value) => value.status === "ready").map((value) => value.id), ["a", "b"]);
const aRun = dispatch(topology, "a", "task_topology_a");
topology = workflowDao.snapshot(userId, topology.workflow.id)!;
const bRun = dispatch(topology, "b", "task_topology_b");
assert.equal(aRun.task.workflowId, topology.workflow.id);
assert.equal(bRun.task.workflowId, topology.workflow.id);
assert.notEqual(aRun.task.agentId, bRun.task.agentId, "ready branches retain independent executor bindings");
terminalTask("task_topology_a", "succeeded", "result_topology_a");
topology = settle(workflowDao.snapshot(userId, topology.workflow.id)!, "a", "task_topology_a");
assert.equal(node(topology, "join").status, "blocked");
terminalTask("task_topology_b", "succeeded", "result_topology_b");
topology = settle(topology, "b", "task_topology_b");
assert.equal(node(topology, "join").status, "succeeded");
assert.equal(node(topology, "publish").status, "ready");
dispatch(topology, "publish", "task_topology_publish");
terminalTask("task_topology_publish", "succeeded", "result_topology_publish");
topology = settle(workflowDao.snapshot(userId, topology.workflow.id)!, "publish", "task_topology_publish");
assert.equal(topology.workflow.status, "succeeded");
assert.equal(topology.attempts.length, 3, "join nodes do not create Runtime Tasks");
console.log("  ✓ DAG topology derives parallel ready work and system-owned joins");

let phases = workflowDao.create({
  id: "workflow_execution_phases",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Execution phases",
  nodes: [work("phase")],
  edges: [],
  createdAt: at(),
});
phases = workflowDao.start(userId, phases.workflow.id, phases.workflow.version, at())!;
const phaseDispatch = dispatch(phases, "phase", "task_execution_phases");
assert.equal(phaseDispatch.task.status, "queued");
assert.equal(phaseDispatch.node.status, "queued");
assert.equal(phaseDispatch.attempt.status, "queued");
let phaseTask = runtimeTaskDao.claim({
  id: phaseDispatch.task.id,
  userId,
  expectedVersion: phaseDispatch.task.version,
  at: at(),
})!;
phases = workflowDao.snapshot(userId, phases.workflow.id)!;
assert.equal(node(phases, "phase").status, "starting");
assert.equal(phases.attempts[0]?.status, "starting");
phaseTask = runtimeTaskDao.transition({
  id: phaseTask.id,
  userId,
  expectedVersion: phaseTask.version,
  expectedLeaseGeneration: phaseTask.leaseGeneration,
  nextStatus: "running",
  at: at(),
})!;
phases = workflowDao.snapshot(userId, phases.workflow.id)!;
assert.equal(node(phases, "phase").status, "running");
assert.equal(phases.attempts[0]?.status, "running");
phaseTask = runtimeTaskDao.transition({
  id: phaseTask.id,
  userId,
  expectedVersion: phaseTask.version,
  expectedLeaseGeneration: phaseTask.leaseGeneration,
  nextStatus: "waiting",
  waitReason: "resource",
  at: at(),
})!;
phases = workflowDao.snapshot(userId, phases.workflow.id)!;
assert.equal(node(phases, "phase").status, "waiting");
assert.equal(phases.attempts[0]?.status, "waiting");
phaseTask = runtimeTaskDao.transition({
  id: phaseTask.id,
  userId,
  expectedVersion: phaseTask.version,
  expectedLeaseGeneration: phaseTask.leaseGeneration,
  nextStatus: "queued",
  at: at(),
})!;
phases = workflowDao.snapshot(userId, phases.workflow.id)!;
assert.equal(node(phases, "phase").status, "queued");
assert.equal(phases.attempts[0]?.status, "queued");
terminalTask(phaseTask.id, "succeeded", "result_execution_phases");
phases = workflowDao.snapshot(userId, phases.workflow.id)!;
assert.equal(phases.workflow.status, "succeeded");
console.log("  ✓ Workflow execution phases mirror the durable Task lifecycle");

let dataFlow = workflowDao.create({
  id: "workflow_dependency_handles",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Dependency handles",
  nodes: [work("source"), work("consumer")],
  edges: [{ from: "source", to: "consumer", condition: "success" }],
  createdAt: at(),
});
dataFlow = workflowDao.start(userId, dataFlow.workflow.id, dataFlow.workflow.version, at())!;
dispatch(dataFlow, "source", "task_dependency_source");
terminalTask("task_dependency_source", "succeeded", "result_dependency_source");
dataFlow = workflowDao.snapshot(userId, dataFlow.workflow.id)!;
const consumerDispatch = dispatch(dataFlow, "consumer", "task_dependency_consumer");
const consumerPayload = consumerDispatch.task.payload as {
  message: string;
  workflow: { dependencies: Array<Record<string, unknown>> };
};
assert.match(consumerPayload.message, /Upstream Workflow results/);
assert.deepEqual(consumerPayload.workflow.dependencies.map((value) => ({
  nodeId: value.nodeId,
  taskId: value.taskId,
  resultId: value.resultId,
})), [{
  nodeId: "source",
  taskId: "task_dependency_source",
  resultId: "result_dependency_source",
}]);
const dependencyConsumerTask = startTask("task_dependency_consumer");
const fullDependency = workflowDao.readDependencyResult({
  workflowId: dataFlow.workflow.id,
  userId,
  actorTaskId: dependencyConsumerTask.id,
  actorLeaseGeneration: dependencyConsumerTask.leaseGeneration,
  resultId: "result_dependency_source",
});
assert.deepEqual(fullDependency?.body, { taskId: "task_dependency_source" });
assert.equal(workflowDao.readDependencyResult({
  workflowId: dataFlow.workflow.id,
  userId,
  actorTaskId: dependencyConsumerTask.id,
  actorLeaseGeneration: dependencyConsumerTask.leaseGeneration,
  resultId: "result_topology_a",
}), undefined);
terminalTask("task_dependency_consumer", "succeeded", "result_dependency_consumer");
assert.equal(workflowDao.snapshot(userId, dataFlow.workflow.id)?.workflow.status, "succeeded");
const excessiveSources = Array.from({ length: 17 }, (_, index) => work(`fanin_${index.toString().padStart(2, "0")}`));
assert.throws(() => workflowDao.create({
  id: "workflow_dependency_fanin_limit",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Dependency fan-in limit",
  nodes: [...excessiveSources, work("fanin_consumer")],
  edges: excessiveSources.map((source) => ({
    from: source.id,
    to: "fanin_consumer",
    condition: "success" as const,
  })),
  createdAt: at(),
}), /dependency handle limit/);
console.log("  ✓ downstream assignments carry bounded durable dependency handles");

let dynamic = workflowDao.create({
  id: "workflow_dynamic",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Dynamic graph",
  nodes: [controller("control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
dynamic = workflowDao.start(userId, dynamic.workflow.id, dynamic.workflow.version, at())!;
db.prepare("UPDATE workflow_nodes SET payload_json = ? WHERE workflow_id = ? AND id = ?")
  .run(JSON.stringify({ assignment: "LEGACY CONTROLLER" }), dynamic.workflow.id, "control");
const legacyControllerDispatch = dispatch(
  workflowDao.snapshot(userId, dynamic.workflow.id)!,
  "control",
  "task_dynamic_control",
);
assert.equal((legacyControllerDispatch.task.payload as { message: string }).message, "LEGACY CONTROLLER");
const dynamicControllerTask = startTask("task_dynamic_control");
dynamic = workflowDao.snapshot(userId, dynamic.workflow.id)!;
const staleGraph = dynamic.workflow.graphRevision;
const beforeRunVersion = dynamic.workflow.version;
dynamic = workflowDao.signal(
  userId,
  dynamic.workflow.id,
  "controller_wakeup",
  dynamic.workflow.version,
  at(),
)!.snapshot;
assert.ok(dynamic.workflow.version > beforeRunVersion);
assert.equal(dynamic.workflow.graphRevision, staleGraph, "run progress does not invalidate graph CAS");
assert.throws(() => workflowDao.expand({
  workflowId: dynamic.workflow.id,
  userId,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration - 1,
  expectedGraphRevision: staleGraph,
  nodes: [work("stale_lease_child")],
  edges: [],
  at: at(),
}), /current controller Task lease/);
dynamic = workflowDao.expand({
  workflowId: dynamic.workflow.id,
  userId,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: staleGraph,
  nodes: [work("dynamic_child")],
  edges: [{ from: "control", to: "dynamic_child", condition: "success" }],
  at: at(),
})!;
assert.equal(dynamic.workflow.graphRevision, staleGraph + 1);
assert.equal(workflowDao.expand({
  workflowId: dynamic.workflow.id,
  userId,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: staleGraph,
  nodes: [work("stale_child")],
  edges: [],
  at: at(),
}), null, "stale graph CAS loses without partial rows");
assert.equal(workflowDao.snapshot(userId, dynamic.workflow.id)!.nodes.some((value) => value.id === "stale_child"), false);
const replay = workflowDao.expand({
  workflowId: dynamic.workflow.id,
  userId,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: staleGraph,
  nodes: [work("dynamic_child")],
  edges: [{ from: "control", to: "dynamic_child", condition: "success" }],
  at: at(),
});
assert.equal(replay?.nodes.filter((value) => value.id === "dynamic_child").length, 1, "mutation replay is idempotent");
const beforeCycle = workflowDao.snapshot(userId, dynamic.workflow.id)!;
assert.throws(() => workflowDao.expand({
  workflowId: dynamic.workflow.id,
  userId,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: beforeCycle.workflow.graphRevision,
  nodes: [work("cycle_a"), work("cycle_b")],
  edges: [
    { from: "cycle_a", to: "cycle_b", condition: "success" },
    { from: "cycle_b", to: "cycle_a", condition: "success" },
  ],
  at: at(),
}), /acyclic/);
assert.equal(workflowDao.snapshot(userId, dynamic.workflow.id)!.workflow.graphRevision, beforeCycle.workflow.graphRevision);
dynamic = workflowDao.sealGraph({
  userId,
  workflowId: dynamic.workflow.id,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: dynamic.workflow.graphRevision,
  at: at(),
})!;
const sealedReplay = workflowDao.sealGraph({
  userId,
  workflowId: dynamic.workflow.id,
  controllerNodeId: "control",
  actorTaskId: dynamicControllerTask.id,
  actorLeaseGeneration: dynamicControllerTask.leaseGeneration,
  expectedGraphRevision: dynamic.workflow.graphRevision - 1,
  at: at(),
});
assert.equal(sealedReplay?.workflow.graphRevision, dynamic.workflow.graphRevision,
  "derived seal mutation survives a lost response");
terminalTask("task_dynamic_control", "succeeded", "result_dynamic_control");
dynamic = settle(dynamic, "control", "task_dynamic_control");
assert.equal(node(dynamic, "dynamic_child").status, "ready");
dispatch(dynamic, "dynamic_child", "task_dynamic_child");
terminalTask("task_dynamic_child", "succeeded", "result_dynamic_child");
dynamic = settle(workflowDao.snapshot(userId, dynamic.workflow.id)!, "dynamic_child", "task_dynamic_child");
assert.equal(dynamic.workflow.status, "succeeded");
let openGraph = workflowDao.create({
  id: "workflow_open_graph",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Open graph",
  nodes: [controller("open_control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
openGraph = workflowDao.start(userId, openGraph.workflow.id, openGraph.workflow.version, at())!;
dispatch(openGraph, "open_control", "task_open_control");
const openControllerTask = startTask("task_open_control");
terminalTask("task_open_control", "succeeded", "result_open_control");
openGraph = settle(workflowDao.snapshot(userId, openGraph.workflow.id)!, "open_control", "task_open_control");
assert.equal(openGraph.workflow.status, "waiting", "an open graph cannot complete from its current nodes");
openGraph = workflowDao.sealGraph({
  userId,
  workflowId: openGraph.workflow.id,
  controllerNodeId: "open_control",
  actorTaskId: openControllerTask.id,
  actorLeaseGeneration: openControllerTask.leaseGeneration,
  expectedGraphRevision: openGraph.workflow.graphRevision,
  at: at(),
  mutationId: "mutation_seal_open",
})!;
assert.equal(openGraph.workflow.status, "succeeded");
let failedController = workflowDao.create({
  id: "workflow_failed_controller",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Failed controller",
  nodes: [controller("failed_control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
failedController = workflowDao.start(userId, failedController.workflow.id, failedController.workflow.version, at())!;
dispatch(failedController, "failed_control", "task_failed_control");
terminalTask("task_failed_control", "failed");
failedController = settle(
  workflowDao.snapshot(userId, failedController.workflow.id)!,
  "failed_control",
  "task_failed_control",
);
assert.equal(failedController.workflow.status, "failed", "a failed final controller cannot leave an open graph waiting");
let controllerIdentity = workflowDao.create({
  id: "workflow_controller_identity",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Controller identity",
  nodes: [controller("identity_control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
controllerIdentity = workflowDao.start(
  userId,
  controllerIdentity.workflow.id,
  controllerIdentity.workflow.version,
  at(),
)!;
const boundController = dispatch(controllerIdentity, "identity_control", "task_bound_controller");
assert.equal(boundController.task.agentId, child.id, "claim derives the immutable executor binding");
terminalTask("task_bound_controller", "succeeded", "result_bound_controller");
controllerIdentity = settle(
  workflowDao.snapshot(userId, controllerIdentity.workflow.id)!,
  "identity_control",
  "task_bound_controller",
);
const closedAgent = agentNodeDao.create({
  id: "agent_workflow_closed",
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  parentAgentId: root.id,
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  path: "/root/closed",
  kind: "subagent",
  status: "closed",
  createdAt: at(),
});
assert.throws(() => workflowDao.create({
  id: "workflow_closed_agent",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Closed Agent",
  nodes: [work("closed_target", { executorAgentId: closedAgent.id })],
  edges: [],
  createdAt: at(),
}), /Closed Agent/);
const guardedController = agentNodeDao.create({
  id: "agent_workflow_guarded_controller",
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  parentAgentId: root.id,
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  path: "/root/guarded-controller",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});
workflowDao.create({
  id: "workflow_guarded_controller",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: guardedController.id,
  name: "Guarded controller",
  nodes: [controller("guarded_control", guardedController.id)],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
assert.throws(
  () => db.prepare("DELETE FROM agent_nodes WHERE id = ?").run(guardedController.id),
  /constraint|referenced/i,
);
assert.throws(
  () => db.prepare("UPDATE agent_nodes SET status = 'closed' WHERE id = ?").run(guardedController.id),
  /Active Workflow|constraint/i,
);
assert.throws(
  () => db.prepare("UPDATE workflows SET controller_agent_id = NULL WHERE id = ?")
    .run("workflow_guarded_controller"),
  /ownership|limits|constraint/i,
);
console.log("  ✓ controller expansion uses graph CAS, cycle rollback, idempotency, and explicit sealing");

let gated = workflowDao.create({
  id: "workflow_gate",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Gate",
  nodes: [gate("approval", "release"), work("after_gate")],
  edges: [{ from: "approval", to: "after_gate", condition: "success" }],
  createdAt: at(),
});
gated = workflowDao.start(userId, gated.workflow.id, gated.workflow.version, at())!;
assert.equal(node(gated, "approval").status, "waiting");
const signal = workflowDao.signal(userId, gated.workflow.id, "release", gated.workflow.version, at())!;
assert.equal(signal.accepted, true);
gated = signal.snapshot;
assert.equal(node(gated, "approval").status, "succeeded");
assert.equal(node(gated, "after_gate").status, "ready");
const signalEvents = workflowDao.listEvents(userId, gated.workflow.id).length;
const duplicateSignal = workflowDao.signal(userId, gated.workflow.id, "release", 1, at())!;
assert.equal(duplicateSignal.accepted, false);
assert.equal(workflowDao.listEvents(userId, gated.workflow.id).length, signalEvents);
dispatch(gated, "after_gate", "task_after_gate");
terminalTask("task_after_gate", "succeeded", "result_after_gate");
gated = settle(workflowDao.snapshot(userId, gated.workflow.id)!, "after_gate", "task_after_gate");
assert.equal(gated.workflow.status, "succeeded");

let revisedGate = workflowDao.create({
  id: "workflow_revised_gate",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Revised gate",
  nodes: [gate("old_gate", "release_v2")],
  edges: [],
  createdAt: at(),
});
revisedGate = workflowDao.signal(
  userId,
  revisedGate.workflow.id,
  "release_v2",
  revisedGate.workflow.version,
  at(),
)!.snapshot;
revisedGate = workflowDao.reviseDefinition({
  workflowId: revisedGate.workflow.id,
  userId,
  expectedVersion: revisedGate.workflow.version,
  expectedDefinitionVersion: revisedGate.workflow.definitionVersion,
  nodes: [gate("new_gate", "release_v2")],
  edges: [],
  at: at(),
})!;
revisedGate = workflowDao.start(userId, revisedGate.workflow.id, revisedGate.workflow.version, at())!;
assert.equal(node(revisedGate, "new_gate").status, "waiting", "a signal from an old definition cannot release a new gate");

let settledJoin = workflowDao.create({
  id: "workflow_settled_join",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Settled join",
  nodes: [work("may_fail"), work("may_pass"), join("settled"), work("cleanup")],
  edges: [
    { from: "may_fail", to: "settled", condition: "settled" },
    { from: "may_pass", to: "settled", condition: "settled" },
    { from: "settled", to: "cleanup", condition: "success" },
  ],
  createdAt: at(),
});
settledJoin = workflowDao.start(userId, settledJoin.workflow.id, settledJoin.workflow.version, at())!;
dispatch(settledJoin, "may_fail", "task_may_fail");
settledJoin = workflowDao.snapshot(userId, settledJoin.workflow.id)!;
dispatch(settledJoin, "may_pass", "task_may_pass");
terminalTask("task_may_fail", "failed");
settledJoin = settle(workflowDao.snapshot(userId, settledJoin.workflow.id)!, "may_fail", "task_may_fail");
assert.equal(node(settledJoin, "settled").status, "blocked");
terminalTask("task_may_pass", "succeeded", "result_may_pass");
settledJoin = settle(settledJoin, "may_pass", "task_may_pass");
assert.equal(node(settledJoin, "settled").status, "succeeded");
assert.equal(node(settledJoin, "cleanup").status, "ready");
dispatch(settledJoin, "cleanup", "task_cleanup");
terminalTask("task_cleanup", "succeeded", "result_cleanup");
settledJoin = settle(workflowDao.snapshot(userId, settledJoin.workflow.id)!, "cleanup", "task_cleanup");
assert.equal(settledJoin.workflow.status, "failed", "all-settled work can finish before final failed status");
console.log("  ✓ durable signals release gates and settled joins wait for every upstream");

let retry = workflowDao.create({
  id: "workflow_retry",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Retry",
  nodes: [work("flaky", { maxAttempts: 2 }), work("downstream")],
  edges: [{ from: "flaky", to: "downstream", condition: "success" }],
  createdAt: at(),
});
retry = workflowDao.start(userId, retry.workflow.id, retry.workflow.version, at())!;
dispatch(retry, "flaky", "task_flaky_1");
terminalTask("task_flaky_1", "failed");
retry = settle(workflowDao.snapshot(userId, retry.workflow.id)!, "flaky", "task_flaky_1");
assert.equal(node(retry, "flaky").status, "ready");
dispatch(retry, "flaky", "task_flaky_2");
terminalTask("task_flaky_2", "failed");
retry = settle(workflowDao.snapshot(userId, retry.workflow.id)!, "flaky", "task_flaky_2");
assert.equal(node(retry, "flaky").status, "failed");
assert.equal(node(retry, "downstream").status, "cancelled");
assert.equal(retry.workflow.status, "failed");
assert.deepEqual(retry.attempts.map((value) => value.taskId), ["task_flaky_1", "task_flaky_2"]);
console.log("  ✓ retries allocate immutable Task attempts and exhausted failure propagates");

assert.throws(() => workflowDao.create({
  id: "workflow_cache_disabled",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Disabled cache",
  nodes: [work("cache_disabled", { effect: "pure_readonly", cachePolicy: "evidence" })],
  edges: [],
  createdAt: at(),
}), /isolated trusted executor/);
assert.equal(
  Number((db.prepare("SELECT COUNT(*) AS count FROM workflow_cache_entries").get() as { count: number }).count),
  0,
);
console.log("  ✓ execution cache fails closed without isolated executor provenance");

let restart = workflowDao.create({
  id: "workflow_restart",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Restart",
  nodes: [
    work("safe", { effect: "pure_readonly", maxAttempts: 2 }),
    work("unsafe", { effect: "workspace_write", maxAttempts: 2, executorAgentId: worker2.id }),
  ],
  edges: [],
  createdAt: at(),
});
restart = workflowDao.start(userId, restart.workflow.id, restart.workflow.version, at())!;
dispatch(restart, "safe", "task_restart_safe");
restart = workflowDao.snapshot(userId, restart.workflow.id)!;
dispatch(restart, "unsafe", "task_restart_unsafe");
const safeContractTask = runtimeTaskDao.byId(userId, "task_restart_safe")!;
const unsafeContractTask = runtimeTaskDao.byId(userId, "task_restart_unsafe")!;
assert.equal(safeContractTask.checkpointSafe, true);
assert.equal(unsafeContractTask.checkpointSafe, false);
assert.deepEqual(
  (safeContractTask.payload as { workflow: { allowedTools: string[] } }).workflow.allowedTools,
  ["workflow_read_dependency"],
);
const restartLeases = new Map<string, number>();
for (const taskId of ["task_restart_safe", "task_restart_unsafe"]) {
  let task = runtimeTaskDao.byId(userId, taskId)!;
  const claimed = runtimeTaskDao.claim({ id: taskId, userId, expectedVersion: task.version, at: at() });
  assert.ok(claimed, `${taskId} claims from ${task.status} v${task.version}`);
  task = claimed;
  const running = runtimeTaskDao.transition({
    id: taskId,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "running",
    at: at(),
  })!;
  restartLeases.set(taskId, running.leaseGeneration);
}
const safeAttempt = node(workflowDao.snapshot(userId, restart.workflow.id)!, "safe").attemptCount;
runtimeTaskDao.recoverAfterRestart(at(), "workflow-restart-fence");
assert.equal(runtimeTaskDao.byId(userId, "task_restart_safe")?.status, "queued");
assert.equal(runtimeTaskDao.byId(userId, "task_restart_unsafe")?.status, "interrupted");
const restartBeforeUsage = workflowDao.snapshot(userId, restart.workflow.id)!;
assert.equal(workflowDao.recordUsage({
  workflowId: restart.workflow.id,
  userId,
  nodeId: "safe",
  taskId: "task_restart_safe",
  expectedTaskLeaseGeneration: restartLeases.get("task_restart_safe")!,
  expectedVersion: restartBeforeUsage.workflow.version,
  tokensUsed: 1,
  costUsedMicros: 0,
  at: at(),
}), null, "an old Task generation cannot report Workflow usage");
const safeAfterFence = startTask("task_restart_safe");
const restartAfterStart = workflowDao.snapshot(userId, restart.workflow.id)!;
restart = workflowDao.recordUsage({
  workflowId: restart.workflow.id,
  userId,
  nodeId: "safe",
  taskId: "task_restart_safe",
  expectedTaskLeaseGeneration: safeAfterFence.leaseGeneration,
  expectedVersion: restartAfterStart.workflow.version,
  tokensUsed: 1,
  costUsedMicros: 0,
  at: at(),
})!;
assert.equal(restart.attempts.find((attempt) => attempt.taskId === "task_restart_safe")?.tokensUsed, 1);
const recovery = workflowDao.recover(userId, restart.workflow.id, at())!;
restart = workflowDao.snapshot(userId, restart.workflow.id)!;
assert.equal(recovery.retried, 0);
assert.equal(recovery.failed, 1);
assert.equal(node(restart, "safe").status, "running");
assert.equal(node(restart, "safe").attemptCount, safeAttempt);
assert.equal(node(restart, "unsafe").status, "failed");
let missingResult = workflowDao.create({
  id: "workflow_missing_result",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Missing result recovery",
  nodes: [work("missing_result", { effect: "pure_readonly", maxAttempts: 2, executorAgentId: worker2.id })],
  edges: [],
  createdAt: at(),
});
missingResult = workflowDao.start(userId, missingResult.workflow.id, missingResult.workflow.version, at())!;
dispatch(missingResult, "missing_result", "task_missing_result");
startTask("task_missing_result");
assert.equal(runtimeTaskDao.byId(userId, "task_missing_result")?.checkpointSafe, true);
forceTerminalWithoutResult("task_missing_result");
assert.equal(workflowDao.settle({
  workflowId: missingResult.workflow.id,
  userId,
  nodeId: "missing_result",
  taskId: "task_missing_result",
  expectedTaskLeaseGeneration: runtimeTaskDao.byId(userId, "task_missing_result")!.leaseGeneration,
  expectedVersion: workflowDao.snapshot(userId, missingResult.workflow.id)!.workflow.version,
  at: at(),
}), null, "success cannot release a dependency before its result is durable");
const missingRecovery = workflowDao.recover(userId, missingResult.workflow.id, at())!;
missingResult = workflowDao.snapshot(userId, missingResult.workflow.id)!;
assert.equal(missingRecovery.retried, 1);
assert.equal(node(missingResult, "missing_result").status, "ready");
let unsafeMissing = workflowDao.create({
  id: "workflow_unsafe_missing_result",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Unsafe missing result",
  nodes: [work("unsafe_missing", { effect: "workspace_write", maxAttempts: 2, executorAgentId: worker2.id })],
  edges: [],
  createdAt: at(),
});
unsafeMissing = workflowDao.start(userId, unsafeMissing.workflow.id, unsafeMissing.workflow.version, at())!;
dispatch(unsafeMissing, "unsafe_missing", "task_unsafe_missing");
startTask("task_unsafe_missing");
forceTerminalWithoutResult("task_unsafe_missing");
const unsafeRecovery = workflowDao.recover(userId, unsafeMissing.workflow.id, at())!;
unsafeMissing = workflowDao.snapshot(userId, unsafeMissing.workflow.id)!;
assert.equal(unsafeRecovery.retried, 0);
assert.equal(node(unsafeMissing, "unsafe_missing").status, "failed");
assert.equal(unsafeMissing.workflow.status, "failed");
console.log("  ✓ restart fencing resumes safe attempts and fails unsafe interruptions closed");

restart = workflowDao.cancel(userId, restart.workflow.id, restart.workflow.version, at())!;
assert.equal(restart.workflow.status, "cancelling");
assert.equal(node(restart, "safe").status, "cancelling");
let cancelledSafe = runtimeTaskDao.byId(userId, "task_restart_safe")!;
assert.equal(cancelledSafe.status, "cancel_requested");
cancelledSafe = runtimeTaskDao.transition({
  id: cancelledSafe.id,
  userId,
  expectedVersion: cancelledSafe.version,
  expectedLeaseGeneration: cancelledSafe.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, restart.workflow.id, at());
assert.equal(cancelledSafe.status, "cancelled");
assert.equal(workflowDao.snapshot(userId, restart.workflow.id)?.workflow.status, "cancelled");
assert.equal(workflowDao.cancel(userId, restart.workflow.id, 1, at())?.workflow.status, "cancelled");
console.log("  ✓ cancellation fans out to Tasks and remains idempotently terminal");

const exactAssignment = "Preserve \\\\ paths, \"quotes\", and a literal {json: true}.";
let exactPayload = workflowDao.create({
  id: "workflow_exact_assignment",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Exact assignment",
  nodes: [{ ...work("exact"), payload: { message: exactAssignment } }],
  edges: [],
  createdAt: at(),
});
exactPayload = workflowDao.start(userId, exactPayload.workflow.id, exactPayload.workflow.version, at())!;
const exactDispatch = dispatch(exactPayload, "exact", "task_exact_assignment");
assert.equal((exactDispatch.task.payload as { message: string }).message, exactAssignment);
terminalTask("task_exact_assignment", "succeeded", "result_exact_assignment");
let legacyAssignment = workflowDao.create({
  id: "workflow_legacy_assignment",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Legacy assignment",
  nodes: [work("legacy_assignment")],
  edges: [],
  createdAt: at(),
});
legacyAssignment = workflowDao.start(userId, legacyAssignment.workflow.id, legacyAssignment.workflow.version, at())!;
db.prepare(
  "UPDATE workflow_nodes SET payload_json = ? WHERE workflow_id = ? AND id = ?",
).run(
  JSON.stringify({ assignment: "DO NOT LOSE THIS" }),
  legacyAssignment.workflow.id,
  "legacy_assignment",
);
const legacyAssignmentDispatch = dispatch(
  workflowDao.snapshot(userId, legacyAssignment.workflow.id)!,
  "legacy_assignment",
  "task_legacy_assignment",
);
assert.equal((legacyAssignmentDispatch.task.payload as { message: string }).message, "DO NOT LOSE THIS");
terminalTask("task_legacy_assignment", "succeeded", "result_legacy_assignment");
assert.throws(() => workflowDao.create({
  id: "workflow_assignment_too_large",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Assignment too large",
  nodes: [{ ...work("too_large"), payload: { message: "x".repeat(32 * 1024 + 1) } }],
  edges: [],
  createdAt: at(),
}), /message exceeds/);

assert.throws(() => workflowDao.create({
  id: "workflow_static_depth",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Static depth",
  nodes: [work("depth_a"), work("depth_b")],
  edges: [{ from: "depth_a", to: "depth_b", condition: "success" }],
  budget: { maxDepth: 0 },
  createdAt: at(),
}), /graph depth budget/);
let dynamicDepth = workflowDao.create({
  id: "workflow_dynamic_depth",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Dynamic depth",
  nodes: [controller("depth_control", child.id)],
  edges: [],
  budget: { maxNodes: 3, maxEdges: 2, maxDepth: 1 },
  graphSealed: false,
  createdAt: at(),
});
dynamicDepth = workflowDao.start(userId, dynamicDepth.workflow.id, dynamicDepth.workflow.version, at())!;
dispatch(dynamicDepth, "depth_control", "task_depth_control");
const depthControllerTask = startTask("task_depth_control");
dynamicDepth = workflowDao.snapshot(userId, dynamicDepth.workflow.id)!;
assert.throws(() => workflowDao.expand({
  workflowId: dynamicDepth.workflow.id,
  userId,
  controllerNodeId: "depth_control",
  actorTaskId: depthControllerTask.id,
  actorLeaseGeneration: depthControllerTask.leaseGeneration,
  expectedGraphRevision: dynamicDepth.workflow.graphRevision,
  nodes: [work("depth_child_a"), work("depth_child_b")],
  edges: [
    { from: "depth_control", to: "depth_child_a", condition: "success" },
    { from: "depth_child_a", to: "depth_child_b", condition: "success" },
  ],
  at: at(),
}), /graph depth budget/);
dynamicDepth = workflowDao.cancel(userId, dynamicDepth.workflow.id, dynamicDepth.workflow.version, at())!;
let depthCancelledTask = runtimeTaskDao.byId(userId, "task_depth_control")!;
depthCancelledTask = runtimeTaskDao.transition({
  id: depthCancelledTask.id,
  userId,
  expectedVersion: depthCancelledTask.version,
  expectedLeaseGeneration: depthCancelledTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, dynamicDepth.workflow.id, at());
assert.equal(depthCancelledTask.status, "cancelled");
let aggregateCap = workflowDao.create({
  id: "workflow_aggregate_definition_cap",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Aggregate definition cap",
  nodes: [controller("aggregate_control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
aggregateCap = workflowDao.start(userId, aggregateCap.workflow.id, aggregateCap.workflow.version, at())!;
dispatch(aggregateCap, "aggregate_control", "task_aggregate_control");
const aggregateController = startTask("task_aggregate_control");
aggregateCap = workflowDao.snapshot(userId, aggregateCap.workflow.id)!;
assert.throws(() => workflowDao.expand({
  workflowId: aggregateCap.workflow.id,
  userId,
  controllerNodeId: "aggregate_control",
  actorTaskId: aggregateController.id,
  actorLeaseGeneration: aggregateController.leaseGeneration,
  expectedGraphRevision: aggregateCap.workflow.graphRevision,
  nodes: Array.from({ length: 9 }, (_, index) => ({
    ...work(`aggregate_${index}`),
    payload: { message: "x".repeat(30 * 1024) },
  })),
  edges: [],
  at: at(),
}), /definition exceeds/);
aggregateCap = workflowDao.cancel(userId, aggregateCap.workflow.id,
  workflowDao.snapshot(userId, aggregateCap.workflow.id)!.workflow.version, at())!;
let aggregateTask = runtimeTaskDao.byId(userId, aggregateController.id)!;
aggregateTask = runtimeTaskDao.transition({
  id: aggregateTask.id,
  userId,
  expectedVersion: aggregateTask.version,
  expectedLeaseGeneration: aggregateTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, aggregateCap.workflow.id, at());
assert.throws(() => workflowDao.create({
  id: "workflow_payload_cap",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Payload cap",
  nodes: [{ ...join("large_payload"), payload: { text: "界".repeat(21_000) } }],
  edges: [],
  createdAt: at(),
}), /payload exceeds 61440 UTF-8 bytes/);
let limited = workflowDao.create({
  id: "workflow_limited",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Limited",
  nodes: [controller("limit_control")],
  edges: [],
  budget: { maxNodes: 2, maxEdges: 1, maxDepth: 1, maxAttempts: 2 },
  graphSealed: false,
  createdAt: at(),
});
limited = workflowDao.start(userId, limited.workflow.id, limited.workflow.version, at())!;
dispatch(limited, "limit_control", "task_limit_control");
const limitControllerTask = startTask("task_limit_control");
limited = workflowDao.snapshot(userId, limited.workflow.id)!;
const limitedGraph = limited.workflow.graphRevision;
assert.throws(() => workflowDao.expand({
  workflowId: limited.workflow.id,
  userId,
  controllerNodeId: "limit_control",
  actorTaskId: limitControllerTask.id,
  actorLeaseGeneration: limitControllerTask.leaseGeneration,
  expectedGraphRevision: limited.workflow.graphRevision,
  nodes: [work("too_many_a"), work("too_many_b")],
  edges: [],
  at: at(),
}), /node budget/);
assert.equal(workflowDao.snapshot(userId, limited.workflow.id)!.workflow.graphRevision, limitedGraph);
assert.throws(() => workflowDao.create({
  id: "workflow_open_without_controller",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Invalid open graph",
  nodes: [work("orphan")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
}), /requires a controller/);
assert.equal(workflowDao.snapshot(otherUserId, limited.workflow.id), undefined);
assert.equal(workflowDao.signal(otherUserId, limited.workflow.id, "x", limited.workflow.version, at()), null);
assert.throws(() => workflowDao.create({
  id: "workflow_cross_root",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: otherRoot.id,
  name: "Cross root",
  nodes: [work("x")],
  edges: [],
  createdAt: at(),
}), /owned Session-backed root Agent/);
assert.equal(workflowDao.listEvents(otherUserId, limited.workflow.id).length, 0);
limited = workflowDao.cancel(userId, limited.workflow.id, limited.workflow.version, at())!;
let limitCancelledTask = runtimeTaskDao.byId(userId, "task_limit_control")!;
limitCancelledTask = runtimeTaskDao.transition({
  id: limitCancelledTask.id,
  userId,
  expectedVersion: limitCancelledTask.version,
  expectedLeaseGeneration: limitCancelledTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, limited.workflow.id, at());

let wideExpansion = workflowDao.create({
  id: "workflow_wide_expansion",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  controllerAgentId: child.id,
  name: "Wide expansion",
  nodes: [controller("wide_control")],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
wideExpansion = workflowDao.start(
  userId,
  wideExpansion.workflow.id,
  wideExpansion.workflow.version,
  at(),
)!;
dispatch(wideExpansion, "wide_control", "task_wide_control");
const wideControllerTask = startTask("task_wide_control");
wideExpansion = workflowDao.snapshot(userId, wideExpansion.workflow.id)!;
const wideNodeIds = Array.from(
  { length: 63 },
  (_, index) => `n${String(index).padStart(3, "0")}_${"x".repeat(123)}`,
);
assert.ok(wideNodeIds.every((id) => Buffer.byteLength(id, "utf8") === 128));
wideExpansion = workflowDao.expand({
  workflowId: wideExpansion.workflow.id,
  userId,
  controllerNodeId: "wide_control",
  actorTaskId: wideControllerTask.id,
  actorLeaseGeneration: wideControllerTask.leaseGeneration,
  expectedGraphRevision: wideExpansion.workflow.graphRevision,
  nodes: wideNodeIds.map((id) => work(id)),
  edges: [],
  mutationId: "mutation_wide_expansion",
  at: at(),
})!;
assert.equal(wideExpansion.nodes.length, 64);
const wideEvent = db.prepare(
  `SELECT length(CAST(payload_json AS BLOB)) AS bytes
   FROM workflow_events WHERE workflow_id = ? AND type = 'workflow.graph_expanded'`,
).get(wideExpansion.workflow.id) as { bytes: number };
assert.ok(wideEvent.bytes <= 16 * 1024, "the legal graph boundary keeps its event within the schema cap");
wideExpansion = workflowDao.cancel(
  userId,
  wideExpansion.workflow.id,
  wideExpansion.workflow.version,
  at(),
)!;
let wideCancelledTask = runtimeTaskDao.byId(userId, wideControllerTask.id)!;
wideCancelledTask = runtimeTaskDao.transition({
  id: wideCancelledTask.id,
  userId,
  expectedVersion: wideCancelledTask.version,
  expectedLeaseGeneration: wideCancelledTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, wideExpansion.workflow.id, at());

let timed = workflowDao.create({
  id: "workflow_timed_budget",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Timed budget",
  nodes: [work("deadline", { maxAttempts: 2 })],
  edges: [],
  budget: { maxRuntimeMs: 1 },
  createdAt: at(),
});
timed = workflowDao.start(userId, timed.workflow.id, timed.workflow.version, at())!;
dispatch(timed, "deadline", "task_deadline");
const deadlineTask = startTask("task_deadline");
timed = workflowDao.snapshot(userId, timed.workflow.id)!;
clock += 2;
timed = workflowDao.tick(userId, timed.workflow.id, timed.workflow.version, at())!;
assert.equal(timed.workflow.status, "cancelling");
assert.equal(node(timed, "deadline").status, "cancelling");
let timedTask = runtimeTaskDao.byId(userId, deadlineTask.id)!;
assert.equal(timedTask.status, "cancel_requested");
timedTask = runtimeTaskDao.transition({
  id: timedTask.id,
  userId,
  expectedVersion: timedTask.version,
  expectedLeaseGeneration: timedTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, timed.workflow.id, at());
timed = workflowDao.snapshot(userId, timed.workflow.id)!;
assert.equal(timed.workflow.status, "failed");
assert.equal(node(timed, "deadline").status, "failed", "deadline cancellation settles only after Task acknowledgement");

let beforeDeadline = workflowDao.create({
  id: "workflow_before_deadline",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Before deadline",
  nodes: [work("before_deadline")],
  edges: [],
  budget: { maxRuntimeMs: 100 },
  createdAt: at(),
});
beforeDeadline = workflowDao.start(userId, beforeDeadline.workflow.id, beforeDeadline.workflow.version, at())!;
dispatch(beforeDeadline, "before_deadline", "task_before_deadline");
terminalTask("task_before_deadline", "succeeded", "result_before_deadline");
clock = beforeDeadline.workflow.startedAt! + 200;
beforeDeadline = workflowDao.tick(
  userId,
  beforeDeadline.workflow.id,
  workflowDao.snapshot(userId, beforeDeadline.workflow.id)!.workflow.version,
  at(),
)!;
assert.equal(beforeDeadline.workflow.status, "succeeded", "projection delay does not move a durable completion past its deadline");

let parallelBeforeDeadline = workflowDao.create({
  id: "workflow_parallel_before_deadline",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Parallel before deadline",
  nodes: [work("parallel_a"), work("parallel_b", { executorAgentId: worker2.id })],
  edges: [],
  budget: { maxRuntimeMs: 100 },
  createdAt: at(),
});
parallelBeforeDeadline = workflowDao.start(
  userId,
  parallelBeforeDeadline.workflow.id,
  parallelBeforeDeadline.workflow.version,
  at(),
)!;
dispatch(parallelBeforeDeadline, "parallel_a", "task_parallel_before_a");
parallelBeforeDeadline = workflowDao.snapshot(userId, parallelBeforeDeadline.workflow.id)!;
dispatch(parallelBeforeDeadline, "parallel_b", "task_parallel_before_b");
startTask("task_parallel_before_a");
startTask("task_parallel_before_b");
const parallelStartedAt = parallelBeforeDeadline.workflow.startedAt!;
forceSucceededWithResult("task_parallel_before_a", "result_parallel_before_a", parallelStartedAt + 10);
forceSucceededWithResult("task_parallel_before_b", "result_parallel_before_b", parallelStartedAt + 20);
clock = parallelStartedAt + 200;
const parallelRecovery = workflowDao.recover(userId, parallelBeforeDeadline.workflow.id, at())!;
parallelBeforeDeadline = workflowDao.snapshot(userId, parallelBeforeDeadline.workflow.id)!;
assert.equal(parallelRecovery.reconciled, 2);
assert.equal(parallelBeforeDeadline.workflow.status, "succeeded",
  "delayed projection cannot turn two on-time terminal Tasks into a timeout");

let afterDeadline = workflowDao.create({
  id: "workflow_after_deadline",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "After deadline",
  nodes: [work("after_deadline")],
  edges: [],
  budget: { maxRuntimeMs: 5 },
  createdAt: at(),
});
afterDeadline = workflowDao.start(userId, afterDeadline.workflow.id, afterDeadline.workflow.version, at())!;
dispatch(afterDeadline, "after_deadline", "task_after_deadline");
startTask("task_after_deadline");
clock = afterDeadline.workflow.startedAt! + 10;
terminalTask("task_after_deadline", "succeeded", "result_after_deadline");
afterDeadline = workflowDao.tick(
  userId,
  afterDeadline.workflow.id,
  workflowDao.snapshot(userId, afterDeadline.workflow.id)!.workflow.version,
  at(),
)!;
assert.equal(afterDeadline.workflow.status, "failed");
assert.equal(node(afterDeadline, "after_deadline").status, "failed");

let attemptCap = workflowDao.create({
  id: "workflow_attempt_cap",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Attempt cap",
  nodes: [work("cap_a"), work("cap_b")],
  edges: [],
  budget: { maxAttempts: 1 },
  createdAt: at(),
});
attemptCap = workflowDao.start(userId, attemptCap.workflow.id, attemptCap.workflow.version, at())!;
dispatch(attemptCap, "cap_a", "task_cap_a");
terminalTask("task_cap_a", "succeeded", "result_cap_a");
attemptCap = settle(workflowDao.snapshot(userId, attemptCap.workflow.id)!, "cap_a", "task_cap_a");
assert.equal(attemptCap.workflow.status, "failed");
assert.equal(node(attemptCap, "cap_b").status, "cancelled");

let tokenJoin = workflowDao.create({
  id: "workflow_token_join",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Token join",
  nodes: [work("token_a"), join("token_join")],
  edges: [{ from: "token_a", to: "token_join", condition: "success" }],
  budget: { maxTokens: 5 },
  createdAt: at(),
});
tokenJoin = workflowDao.start(userId, tokenJoin.workflow.id, tokenJoin.workflow.version, at())!;
dispatch(tokenJoin, "token_a", "task_token_a");
terminalTask("task_token_a", "succeeded", "result_token_a", { tokensUsed: 5 });
tokenJoin = settle(workflowDao.snapshot(userId, tokenJoin.workflow.id)!, "token_a", "task_token_a");
assert.equal(tokenJoin.workflow.status, "succeeded", "a zero-cost join can complete at the exact token cap");
assert.equal(tokenJoin.workflow.tokensUsed, 5);
assert.equal(tokenJoin.attempts[0]?.tokensUsed, 5);
const tokenJoinAgain = settle(tokenJoin, "token_a", "task_token_a", { tokensUsed: 5 });
assert.equal(tokenJoinAgain.workflow.tokensUsed, 5, "settlement usage is idempotent");

let tokenDownstream = workflowDao.create({
  id: "workflow_token_downstream",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Token downstream",
  nodes: [work("token_source"), work("token_next")],
  edges: [{ from: "token_source", to: "token_next", condition: "success" }],
  budget: { maxTokens: 5 },
  createdAt: at(),
});
tokenDownstream = workflowDao.start(userId, tokenDownstream.workflow.id, tokenDownstream.workflow.version, at())!;
dispatch(tokenDownstream, "token_source", "task_token_source");
terminalTask("task_token_source", "succeeded", "result_token_source", { tokensUsed: 5 });
tokenDownstream = settle(
  workflowDao.snapshot(userId, tokenDownstream.workflow.id)!,
  "token_source",
  "task_token_source",
);
assert.equal(tokenDownstream.workflow.status, "failed");
assert.equal(node(tokenDownstream, "token_next").status, "cancelled");

let reserved = workflowDao.create({
  id: "workflow_parallel_reservation",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Parallel reservation",
  nodes: [work("reserve_a"), work("reserve_b"), work("reserve_c")],
  edges: [],
  budget: { maxTokens: 300_000, maxCostMicros: 75_000_000 },
  createdAt: at(),
});
reserved = workflowDao.start(userId, reserved.workflow.id, reserved.workflow.version, at())!;
dispatch(reserved, "reserve_a", "task_reserve_a");
reserved = workflowDao.snapshot(userId, reserved.workflow.id)!;
dispatch(reserved, "reserve_b", "task_reserve_b");
reserved = workflowDao.snapshot(userId, reserved.workflow.id)!;
assert.equal(reserved.workflow.tokensUsed, 0);
assert.equal(reserved.workflow.tokensReserved, 300_000);
assert.equal(reserved.workflow.costReservedMicros, 75_000_000);
assert.deepEqual(reserved.attempts.map((attempt) => attempt.tokensReserved), [256_000, 44_000]);
assert.throws(() => workflowDao.claim({
  workflowId: reserved.workflow.id,
  userId,
  nodeId: "reserve_c",
  taskId: "task_reserve_c_blocked",
  expectedVersion: reserved.workflow.version,
  at: at(),
}), /tokens/);
reserved = workflowDao.cancel(userId, reserved.workflow.id, reserved.workflow.version, at())!;
workflowDao.recover(userId, reserved.workflow.id, at());
reserved = workflowDao.snapshot(userId, reserved.workflow.id)!;
assert.equal(reserved.workflow.status, "cancelled");
assert.equal(reserved.workflow.tokensReserved, 0);
assert.equal(reserved.workflow.costReservedMicros, 0);

let lateUsage = workflowDao.create({
  id: "workflow_late_usage",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Late usage",
  nodes: [work("late_usage")],
  edges: [],
  createdAt: at(),
});
lateUsage = workflowDao.start(userId, lateUsage.workflow.id, lateUsage.workflow.version, at())!;
dispatch(lateUsage, "late_usage", "task_late_usage");
let lateTask = startTask("task_late_usage");
lateUsage = workflowDao.cancel(
  userId,
  lateUsage.workflow.id,
  workflowDao.snapshot(userId, lateUsage.workflow.id)!.workflow.version,
  at(),
)!;
lateTask = runtimeTaskDao.transition({
  id: lateTask.id,
  userId,
  expectedVersion: runtimeTaskDao.byId(userId, lateTask.id)!.version,
  expectedLeaseGeneration: lateTask.leaseGeneration,
  nextStatus: "cancelled",
  at: at(),
})!;
workflowDao.recover(userId, lateUsage.workflow.id, at());
lateUsage = workflowDao.recordLateUsage({
  userId,
  taskId: lateTask.id,
  expectedTaskLeaseGeneration: lateTask.leaseGeneration,
  tokensUsed: 7,
  costUsedMicros: 3,
  at: at(),
})!;
assert.equal(lateUsage.workflow.tokensUsed, 7);
assert.equal(lateUsage.workflow.costUsedMicros, 3);
assert.equal(lateUsage.attempts[0]?.tokensUsed, 7);
assert.equal(workflowDao.listEvents(userId, lateUsage.workflow.id).at(-1)?.type, "workflow.usage_late");
assert.equal(workflowDao.recordLateUsage({
  userId: otherUserId,
  taskId: lateTask.id,
  expectedTaskLeaseGeneration: lateTask.leaseGeneration,
  tokensUsed: 8,
  costUsedMicros: 4,
  at: at(),
}), null);

let usageCheckpoint = workflowDao.create({
  id: "workflow_usage_checkpoint",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Usage checkpoint",
  nodes: [work("usage")],
  edges: [],
  createdAt: at(),
});
usageCheckpoint = workflowDao.start(userId, usageCheckpoint.workflow.id, usageCheckpoint.workflow.version, at())!;
dispatch(usageCheckpoint, "usage", "task_usage");
const usageTask = startTask("task_usage");
usageCheckpoint = workflowDao.snapshot(userId, usageCheckpoint.workflow.id)!;
const usageEventsBefore = workflowDao.listEvents(userId, usageCheckpoint.workflow.id).length;
for (let value = 1; value <= 10; value += 1) {
  usageCheckpoint = workflowDao.recordUsage({
    workflowId: usageCheckpoint.workflow.id,
    userId,
    nodeId: "usage",
    taskId: usageTask.id,
    expectedTaskLeaseGeneration: usageTask.leaseGeneration,
    expectedVersion: usageCheckpoint.workflow.version,
    tokensUsed: value,
    costUsedMicros: value,
    at: at(),
  })!;
}
const usageEvents = workflowDao.listEvents(userId, usageCheckpoint.workflow.id);
assert.equal(usageEvents.length, usageEventsBefore + 10);
assert.ok(
  usageEvents.slice(-10).every((event) => event.type === "workflow.usage_checkpoint"),
  "every accepted budget checkpoint remains auditable",
);
assert.equal(usageCheckpoint.workflow.tokensUsed, 10);
assert.equal(usageCheckpoint.attempts[0]?.tokensUsed, 10);
terminalTask("task_usage", "succeeded", "result_usage");
usageCheckpoint = settle(
  workflowDao.snapshot(userId, usageCheckpoint.workflow.id)!,
  "usage",
  "task_usage",
);
assert.equal(usageCheckpoint.workflow.tokensUsed, 10);
assert.equal(usageCheckpoint.workflow.tokensReserved, 0);
assert.equal(usageCheckpoint.workflow.costReservedMicros, 0);
console.log("  ✓ hard budgets roll back atomically and every operation is owner-scoped");

let revision = workflowDao.create({
  id: "workflow_definition_revision",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Revision",
  nodes: [work("v1")],
  edges: [],
  createdAt: at(),
});
const originalGraphRevision = revision.workflow.graphRevision;
revision = workflowDao.reviseDefinition({
  workflowId: revision.workflow.id,
  userId,
  expectedVersion: revision.workflow.version,
  expectedDefinitionVersion: revision.workflow.definitionVersion,
  nodes: [work("v2")],
  edges: [],
  mutationId: "mutation_definition_v2",
  at: at(),
})!;
assert.equal(revision.workflow.definitionVersion, 2);
assert.equal(revision.workflow.graphRevision, originalGraphRevision + 1);
assert.equal(revision.nodes[0]?.id, "v2");
const definitions = db.prepare(
  "SELECT version FROM workflow_definition_versions WHERE workflow_id = ? ORDER BY version",
).all(revision.workflow.id) as Array<{ version: number }>;
assert.deepEqual(definitions.map((value) => value.version), [1, 2]);
assert.ok(workflowDao.listEvents(userId, revision.workflow.id).every((event, index) => event.seq === index + 1));
let definitionCap = workflowDao.create({
  id: "workflow_definition_cap",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Definition cap",
  nodes: [work("definition_1")],
  edges: [],
  createdAt: at(),
});
for (let version = 2; version <= 64; version += 1) {
  definitionCap = workflowDao.reviseDefinition({
    workflowId: definitionCap.workflow.id,
    userId,
    expectedVersion: definitionCap.workflow.version,
    expectedDefinitionVersion: definitionCap.workflow.definitionVersion,
    nodes: [work(`definition_${version}`)],
    edges: [],
    at: at(),
  })!;
}
assert.throws(() => workflowDao.reviseDefinition({
  workflowId: definitionCap.workflow.id,
  userId,
  expectedVersion: definitionCap.workflow.version,
  expectedDefinitionVersion: definitionCap.workflow.definitionVersion,
  nodes: [work("definition_65")],
  edges: [],
  at: at(),
}), /definition version budget/);
assert.throws(
  () => db.prepare("UPDATE workflows SET max_nodes = 65 WHERE id = ?").run(revision.workflow.id),
  /invalid Workflow ownership or limits/,
  "the upgraded table keeps the fresh-schema limit boundary",
);
createSession("session_workflow_cascade");
const cascadeRoot = agentNodeDao.create({
  id: "agent_workflow_cascade",
  userId,
  sessionId: "session_workflow_cascade",
  rootAgentId: "agent_workflow_cascade",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: at(),
});
const cascadeExecutor = agentNodeDao.create({
  id: "agent_workflow_cascade_executor",
  userId,
  sessionId: "session_workflow_cascade",
  rootAgentId: cascadeRoot.id,
  parentAgentId: cascadeRoot.id,
  path: "/root/workflow",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});
workflowDao.create({
  id: "workflow_root_cascade",
  userId,
  ownerSessionId: "session_workflow_cascade",
  rootAgentId: cascadeRoot.id,
  controllerAgentId: cascadeExecutor.id,
  name: "Cascade",
  nodes: [{ ...controller("cascade", cascadeExecutor.id) }],
  edges: [],
  graphSealed: false,
  createdAt: at(),
});
db.prepare("DELETE FROM agent_nodes WHERE id = ?").run(cascadeRoot.id);
assert.equal(db.prepare("SELECT 1 FROM workflows WHERE id = 'workflow_root_cascade'").get(), undefined);
console.log("  ✓ immutable definition history and append-only events carry separate revisions");

let idCounter = 0;
const engine = new WorkflowEngine({
  userId,
  now: at,
  id: (kind: string) => `${kind}_${++idCounter}`,
});
const engineWorkflow = engine.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Engine facade",
  nodes: [work("engine_work")],
  edges: [],
});
assert.equal(engine.snapshot(engineWorkflow.workflow.id)?.workflow.id, engineWorkflow.workflow.id);
assert.equal(engine.start(engineWorkflow.workflow.id, engineWorkflow.workflow.version)?.nodes[0]?.status, "ready");
console.log("  ✓ WorkflowEngine is a persistence-first facade with no pi dependency");

const coordinator = new WorkflowCoordinator({
  userId,
  now: at,
  id: (kind: string) => `coordinator_${kind}_${++idCounter}`,
});
let coordinated = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Coordinator recovery",
  nodes: [work("coordinated", { effect: "pure_readonly", maxAttempts: 2 })],
  edges: [],
});
coordinated = coordinator.start(coordinated.workflow.id, coordinated.workflow.version)!;
let pumped = coordinator.pump(coordinated.workflow.id);
assert.equal(pumped.dispatches.length, 1);
const coordinatedTaskId = pumped.dispatches[0]!.task.id;
assert.equal(pumped.dispatches[0]!.task.agentId, child.id);
assert.ok(pumped.dispatches[0]!.task.agentOrd > 0, "Workflow Task uses shared Agent FIFO");
assert.equal(runtimeTaskDao.byId(userId, coordinatedTaskId)?.checkpointSafe, true);
let coordinatedTask = startTask(coordinatedTaskId);
const staleLease = coordinatedTask.leaseGeneration;
runtimeTaskDao.recoverAfterRestart(at(), "coordinator-crash-fence");
coordinatedTask = runtimeTaskDao.byId(userId, coordinatedTaskId)!;
assert.equal(coordinatedTask.status, "queued");
assert.ok(coordinatedTask.leaseGeneration > staleLease);
pumped = coordinator.pump(coordinated.workflow.id);
assert.equal(pumped.dispatches.length, 0, "checkpoint recovery keeps one durable attempt");
terminalTask(coordinatedTaskId, "succeeded", "result_coordinated");
pumped = coordinator.pump(coordinated.workflow.id);
coordinated = pumped.snapshot!;
assert.equal(coordinated.workflow.status, "succeeded");
assert.equal(coordinated.attempts.length, 1);
assert.ok(node(coordinated, "coordinated").outputDigest);
assert.ok(coordinator.candidates().workflows.every((workflow) => workflow.userId === userId));
console.log("  ✓ WorkflowCoordinator proves claim/recover/settle without owning Task execution");

let partialPump = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Partial pump",
  nodes: [work("partial_a"), work("partial_b", { executorAgentId: worker2.id })],
  edges: [],
  budget: { maxAttempts: 1 },
});
partialPump = coordinator.start(partialPump.workflow.id, partialPump.workflow.version)!;
const partial = coordinator.pump(partialPump.workflow.id);
assert.equal(partial.dispatches.length, 1,
  "a normal attempt boundary returns already committed dispatches");
terminalTask(partial.dispatches[0]!.task.id, "succeeded", `result_${partial.dispatches[0]!.task.id}`);
partialPump = workflowDao.snapshot(userId, partialPump.workflow.id)!;
assert.equal(partialPump.workflow.status, "failed");
assert.equal(partialPump.attempts.length, 1);
console.log("  ✓ Coordinator preserves partial progress at a hard attempt boundary");

let cancelWorkerStarted!: () => void;
let releaseCancelledWorker!: () => void;
let cancelSignalObserved!: () => void;
let lateWorkerStarted!: () => void;
let releaseLateWorker!: () => void;
const cancelStarted = new Promise<void>((resolve) => { cancelWorkerStarted = resolve; });
const cancelRelease = new Promise<void>((resolve) => { releaseCancelledWorker = resolve; });
const cancelSignal = new Promise<void>((resolve) => { cancelSignalObserved = resolve; });
const lateStarted = new Promise<void>((resolve) => { lateWorkerStarted = resolve; });
const lateRelease = new Promise<void>((resolve) => { releaseLateWorker = resolve; });
let supervisorResultId = 0;
const workflowSupervisor = new AgentSupervisor({
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  now: at,
  id: (kind) => `${kind}_workflow_supervisor_${++supervisorResultId}`,
  waitPollMs: 5,
  interruptGraceMs: 20,
  closeTimeoutMs: 100,
  workerFactory: async () => ({
    async run(input) {
      if (input.task.title === "supervisor_cancel") {
        cancelWorkerStarted();
        input.signal.addEventListener("abort", cancelSignalObserved, { once: true });
        await cancelRelease;
      }
      if (input.task.title === "supervisor_late_usage") {
        lateWorkerStarted();
        await lateRelease;
        return {
          summary: "late provider result",
          body: {},
          artifacts: [],
          tokensUsed: 17,
          costUsedMicros: 9,
        };
      }
      if (input.task.title === "supervisor_oversized") {
        return {
          summary: "oversized result",
          body: { text: "x".repeat(300 * 1024) },
          artifacts: [],
          tokensUsed: 11,
          costUsedMicros: 5,
        };
      }
      return {
        summary: `done:${input.task.id}`,
        body: { taskId: input.task.id },
        artifacts: [],
        tokensUsed: 7,
        costUsedMicros: 3,
      };
    },
  }),
});
let supervised = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Supervisor settlement",
  nodes: [work("supervisor_success")],
  edges: [],
});
supervised = coordinator.start(supervised.workflow.id, supervised.workflow.version)!;
coordinator.pump(supervised.workflow.id);
workflowSupervisor.poke();
await until(
  () => workflowDao.snapshot(userId, supervised.workflow.id)?.workflow.status === "succeeded",
  "Workflow Supervisor atomic settlement",
);
supervised = workflowDao.snapshot(userId, supervised.workflow.id)!;
assert.equal(supervised.workflow.tokensUsed, 7);
assert.equal(supervised.workflow.costUsedMicros, 3);

let oversized = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Supervisor oversized result",
  nodes: [work("supervisor_oversized")],
  edges: [],
});
oversized = coordinator.start(oversized.workflow.id, oversized.workflow.version)!;
coordinator.pump(oversized.workflow.id);
workflowSupervisor.poke();
await until(
  () => workflowDao.snapshot(userId, oversized.workflow.id)?.workflow.status === "succeeded",
  "Workflow Supervisor oversized-result fallback",
);
oversized = workflowDao.snapshot(userId, oversized.workflow.id)!;
assert.equal(oversized.workflow.tokensUsed, 11);
assert.equal(oversized.workflow.costUsedMicros, 5);
assert.equal(oversized.attempts[0]?.tokensUsed, 11);

let cancelRace = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Supervisor cancel race",
  nodes: [work("supervisor_cancel")],
  edges: [],
});
cancelRace = coordinator.start(cancelRace.workflow.id, cancelRace.workflow.version)!;
const cancelDispatch = coordinator.pump(cancelRace.workflow.id).dispatches[0]!;
workflowSupervisor.poke();
await cancelStarted;
cancelRace = workflowDao.snapshot(userId, cancelRace.workflow.id)!;
cancelRace = workflowDao.cancel(userId, cancelRace.workflow.id, cancelRace.workflow.version, at())!;
assert.equal(cancelRace.workflow.status, "cancelling");
workflowSupervisor.poke();
await cancelSignal;
releaseCancelledWorker();
await until(
  () => runtimeTaskDao.byId(userId, cancelDispatch.task.id)?.status === "cancelled",
  "cancel wins worker result race without livelock",
);
cancelRace = workflowDao.snapshot(userId, cancelRace.workflow.id)!;
assert.equal(cancelRace.workflow.status, "cancelled");
assert.equal(cancelRace.workflow.tokensUsed, 7, "cancel acknowledgement commits final provider usage");
assert.equal(cancelRace.workflow.costUsedMicros, 3);

let lateSupervisor = coordinator.create({
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Supervisor late usage",
  nodes: [work("supervisor_late_usage")],
  edges: [],
});
lateSupervisor = coordinator.start(lateSupervisor.workflow.id, lateSupervisor.workflow.version)!;
const lateDispatch = coordinator.pump(lateSupervisor.workflow.id).dispatches[0]!;
workflowSupervisor.poke();
await lateStarted;
lateSupervisor = workflowDao.snapshot(userId, lateSupervisor.workflow.id)!;
lateSupervisor = workflowDao.cancel(
  userId,
  lateSupervisor.workflow.id,
  lateSupervisor.workflow.version,
  at(),
)!;
workflowSupervisor.poke();
await until(
  () => runtimeTaskDao.byId(userId, lateDispatch.task.id)?.status === "cancelled",
  "force fence settles late-usage Task",
);
releaseLateWorker();
await until(
  () => workflowDao.snapshot(userId, lateSupervisor.workflow.id)?.workflow.tokensUsed === 17,
  "detached provider final usage commits after force fence",
);
lateSupervisor = workflowDao.snapshot(userId, lateSupervisor.workflow.id)!;
assert.equal(lateSupervisor.workflow.status, "cancelled");
assert.equal(lateSupervisor.workflow.costUsedMicros, 9);
assert.equal(workflowDao.listEvents(userId, lateSupervisor.workflow.id).at(-1)?.type, "workflow.usage_late");
await workflowSupervisor.close();
console.log("  ✓ Supervisor routes live and late Workflow usage without cancellation livelock");

const foreignLoadAgent = agentNodeDao.create({
  id: "agent_workflow_foreign_load",
  userId: otherUserId,
  sessionId: "session_other",
  rootAgentId: otherRoot.id,
  parentAgentId: otherRoot.id,
  path: "/root/load",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});
workflowDao.create({
  id: "workflow_foreign_candidate_load",
  userId: otherUserId,
  ownerSessionId: "session_other",
  rootAgentId: otherRoot.id,
  name: "Foreign candidate load",
  nodes: [work("foreign_load", { executorAgentId: foreignLoadAgent.id })],
  edges: [],
  createdAt: at(),
});
db.prepare("UPDATE workflows SET status = 'succeeded', settled_at = ? WHERE id = ?")
  .run(at(), "workflow_foreign_candidate_load");
db.exec(`
  WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
  INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, agent_id, agent_ord, workflow_id,
     kind, title, payload_json, payload_bytes, status, await_policy, cancel_policy,
     checkpoint_safe, lease_generation, version, created_at, updated_at, started_at, settled_at)
  SELECT 'foreign_task_' || n, '${otherUserId}', 'session_other', 'session_other',
    '${foreignLoadAgent.id}', n, 'workflow_foreign_candidate_load', 'workflow_node',
    'foreign', '{"message":"x"}', length(CAST('{"message":"x"}' AS BLOB)),
    'succeeded', 'background', 'detached', 0, 1, 1, n, n, n, n
  FROM seq;
  WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
  INSERT INTO workflow_node_attempts
    (workflow_id, node_id, attempt_no, task_id, status, execution_phase, source,
     evidence_json, tokens_used, cost_used_micros, created_at, settled_at)
  SELECT 'workflow_foreign_candidate_load', 'foreign_load', n, 'foreign_task_' || n,
    'running', 'succeeded', 'execution', '{}', 0, 0, n, NULL
  FROM seq;
`);
const candidatePlan = db.prepare(
  `EXPLAIN QUERY PLAN SELECT dirty.id FROM workflows dirty
   WHERE dirty.user_id = ? AND dirty.root_agent_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM workflow_node_attempts attempt
       JOIN runtime_tasks task ON task.id = attempt.task_id
       WHERE attempt.workflow_id = dirty.id
         AND attempt.status IN ('running','cancel_requested')
         AND task.status IN ('succeeded','failed','cancelled','interrupted')
     )`,
).all("empty_candidate_user") as unknown as Array<{ detail: string }>;
assert.ok(candidatePlan.some((step) => step.detail.includes("idx_workflows_user_id")),
  `candidate plan must start from owned Workflows: ${JSON.stringify(candidatePlan)}`);
const profileStarted = performance.now();
for (let index = 0; index < 100; index += 1) {
  workflowDao.listCoordinatorCandidates("empty_candidate_user", { limit: 50 });
}
const candidateProfileMs = performance.now() - profileStarted;
assert.ok(candidateProfileMs < timeBudgetMs(250),
  `cross-tenant candidate profile regressed: ${candidateProfileMs.toFixed(2)}ms`);
console.log(`  ✓ candidate scan is user-first under 50k foreign attempts (${candidateProfileMs.toFixed(2)}ms / 100)`);
db.exec(`
  PRAGMA foreign_keys = OFF;
  DELETE FROM workflow_node_attempts WHERE workflow_id = 'workflow_foreign_candidate_load';
  DELETE FROM runtime_tasks WHERE user_id = '${otherUserId}';
  DELETE FROM workflows WHERE id = 'workflow_foreign_candidate_load';
  PRAGMA foreign_keys = ON;
`);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

assert.equal(
  (db.prepare(
    `SELECT COUNT(*) AS count FROM runtime_tasks
     WHERE status IN ('starting','running','waiting','cancel_requested')`,
  ).get() as { count: number }).count,
  0,
  "the contract test leaves no active Task lease",
);

const legacyCancelExecutor = agentNodeDao.create({
  id: "agent_legacy_cancel_repair",
  userId,
  sessionId: "session_workflow",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/legacy-cancel-repair",
  provider: "mock",
  model: "mock",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: at(),
});
let legacyCancel = workflowDao.create({
  id: "workflow_legacy_cancel_repair",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Legacy cancel repair",
  nodes: [work("legacy_cancel", { executorAgentId: legacyCancelExecutor.id })],
  edges: [],
  createdAt: at(),
});
legacyCancel = workflowDao.start(userId, legacyCancel.workflow.id, legacyCancel.workflow.version, at())!;
dispatch(legacyCancel, "legacy_cancel", "task_legacy_cancel_repair");
startTask("task_legacy_cancel_repair");
legacyCancel = workflowDao.cancel(userId, legacyCancel.workflow.id,
  workflowDao.snapshot(userId, legacyCancel.workflow.id)!.workflow.version, at())!;
assert.equal(legacyCancel.workflow.status, "cancelling");
db.exec(`
  UPDATE workflows SET status = 'cancelled', cancellation_pending = 0,
    terminal_intent = NULL, settled_at = updated_at
  WHERE id = 'workflow_legacy_cancel_repair';
  UPDATE workflow_nodes SET status = 'cancelled', execution_phase = NULL,
    settled_at = updated_at
  WHERE workflow_id = 'workflow_legacy_cancel_repair' AND id = 'legacy_cancel';
`);
db.prepare("UPDATE agent_nodes SET status = 'closed' WHERE id = ?").run(legacyCancelExecutor.id);
let legacyCheckpoint = workflowDao.create({
  id: "workflow_legacy_checkpoint",
  userId,
  ownerSessionId: "session_workflow",
  rootAgentId: root.id,
  name: "Legacy checkpoint",
  nodes: [work("legacy_checkpoint", { executorAgentId: worker2.id })],
  edges: [],
  createdAt: at(),
});
legacyCheckpoint = workflowDao.start(
  userId,
  legacyCheckpoint.workflow.id,
  legacyCheckpoint.workflow.version,
  at(),
)!;
dispatch(legacyCheckpoint, "legacy_checkpoint", "task_legacy_checkpoint");
startTask("task_legacy_checkpoint");
db.prepare(
  "UPDATE runtime_tasks SET checkpoint_safe = 1, capability_contract_version = 0 WHERE id = ?",
).run("task_legacy_checkpoint");
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

db.close();
const reopen = spawnSync(
  path.resolve("node_modules/.bin/tsx"),
  ["-e", `(async () => {
    process.env.AGENT_WEB_DATA_DIR = ${JSON.stringify(tmp)};
    const { db, runtimeTaskDao, sessionDao, workflowDao } = await import("./server/src/persistence/index.ts");
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) process.exit(2);
    const repaired = db.prepare(
      "SELECT status, cancellation_pending, terminal_intent FROM workflows WHERE id = ?",
    ).get("workflow_legacy_cancel_repair");
    const node = db.prepare(
      "SELECT status, execution_phase FROM workflow_nodes WHERE workflow_id = ? AND id = ?",
    ).get("workflow_legacy_cancel_repair", "legacy_cancel");
    if (JSON.stringify(repaired) !== JSON.stringify({
      status: "cancelled", cancellation_pending: 1, terminal_intent: "cancelled",
    })) process.exit(3);
    if (JSON.stringify(node) !== JSON.stringify({ status: "running", execution_phase: "cancel_requested" })) {
      process.exit(4);
    }
    if (runtimeTaskDao.byId(${JSON.stringify(userId)}, "task_legacy_checkpoint")?.checkpointSafe !== false) {
      process.exit(9);
    }
    const recoveryAt = 2_000_000_000_000;
    runtimeTaskDao.recoverAfterRestart(recoveryAt, "legacy-cancel-repair");
    workflowDao.recover(${JSON.stringify(userId)}, "workflow_legacy_cancel_repair", recoveryAt);
    workflowDao.recover(${JSON.stringify(userId)}, "workflow_legacy_checkpoint", recoveryAt);
    const final = workflowDao.snapshot(${JSON.stringify(userId)}, "workflow_legacy_cancel_repair");
    if (final?.workflow.status !== "cancelled" || final.nodes[0]?.status !== "cancelled") process.exit(5);
    const checkpoint = workflowDao.snapshot(${JSON.stringify(userId)}, "workflow_legacy_checkpoint");
    if (checkpoint?.workflow.status !== "failed" || checkpoint.nodes[0]?.status !== "failed") process.exit(10);
    sessionDao.delete("session_workflow");
    for (const table of ["workflows", "workflow_nodes", "workflow_edges", "workflow_node_attempts"]) {
      const count = db.prepare(\`SELECT COUNT(*) AS count FROM \${table}\`).get().count;
      if (Number(count) !== 0) process.exit(6);
    }
    if (db.prepare("SELECT 1 FROM agent_nodes WHERE user_id = ?").get(${JSON.stringify(userId)})) process.exit(7);
    db.prepare("DELETE FROM users WHERE id = ?").run(${JSON.stringify(otherUserId)});
    if (db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(${JSON.stringify(otherUserId)})) process.exit(11);
    if (db.prepare("SELECT 1 FROM agent_nodes WHERE user_id = ?").get(${JSON.stringify(otherUserId)})) process.exit(12);
    if (db.prepare("SELECT 1 FROM runtime_tasks WHERE user_id = ?").get(${JSON.stringify(otherUserId)})) process.exit(13);
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) process.exit(8);
    db.close();
  })().catch((error) => { console.error(error); process.exit(1); });`],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(reopen.status, 0, `second migration boot failed:\n${reopen.stderr}`);
console.log("  ✓ Workflow schema migration remains idempotent on a second process boot");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Workflow engine checks passed");
