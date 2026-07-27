import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-workflow-launch-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const {
  agentNodeDao,
  db,
  runtimeTaskDao,
  sessionDao,
  userDao,
  workflowDao,
} = await import("../server/src/persistence/index.ts");
const {
  WorkflowExpansionService,
  WorkflowLaunchService,
} = await import("../server/src/orchestration/workflow-launch.ts");
const { WorkflowCoordinator } = await import("../server/src/orchestration/workflow-engine.ts");
const { createWorkflowTools } = await import("../server/src/orchestration/workflow-tools.ts");
const { createTools } = await import("../server/src/runtime/tools.ts");

let clock = 2_000_000_000_000;
const now = () => ++clock;
const userId = "workflow_launch_user";
const sessionId = "workflow_launch_session";
const rootAgentId = "agt_root_workflow_launch";

userDao.create({
  id: userId,
  email: "workflow-launch@example.invalid",
  password_hash: "x",
  created_at: now(),
});
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "Workflow launch",
  provider: "mock",
  model: "mock-model",
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
  label: "Current session",
  kind: "session",
  status: "idle",
  createdAt: now(),
});

function deterministicIds(workflowId: string, agentIds: readonly string[]) {
  let agent = 0;
  return (kind: "workflow" | "agent") => {
    if (kind === "workflow") return workflowId;
    const value = agentIds[agent++];
    if (!value) throw new Error("test id factory exhausted");
    return value;
  };
}

let changed = 0;
const launched = new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: 32,
  now,
  id: deterministicIds("wfl_launch_happy", ["agt_research", "agt_review", "agt_merge"]),
  onChanged: () => { changed += 1; },
}).launch({
  name: "Research and review",
  provider: "mock",
  model: "mock-model",
  thinkingLevel: "high",
  budget: { maxNodes: 3, maxEdges: 2, maxDepth: 2, maxAttempts: 4 },
  nodes: [
    {
      id: "research",
      name: "Research",
      message: "Inspect the evidence and write a bounded report.",
      effect: "workspace_read",
    },
    {
      id: "review",
      name: "Review",
      message: "Review the implementation independently.",
      effect: "pure_readonly",
      maxAttempts: 2,
    },
    {
      id: "merge",
      name: "Merge findings",
      message: "Read both upstream results and produce one decision.",
      dependencies: [{ nodeId: "research" }, { nodeId: "review", condition: "settled" }],
    },
  ],
});

assert.equal(changed, 1, "the exact scheduler/UI hint runs once after commit");
assert.equal(launched.snapshot.workflow.status, "running");
assert.equal(launched.snapshot.workflow.graphSealed, true);
assert.deepEqual(
  {
    maxNodes: launched.snapshot.workflow.budget.maxNodes,
    maxEdges: launched.snapshot.workflow.budget.maxEdges,
    maxDepth: launched.snapshot.workflow.budget.maxDepth,
    maxAttempts: launched.snapshot.workflow.budget.maxAttempts,
  },
  { maxNodes: 3, maxEdges: 2, maxDepth: 2, maxAttempts: 4 },
  "static launch applies all declared graph budgets",
);
assert.equal(launched.snapshot.nodes.filter((node) => node.status === "ready").length, 2);
assert.equal(launched.snapshot.nodes.find((node) => node.id === "merge")?.status, "blocked");
assert.deepEqual(
  launched.snapshot.edges.map(({ from, to, condition }) => ({ from, to, condition })),
  [
    { from: "research", to: "merge", condition: "success" },
    { from: "review", to: "merge", condition: "settled" },
  ],
);
assert.deepEqual(
  launched.executors.map(({ nodeId, agentId }) => ({ nodeId, agentId })),
  [
    { nodeId: "research", agentId: "agt_research" },
    { nodeId: "review", agentId: "agt_review" },
    { nodeId: "merge", agentId: "agt_merge" },
  ],
);
for (const executor of launched.executors) {
  const agent = agentNodeDao.byId(userId, executor.agentId);
  assert.equal(agent?.status, "idle");
  assert.equal(agent?.provider, "mock");
  assert.equal(agent?.model, "mock-model");
  assert.equal(agent?.thinkingLevel, "high");
  assert.equal(agent?.path, executor.path);
}
assert.deepEqual(
  workflowDao.listEvents(userId, launched.snapshot.workflow.id, 0, 10).map((event) => event.type),
  ["workflow.created", "workflow.started"],
  "identity, graph, and start edge commit as one launch",
);
console.log("  ✓ declarative launch commits executors, graph, and start edge");

