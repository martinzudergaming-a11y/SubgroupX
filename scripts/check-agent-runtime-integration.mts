import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOrchestrationRunner } from "../server/src/runtime/tools.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-runtime-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://127.0.0.1:1/v1";
process.env.AGENT_WEB_JAIL_KEY = "fixture-key";
process.env.AGENT_WEB_JAIL_MODEL = "operator-model";

const [{ AgentSessionRuntime }, persistence, providers, { orchestrationReadModel }] = await Promise.all([
  import("../server/src/runtime/agent-session.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/runtime/providers.ts"),
  import("../server/src/orchestration/read-model.ts"),
]);
providers.registerMockProvider();

const {
  agentMessageDao,
  agentNodeDao,
  agentTaskDao,
  agentTurnDao,
  runtimeTaskDao,
  sessionDao,
  taskResultDao,
  taskResultDeliveryDao,
  messageDao,
  userDao,
  db,
} = persistence;

const userId = "user_agent_runtime";
const sessionId = "session_agent_runtime";
const now = Date.now();
userDao.create({
  id: userId,
  email: "agent-runtime@example.invalid",
  password_hash: "x",
  created_at: now,
});
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "Agent runtime contract",
  provider: providers.MOCK_PROVIDER,
  model: providers.MOCK_MODEL_ID,
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
  created_at: now,
  updated_at: now,
});

type RuntimeSeam = {
  createAgentOrchestrationRunner(parentAgentId?: string): AgentOrchestrationRunner;
  promptWithAgentRoster(base: string): Promise<string>;
  runSubagent(parentToolCallId: string, task: string, signal?: AbortSignal): Promise<string>;
  currentTurnId: string | null;
};

function seam(runtime: InstanceType<typeof AgentSessionRuntime>): RuntimeSeam {
  return runtime as unknown as RuntimeSeam;
}

