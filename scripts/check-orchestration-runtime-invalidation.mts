import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-invalidation-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const express = (await import("express")).default;
const [
  { createApiRouter },
  auth,
  persistence,
  { WorkflowCoordinator },
  { WorkflowScheduler },
  { createWorkflowTools },
  { AgentSupervisor },
  { TeamCoordinator },
  { TeamTurnExecutor },
  { sessionManager },
  { attachRuntimeStreamHost },
  { RuntimeStreamClient },
  providers,
  browserInvalidation,
] = await Promise.all([
  import("../server/src/http/api.ts"),
  import("../server/src/identity/auth.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/orchestration/workflow-engine.ts"),
  import("../server/src/orchestration/workflow-scheduler.ts"),
  import("../server/src/orchestration/workflow-tools.ts"),
  import("../server/src/orchestration/agent-supervisor.ts"),
  import("../server/src/orchestration/team-coordinator.ts"),
  import("../server/src/orchestration/team-turn-executor.ts"),
  import("../server/src/runtime/manager.ts"),
  import("../server/src/runtime/runtime-stream-host.ts"),
  import("../server/src/runtime/runtime-stream-client.ts"),
  import("../server/src/runtime/providers.ts"),
  import("../web/src/orchestration/invalidation-store.ts"),
]);
providers.registerMockProvider();

const {
  agentNodeDao,
  agentTurnDao,
  runtimeTaskDao,
  sessionDao,
  teamTurnOutcomeDao,
  userDao,
  workflowDao,
} = persistence;
const userId = "user_runtime_invalidation";
const email = "runtime-invalidation@example.invalid";
let clock = 2_200_000_000_000;
let serial = 0;
const now = () => ++clock;
const id = (kind: string) => `${kind}_runtime_invalidation_${++serial}`;

userDao.create({ id: userId, email, password_hash: "x", created_at: now() });
function createSession(sessionId: string, title: string): string {
  sessionDao.create({
    id: sessionId,
    user_id: userId,
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
    cwd: ".",
    created_at: now(),
    updated_at: clock,
  });
  const rootId = `agent_${sessionId}`;
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
  return rootId;
}

const ownerSessionId = "session_runtime_invalidation_owner";
const memberSessionId = "session_runtime_invalidation_member";
const ownerRootId = createSession(ownerSessionId, "Owner session");
createSession(memberSessionId, "Member session");
const workflowAgentId = "agent_runtime_invalidation_workflow";
agentNodeDao.create({
  id: workflowAgentId,
  userId,
  sessionId: ownerSessionId,
  rootAgentId: ownerRootId,
  parentAgentId: ownerRootId,
  path: "/root/workflow",
  provider: "mock",
  model: "mock-coder",
  thinkingLevel: "medium",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});

const app = express();
app.use("/api", createApiRouter());
const apiServer = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => apiServer.once("listening", resolve));
const apiAddress = apiServer.address();
if (!apiAddress || typeof apiAddress === "string") throw new Error("API fixture did not bind TCP");
const token = auth.issueToken({ id: userId, email });
async function api(route: string): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api${route}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `${route} must remain readable after invalidation`);
  return await response.json() as Record<string, any>;
}

const socket = path.join(tmp, "runtime.sock");
const streamServer = http.createServer();
const streamWss = attachRuntimeStreamHost(streamServer);
await new Promise<void>((resolve) => streamServer.listen(socket, () => resolve()));
const wireEvents: any[] = [];
const stream = new RuntimeStreamClient({
  socketPath: socket,
  onEvent: (event) => {
    wireEvents.push(event);
    if (event.type === "orchestration_invalidated") {
      browserInvalidation.publishOrchestrationInvalidation(event);
    } else if (event.type === "orchestration_invalidation_snapshot") {
      browserInvalidation.publishOrchestrationInvalidationSnapshot(event.snapshot);
    }
  },
  onClose: () => {},
});