const coordinator = new WorkflowCoordinator({
  userId,
  now,
  id: (kind) => `${kind}_launch_${now()}`,
});
const pumped = coordinator.pump(launched.snapshot.workflow.id);
assert.equal(pumped.dispatches.length, 2, "independent roots materialize without a stage barrier");
assert.deepEqual(
  pumped.dispatches.map((dispatch) => dispatch.node.id).sort(),
  ["research", "review"],
);
assert.equal(
  new Set(pumped.dispatches.map((dispatch) => dispatch.task.agentId)).size,
  2,
  "parallel nodes use independent Agent contexts",
);
console.log("  ✓ scheduler materializes independent nodes onto distinct Agents");

const count = (table: "agent_nodes" | "workflows") => Number((db.prepare(
  `SELECT COUNT(*) AS count FROM ${table}`,
).get() as { count: number }).count);
const agentsBeforeCycle = count("agent_nodes");
const workflowsBeforeCycle = count("workflows");
assert.throws(() => new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: 32,
  now,
  id: deterministicIds("wfl_launch_cycle", ["agt_cycle_a", "agt_cycle_b"]),
}).launch({
  name: "Cycle",
  provider: "mock",
  model: "mock-model",
  nodes: [
    { id: "a", name: "A", message: "A", dependencies: [{ nodeId: "b" }] },
    { id: "b", name: "B", message: "B", dependencies: [{ nodeId: "a" }] },
  ],
}), /acyclic/);
assert.equal(count("agent_nodes"), agentsBeforeCycle, "a rejected graph leaves no Agent identities");
assert.equal(count("workflows"), workflowsBeforeCycle, "a rejected graph leaves no Workflow");
assert.equal(workflowDao.snapshot(userId, "wfl_launch_cycle"), undefined);
console.log("  ✓ invalid graph rolls back the complete launch boundary");

const agentsBeforeConflict = count("agent_nodes");
assert.throws(() => workflowDao.launch({
  id: "wfl_launch_insert_conflict",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  name: "Insert conflict",
  nodes: [
    {
      id: "first",
      name: "First",
      kind: "work",
      payload: { message: "First" },
      effect: "unknown",
      cachePolicy: "none",
      maxAttempts: 1,
      executorAgentId: "agt_insert_first",
    },
    {
      id: "second",
      name: "Second",
      kind: "work",
      payload: { message: "Second" },
      effect: "unknown",
      cachePolicy: "none",
      maxAttempts: 1,
      executorAgentId: "agt_insert_second",
    },
  ],
  edges: [],
  graphSealed: true,
  executors: ["agt_insert_first", "agt_insert_second"].map((id) => ({
    id,
    userId,
    sessionId,
    rootAgentId,
    parentAgentId: rootAgentId,
    path: "/root/duplicate_executor_path",
    label: id,
    provider: "mock",
    model: "mock-model",
    kind: "subagent" as const,
    purpose: "addressable" as const,
    status: "idle" as const,
    createdAt: now(),
  })),
  maxTreeAgents: 32,
  createdAt: now(),
}), /UNIQUE constraint failed/);
assert.equal(agentNodeDao.byId(userId, "agt_insert_first"), undefined);
assert.equal(agentNodeDao.byId(userId, "agt_insert_second"), undefined);
assert.equal(workflowDao.snapshot(userId, "wfl_launch_insert_conflict"), undefined);
assert.equal(count("agent_nodes"), agentsBeforeConflict);
console.log("  ✓ a mid-insert failure rolls back prior executor rows");