async function until<T>(read: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rootId(): string {
  return agentNodeDao.listBySession(userId, sessionId, { limit: 100 })
    .find((agent) => agent.id === agent.rootAgentId)!.id;
}

function agentAt(agentPath: string) {
  return agentNodeDao.listBySession(userId, sessionId, { limit: 100 })
    .find((agent) => agent.path === agentPath);
}

function latestTask(agentId: string) {
  return runtimeTaskDao.listBySession(userId, sessionId, { limit: 100 })
    .filter((task) => task.agentId === agentId)
    .sort((left, right) => right.agentOrd - left.agentOrd)[0];
}

let runtime = new AgentSessionRuntime(sessionDao.byId(sessionId)!);
const firstIdle: string[] = [];
const accountEvents: Array<{ type: string; status?: string; activity?: string; kind?: string }> = [];
runtime.onBackgroundIdle = () => firstIdle.push("idle");
runtime.onWake = (event) => accountEvents.push(event);

let changedModelAtToolBoundary = false;
const stopBoundaryWatch = runtime.subscribe((event) => {
  if (
    !changedModelAtToolBoundary
    && event.type === "agent_event"
    && event.event.t === "assistant_end"
    && event.event.blocks.some((block) => block.type === "toolCall" && block.name === "spawn_agent")
  ) {
    changedModelAtToolBoundary = true;
    sessionDao.setModel(sessionId, providers.JAIL_PROVIDER, "operator-model");
  }
});
await runtime.sendMessage("/agent probe\n/bash sleep 0.4; printf child-ok");
stopBoundaryWatch();
assert.equal(changedModelAtToolBoundary, true);
const probe = await until(() => agentAt("/root/probe"), "spawn_agent creates a durable Agent");
assert.equal(runtime.getStatus(), "idle", "foreground Turn is independently idle");
assert.equal(runtime.hasBackgroundTasks(), true, "slow detached Task remains runnable");
assert.equal(accountEvents.filter((event) => event.type === "session_wake" && event.kind === "done").length, 0);
assert.equal(accountEvents.filter((event) => event.type === "session_activity").at(-1)?.activity, "running");
assert.equal(accountEvents.filter((event) => event.type === "session_status").at(-1)?.status, "idle");
sessionDao.setModel(sessionId, providers.MOCK_PROVIDER, providers.MOCK_MODEL_ID);
const probeTask = await until(() => {
  const task = latestTask(probe.id);
  return task && ["succeeded", "failed"].includes(task.status) ? task : undefined;
}, "Child Agent completes its real pi Turn");
assert.equal(probeTask.status, "succeeded");
assert.match(taskResultDao.byTask(userId, probeTask.id)?.summary ?? "", /ran `sleep 0\.4; printf child-ok`/);
assert.equal(probe.provider, providers.MOCK_PROVIDER);
assert.equal(probe.model, providers.MOCK_MODEL_ID);
assert.equal(probe.thinkingLevel, "medium");
assert.ok(agentMessageDao.load(userId, probe.id)!.messages.length >= 2);
assert.equal(firstIdle.length, 1);
assert.equal(accountEvents.filter((event) => event.type === "session_wake" && event.kind === "done").length, 1);
assert.equal(accountEvents.filter((event) => event.type === "session_activity").at(-1)?.activity, "idle");
assert.ok(runtime.getTimeline().some((item) => item.kind === "tool" && item.name === "spawn_agent" && item.status === "success"));
console.log("  ✓ root Tool call returns immediately while a real pi Child Agent completes in background");

assert.equal(agentNodeDao.roster(userId, rootId())!.tasks.find((task) => task.id === probeTask.id)?.unreadResult, true);
const foreignControllerSessionId = "session_agent_runtime_foreign_controller";
sessionDao.create({
  ...sessionDao.byId(sessionId)!,
  id: foreignControllerSessionId,
  title: "Foreign controller",
  status: "idle",
  created_at: now + 1,
  updated_at: now + 1,
});
const foreignController = agentNodeDao.create({
  id: "agent_runtime_foreign_controller",
  userId,
  sessionId: foreignControllerSessionId,
  rootAgentId: "agent_runtime_foreign_controller",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now + 1,
});
db.prepare(
  `INSERT INTO workflows
    (id, user_id, owner_session_id, root_agent_id, name, status,
     version, created_at, updated_at)
   VALUES ('workflow_runtime_hidden', ?, ?, ?, 'Hidden Workflow', 'running', 1, ?, ?)`,
).run(userId, foreignControllerSessionId, foreignController.id, now + 2, now + 2);
db.prepare(
  `INSERT INTO runtime_tasks
    (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
     agent_id, agent_ord, parent_task_id, workflow_id, kind, title, payload_json,
     payload_bytes, status, await_policy, cancel_policy, checkpoint_safe,
     activity, wait_reason, lease_generation, version, created_at, updated_at,
     started_at, settled_at)
   VALUES ('task_runtime_hidden', ?, ?, ?, NULL, NULL, ?, 99, NULL,
     'workflow_runtime_hidden', 'workflow_node', 'HIDDEN_TASK_TITLE', '{}', 2,
     'succeeded', 'background', 'detached', 0, NULL, NULL, 0, 1, ?, ?, ?, ?)`,
).run(userId, sessionId, sessionId, probe.id, now + 3, now + 3, now + 3, now + 3);
db.prepare(
  `INSERT INTO task_results
    (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
   VALUES ('result_runtime_hidden', 'task_runtime_hidden', 'HIDDEN_SUMMARY', '{}', '{}', 1, ?, NULL)`,
).run(now + 3);
assert.doesNotMatch(
  await seam(runtime).promptWithAgentRoster("MODEL_CAPSULE"),
  /HIDDEN_TASK_TITLE|HIDDEN_SUMMARY/,
  "the model capsule rejects a same-user Workflow from another Agent root",
);
const deliveryStepId = "tc_result_delivery_probe";
const probeDetail = await seam(runtime).createAgentOrchestrationRunner().get({
  target: probe.path,
  ownerStepId: deliveryStepId,
});
assert.match(probeDetail, /result: .*printf child-ok/s);
assert.doesNotMatch(probeDetail, /HIDDEN_TASK_TITLE|HIDDEN_SUMMARY/);
assert.equal(
  agentNodeDao.roster(userId, rootId())!.tasks.find((task) => task.id === probeTask.id)?.unreadResult,
  true,
  "reading inside get_agent only stages acknowledgement",
);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 1);
const runtimeDelivery = runtime as unknown as {
  nextSeq(): number;
  toolItems: Map<string, any>;
  onAgentEvent(event: any, signal: AbortSignal): Promise<void>;
};
runtimeDelivery.toolItems.set(deliveryStepId, {
  kind: "tool",
  id: deliveryStepId,
  seq: runtimeDelivery.nextSeq(),
  name: "get_agent",
  toolKind: "subagent",
  arguments: { target: probe.path },
  status: "running",
  ts: Date.now(),
});
await runtimeDelivery.onAgentEvent({
  type: "tool_execution_end",
  toolCallId: deliveryStepId,
  result: { content: [{ type: "text", text: probeDetail }], details: {} },
  isError: false,
}, new AbortController().signal);
assert.equal(
  agentNodeDao.roster(userId, rootId())!.tasks.find((task) => task.id === probeTask.id)?.unreadResult,
  true,
  "Timeline Step success does not acknowledge before root model context is durable",
);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 1);
messageDao.replaceAll(sessionId, [{
  role: "toolResult",
  toolCallId: deliveryStepId,
  toolName: "get_agent",
  content: [{ type: "text", text: probeDetail }],
  details: {},
  isError: false,
  timestamp: Date.now(),
}]);
taskResultDeliveryDao.commitPersisted(userId, sessionId, Date.now());
assert.equal(agentNodeDao.roster(userId, rootId())!.tasks.find((task) => task.id === probeTask.id)?.unreadResult, false);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 0);
console.log("  ✓ get_agent acknowledges only after its parent Step result is durable");