async function until(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface ResourceProbe<T> {
  reads: number;
  latest?: T;
  failure?: unknown;
  stop(): void;
}

function watchResource<T>(
  key: Parameters<typeof browserInvalidation.subscribeOrchestrationInvalidation>[0],
  load: () => Promise<T>,
): ResourceProbe<T> {
  const probe: ResourceProbe<T> = { reads: 0, stop: () => {} };
  probe.stop = browserInvalidation.subscribeOrchestrationInvalidation(key, () => {
    probe.reads += 1;
    void load().then(
      (value) => { probe.latest = value; },
      (error) => { probe.failure = error; },
    );
  });
  return probe;
}

let scheduler: InstanceType<typeof WorkflowScheduler> | undefined;
let supervisor: InstanceType<typeof AgentSupervisor> | undefined;
const stops: Array<() => void> = [];
try {
  await stream.whenReady();
  await stream.subscribeUserStatus(userId);
  await Promise.resolve();
  await Promise.resolve();
  wireEvents.length = 0;

  const coordinator = new WorkflowCoordinator({ userId, now, id });
  let workflow = coordinator.create({
    id: "workflow_runtime_invalidation",
    ownerSessionId,
    rootAgentId: ownerRootId,
    controllerAgentId: workflowAgentId,
    name: "Runtime invalidation",
    nodes: [{
      id: "workflow_node_runtime_invalidation",
      name: "Control",
      kind: "controller",
      payload: { message: "Inspect the fixture." },
      effect: "workspace_write",
      cachePolicy: "none",
      maxAttempts: 1,
      executorAgentId: workflowAgentId,
    }],
    edges: [],
    graphSealed: false,
  });
  workflow = coordinator.start(workflow.workflow.id, workflow.workflow.version)!;
  const workflowBaseline = (await api(`/orchestration/workflows/${workflow.workflow.id}`)).workflow;
  const workflowProbe = watchResource(
    `workflow:${workflow.workflow.id}`,
    async () => (await api(`/orchestration/workflows/${workflow.workflow.id}`)).workflow,
  );
  const workflowRunProbe = watchResource(
    "workflows",
    async () => await api(`/sessions/${ownerSessionId}/run`),
  );
  stops.push(workflowProbe.stop, workflowRunProbe.stop);

  scheduler = new WorkflowScheduler(sessionManager, {
    truthScanMs: 60_000,
    pageSize: 4,
    pagesPerPump: 1,
    dispatchPerWorkflow: 4,
  }).start();
  await until(
    () => wireEvents.some((event) =>
      event.type === "orchestration_invalidated"
      && event.resource === "workflow"
      && event.workflowId === workflow.workflow.id),
    "Workflow scheduler mutation reaches the runtime WebSocket",
  );
  await until(
    () => Number((workflowProbe.latest as any)?.version) > Number(workflowBaseline.version),
    "Workflow browser resource refetches the scheduler revision",
  );
  assert.equal(workflowProbe.failure, undefined);
  assert.equal(workflowProbe.reads, 1);
  scheduler.stopClaiming();
  scheduler = undefined;

  const schedulerSnapshot = workflowDao.snapshot(userId, workflow.workflow.id)!;
  const attempt = schedulerSnapshot.attempts[0]!;
  const runtimePhases: string[] = [];
  let controllerTask = runtimeTaskDao.byId(userId, attempt.taskId)!;
  let finishWorker: ((result: {
    summary: string;
    body: Record<string, never>;
    artifacts: never[];
  }) => void) | undefined;
  const runningBaseline = schedulerSnapshot.workflow.version;
  const readsBeforeRunning = workflowProbe.reads;
  wireEvents.length = 0;
  supervisor = new AgentSupervisor({
    userId,
    sessionId: ownerSessionId,
    rootAgentId: ownerRootId,
    now,
    defaultAgentConfig: { provider: "mock", model: "mock-coder", thinkingLevel: "off" },
    workerFactory: () => ({
      run: ({ task }) => {
        controllerTask = task;
        return new Promise((resolve) => { finishWorker = resolve; });
      },
      close: () => {},
    }),
    onTaskChanged: (taskId) => {
      const changed = runtimeTaskDao.byId(userId, taskId);
      if (changed) runtimePhases.push(changed.status);
      sessionManager.notifyWorkflowTaskChanged(userId, taskId);
    },
    onAttemptEnd: (taskId) => sessionManager.notifyWorkflowTaskChanged(userId, taskId),
  });
  await until(
    () => runtimePhases.includes("starting") && runtimePhases.includes("running") && Boolean(finishWorker),
    "Workflow Task starting and running producers publish their post-commit edge",
  );
  await until(
    () => wireEvents.some((event) =>
      event.type === "orchestration_invalidated"
      && event.resource === "workflow"
      && event.version > runningBaseline),
    "Workflow Task running revision reaches the runtime WebSocket",
  );
  await until(
    () => workflowProbe.reads > readsBeforeRunning
      && Number((workflowProbe.latest as any)?.version) > runningBaseline,
    "Workflow browser resource refetches the running revision",
  );

  wireEvents.length = 0;
  const toolBaseline = workflowDao.snapshot(userId, workflow.workflow.id)!.workflow.version;
  const runBeforeTool = await api(`/sessions/${ownerSessionId}/run`);
  const readsBeforeTool = workflowProbe.reads;
  const runReadsBeforeTool = workflowRunProbe.reads;
  const expand = createWorkflowTools({
    nodeKind: "controller",
    actor: () => ({
      userId,
      taskId: controllerTask.id,
      taskLeaseGeneration: controllerTask.leaseGeneration,
      expectedWorkflowId: workflow.workflow.id,
      expectedNodeId: attempt.nodeId,
      nodeKind: "controller",
    }),
    now,
    onMutation: (changedWorkflow) => sessionManager.notifyWorkflowChanged(changedWorkflow),
    expand: (input) => workflowDao.expand({
      workflowId: input.workflowId,
      userId: input.actor.userId,
      controllerNodeId: input.controllerNodeId,
      actorTaskId: input.actor.taskId,
      actorLeaseGeneration: input.actor.taskLeaseGeneration,
      expectedGraphRevision: input.expectedGraphRevision,
      nodes: input.nodes.map((node) => node.kind === "work"
        ? { ...node, executorAgentId: workflowAgentId }
        : node),
      edges: input.edges,
      mutationId: `test-expand:${input.mutationKey}`,
      at: input.at,
    }),
  }).find((tool) => tool.name === "workflow_expand")!;
  await expand.execute("tool_runtime_invalidation", {
    nodes: [{
      id: "workflow_node_runtime_invalidation_after_tool",
      name: "Follow-up",
      kind: "work",
      payload: { message: "Inspect the result." },
      effect: "workspace_read",
      cachePolicy: "none",
      maxAttempts: 1,
    }],
    edges: [{
      from: attempt.nodeId,
      to: "workflow_node_runtime_invalidation_after_tool",
      condition: "success",
    }],
  }, new AbortController().signal);
  await until(
    () => wireEvents.some((event) =>
      event.type === "orchestration_invalidated"
      && event.resource === "workflow"
      && event.version > toolBaseline),
    "Workflow Tool mutation reaches the runtime WebSocket",
  );
  await until(
    () => workflowProbe.reads > readsBeforeTool
      && Number((workflowProbe.latest as any)?.version) > toolBaseline,
    "Workflow browser resource refetches the Tool revision",
  );
  await until(
    () => workflowRunProbe.reads > runReadsBeforeTool
      && Number((workflowRunProbe.latest as any)?.linkedWorkflows?.items?.[0]?.version) > toolBaseline,
    "Run browser resource refetches the pure Workflow revision",
  );
  assert.equal(
    Number((workflowRunProbe.latest as any).revision),
    Number(runBeforeTool.revision),
    "the pure Workflow mutation must not depend on an Agent roster revision",
  );

  wireEvents.length = 0;
  const settleBaseline = workflowDao.snapshot(userId, workflow.workflow.id)!.workflow.version;
  const readsBeforeSettlement = workflowProbe.reads;
  finishWorker!({ summary: "Controller complete", body: {}, artifacts: [] });
  await until(
    () => runtimeTaskDao.byId(userId, controllerTask.id)?.status === "succeeded",
    "Workflow worker settles through AgentSupervisor",
  );
  await until(
    () => wireEvents.some((event) =>
      event.type === "orchestration_invalidated"
      && event.resource === "workflow"
      && event.version > settleBaseline),
    "Workflow Task settlement reaches the runtime WebSocket",
  );
  await until(
    () => workflowProbe.reads > readsBeforeSettlement
      && Number((workflowProbe.latest as any)?.version) > settleBaseline,
    "Workflow browser resource refetches the Task settlement",
  );
  await supervisor.close();
  supervisor = undefined;

  const owner = new TeamCoordinator({ userId, actorSessionId: ownerSessionId, now, id });
  const team = owner.createFromSessions({
    name: "Runtime invalidation",
    members: [
      { sessionId: ownerSessionId, role: "lead" },
      { sessionId: memberSessionId, role: "worker" },
    ],
    leadSessionId: ownerSessionId,
  });
  const target = team.members.find((member) => member.sessionId === memberSessionId)!;
  const work = owner.assignWork({
    teamId: team.team.id,
    targetMemberId: target.id,
    title: "Verify invalidation",
    payload: { request: "Verify the durable path." },
    idempotencyKey: "runtime-invalidation-work",
    deadlineAt: now() + 60_000,
    budget: { maxModelCycles: 1, maxTokens: 4_000 },
  });
  const teamBaseline = (await api(`/orchestration/teams/${team.team.id}`)).team;
  const mailBaseline = (await api(`/orchestration/teams/${team.team.id}/mail`)).items[0];
  assert.equal(mailBaseline.status, "queued");
  const teamProbe = watchResource(
    `team:${team.team.id}`,
    async () => (await api(`/orchestration/teams/${team.team.id}`)).team,
  );
  const mailProbe = watchResource(
    `team:${team.team.id}`,
    async () => (await api(`/orchestration/teams/${team.team.id}/mail`)).items[0],
  );
  stops.push(teamProbe.stop, mailProbe.stop);
  wireEvents.length = 0;

  const executor = new TeamTurnExecutor({
    userId,
    now,
    id,
    mailLeaseMs: 10_000,
    onChanged: ({ task }) => sessionManager.notifyTeamTaskChanged(userId, task),
    gateway: {
      activateSession: (_owner, sessionId) => ({
        beginInternalTeamTurn: (input) => {
          agentTurnDao.start({
            id: input.turnId,
            sessionId,
            startedAt: now(),
            provider: "mock",
            model: "mock-coder",
            source: "team",
            teamTaskId: input.task.id,
            teamTaskLeaseGeneration: input.lease.taskGeneration,
            teamMailClaimGeneration: input.lease.claimGeneration,
          });
          return {
            accepted: true as const,
            completion: (async () => {
              await new Promise((resolve) => setTimeout(resolve, 80));
              const completedAt = now();
              agentTurnDao.complete(sessionId, input.turnId, "completed", completedAt);
              teamTurnOutcomeDao.record({
                taskId: input.task.id,
                userId,
                sessionId,
                turnId: input.turnId,
                taskLeaseGeneration: input.lease.taskGeneration,
                mailClaimGeneration: input.lease.claimGeneration,
                status: "completed",
                summary: "Invalidation verified",
                body: { ok: true },
                artifacts: [],
                at: completedAt,
              });
              return {
                status: "completed" as const,
                completedAt,
                summary: "Invalidation verified",
                body: { ok: true },
                artifacts: [],
                usage: { modelCycles: 1, tokens: 64 },
              };
            })(),
          };
        },
      }),
    },
  });
  const outcome = await executor.execute(work.task.id);
  assert.equal(outcome.status, "succeeded");
  await until(
    () => wireEvents.some((event) =>
      event.type === "orchestration_invalidated"
      && event.resource === "team"
      && event.teamId === team.team.id),
    "Team executor mutation reaches the runtime WebSocket",
  );
  await until(
    () => (mailProbe.latest as any)?.status === "acknowledged"
      && Number((teamProbe.latest as any)?.version) > Number(teamBaseline.version),
    "Team and mail browser resources refetch the committed revision",
  );
  assert.equal(teamProbe.failure, undefined);
  assert.equal(mailProbe.failure, undefined);
  assert.ok(teamProbe.reads >= 1);
  assert.ok(mailProbe.reads >= 1);
  const invalidations = wireEvents.filter((event) => event.type === "orchestration_invalidated");
  assert.ok(invalidations.some((event) => event.resource === "session_run" && event.sessionId === memberSessionId));
  assert.ok(invalidations.some((event) => event.resource === "activity"));
  assert.ok(invalidations.every((event) => !("payload" in event) && !("result" in event)));

  console.log(JSON.stringify({
    ok: true,
    workflow: {
      before: workflowBaseline.version,
      after: (workflowProbe.latest as any).version,
      refetches: workflowProbe.reads,
      runRefetches: workflowRunProbe.reads,
      paths: ["scheduler", "task_starting", "task_running", "tool", "task_settlement"],
    },
    team: {
      before: teamBaseline.version,
      after: (teamProbe.latest as any).version,
      detailRefetches: teamProbe.reads,
      mailRefetches: mailProbe.reads,
      mailStatus: (mailProbe.latest as any).status,
    },
  }));
} finally {
  scheduler?.stopClaiming();
  await supervisor?.close();
  for (const stop of stops) stop();
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise<void>((resolve) => streamWss.close(() => resolve()));
  await new Promise<void>((resolve) => streamServer.close(() => resolve()));
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