const agentsBeforeCapacity = count("agent_nodes");
assert.throws(() => new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: agentsBeforeCapacity,
  now,
  id: deterministicIds("wfl_launch_capacity", ["agt_capacity"]),
}).launch({
  name: "Capacity",
  provider: "mock",
  model: "mock-model",
  nodes: [{ id: "work", name: "Work", message: "Work" }],
}), /Agent tree limit reached/);
assert.equal(count("agent_nodes"), agentsBeforeCapacity);
assert.equal(workflowDao.snapshot(userId, "wfl_launch_capacity"), undefined);
console.log("  ✓ tree capacity is enforced inside the launch transaction");

const dynamicLaunch = new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: 32,
  now,
  id: deterministicIds("wfl_dynamic_launch", ["agt_dynamic_controller"]),
}).launchDynamic({
  name: "Dynamic review",
  controller: {
    name: "Review controller",
    message: "Plan independent checks. Expand the graph. Seal it after the plan is complete.",
  },
  budget: { maxNodes: 8, maxEdges: 16, maxAttempts: 16 },
  provider: "mock",
  model: "mock-model",
  thinkingLevel: "medium",
});
assert.equal(dynamicLaunch.snapshot.workflow.status, "running");
assert.equal(dynamicLaunch.snapshot.workflow.graphSealed, false);
assert.equal(dynamicLaunch.snapshot.workflow.controllerAgentId, "agt_dynamic_controller");
assert.deepEqual(
  dynamicLaunch.snapshot.nodes.map(({ id, kind, status }) => ({ id, kind, status })),
  [{ id: "controller", kind: "controller", status: "ready" }],
);
const controllerDispatch = coordinator.pump(dynamicLaunch.snapshot.workflow.id).dispatches[0];
assert(controllerDispatch, "dynamic controller materializes as the first Task");
let controllerTask = runtimeTaskDao.claim({
  id: controllerDispatch.task.id,
  userId,
  expectedVersion: controllerDispatch.task.version,
  at: now(),
})!;
controllerTask = runtimeTaskDao.transition({
  id: controllerTask.id,
  userId,
  expectedVersion: controllerTask.version,
  expectedLeaseGeneration: controllerTask.leaseGeneration,
  nextStatus: "running",
  activity: "model",
  at: now(),
})!;
const controllerAgent = agentNodeDao.byId(userId, "agt_dynamic_controller")!;
const expansionService = new WorkflowExpansionService({
  userId,
  controllerAgent,
  maxTreeAgents: 32,
});
const controllerTools = createWorkflowTools({
  nodeKind: "controller",
  actor: () => ({
    userId,
    taskId: controllerTask.id,
    taskLeaseGeneration: controllerTask.leaseGeneration,
    expectedWorkflowId: dynamicLaunch.snapshot.workflow.id,
    expectedNodeId: "controller",
    nodeKind: "controller",
  }),
  now,
  expand: (input) => expansionService.expand({
    workflowId: input.workflowId,
    controllerNodeId: input.controllerNodeId,
    actorTaskId: input.actor.taskId,
    actorLeaseGeneration: input.actor.taskLeaseGeneration,
    expectedGraphRevision: input.expectedGraphRevision,
    mutationKey: input.mutationKey,
    nodes: input.nodes,
    edges: input.edges,
    at: input.at,
  }),
});
const expandTool = controllerTools.find((tool) => tool.name === "workflow_expand")!;
assert.equal(
  JSON.stringify(expandTool.parameters).includes("executorAgentId"),
  false,
  "controller schema never exposes runtime Agent ids",
);
const expansionArgs = {
  nodes: [
    {
      id: "inspect",
      name: "Inspect",
      kind: "work",
      payload: { message: "Inspect the implementation." },
      effect: "workspace_read",
      cachePolicy: "none",
      maxAttempts: 1,
      executorAgentId: "agt_model_injected",
    },
    {
      id: "review",
      name: "Review",
      kind: "work",
      payload: { message: "Review the implementation independently." },
      effect: "pure_readonly",
      cachePolicy: "none",
      maxAttempts: 1,
    },
    {
      id: "join",
      name: "Join",
      kind: "join",
      payload: {},
      effect: "pure_readonly",
      cachePolicy: "none",
      maxAttempts: 1,
    },
  ],
  edges: [
    { from: "inspect", to: "join", condition: "success" },
    { from: "review", to: "join", condition: "settled" },
  ],
} as const;
const agentsBeforeExpansion = count("agent_nodes");
await expandTool.execute("tool_dynamic_expand", expansionArgs, new AbortController().signal);
let expanded = workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!;
assert.equal(count("agent_nodes"), agentsBeforeExpansion + 2, "only work nodes receive new Agents");
assert.equal(agentNodeDao.byId(userId, "agt_model_injected"), undefined, "runtime ignores an injected Agent id");
assert.equal(expanded.nodes.find((node) => node.id === "inspect")?.status, "ready");
assert.equal(expanded.nodes.find((node) => node.id === "review")?.status, "ready");
assert.equal(expanded.nodes.find((node) => node.id === "join")?.status, "blocked");
for (const nodeId of ["inspect", "review"] as const) {
  const executorId = expanded.nodes.find((node) => node.id === nodeId)?.executorAgentId;
  assert(executorId && executorId.startsWith("agt_wfx_"));
  const executor = agentNodeDao.byId(userId, executorId);
  assert.equal(executor?.parentAgentId, controllerAgent.id);
  assert.equal(executor?.provider, controllerAgent.provider);
  assert.equal(executor?.model, controllerAgent.model);
}
const graphRevisionAfterExpansion = expanded.workflow.graphRevision;
await expandTool.execute("tool_dynamic_expand", expansionArgs, new AbortController().signal);
expanded = workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!;
assert.equal(expanded.workflow.graphRevision, graphRevisionAfterExpansion);
assert.equal(count("agent_nodes"), agentsBeforeExpansion + 2, "exact Tool replay is idempotent");