const privateTurnId = "turn_private_join_delivery";
agentTurnDao.start({
  id: privateTurnId,
  sessionId,
  startedAt: Date.now(),
  provider: providers.MOCK_PROVIDER,
  model: providers.MOCK_MODEL_ID,
});
seam(runtime).currentTurnId = privateTurnId;
const taskForStep = (stepId: string) => runtimeTaskDao.listByOwner(userId, {
  ownerSessionId: sessionId,
  ownerTurnId: privateTurnId,
  ownerStepId: stepId,
  limit: 8,
}).find((task) => ["succeeded", "failed", "cancelled", "interrupted"].includes(task.status));
const recordJoinedToolStart = async (stepId: string): Promise<void> => {
  await runtimeDelivery.onAgentEvent({
    type: "tool_execution_start",
    toolCallId: stepId,
    toolName: "spawn_subagent",
    args: { task: "private joined probe" },
  }, new AbortController().signal);
};
const recordJoinedToolEnd = async (stepId: string, text: string, isError: boolean): Promise<void> => {
  await runtimeDelivery.onAgentEvent({
    type: "tool_execution_end",
    toolCallId: stepId,
    result: { content: [{ type: "text", text }], details: {} },
    isError,
  }, new AbortController().signal);
};
const persistJoinedToolResult = (stepId: string, text: string, isError: boolean): void => {
  messageDao.replaceAll(sessionId, [
    ...messageDao.list(sessionId),
    {
      role: "toolResult",
      toolCallId: stepId,
      toolName: "spawn_subagent",
      content: [{ type: "text", text }],
      details: {},
      isError,
      timestamp: Date.now(),
    },
  ]);
};
const activityBeforePrivateJoin = runtimeTaskDao.terminalOutcomeByRoot(userId, rootId());
const errorWakesBeforePrivateJoin = accountEvents.filter(
  (event) => event.type === "session_wake" && event.kind === "error",
).length;

const privateSuccessStep = "tc_private_join_success";
await recordJoinedToolStart(privateSuccessStep);
const privateSuccessText = await seam(runtime).runSubagent(
  privateSuccessStep,
  "/bash printf private-joined-ok",
);
const privateSuccessTask = taskForStep(privateSuccessStep)!;
const privateSuccessResult = taskResultDao.byTask(userId, privateSuccessTask.id)!;
assert.equal(privateSuccessTask.status, "succeeded");
assert.equal(privateSuccessResult.acknowledgedAt, undefined);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 1);
assert.equal(
  orchestrationReadModel.taskDetail(userId, privateSuccessTask.id),
  undefined,
  "private joined Tasks stay outside the HTTP read model",
);
await recordJoinedToolEnd(privateSuccessStep, privateSuccessText, false);
taskResultDeliveryDao.commitPersisted(userId, sessionId, Date.now());
assert.equal(
  taskResultDao.byTask(userId, privateSuccessTask.id)?.acknowledgedAt,
  undefined,
  "Timeline success is not the parent transcript commit boundary",
);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 1);
assert.deepEqual(
  runtimeTaskDao.terminalOutcomeByRoot(userId, rootId()),
  activityBeforePrivateJoin,
  "private unread state never enters account Activity",
);
persistJoinedToolResult(privateSuccessStep, privateSuccessText, false);
taskResultDeliveryDao.commitPersisted(userId, sessionId, Date.now());
assert.ok(taskResultDao.byTask(userId, privateSuccessTask.id)?.acknowledgedAt);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 0);

