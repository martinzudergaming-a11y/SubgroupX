import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-team-ingress-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const [persistence, providers, managerModule, dispatcherModule, permitsModule, readModelModule] = await Promise.all([
  import("../server/src/persistence/index.ts"),
  import("../server/src/runtime/providers.ts"),
  import("../server/src/runtime/manager.ts"),
  import("../server/src/orchestration/runtime-task-dispatcher.ts"),
  import("../server/src/orchestration/runtime-task-permits.ts"),
  import("../server/src/orchestration/read-model.ts"),
]);

providers.registerMockProvider();
const { SessionManager } = managerModule;
const { RuntimeTaskDispatcher } = dispatcherModule;
const { RuntimeTaskPermitPool } = permitsModule;
const { orchestrationReadModel } = readModelModule;
const {
  agentTurnDao,
  messageDao,
  runtimeTaskDao,
  sessionDao,
  taskResultDao,
  teamDao,
  teamMailDao,
  timelineDao,
  userDao,
} = persistence;

const userId = "user_team_ingress";
const ownerSessionId = "session_team_ingress_owner";
const now = Date.now();
userDao.create({
  id: userId,
  email: "team-ingress@example.invalid",
  password_hash: "x",
  created_at: now,
});
sessionDao.create({
  id: ownerSessionId,
  user_id: userId,
  title: "Team ingress owner",
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

async function until<T>(read: () => T | undefined, label: string, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const manager = new SessionManager({ taskPermits: new RuntimeTaskPermitPool(2) });
const dispatcher = new RuntimeTaskDispatcher(manager, { truthScanMs: 50 }).start();
const statusEvents: Array<{ type: string; sessionId?: string }> = [];
const unsubscribe = manager.subscribeUserStatus(userId, (event) => {
  statusEvents.push({
    type: event.type,
    ...(event.type === "session_created" ? { sessionId: event.session.id } : {}),
  });
});

try {
  const runtime = manager.getRuntime(userId, ownerSessionId);
  assert.ok(runtime, "production SessionManager must construct the owner runtime");

  await runtime.sendMessage("/team-create Release review\nanalyst\nreviewer");
  const createStep = timelineDao.list(ownerSessionId).find(
    (item) => item.kind === "tool" && item.name === "team_create",
  );
  assert.equal(createStep?.kind, "tool");
  assert.equal(createStep?.status, "success");

  const team = teamDao.listForSession(userId, ownerSessionId, 10)[0];
  assert.ok(team, "the Agent Tool must create a durable Team");
  const snapshot = teamDao.snapshot(userId, team.id)!;
  const worker = snapshot.members.find((member) => member.role === "analyst");
  const reviewer = snapshot.members.find((member) => member.role === "reviewer");
  assert.ok(worker && reviewer, "the product path must provision one real Session for each role");
  assert.equal(sessionDao.byId(worker.sessionId)?.team_provision_state, "published");
  assert.equal(sessionDao.byId(reviewer.sessionId)?.team_provision_state, "published");
  assert.equal(
    manager.listSessions(userId).find((session) => session.id === worker.sessionId)?.isTeamMemberSession,
    true,
  );
  assert.ok(
    statusEvents.some((event) => event.type === "session_created" && event.sessionId === worker.sessionId),
    "Team activation must publish the newly visible Session to live clients",
  );
  assert.ok(
    statusEvents.some((event) => event.type === "session_created" && event.sessionId === reviewer.sessionId),
    "Team activation must publish every newly visible Session to live clients",
  );

  await runtime.sendMessage(`/team-list ${team.id}`);
  const listStep = timelineDao.list(ownerSessionId).find(
    (item) => item.kind === "tool" && item.name === "team_mail"
      && item.arguments.action === "list" && item.arguments.teamId === team.id,
  );
  assert.equal(listStep?.kind, "tool");
  assert.equal(listStep?.status, "success");
  assert.match(listStep?.resultText ?? "", new RegExp(worker.id));

  await runtime.sendMessage([
    `/team-assign ${team.id} ${worker.id}`,
    "Inspect the release",
    JSON.stringify({
      request: [
        `/team-assign ${team.id} ${reviewer.id}`,
        "Verify the review",
        JSON.stringify({ request: "Return a short independent verification." }),
      ].join("\n"),
    }),
  ].join("\n"));
  const assignStep = timelineDao.list(ownerSessionId).find(
    (item) => item.kind === "tool" && item.name === "team_assign",
  );
  assert.equal(assignStep?.kind, "tool");
  assert.equal(assignStep?.status, "success");
  assert.ok(assignStep.turnId, "Team assignment must retain its product Turn");

  const workMail = teamMailDao.listOutbox(userId, ownerSessionId, { limit: 10 })
    .find((mail) => mail.kind === "work");
  assert.ok(workMail?.taskId, "the Team Tool must atomically create work mail and one Task");
  const acceptedTask = runtimeTaskDao.byId(userId, workMail.taskId)!;
  assert.equal(acceptedTask.ownerTurnId, assignStep.turnId);
  assert.equal(acceptedTask.ownerStepId, assignStep.id);
  assert.equal(acceptedTask.awaitPolicy, "background");

  const completedTask = await until(() => {
    const task = runtimeTaskDao.byId(userId, workMail.taskId!);
    return task?.status === "succeeded" ? task : undefined;
  }, "Team role Session completes its real Agent Turn");
  assert.equal(completedTask.sessionId, worker.sessionId);
  assert.equal(teamMailDao.byTask(userId, completedTask.id)?.status, "acknowledged");
  assert.ok(taskResultDao.byTask(userId, completedTask.id));

  const teamTurn = agentTurnDao.byTeamTask(worker.sessionId, completedTask.id);
  assert.equal(teamTurn?.source, "team");
  assert.equal(teamTurn?.status, "completed");
  const workerAssignment = timelineDao.list(worker.sessionId).find(
    (item) => item.kind === "team_assignment" && item.taskId === completedTask.id,
  );
  assert.equal(workerAssignment?.kind, "team_assignment");
  assert.equal(workerAssignment.title, completedTask.title);
  assert.equal(workerAssignment.turnId, teamTurn.id);
  assert.equal(
    timelineDao.list(worker.sessionId).some((item) => item.kind === "user"),
    false,
    "Team assignment is not a user-authored Timeline Message",
  );
  assert.equal(
    messageDao.list(worker.sessionId).some((message) =>
      Boolean(message) && typeof message === "object" && (message as { role?: unknown }).role === "user"),
    false,
    "Team assignment remains a typed engine message",
  );

  const nestedTask = await until(() => runtimeTaskDao
    .listBySession(userId, reviewer.sessionId, { limit: 20 })
    .find((task) => task.kind === "team_turn" && task.parentTaskId === completedTask.id
      && task.status === "succeeded"), "nested Team handoff completes");
  const nestedStep = timelineDao.list(worker.sessionId).find(
    (item) => item.kind === "tool" && item.name === "team_assign",
  );
  assert.equal(nestedStep?.kind, "tool");
  assert.equal(nestedStep?.status, "success");
  assert.equal(nestedTask.ownerTurnId, teamTurn?.id);
  assert.equal(nestedTask.ownerStepId, nestedStep.id);
  const nestedMail = teamMailDao.byTask(userId, nestedTask.id)!;
  assert.equal(nestedMail.parentMailId, workMail.id);
  assert.equal(nestedMail.status, "acknowledged");
  const nestedTurn = agentTurnDao.byTeamTask(reviewer.sessionId, nestedTask.id);
  const nestedAssignment = timelineDao.list(reviewer.sessionId).find(
    (item) => item.kind === "team_assignment" && item.taskId === nestedTask.id,
  );
  assert.equal(nestedAssignment?.kind, "team_assignment");
  assert.equal(nestedAssignment.turnId, nestedTurn?.id);
  assert.equal(
    timelineDao.list(reviewer.sessionId).some((item) => item.kind === "user"),
    false,
  );

  dispatcher.stopClaiming();
  for (let index = 0; index < 45; index += 1) {
    runtimeTaskDao.create({
      id: `task_reviewer_unrelated_${index}`,
      userId,
      sessionId: reviewer.sessionId,
      ownerSessionId: reviewer.sessionId,
      agentId: reviewer.agentId,
      kind: "delegation",
      title: `Unrelated background Task ${index}`,
      payload: {},
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: false,
      createdAt: nestedTask.updatedAt + 1_000 + index,
    });
  }

  const reviewerRun = orchestrationReadModel.sessionRun(userId, reviewer.sessionId);
  assert.equal(reviewerRun?.tasks.items.some((task) => task.id === nestedTask.id), false);
  assert.equal(reviewerRun?.latestTeamTask?.id, nestedTask.id);
  const teamRunSamples: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < 8; iteration += 1) {
      assert.equal(
        orchestrationReadModel.sessionRun(userId, reviewer.sessionId)?.latestTeamTask?.id,
        nestedTask.id,
      );
    }
    teamRunSamples.push((performance.now() - started) / 8);
  }
  teamRunSamples.sort((left, right) => left - right);
  const teamRunMedianMs = teamRunSamples[2]!;
  assert.ok(teamRunMedianMs < timeBudgetMs(100), `bounded Team member Run took ${teamRunMedianMs.toFixed(1)}ms`);
  assert.ok(orchestrationReadModel.activity(userId, { limit: 100 }).items.some(
    (item) => item.task.id === nestedTask.id,
  ));
  assert.equal(orchestrationReadModel.taskDetail(userId, nestedTask.id)?.id, nestedTask.id);
  assert.equal(orchestrationReadModel.resultDetail(userId, nestedTask.id)?.taskId, nestedTask.id);

  persistence.db.prepare("UPDATE team_mail SET parent_mail_id = NULL WHERE id = ?").run(nestedMail.id);
  try {
    assert.equal(
      orchestrationReadModel.sessionRun(userId, reviewer.sessionId)?.tasks.items.some(
        (task) => task.id === nestedTask.id,
      ),
      false,
    );
    assert.equal(
      orchestrationReadModel.sessionRun(userId, reviewer.sessionId)?.latestTeamTask,
      undefined,
    );
    assert.equal(orchestrationReadModel.activity(userId, { limit: 100 }).items.some(
      (item) => item.task.id === nestedTask.id,
    ), false);
    assert.equal(orchestrationReadModel.taskDetail(userId, nestedTask.id), undefined);
    assert.equal(orchestrationReadModel.resultDetail(userId, nestedTask.id), undefined);
  } finally {
    persistence.db.prepare("UPDATE team_mail SET parent_mail_id = ? WHERE id = ?")
      .run(workMail.id, nestedMail.id);
  }
  persistence.db.prepare(`UPDATE runtime_tasks
    SET owner_session_id = ?, owner_turn_id = NULL, owner_step_id = NULL
    WHERE id = ?`)
    .run(reviewer.sessionId, nestedTask.id);
  try {
    assert.equal(
      orchestrationReadModel.sessionRun(userId, reviewer.sessionId)?.tasks.items.some(
        (task) => task.id === nestedTask.id,
      ),
      false,
    );
    assert.equal(
      orchestrationReadModel.sessionRun(userId, reviewer.sessionId)?.latestTeamTask,
      undefined,
    );
    assert.equal(orchestrationReadModel.activity(userId, { limit: 100 }).items.some(
      (item) => item.task.id === nestedTask.id,
    ), false);
    assert.equal(orchestrationReadModel.taskDetail(userId, nestedTask.id), undefined);
    assert.equal(orchestrationReadModel.resultDetail(userId, nestedTask.id), undefined);
  } finally {
    persistence.db.prepare(`UPDATE runtime_tasks
      SET owner_session_id = ?, owner_turn_id = ?, owner_step_id = ?
      WHERE id = ?`)
      .run(nestedTask.ownerSessionId, nestedTask.ownerTurnId, nestedTask.ownerStepId, nestedTask.id);
  }
  const rootLedger = persistence.db.prepare(
    `SELECT self_used_model_cycles, self_used_tokens,
            child_reserved_turns, child_reserved_tokens,
            budget_remaining_turns, budget_remaining_tokens,
            route_used_turns, route_used_tokens,
            route_reserved_turns, route_reserved_tokens
     FROM team_mail WHERE id = ?`,
  ).get(workMail.id) as Record<string, number>;
  assert.deepEqual({ ...rootLedger }, {
    self_used_model_cycles: 2,
    self_used_tokens: 0,
    child_reserved_turns: 6,
    child_reserved_tokens: 50_000,
    budget_remaining_turns: 0,
    budget_remaining_tokens: 50_000,
    route_used_turns: 3,
    route_used_tokens: 0,
    route_reserved_turns: 5,
    route_reserved_tokens: 50_000,
  });
  const childLedger = persistence.db.prepare(
    `SELECT budget_turns, budget_tokens, self_used_model_cycles, self_used_tokens,
            budget_remaining_turns, budget_remaining_tokens
     FROM team_mail WHERE id = ?`,
  ).get(nestedMail.id) as Record<string, number>;
  assert.deepEqual({ ...childLedger }, {
    budget_turns: 6,
    budget_tokens: 50_000,
    self_used_model_cycles: 1,
    self_used_tokens: 0,
    budget_remaining_turns: 5,
    budget_remaining_tokens: 50_000,
  });
  assert.equal(
    rootLedger.route_used_turns
      + rootLedger.route_reserved_turns
      + rootLedger.budget_remaining_turns,
    8,
  );
  assert.equal(
    rootLedger.route_used_tokens
      + rootLedger.route_reserved_tokens
      + rootLedger.budget_remaining_tokens,
    100_000,
  );

  const context = await (runtime as unknown as {
    promptWithAgentRoster(base: string): Promise<string>;
  }).promptWithAgentRoster("TEAM_INGRESS_CONTEXT");
  assert.match(context, new RegExp(completedTask.id));
  assert.match(context, /"status":"succeeded"/);

  console.log("OK Team Agent ingress:");
  console.log("  ✓ team_create provisions and publishes a real Session");
  console.log("  ✓ team_mail rediscovers bounded member identity");
  console.log("  ✓ team_assign preserves Turn/Step provenance and dispatches in background");
  console.log("  ✓ each Team Turn persists a system assignment marker without a user Message");
  console.log("  ✓ nested handoff inherits its trusted parent route and remaining budget");
  console.log("  ✓ exact Team mail ancestry and Task ownership gate every cross-Session read");
  console.log("  ✓ latest Team Task stays visible beyond the bounded generic Task page");
  console.log(`  ✓ 45-unrelated-Task Team Run median: ${teamRunMedianMs.toFixed(2)} ms`);
  console.log("  ✓ role Session completes a typed Team Turn and returns bounded owner context");
} finally {
  unsubscribe();
  dispatcher.stopClaiming();
  manager.disposeUserRuntimes(userId);
  fs.rmSync(tmp, { recursive: true, force: true });
}