const agentsBeforeRejectedExpansion = count("agent_nodes");
await assert.rejects(() => expandTool.execute("tool_dynamic_cycle", {
  nodes: [
    {
      id: "cycle_a",
      name: "Cycle A",
      kind: "work",
      payload: { message: "A" },
      effect: "unknown",
      cachePolicy: "none",
      maxAttempts: 1,
    },
    {
      id: "cycle_b",
      name: "Cycle B",
      kind: "work",
      payload: { message: "B" },
      effect: "unknown",
      cachePolicy: "none",
      maxAttempts: 1,
    },
  ],
  edges: [
    { from: "cycle_a", to: "cycle_b", condition: "success" },
    { from: "cycle_b", to: "cycle_a", condition: "success" },
  ],
}, new AbortController().signal), /acyclic/);
assert.equal(count("agent_nodes"), agentsBeforeRejectedExpansion, "rejected expansion leaves no executor");
assert.equal(
  workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!.nodes.some((node) => node.id === "cycle_a"),
  false,
);
const expandedBeforeCapacity = workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!;
const agentsBeforeExpansionCapacity = count("agent_nodes");
assert.throws(() => new WorkflowExpansionService({
  userId,
  controllerAgent,
  maxTreeAgents: agentsBeforeExpansionCapacity,
}).expand({
  workflowId: dynamicLaunch.snapshot.workflow.id,
  controllerNodeId: "controller",
  actorTaskId: controllerTask.id,
  actorLeaseGeneration: controllerTask.leaseGeneration,
  expectedGraphRevision: expandedBeforeCapacity.workflow.graphRevision,
  mutationKey: "tool_dynamic_capacity",
  nodes: [{
    id: "capacity_rejected",
    name: "Capacity rejected",
    kind: "work",
    payload: { message: "This node must not be admitted." },
    effect: "unknown",
    cachePolicy: "none",
    maxAttempts: 1,
  }],
  edges: [],
  at: now(),
}), /Agent tree limit reached/);
assert.equal(count("agent_nodes"), agentsBeforeExpansionCapacity);
assert.equal(
  workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!.nodes.some((node) =>
    node.id === "capacity_rejected"),
  false,
);
const beforeExpansionInsertConflict = workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!;
const agentsBeforeExpansionInsertConflict = count("agent_nodes");
assert.throws(() => workflowDao.expand({
  workflowId: dynamicLaunch.snapshot.workflow.id,
  userId,
  controllerNodeId: "controller",
  actorTaskId: controllerTask.id,
  actorLeaseGeneration: controllerTask.leaseGeneration,
  expectedGraphRevision: beforeExpansionInsertConflict.workflow.graphRevision,
  nodes: ["a", "b"].map((suffix) => ({
    id: `insert_conflict_${suffix}`,
    name: `Insert conflict ${suffix}`,
    kind: "work" as const,
    payload: { message: suffix },
    effect: "unknown" as const,
    cachePolicy: "none" as const,
    maxAttempts: 1,
    executorAgentId: `agt_dynamic_insert_conflict_${suffix}`,
  })),
  edges: [],
  executors: ["a", "b"].map((suffix) => ({
    id: `agt_dynamic_insert_conflict_${suffix}`,
    userId,
    sessionId,
    rootAgentId,
    parentAgentId: controllerAgent.id,
    path: "/root/dynamic_duplicate_executor_path",
    label: suffix,
    provider: "mock",
    model: "mock-model",
    kind: "subagent" as const,
    purpose: "addressable" as const,
    status: "idle" as const,
    createdAt: now(),
  })),
  maxTreeAgents: 32,
  mutationId: "test-dynamic-insert-conflict",
  at: now(),
}), /UNIQUE constraint failed/);
assert.equal(count("agent_nodes"), agentsBeforeExpansionInsertConflict);
assert.equal(agentNodeDao.byId(userId, "agt_dynamic_insert_conflict_a"), undefined);
assert.equal(
  workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!.nodes.some((node) =>
    node.id.startsWith("insert_conflict_")),
  false,
);
const sealTool = controllerTools.find((tool) => tool.name === "workflow_seal")!;
await sealTool.execute("tool_dynamic_seal", {}, new AbortController().signal);
assert.equal(workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!.workflow.graphSealed, true);
const dynamicLiveBeforeSettlement = agentNodeDao.countNonClosedByRoot(userId, rootAgentId);
assert.ok(workflowDao.settleExecution({
  id: "result_dynamic_controller",
  taskId: controllerTask.id,
  userId,
  summary: "Controller sealed the graph",
  body: {},
  artifacts: [],
  expectedTaskVersion: controllerTask.version,
  expectedLeaseGeneration: controllerTask.leaseGeneration,
  nextStatus: "succeeded",
  eventType: "worker:succeeded",
  eventPayload: {},
  createdAt: now(),
}));
const dynamicWork = coordinator.pump(dynamicLaunch.snapshot.workflow.id).dispatches;
assert.deepEqual(dynamicWork.map((dispatch) => dispatch.node.id).sort(), ["inspect", "review"]);
for (const [index, dispatch] of dynamicWork.entries()) {
  let task = runtimeTaskDao.claim({
    id: dispatch.task.id,
    userId,
    expectedVersion: dispatch.task.version,
    at: now(),
  })!;
  task = runtimeTaskDao.transition({
    id: task.id,
    userId,
    expectedVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "running",
    at: now(),
  })!;
  const settled = workflowDao.settleExecution({
    id: `result_dynamic_${dispatch.node.id}`,
    taskId: task.id,
    userId,
    summary: `Completed ${dispatch.node.id}`,
    body: {},
    artifacts: [],
    expectedTaskVersion: task.version,
    expectedLeaseGeneration: task.leaseGeneration,
    nextStatus: "succeeded",
    eventType: "worker:succeeded",
    eventPayload: {},
    createdAt: now(),
  })!;
  if (index === 0) {
    assert.notEqual(settled.snapshot.workflow.status, "succeeded");
    assert.equal(agentNodeDao.byId(userId, controllerAgent.id)?.status, "idle");
    const idleController = agentNodeDao.byId(userId, controllerAgent.id)!;
    assert.throws(() => agentNodeDao.transitionStatus({
      id: idleController.id,
      userId,
      expectedVersion: idleController.version,
      nextStatus: "closed",
      at: now(),
    }), /Active Workflow still uses this executor Agent/);
  }
}
const settledDynamic = workflowDao.snapshot(userId, dynamicLaunch.snapshot.workflow.id)!;
assert.equal(settledDynamic.workflow.status, "succeeded");
assert.ok(settledDynamic.nodes.every((node) => node.status === "succeeded"));
const dynamicExecutorIds = settledDynamic.nodes.flatMap((node) =>
  node.executorAgentId === undefined ? [] : [node.executorAgentId]);