const privateFailureStep = "tc_private_join_failure";
let privateFailureText = "";
process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "1";
try {
  await recordJoinedToolStart(privateFailureStep);
  await seam(runtime).runSubagent(
    privateFailureStep,
    "/write private-joined-failure.txt\nnot-persisted",
  );
  assert.fail("private joined provider failure must reject its parent Tool");
} catch (error) {
  privateFailureText = error instanceof Error ? error.message : String(error);
} finally {
  delete process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR;
}
const privateFailureTask = taskForStep(privateFailureStep)!;
assert.equal(privateFailureTask.status, "failed");
assert.equal(taskResultDao.byTask(userId, privateFailureTask.id)?.acknowledgedAt, undefined);
await recordJoinedToolEnd(privateFailureStep, privateFailureText, true);
assert.equal(
  taskResultDeliveryDao.countPending(userId, rootId()),
  1,
  "a joined error ToolResult preserves its opt-in delivery stage",
);
assert.deepEqual(runtimeTaskDao.terminalOutcomeByRoot(userId, rootId()), activityBeforePrivateJoin);
persistJoinedToolResult(privateFailureStep, privateFailureText, true);
taskResultDeliveryDao.commitPersisted(userId, sessionId, Date.now());
assert.ok(taskResultDao.byTask(userId, privateFailureTask.id)?.acknowledgedAt);
assert.equal(taskResultDeliveryDao.countPending(userId, rootId()), 0);

const privateRecoveryStep = "tc_private_join_recovery";
await recordJoinedToolStart(privateRecoveryStep);
const privateRecoveryText = await seam(runtime).runSubagent(
  privateRecoveryStep,
  "/bash printf private-joined-recovered",
);
const privateRecoveryTask = taskForStep(privateRecoveryStep)!;
await recordJoinedToolEnd(privateRecoveryStep, privateRecoveryText, false);
persistJoinedToolResult(privateRecoveryStep, privateRecoveryText, false);
taskResultDeliveryDao.commitPersisted(userId, sessionId, Date.now());
assert.ok(taskResultDao.byTask(userId, privateRecoveryTask.id)?.acknowledgedAt);
assert.deepEqual(
  runtimeTaskDao.terminalOutcomeByRoot(userId, rootId()),
  activityBeforePrivateJoin,
  "a failed private slot cannot leave account Activity in error",
);
assert.equal(
  accountEvents.filter((event) => event.type === "session_wake" && event.kind === "error").length,
  errorWakesBeforePrivateJoin,
  "private failure cannot publish a background error wake",
);
agentTurnDao.complete(sessionId, privateTurnId, "completed", Date.now());
seam(runtime).currentTurnId = null;
console.log("  ✓ private joined Results ACK only after durable parent delivery and never pollute Activity");

const promptBefore = await seam(runtime).promptWithAgentRoster("BASE");
const revisionBefore = agentNodeDao.roster(userId, rootId())!.revision;
await runtime.sendMessage("ordinary foreground turn");
assert.equal(agentNodeDao.roster(userId, rootId())!.revision, revisionBefore);
assert.equal(await seam(runtime).promptWithAgentRoster("BASE"), promptBefore);
console.log("  ✓ ordinary Session Turns keep Agent capsule bytes and revision stable");

const rootRunner = seam(runtime).createAgentOrchestrationRunner();
await rootRunner.spawn({
  taskName: "parent",
  message: "/bash sleep 0.4; printf PARENT_SECRET",
  context: "none",
});
const parent = await until(() => agentAt("/root/parent"), "parent Agent exists");
const parentTask = await until(() => {
  const task = latestTask(parent.id);
  return task?.status === "running" && task.activity === "tool:shell" ? task : undefined;
}, "parent shell is live");
const parentRunner = seam(runtime).createAgentOrchestrationRunner(parent.id);
await parentRunner.spawn({
  taskName: "grandchild",
  message: "/bash printf grandchild-ok",
  context: "recent",
});
const grandchild = await until(() => agentAt("/root/parent/grandchild"), "nested Agent path");
const grandchildTask = await until(() => {
  const task = latestTask(grandchild.id);
  return task && ["succeeded", "failed"].includes(task.status) ? task : undefined;
}, "nested Agent completes");
assert.equal(grandchild.parentAgentId, parent.id);
assert.equal(grandchildTask.parentTaskId, parentTask.id);
assert.match(JSON.stringify(agentMessageDao.load(userId, grandchild.id)?.messages), /PARENT_SECRET/);
await until(() => latestTask(parent.id)?.status === "succeeded" ? true : undefined, "parent completes");
await until(() => firstIdle.length >= 2 ? true : undefined, "nested batch publishes one idle edge");
console.log("  ✓ child→grandchild keeps path/Task lineage and a bounded live-context handoff");