assert.deepEqual(
  dynamicExecutorIds.map((agentId) => agentNodeDao.byId(userId, agentId)?.status),
  ["closed", "closed", "closed"],
);
assert.equal(
  agentNodeDao.countNonClosedByRoot(userId, rootAgentId),
  dynamicLiveBeforeSettlement - dynamicExecutorIds.length,
);
console.log("  ✓ dynamic controller expands, seals, completes, and retires its full executor pool");

const liveAgentsBeforeReclamation = agentNodeDao.countNonClosedByRoot(userId, rootAgentId);
const reclamationLimit = liveAgentsBeforeReclamation + 1;
const reclamationLaunch = new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: reclamationLimit,
  now,
  id: deterministicIds("wfl_reclamation", ["agt_reclamation"]),
}).launch({
  name: "Reclaim one executor",
  provider: "mock",
  model: "mock-model",
  nodes: [{ id: "finish", name: "Finish", message: "Complete the bounded task." }],
});
assert.equal(
  Number((db.prepare(
    "SELECT COUNT(*) AS count FROM workflow_managed_executors WHERE workflow_id = ? AND retired_at IS NULL",
  ).get(reclamationLaunch.snapshot.workflow.id) as { count: number }).count),
  1,
  "the launch transaction records managed executor ownership",
);
assert.throws(() => runtimeTaskDao.create({
  id: "task_reclamation_forged_followup",
  userId,
  sessionId,
  ownerSessionId: sessionId,
  agentId: "agt_reclamation",
  kind: "delegation",
  title: "Do not escape the Workflow",
  payload: { message: "This must stay outside the executor FIFO." },
  awaitPolicy: "background",
  cancelPolicy: "detached",
  checkpointSafe: false,
  createdAt: now(),
}), /accepts only its owning Workflow Tasks/);
assert.throws(() => workflowDao.create({
  id: "wfl_reclamation_escape",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  name: "Do not share a managed executor",
  nodes: [{
    id: "escape",
    name: "Escape",
    kind: "work",
    payload: { message: "This graph must not reuse the managed Agent." },
    effect: "unknown",
    cachePolicy: "none",
    maxAttempts: 1,
    executorAgentId: "agt_reclamation",
  }],
  edges: [],
  createdAt: now(),
}), /invalid Workflow executor Agent/);
assert.equal(workflowDao.snapshot(userId, "wfl_reclamation_escape"), undefined);
const reclamationDispatch = coordinator.pump(reclamationLaunch.snapshot.workflow.id).dispatches[0]!;
let reclamationTask = runtimeTaskDao.claim({
  id: reclamationDispatch.task.id,
  userId,
  expectedVersion: reclamationDispatch.task.version,
  at: now(),
})!;
reclamationTask = runtimeTaskDao.transition({
  id: reclamationTask.id,
  userId,
  expectedVersion: reclamationTask.version,
  expectedLeaseGeneration: reclamationTask.leaseGeneration,
  nextStatus: "running",
  at: now(),
})!;
const runningReclamationAgent = agentNodeDao.byId(userId, "agt_reclamation")!;
assert.ok(agentNodeDao.transitionStatus({
  id: runningReclamationAgent.id,
  userId,
  expectedVersion: runningReclamationAgent.version,
  nextStatus: "running",
  at: now(),
}));
const reclamationSettlement = workflowDao.settleExecution({
  id: "result_reclamation",
  taskId: reclamationTask.id,
  userId,
  summary: "Executor completed",
  body: { ok: true },
  artifacts: [],
  expectedTaskVersion: reclamationTask.version,
  expectedLeaseGeneration: reclamationTask.leaseGeneration,
  nextStatus: "succeeded",
  eventType: "worker:succeeded",
  eventPayload: {},
  createdAt: now(),
})!;
assert.equal(reclamationSettlement.snapshot.workflow.status, "succeeded");
assert.equal(agentNodeDao.byId(userId, "agt_reclamation")?.status, "closed");
assert.equal(
  agentNodeDao.countNonClosedByRoot(userId, rootAgentId),
  liveAgentsBeforeReclamation,
  "a settled Workflow releases its live tree slot",
);
assert.ok(
  agentNodeDao.roster(userId, rootAgentId)?.nodes.some((agent) =>
    agent.id === "agt_reclamation" && agent.status === "closed"),
  "the closed executor remains in the durable inspector roster",
);
assert.ok(
  (db.prepare(
    "SELECT retired_at FROM workflow_managed_executors WHERE workflow_id = ? AND agent_id = ?",
  ).get(reclamationLaunch.snapshot.workflow.id, "agt_reclamation") as { retired_at: number | null }).retired_at,
);

const cancelledLaunch = new WorkflowLaunchService({
  userId,
  sessionId,
  rootAgentId,
  maxTreeAgents: reclamationLimit,
  now,
  id: deterministicIds("wfl_reclamation_cancel", ["agt_reclamation_cancel"]),
}).launch({
  name: "Cancel before dispatch",
  provider: "mock",
  model: "mock-model",
  nodes: [{ id: "cancel", name: "Cancel", message: "This Task will not start." }],
});
const cancelled = workflowDao.cancel(
  userId,
  cancelledLaunch.snapshot.workflow.id,
  cancelledLaunch.snapshot.workflow.version,
  now(),
)!;
assert.equal(cancelled.workflow.status, "cancelled");
assert.equal(agentNodeDao.byId(userId, "agt_reclamation_cancel")?.status, "closed");
assert.equal(agentNodeDao.countNonClosedByRoot(userId, rootAgentId), liveAgentsBeforeReclamation);

const callerOwnedAgent = agentNodeDao.create({
  id: "agt_caller_owned_workflow",
  userId,
  sessionId,
  rootAgentId,
  parentAgentId: rootAgentId,
  path: "/root/caller_owned_workflow",
  label: "Caller owned",
  provider: "mock",
  model: "mock-model",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const callerOwnedDraft = workflowDao.create({
  id: "wfl_caller_owned",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  name: "Caller-owned executor",
  nodes: [{
    id: "work",
    name: "Work",
    kind: "work",
    payload: { message: "Use the existing Agent." },
    effect: "unknown",
    cachePolicy: "none",
    maxAttempts: 1,
    executorAgentId: callerOwnedAgent.id,
  }],
  edges: [],
  createdAt: now(),
});
const callerOwnedStarted = workflowDao.start(
  userId,
  callerOwnedDraft.workflow.id,
  callerOwnedDraft.workflow.version,
  now(),
)!;
const callerOwnedDispatch = coordinator.pump(callerOwnedStarted.workflow.id).dispatches[0]!;
let callerOwnedTask = runtimeTaskDao.claim({
  id: callerOwnedDispatch.task.id,
  userId,
  expectedVersion: callerOwnedDispatch.task.version,
  at: now(),
})!;
callerOwnedTask = runtimeTaskDao.transition({
  id: callerOwnedTask.id,
  userId,
  expectedVersion: callerOwnedTask.version,
  expectedLeaseGeneration: callerOwnedTask.leaseGeneration,
  nextStatus: "running",
  at: now(),
})!;
assert.equal(workflowDao.settleExecution({
  id: "result_caller_owned",
  taskId: callerOwnedTask.id,
  userId,
  summary: "Caller-owned Agent completed",
  body: {},
  artifacts: [],
  expectedTaskVersion: callerOwnedTask.version,
  expectedLeaseGeneration: callerOwnedTask.leaseGeneration,
  nextStatus: "succeeded",
  eventType: "worker:succeeded",
  eventPayload: {},
  createdAt: now(),
})?.snapshot.workflow.status, "succeeded");
assert.equal(agentNodeDao.byId(userId, callerOwnedAgent.id)?.status, "idle");
assert.equal(
  Number((db.prepare(
    "SELECT COUNT(*) AS count FROM workflow_managed_executors WHERE workflow_id = ?",
  ).get(callerOwnedDraft.workflow.id) as { count: number }).count),
  0,
);
console.log("  ✓ terminal launch executors retire while caller-owned Workflow Agents remain open");

let toolInput: unknown;
const withoutRunner = createTools({} as never);
assert.equal(withoutRunner.some((tool) => tool.name === "run_workflow"), false);
const withRunner = createTools({} as never, undefined, undefined, undefined, {
  run(input) {
    toolInput = input;
    return "started";
  },
});
const runWorkflow = withRunner.find((tool) => tool.name === "run_workflow");
assert(runWorkflow);
await assert.rejects(
  runWorkflow.execute("step_missing_workflow_body", { name: "Missing body" }),
  /requires nodes or one controller/,
);
await runWorkflow.execute("step_noisy_dynamic_workflow", {
  name: "Noisy dynamic body",
  nodes: [{ id: "stray", name: "Stray", message: "Must be ignored" }],
  controller: { name: "Controller", message: "Build the graph" },
});
assert.deepEqual(toolInput, {
  name: "Noisy dynamic body",
  controller: { name: "Controller", message: "Build the graph" },
}, "an explicit controller normalizes noisy model output to one dynamic launch");
const toolResult = await runWorkflow.execute("step_workflow", {
  name: "Tool launch",
  nodes: [{
    id: "first",
    name: "First",
    message: "Do the first task.",
    dependencies: [{ node_id: "upstream", condition: "settled" }],
    effect: "workspace_read",
    max_attempts: 3,
  }],
  budget: { max_runtime_minutes: 10, max_tokens: 50_000, max_cost_usd: 2.5 },
});
assert.equal(toolResult.content[0]?.type, "text");
assert.deepEqual(toolInput, {
  name: "Tool launch",
  nodes: [{
    id: "first",
    name: "First",
    message: "Do the first task.",
    dependencies: [{ nodeId: "upstream", condition: "settled" }],
    effect: "workspace_read",
    maxAttempts: 3,
  }],
  budget: { maxRuntimeMs: 600_000, maxTokens: 50_000, maxCostMicros: 2_500_000 },
});
await runWorkflow.execute("step_dynamic_workflow", {
  name: "Dynamic Tool launch",
  controller: {
    name: "Controller",
    message: "Build the graph and seal it.",
    max_attempts: 2,
  },
  budget: { max_nodes: 8, max_edges: 24, max_depth: 4, max_attempts: 12 },
});
assert.deepEqual(toolInput, {
  name: "Dynamic Tool launch",
  controller: {
    name: "Controller",
    message: "Build the graph and seal it.",
    maxAttempts: 2,
  },
  budget: { maxNodes: 8, maxEdges: 24, maxDepth: 4, maxAttempts: 12 },
});
console.log("  ✓ only the root runner exposes one normalized high-level Tool");

console.log("workflow launch checks passed");