runtime.close();
await new Promise((resolve) => setTimeout(resolve, 20));
sessionDao.setModel(sessionId, providers.JAIL_PROVIDER, "operator-model");
runtime = new AgentSessionRuntime(sessionDao.byId(sessionId)!);
const rebuiltIdle: string[] = [];
runtime.onBackgroundIdle = () => rebuiltIdle.push("idle");
await seam(runtime).createAgentOrchestrationRunner().followUp({
  target: probe.path,
  message: "/bash printf followup-ok",
});
const followUp = await until(() => {
  const task = latestTask(probe.id);
  return task && task.id !== probeTask.id && ["succeeded", "failed"].includes(task.status) ? task : undefined;
}, "pinned Child resumes after runtime rebuild");
assert.equal(followUp.status, "succeeded");
assert.match(taskResultDao.byTask(userId, followUp.id)?.summary ?? "", /ran `printf followup-ok`/);
const restoredProbe = agentNodeDao.byId(userId, probe.id)!;
assert.deepEqual(
  [restoredProbe.provider, restoredProbe.model, restoredProbe.thinkingLevel],
  [providers.MOCK_PROVIDER, providers.MOCK_MODEL_ID, "medium"],
);
assert.equal(rebuiltIdle.length, 1);
console.log("  ✓ runtime rebuild and root model change do not silently migrate a Child transcript");

runtime.close();
await new Promise((resolve) => setTimeout(resolve, 20));
const addressableFailure = agentTaskDao.create({
  agent: {
    id: "agent_runtime_addressable_failure",
    userId,
    sessionId,
    rootAgentId: rootId(),
    parentAgentId: rootId(),
    path: "/root/addressable_failure",
    provider: providers.MOCK_PROVIDER,
    model: providers.MOCK_MODEL_ID,
    kind: "subagent",
    status: "idle",
    createdAt: Date.now(),
  },
  task: {
    id: "task_runtime_addressable_failure",
    userId,
    sessionId,
    ownerSessionId: sessionId,
    agentId: "agent_runtime_addressable_failure",
    kind: "delegation",
    title: "Addressable failure",
    payload: { message: "failure", context: "none" },
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: Date.now(),
  },
  initialMessages: [],
});
const claimedAddressableFailure = runtimeTaskDao.claim({
  id: addressableFailure.task.id,
  userId,
  expectedVersion: addressableFailure.task.version,
  at: Date.now(),
})!;
const runningAddressableFailure = runtimeTaskDao.transition({
  id: claimedAddressableFailure.id,
  userId,
  expectedVersion: claimedAddressableFailure.version,
  expectedLeaseGeneration: claimedAddressableFailure.leaseGeneration,
  nextStatus: "running",
  at: Date.now(),
})!;
assert.ok(taskResultDao.settle({
  id: "result_runtime_addressable_failure",
  taskId: runningAddressableFailure.id,
  userId,
  expectedTaskVersion: runningAddressableFailure.version,
  expectedLeaseGeneration: runningAddressableFailure.leaseGeneration,
  nextStatus: "failed",
  summary: "Addressable background failure",
  body: {},
  artifacts: [],
  createdAt: Date.now(),
}));
assert.deepEqual(runtimeTaskDao.terminalOutcomeByRoot(userId, rootId()), {
  unreadFailure: true,
  latestStatus: "failed",
});
assert.ok(
  orchestrationReadModel.activity(userId, { limit: 100 }).items
    .some((item) => item.task.id === addressableFailure.task.id),
  "addressable background failure remains visible in account Activity",
);
console.log("  ✓ addressable background failure remains an Activity error");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Agent runtime integration contract passed.");
