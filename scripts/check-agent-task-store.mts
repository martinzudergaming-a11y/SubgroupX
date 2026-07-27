import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TimelineItem } from "../shared/src/protocol.ts";
import { reduceTimeline } from "../shared/src/timeline-reducer.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-task-store-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const {
  agentMessageDao,
  agentNodeDao,
  agentTurnDao,
  AGENT_TRANSCRIPT_MAX_MESSAGES,
  db,
  JOINED_PROGRESS_MAX_EVENT_BYTES,
  JOINED_PROGRESS_MAX_BYTES,
  JOINED_PROGRESS_MAX_ITEMS,
  joinedTaskProgressDao,
  ORCHESTRATION_QUERY_MAX,
  runtimeTaskDao,
  sessionDao,
  TASK_PAYLOAD_MAX_BYTES,
  TASK_RESULT_BODY_MAX_BYTES,
  taskEventDao,
  taskResultDao,
  timelineDao,
  userDao,
} = await import("../server/src/persistence/index.ts");

const now = 1_800_000_000_000;
const userId = "user_store";
const otherUserId = "user_other";
userDao.create({ id: userId, email: "store@example.invalid", password_hash: "x", created_at: now });
userDao.create({ id: otherUserId, email: "other@example.invalid", password_hash: "x", created_at: now });

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
    created_at: now,
    updated_at: now,
  });
}
createSession("session_owner");
createSession("session_target");
createSession("session_tree_two");
createSession("session_task_owner");
createSession("session_other", otherUserId);

const root = agentNodeDao.create({
  id: "agent_root",
  userId,
  sessionId: "session_owner",
  rootAgentId: "agent_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now,
});
assert.equal(root.version, 1);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, 1);
const child = agentNodeDao.create({
  id: "agent_child",
  userId,
  sessionId: "session_owner",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/review",
    label: "Review",
    provider: "mock",
    model: "mock",
  kind: "subagent",
  createdAt: now + 1,
});
assert.equal(child.status, "initializing");
assert.equal(child.provider, "mock");
assert.equal(child.model, "mock");
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, 2);
const childIdle = agentNodeDao.transitionStatus({
  id: child.id,
  userId,
  expectedVersion: 1,
  nextStatus: "idle",
  at: now + 2,
});
assert.equal(childIdle?.version, 2);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, 3);
function createChildAgent(id: string, path: string) {
  return agentNodeDao.create({
    id,
    userId,
    sessionId: "session_owner",
    rootAgentId: root.id,
    parentAgentId: root.id,
    path,
    provider: "mock",
    model: "mock",
    kind: "subagent",
    createdAt: now + 2,
  });
}
assert.equal(
  agentNodeDao.transitionStatus({
    id: child.id,
    userId,
    expectedVersion: 1,
    nextStatus: "running",
    at: now + 3,
  }),
  null,
  "a stale Agent writer must lose the CAS",
);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, 3, "a lost CAS must not invalidate the roster");
assert.equal(agentNodeDao.listByRoot(userId, root.id, { limit: 1 }).length, 1);
assert.equal(agentNodeDao.listBySession(otherUserId, "session_owner").length, 0, "Agent reads are user scoped");
assert.throws(() => agentNodeDao.create({
  id: "agent_missing_provenance",
  userId,
  sessionId: "session_owner",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/missing_provenance",
  kind: "subagent",
  createdAt: now + 3,
}), /pinned provider\/model provenance/);
assert.equal(agentNodeDao.byId(userId, "agent_missing_provenance"), undefined);
assert.throws(() => agentNodeDao.create({
  id: "agent_duplicate_session",
  userId,
  sessionId: "session_owner",
  rootAgentId: "agent_duplicate_session",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now + 3,
}), /UNIQUE constraint failed/, "one Session cannot own two Agent identities");
assert.throws(() => agentNodeDao.create({
  id: "agent_root_without_session",
  userId,
  rootAgentId: "agent_root_without_session",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now + 3,
}), /requires a real Session/);
assert.throws(() => agentNodeDao.create({
  id: "agent_cross_session_child",
  userId,
  sessionId: "session_target",
  rootAgentId: root.id,
  parentAgentId: root.id,
  path: "/root/cross_session",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  createdAt: now + 3,
}), /must use its root Session/);
const secondRoot = agentNodeDao.create({
  id: "agent_second_root",
  userId,
  sessionId: "session_tree_two",
  rootAgentId: "agent_second_root",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now + 3,
});
const otherRoot = agentNodeDao.create({
  id: "agent_other",
  userId: otherUserId,
  sessionId: "session_other",
  rootAgentId: "agent_other",
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now,
});
assert.throws(() => agentNodeDao.create({
  id: "agent_cross_owner",
  userId,
  sessionId: "session_owner",
  rootAgentId: otherRoot.id,
  parentAgentId: otherRoot.id,
    path: "/root/cross",
    provider: "mock",
    model: "mock",
  kind: "subagent",
  createdAt: now + 3,
}), /same owned tree/);
console.log("  ✓ Agent rows use stable paths and monotonic CAS versions");

function createTask(
  id: string,
  options: {
    agentId?: string;
    sessionId?: string;
    ownerSessionId?: string;
    ownerStepId?: string;
    checkpointSafe?: boolean;
    parentTaskId?: string;
    at?: number;
  } = {},
) {
  return runtimeTaskDao.create({
    id,
    userId,
    sessionId: options.sessionId ?? "session_owner",
    ownerSessionId: options.ownerSessionId ?? "session_owner",
    ownerStepId: options.ownerStepId ?? "step_delegate",
    agentId: options.agentId ?? child.id,
    parentTaskId: options.parentTaskId,
    kind: "delegation",
    title: `Task ${id}`,
    payload: { assignment: id },
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: options.checkpointSafe ?? false,
    createdAt: options.at ?? now + 10,
  });
}

const task = createTask("task_main");
assert.equal(task.status, "queued");
assert.equal(task.version, 1);
assert.equal(task.leaseGeneration, 0);
assert.deepEqual(taskEventDao.listRecent(userId, task.id).map((event) => event.type), ["created"]);
let rosterRevision = agentNodeDao.roster(userId, root.id)!.revision;
assert.equal(rosterRevision, 4, "Task creation advances the tree-wide roster revision");
assert.throws(() => runtimeTaskDao.create({
  id: "task_cross_owner",
  userId,
  sessionId: "session_target",
  ownerSessionId: "session_owner",
  agentId: otherRoot.id,
  kind: "delegation",
  title: "Cross owner",
  payload: {},
  awaitPolicy: "join",
  cancelPolicy: "linked",
  checkpointSafe: false,
  createdAt: now + 10,
}), /same user/);
const otherTreeTask = createTask("task_other_tree", {
  agentId: secondRoot.id,
  sessionId: "session_tree_two",
  at: now + 10,
});
assert.throws(
  () => createTask("task_cross_tree_parent", { parentTaskId: otherTreeTask.id, at: now + 10 }),
  /same owned Agent tree/,
);

const claimed = runtimeTaskDao.claim({ id: task.id, userId, expectedVersion: 1, at: now + 11 });
assert.equal(claimed?.status, "starting");
assert.equal(claimed?.version, 2);
assert.equal(claimed?.leaseGeneration, 1);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
assert.equal(
  runtimeTaskDao.claim({ id: task.id, userId, expectedVersion: 1, at: now + 12 }),
  null,
  "one queued version can be claimed once",
);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, rosterRevision, "a lost Task claim must not advance it");
assert.equal(
  runtimeTaskDao.transition({
    id: task.id,
    userId,
    expectedVersion: 2,
    expectedLeaseGeneration: 0,
    nextStatus: "running",
    at: now + 13,
  }),
  null,
  "an old lease generation cannot mutate a new attempt",
);
let running = runtimeTaskDao.transition({
  id: task.id,
  userId,
  expectedVersion: 2,
  expectedLeaseGeneration: 1,
  nextStatus: "running",
  activity: "model",
  at: now + 13,
});
assert.equal(running?.version, 3);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
running = runtimeTaskDao.updateActivity({
  id: task.id,
  userId,
  expectedVersion: running!.version,
  expectedLeaseGeneration: 1,
  activity: "tool:read",
  at: now + 14,
});
assert.equal(running?.activity, "tool:read");
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
assert.throws(
  () => runtimeTaskDao.transition({
    id: task.id,
    userId,
    expectedVersion: running!.version,
    expectedLeaseGeneration: 1,
    nextStatus: "starting",
    at: now + 15,
  }),
  /invalid Task status transition/,
);
assert.equal(runtimeTaskDao.byId(userId, task.id)?.status, "running", "invalid edges do not mutate state");
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, rosterRevision);
const succeeded = runtimeTaskDao.transition({
  id: task.id,
  userId,
  expectedVersion: running!.version,
  expectedLeaseGeneration: 1,
  nextStatus: "succeeded",
  at: now + 16,
  eventPayload: { source: "worker" },
});
assert.equal(succeeded?.status, "succeeded");
assert.equal(succeeded?.settledAt, now + 16);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
assert.throws(() => runtimeTaskDao.transition({
  id: task.id,
  userId,
  expectedVersion: succeeded!.version,
  expectedLeaseGeneration: 1,
  nextStatus: "failed",
  at: now + 17,
}), /invalid Task status transition/, "a terminal Task cannot transition");
console.log("  ✓ Task claims fence stale workers and legal transitions append evidence");

assert.equal(taskResultDao.create({
  id: "result_stale",
  taskId: task.id,
  userId,
  summary: "stale worker",
  body: { answer: "stale" },
  artifacts: [],
  expectedTaskVersion: succeeded!.version - 1,
  expectedLeaseGeneration: succeeded!.leaseGeneration - 1,
  createdAt: now + 19,
}), null, "a stale Task lease cannot publish a result");
const result = taskResultDao.create({
  id: "result_main",
  taskId: task.id,
  userId,
  summary: "Review complete",
  body: { answer: "ok" },
  artifacts: [{ path: "report.txt" }],
  expectedTaskVersion: succeeded!.version,
  expectedLeaseGeneration: succeeded!.leaseGeneration,
  createdAt: now + 20,
});
assert.ok(result);
assert.equal(result.version, 1);
let [digest] = runtimeTaskDao.listDigestsByRoot(userId, root.id, { limit: 10 })
  .filter((value) => value.id === task.id);
const resultRevision = digest.version;
assert.ok(resultRevision > succeeded!.version, "result storage advances the digest revision");
assert.equal(digest.resultId, result.id);
assert.equal(digest.unreadResult, true);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
assert.equal(taskResultDao.acknowledge({ userId, taskId: task.id, expectedVersion: 0, at: now + 21 }), null);
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, rosterRevision);
const acknowledged = taskResultDao.acknowledge({ userId, taskId: task.id, expectedVersion: 1, at: now + 21 });
assert.equal(acknowledged?.version, 2);
[digest] = runtimeTaskDao.listDigestsByRoot(userId, root.id, { limit: 10 })
  .filter((value) => value.id === task.id);
assert.equal(digest.unreadResult, false);
assert.ok(digest.version > resultRevision, "result acknowledgement advances the digest revision");
assert.equal(agentNodeDao.roster(userId, root.id)?.revision, ++rosterRevision);
const rosterSnapshot = agentNodeDao.roster(userId, root.id)!;
assert.deepEqual(new Set(rosterSnapshot.nodes.map((node) => node.id)), new Set([root.id, child.id]));
assert.ok(rosterSnapshot.tasks.some((value) => value.id === task.id && !value.unreadResult));
assert.equal(agentNodeDao.roster(otherUserId, root.id), undefined, "roster snapshots are user scoped");
console.log("  ✓ Result detail is lazy and acknowledgement is CAS guarded");

const atomicSettleChild = createChildAgent("agent_atomic_settle", "/root/atomic_settle");
const atomicSettleTask = createTask("task_atomic_settle", { agentId: atomicSettleChild.id, at: now + 21 });
const atomicSettleClaim = runtimeTaskDao.claim({
  id: atomicSettleTask.id,
  userId,
  expectedVersion: atomicSettleTask.version,
  at: now + 22,
})!;
const atomicSettleRunning = runtimeTaskDao.transition({
  id: atomicSettleTask.id,
  userId,
  expectedVersion: atomicSettleClaim.version,
  expectedLeaseGeneration: atomicSettleClaim.leaseGeneration,
  nextStatus: "running",
  at: now + 23,
})!;
assert.throws(() => taskResultDao.settle({
  id: "result_atomic_invalid",
  taskId: atomicSettleTask.id,
  userId,
  summary: "must roll back",
  body: { oversized: "x".repeat(256 * 1024 + 1) },
  artifacts: [],
  expectedTaskVersion: atomicSettleRunning.version,
  expectedLeaseGeneration: atomicSettleRunning.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now + 24,
}), /exceeds 262144 UTF-8 bytes/);
assert.equal(runtimeTaskDao.byId(userId, atomicSettleTask.id)?.status, "running");
assert.equal(taskResultDao.byTask(userId, atomicSettleTask.id), undefined);
const atomicSettlement = taskResultDao.settle({
  id: "result_atomic_valid",
  taskId: atomicSettleTask.id,
  userId,
  summary: "committed together",
  body: { ok: true },
  artifacts: [],
  expectedTaskVersion: atomicSettleRunning.version,
  expectedLeaseGeneration: atomicSettleRunning.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now + 25,
});
assert.equal(atomicSettlement?.task.status, "succeeded");
assert.equal(atomicSettlement?.result.id, "result_atomic_valid");
assert.ok(agentNodeDao.transitionStatus({
  id: atomicSettleChild.id,
  userId,
  expectedVersion: atomicSettleChild.version,
  nextStatus: "idle",
  at: now + 25,
}));
console.log("  ✓ terminal Task and TaskResult commit atomically or roll back together");

function createRunningJoinedFixture(suffix: string, ownerSeq: number) {
  const agent = createChildAgent(`agent_joined_${suffix}`, `/root/joined_${suffix}`);
  const turnId = `turn_joined_${suffix}`;
  const stepId = `step_joined_${suffix}`;
  agentTurnDao.start({
    id: turnId,
    sessionId: "session_owner",
    startedAt: now + ownerSeq,
    provider: "mock",
    model: "mock",
  });
  timelineDao.append("session_owner", {
    kind: "tool",
    id: stepId,
    seq: ownerSeq,
    name: "spawn_subagent",
    toolKind: "subagent",
    arguments: {},
    status: "running",
    ts: now + ownerSeq,
    turnId,
  });
  const created = runtimeTaskDao.create({
    id: `task_joined_${suffix}`,
    userId,
    sessionId: "session_owner",
    ownerSessionId: "session_owner",
    ownerTurnId: turnId,
    ownerStepId: stepId,
    agentId: agent.id,
    kind: "delegation",
    title: suffix,
    payload: {},
    awaitPolicy: "join",
    cancelPolicy: "linked",
    checkpointSafe: false,
    createdAt: now + ownerSeq,
  });
  const claimed = runtimeTaskDao.claim({
    id: created.id,
    userId,
    expectedVersion: created.version,
    at: now + ownerSeq + 1,
  })!;
  const running = runtimeTaskDao.transition({
    id: claimed.id,
    userId,
    expectedVersion: claimed.version,
    expectedLeaseGeneration: claimed.leaseGeneration,
    nextStatus: "running",
    at: now + ownerSeq + 2,
  })!;
  return { agent, turnId, stepId, ownerSeq, task: running };
}

function idleJoinedFixtureAgent(agentId: string, at: number): void {
  const current = agentNodeDao.byId(userId, agentId)!;
  assert.ok(agentNodeDao.transitionStatus({
    id: current.id,
    userId,
    expectedVersion: current.version,
    nextStatus: "idle",
    at,
  }));
}

const missingProgress = createRunningJoinedFixture("missing_progress", 48);
assert.throws(() => taskResultDao.settle({
  id: "result_joined_missing_progress_bad",
  taskId: missingProgress.task.id,
  userId,
  summary: "must not succeed",
  body: {},
  artifacts: [],
  expectedTaskVersion: missingProgress.task.version,
  expectedLeaseGeneration: missingProgress.task.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now + 48,
}), /cannot succeed without Child progress/);
assert.equal(runtimeTaskDao.byId(userId, missingProgress.task.id)?.status, "running");
assert.equal(taskResultDao.byTask(userId, missingProgress.task.id), undefined);
assert.equal(taskResultDao.settle({
  id: "result_joined_missing_progress_failed",
  taskId: missingProgress.task.id,
  userId,
  summary: "failed before progress",
  body: {},
  artifacts: [],
  expectedTaskVersion: missingProgress.task.version,
  expectedLeaseGeneration: missingProgress.task.leaseGeneration,
  nextStatus: "failed",
  createdAt: now + 49,
})?.task.status, "failed");
agentTurnDao.complete("session_owner", missingProgress.turnId, "failed", now + 49);
idleJoinedFixtureAgent(missingProgress.agent.id, now + 49);

const failedProgress = createRunningJoinedFixture("failed_progress", 49);
const failedChildTurnId = "turn_child_failed_progress";
assert.equal(joinedTaskProgressDao.commit({
  userId,
  taskId: failedProgress.task.id,
  expectedLeaseGeneration: failedProgress.task.leaseGeneration,
  progressSeq: 1,
  ownerTimelineSeq: failedProgress.ownerSeq,
  event: { t: "turn_start", turnId: failedChildTurnId, startedAt: now + 49 },
  at: now + 49,
}).kind, "committed");
assert.equal(joinedTaskProgressDao.commit({
  userId,
  taskId: failedProgress.task.id,
  expectedLeaseGeneration: failedProgress.task.leaseGeneration,
  progressSeq: 2,
  ownerTimelineSeq: failedProgress.ownerSeq,
  event: { t: "turn_end", turnId: failedChildTurnId, status: "failed", completedAt: now + 50, durationMs: 1 },
  at: now + 50,
}).kind, "committed");
assert.throws(() => taskResultDao.settle({
  id: "result_joined_failed_progress_bad",
  taskId: failedProgress.task.id,
  userId,
  summary: "must not succeed",
  body: {},
  artifacts: [],
  expectedTaskVersion: failedProgress.task.version,
  expectedLeaseGeneration: failedProgress.task.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now + 50,
}), /cannot succeed with Child progress failed/);
assert.equal(runtimeTaskDao.byId(userId, failedProgress.task.id)?.status, "running");
assert.equal(taskResultDao.settle({
  id: "result_joined_failed_progress_failed",
  taskId: failedProgress.task.id,
  userId,
  summary: "Child progress failed",
  body: {},
  artifacts: [],
  expectedTaskVersion: failedProgress.task.version,
  expectedLeaseGeneration: failedProgress.task.leaseGeneration,
  nextStatus: "failed",
  createdAt: now + 51,
})?.task.status, "failed");
agentTurnDao.complete("session_owner", failedProgress.turnId, "failed", now + 51);
idleJoinedFixtureAgent(failedProgress.agent.id, now + 51);
console.log("  ✓ joined Task success requires exact-generation completed Child progress");

const progressChild = createChildAgent("agent_joined_progress", "/root/joined_progress");
const progressTurnId = "turn_joined_progress";
const progressStepId = "step_joined_progress";
const progressOwnerSeq = 50;
agentTurnDao.start({
  id: progressTurnId,
  sessionId: "session_owner",
  startedAt: now + 26,
  provider: "mock",
  model: "mock",
});
timelineDao.append("session_owner", {
  kind: "tool",
  id: progressStepId,
  seq: progressOwnerSeq,
  name: "spawn_subagent",
  toolKind: "subagent",
  arguments: { task: "bounded progress" },
  status: "running",
  ts: now + 26,
  turnId: progressTurnId,
});
const progressTask = runtimeTaskDao.create({
  id: "task_joined_progress",
  userId,
  sessionId: "session_owner",
  ownerSessionId: "session_owner",
  ownerTurnId: progressTurnId,
  ownerStepId: progressStepId,
  agentId: progressChild.id,
  kind: "delegation",
  title: "Joined progress",
  payload: { message: "bounded progress" },
  awaitPolicy: "join",
  cancelPolicy: "linked",
  checkpointSafe: false,
  createdAt: now + 27,
});
const progressClaim = runtimeTaskDao.claim({
  id: progressTask.id,
  userId,
  expectedVersion: progressTask.version,
  at: now + 28,
})!;
const progressRunning = runtimeTaskDao.transition({
  id: progressTask.id,
  userId,
  expectedVersion: progressClaim.version,
  expectedLeaseGeneration: progressClaim.leaseGeneration,
  nextStatus: "running",
  at: now + 29,
})!;
const progressCommit = (progressSeq: number, event: Parameters<typeof joinedTaskProgressDao.commit>[0]["event"], at: number) =>
  joinedTaskProgressDao.commit({
    userId,
    taskId: progressTask.id,
    expectedLeaseGeneration: progressRunning.leaseGeneration,
    progressSeq,
    ownerTimelineSeq: progressOwnerSeq,
    event,
    at,
  });
const childTurnId = "turn_child_progress_fixture";
assert.equal(progressCommit(1, {
  t: "turn_start",
  turnId: childTurnId,
  startedAt: now + 30,
}, now + 30).kind, "committed");
timelineDao.append("session_owner", {
  kind: "tool",
  id: progressStepId,
  seq: progressOwnerSeq + 1_000,
  name: "spawn_subagent",
  toolKind: "subagent",
  arguments: { task: "decoy duplicate owner" },
  status: "running",
  ts: now + 30,
  turnId: progressTurnId,
});
assert.throws(() => joinedTaskProgressDao.commit({
  userId,
  taskId: progressTask.id,
  expectedLeaseGeneration: progressRunning.leaseGeneration,
  progressSeq: 2,
  ownerTimelineSeq: progressOwnerSeq + 1_000,
  event: { t: "assistant_start", id: "assistant_decoy_owner", turnId: childTurnId },
  at: now + 31,
}), /cannot change its pinned owner Timeline seq/);
assert.equal(joinedTaskProgressDao.byTask(userId, progressTask.id)?.ownerTimelineSeq, progressOwnerSeq);
assert.equal(progressCommit(2, {
  t: "assistant_start",
  id: "assistant_child_progress",
  turnId: childTurnId,
}, now + 31).kind, "committed");
const toolBlock = {
  type: "toolCall" as const,
  id: "child_tool_0",
  name: "read_file",
  toolKind: "read" as const,
  path: "fixture.txt",
  arguments: { path: "fixture.txt" },
};
assert.equal(progressCommit(3, {
  t: "assistant_update",
  id: "assistant_child_progress",
  blocks: [toolBlock],
  turnId: childTurnId,
}, now + 32).kind, "committed");
const readyEvent = {
  t: "tool_status" as const,
  id: toolBlock.id,
  status: "ready" as const,
  turnId: childTurnId,
};
assert.equal(progressCommit(4, readyEvent, now + 33).kind, "committed");
assert.equal(progressCommit(4, readyEvent, now + 33).kind, "duplicate", "same cursor + hash is idempotent");
assert.throws(() => progressCommit(4, { ...readyEvent, status: "running" }, now + 33), /Conflicting/);
assert.throws(() => progressCommit(6, {
  t: "tool_status",
  id: toolBlock.id,
  status: "running",
  turnId: childTurnId,
}, now + 34), /sequence contains a gap/);
assert.equal(joinedTaskProgressDao.commit({
  userId,
  taskId: progressTask.id,
  expectedLeaseGeneration: progressRunning.leaseGeneration - 1,
  progressSeq: 5,
  ownerTimelineSeq: progressOwnerSeq,
  event: { t: "turn_end", turnId: childTurnId, status: "failed", completedAt: now + 34, durationMs: 4 },
  at: now + 34,
}).kind, "stale");
assert.throws(() => progressCommit(5, {
  t: "subagent_event",
  parentId: "recursive",
  event: { t: "turn_start", turnId: "nested", startedAt: now + 34 },
}, now + 34), /Unsupported joined Child progress event/);
const oversizedProjection = progressCommit(5, {
  t: "assistant_update",
  id: "assistant_child_progress",
  blocks: [{ type: "text", text: "x".repeat(JOINED_PROGRESS_MAX_EVENT_BYTES + 1) }],
  turnId: childTurnId,
}, now + 34);
assert.equal(oversizedProjection.kind, "committed");
assert.equal(oversizedProjection.kind === "committed" ? oversizedProjection.wire : null, "snapshot");
assert.equal(oversizedProjection.kind === "committed" ? oversizedProjection.legacyFallback : null, false,
  "an oversized provider event is never echoed across the compatibility wire");
assert.equal(joinedTaskProgressDao.byTask(userId, progressTask.id)?.omittedItems, 1);

let progressSeq = 5;
progressSeq += 1;
assert.equal(progressCommit(progressSeq, {
  t: "assistant_end",
  id: "assistant_child_progress",
  blocks: [toolBlock],
  turnId: childTurnId,
}, now + 35).kind, "committed");
progressSeq += 1;
assert.equal(progressCommit(progressSeq, {
  t: "tool_end",
  id: toolBlock.id,
  status: "success",
  resultText: "done",
  isError: false,
  name: toolBlock.name,
  toolKind: toolBlock.toolKind,
  path: toolBlock.path,
  arguments: toolBlock.arguments,
  turnId: childTurnId,
}, now + 36).kind, "committed");
progressSeq += 1;
assert.equal(progressCommit(progressSeq, {
  t: "tool_start",
  id: "child_live_guard",
  name: "read_file",
  toolKind: "read",
  arguments: {},
  turnId: childTurnId,
}, now + 37).kind, "committed");
progressSeq += 1;
assert.equal(progressCommit(progressSeq, {
  t: "tool_status",
  id: "child_live_guard",
  status: "running",
  runningElapsedMs: 0,
  turnId: childTurnId,
}, now + 38).kind, "committed");

const longProgressStarted = performance.now();
let sawCompactedLegacyFallback = false;
for (let index = 1; index <= 1_100; index += 1) {
  progressSeq += 1;
  const checkpoint = progressCommit(progressSeq, {
    t: "tool_end",
    id: `child_tool_${index}`,
    status: "success",
    resultText: `read ${index}`,
    isError: false,
    name: "read_file",
    toolKind: "read",
    path: `fixture-${index}.txt`,
    arguments: { path: `fixture-${index}.txt` },
    turnId: childTurnId,
  }, now + 34 + index);
  assert.equal(checkpoint.kind, "committed");
  if (checkpoint.kind === "committed" && checkpoint.wire === "snapshot" && checkpoint.legacyFallback) {
    sawCompactedLegacyFallback = true;
  }
}
const boundedBefore = joinedTaskProgressDao.byTask(userId, progressTask.id)!;
const longProgressElapsedMs = performance.now() - longProgressStarted;
assert.ok(longProgressElapsedMs < timeBudgetMs(5_000), "1,100 progress checkpoints remain bounded");
assert.ok(boundedBefore.items.length <= JOINED_PROGRESS_MAX_ITEMS);
assert.ok(boundedBefore.bytes <= JOINED_PROGRESS_MAX_BYTES);
assert.ok(boundedBefore.omittedItems > 900);
assert.equal(sawCompactedLegacyFallback, true,
  "a bounded snapshot retains one ordinary semantic fallback for protocol-v5 readers");
assert.ok(boundedBefore.items.some((item) => item.kind === "tool" && item.id === "child_tool_1100"));
assert.ok(boundedBefore.items.some((item) =>
  item.kind === "tool" && item.id === "child_live_guard" && item.status === "running"),
"compaction never trades an older live row for a terminal row");
assert.equal(new Set(boundedBefore.items.map((item) => item.seq)).size, boundedBefore.items.length);
assert.ok(boundedBefore.nestedSeqHighwater >= Math.max(...boundedBefore.items.map((item) => item.seq)));
assert.equal(
  boundedBefore.items.find((item) => item.id === "child_tool_1100")?.seq,
  boundedBefore.nestedSeqHighwater,
  "post-compaction allocation continues above every omitted seq",
);
const compactedParent = timelineDao.atSeq("session_owner", progressOwnerSeq) as Extract<TimelineItem, { kind: "tool" }>;
assert.deepEqual(compactedParent.children, boundedBefore.items, "durable owner replay matches the bounded snapshot");
assert.equal(compactedParent.childProgress?.omittedItems, boundedBefore.omittedItems,
  "durable owner replay carries omission pressure without inventing a Timeline row kind");
const compactedLive = reduceTimeline([{
  ...compactedParent,
  children: [],
  childProgress: { ...compactedParent.childProgress!, lastSeq: 5 },
}], {
  t: "subagent_snapshot",
  parentId: compactedParent.id,
  children: compactedParent.children ?? [],
  progress: compactedParent.childProgress!,
});
assert.deepEqual(
  (compactedLive[0] as Extract<TimelineItem, { kind: "tool" }>).children,
  boundedBefore.items,
  "authoritative compaction wire converges the live reducer with replay",
);
assert.throws(() => progressCommit(progressSeq + 1, {
  t: "turn_end",
  turnId: childTurnId,
  status: "completed",
  completedAt: now + 1_199,
  durationMs: 1_169,
}, now + 1_199), /cannot leave projected Steps in progress/,
"compaction cannot hide a live Step from the terminal invariant");
assert.equal(joinedTaskProgressDao.byTask(userId, progressTask.id)?.lastSeq, progressSeq);
progressSeq += 1;
assert.equal(progressCommit(progressSeq, {
  t: "tool_end",
  id: "child_live_guard",
  status: "success",
  resultText: "settled",
  isError: false,
  turnId: childTurnId,
}, now + 1_199).kind, "committed");
progressSeq += 1;
const completedProgress = progressCommit(progressSeq, {
  t: "turn_end",
  turnId: childTurnId,
  status: "completed",
  completedAt: now + 1_200,
  durationMs: 1_170,
}, now + 1_200);
assert.equal(completedProgress.kind, "committed");
assert.equal(joinedTaskProgressDao.byTask(userId, progressTask.id)?.status, "completed");
const settledLongProgress = taskResultDao.settle({
  id: "result_joined_progress",
  taskId: progressTask.id,
  userId,
  summary: "Long joined work completed",
  body: {},
  artifacts: [],
  expectedTaskVersion: progressRunning.version,
  expectedLeaseGeneration: progressRunning.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now + 1_201,
})!;
assert.equal(settledLongProgress.task.status, "succeeded", "UI projection pressure never fails Child work");
agentTurnDao.complete("session_owner", progressTurnId, "completed", now + 1_201);
assert.equal(joinedTaskProgressDao.commit({
  userId,
  taskId: progressTask.id,
  expectedLeaseGeneration: progressRunning.leaseGeneration,
  progressSeq: progressSeq + 1,
  ownerTimelineSeq: progressOwnerSeq,
  event: { t: "turn_end", turnId: childTurnId, status: "completed", completedAt: now + 1_202, durationMs: 1 },
  at: now + 1_202,
}).kind, "stale", "a settled Task rejects its old worker");

const recoveryTurnId = "turn_joined_recovery";
const recoveryStepId = "step_joined_recovery";
const recoveryOwnerSeq = 51;
agentTurnDao.start({
  id: recoveryTurnId,
  sessionId: "session_owner",
  startedAt: now + 1_203,
  provider: "mock",
  model: "mock",
});
timelineDao.append("session_owner", {
  kind: "tool",
  id: recoveryStepId,
  seq: recoveryOwnerSeq,
  name: "spawn_subagent",
  toolKind: "subagent",
  arguments: {},
  status: "running",
  ts: now + 1_203,
  turnId: recoveryTurnId,
});
const recoveryTask = runtimeTaskDao.create({
  id: "task_joined_recovery",
  userId,
  sessionId: "session_owner",
  ownerSessionId: "session_owner",
  ownerTurnId: recoveryTurnId,
  ownerStepId: recoveryStepId,
  agentId: progressChild.id,
  kind: "delegation",
  title: "Joined recovery",
  payload: {},
  awaitPolicy: "join",
  cancelPolicy: "linked",
  checkpointSafe: false,
  createdAt: now + 1_204,
});
const recoveryClaim = runtimeTaskDao.claim({
  id: recoveryTask.id,
  userId,
  expectedVersion: recoveryTask.version,
  at: now + 1_205,
})!;
const recoveryRunning = runtimeTaskDao.transition({
  id: recoveryTask.id,
  userId,
  expectedVersion: recoveryClaim.version,
  expectedLeaseGeneration: recoveryClaim.leaseGeneration,
  nextStatus: "running",
  at: now + 1_206,
})!;
const recoveryCommit = (recoverySeq: number, event: Parameters<typeof joinedTaskProgressDao.commit>[0]["event"]) =>
  joinedTaskProgressDao.commit({
    userId,
    taskId: recoveryTask.id,
    expectedLeaseGeneration: recoveryRunning.leaseGeneration,
    progressSeq: recoverySeq,
    ownerTimelineSeq: recoveryOwnerSeq,
    event,
    at: now + 1_206 + recoverySeq,
  });
assert.equal(recoveryCommit(1, {
  t: "turn_start",
  turnId: "turn_child_recovery_fixture",
  startedAt: now + 1_207,
}).kind, "committed");
assert.equal(recoveryCommit(2, {
  t: "tool_start",
  id: "recovery_running_tool",
  name: "read_file",
  toolKind: "read",
  arguments: {},
  turnId: "turn_child_recovery_fixture",
}).kind, "committed");
const recoveryAt = now + 1_210;
const interruptedProgressTask = runtimeTaskDao.transition({
  id: recoveryTask.id,
  userId,
  expectedVersion: recoveryRunning.version,
  expectedLeaseGeneration: recoveryRunning.leaseGeneration,
  nextStatus: "interrupted",
  at: recoveryAt,
})!;
assert.equal(interruptedProgressTask.status, "interrupted");
const recoveredProgress = joinedTaskProgressDao.byTask(userId, recoveryTask.id)!;
assert.equal(recoveredProgress.status, "interrupted");
assert.equal(recoveredProgress.source, "recovery");
assert.equal(recoveredProgress.lastSeq, 3, "recovery owns one explicit terminal cursor");
assert.equal(recoveredProgress.updatedAt, recoveryAt);
assert.ok(recoveredProgress.items.every((item) =>
  item.kind !== "tool" || (item.status === "denied" && item.termination === "cancelled")));
const recoveredParent = timelineDao.atSeq("session_owner", recoveryOwnerSeq) as Extract<TimelineItem, { kind: "tool" }>;
assert.equal(recoveredParent.childProgress?.source, "recovery");
assert.equal(recoveredParent.childProgress?.status, "interrupted");
assert.equal(recoveredParent.childProgress?.lastSeq, recoveredProgress.lastSeq);
assert.equal(joinedTaskProgressDao.commit({
  userId,
  taskId: recoveryTask.id,
  expectedLeaseGeneration: recoveryRunning.leaseGeneration,
  progressSeq: 3,
  ownerTimelineSeq: recoveryOwnerSeq,
  event: { t: "turn_end", turnId: "turn_child_recovery_fixture", status: "completed", completedAt: recoveryAt, durationMs: 1 },
  at: recoveryAt,
}).kind, "stale", "a fenced worker cannot overwrite recovery");
agentTurnDao.complete("session_owner", recoveryTurnId, "interrupted", recoveryAt);
assert.ok(agentNodeDao.transitionStatus({
  id: progressChild.id,
  userId,
  expectedVersion: progressChild.version,
  nextStatus: "idle",
  at: recoveryAt,
}));
console.log(
  `  ✓ 1,100 joined Steps: ${longProgressElapsedMs.toFixed(1)}ms, `
  + `${boundedBefore.items.length} retained rows, ${boundedBefore.bytes} bytes`,
);

const fifoChild = createChildAgent("agent_fifo", "/root/fifo");
const fifoFirst = createTask("task_z_created_first", { agentId: fifoChild.id, at: now + 26 });
const fifoSecond = createTask("task_a_created_second", { agentId: fifoChild.id, at: now + 26 });
assert.deepEqual([fifoFirst.agentOrd, fifoSecond.agentOrd], [1, 2]);
assert.equal(runtimeTaskDao.claim({
  id: fifoSecond.id,
  userId,
  expectedVersion: fifoSecond.version,
  at: now + 27,
}), null, "same-millisecond UUID ordering cannot overtake durable Agent FIFO order");
const fifoFirstClaim = runtimeTaskDao.claim({
  id: fifoFirst.id,
  userId,
  expectedVersion: fifoFirst.version,
  at: now + 27,
})!;
runtimeTaskDao.transition({
  id: fifoFirst.id,
  userId,
  expectedVersion: fifoFirstClaim.version,
  expectedLeaseGeneration: fifoFirstClaim.leaseGeneration,
  nextStatus: "interrupted",
  at: now + 28,
});
const fifoSecondClaim = runtimeTaskDao.claim({
  id: fifoSecond.id,
  userId,
  expectedVersion: fifoSecond.version,
  at: now + 29,
})!;
runtimeTaskDao.transition({
  id: fifoSecond.id,
  userId,
  expectedVersion: fifoSecondClaim.version,
  expectedLeaseGeneration: fifoSecondClaim.leaseGeneration,
  nextStatus: "interrupted",
  at: now + 30,
});
assert.ok(agentNodeDao.transitionStatus({
  id: fifoChild.id,
  userId,
  expectedVersion: fifoChild.version,
  nextStatus: "idle",
  at: now + 30,
}));
console.log("  ✓ Agent FIFO is creation-ordered even when timestamps tie and ids sort backwards");

const ownerCascadeTask = createTask("task_owner_cascade", {
  ownerSessionId: "session_task_owner",
  at: now + 21,
});
const revisionBeforeOwnerCascade = agentNodeDao.roster(userId, root.id)!.revision;
sessionDao.delete("session_task_owner");
assert.equal(runtimeTaskDao.byId(userId, ownerCascadeTask.id), undefined);
assert.equal(
  agentNodeDao.roster(userId, root.id)?.revision,
  revisionBeforeOwnerCascade + 1,
  "owner-Session cascades invalidate the surviving Agent tree",
);

const contextTask = createTask("task_context", { at: now + 22 });
const contextClaim = runtimeTaskDao.claim({
  id: contextTask.id,
  userId,
  expectedVersion: contextTask.version,
  at: now + 23,
})!;
const contextRunning = runtimeTaskDao.transition({
  id: contextTask.id,
  userId,
  expectedVersion: contextClaim.version,
  expectedLeaseGeneration: contextClaim.leaseGeneration,
  nextStatus: "running",
  at: now + 24,
})!;
const transcriptMessages = [
  { role: "user", content: "first assignment", timestamp: now + 22 },
  {
    role: "assistant",
    content: [{ type: "text", text: "done 界" }],
    api: "mock",
    provider: "mock",
    model: "mock",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: now + 24,
  },
];
const transcript = agentMessageDao.replaceFromTask({
  userId,
  agentId: child.id,
  taskId: contextTask.id,
  leaseGeneration: contextRunning.leaseGeneration,
  expectedVersion: 0,
  messages: transcriptMessages,
  savedAt: now + 25,
});
assert.equal(transcript?.version, 1);
assert.deepEqual(agentMessageDao.load(userId, child.id), { version: 1, messages: transcriptMessages });
transcriptMessages[0]!.content = "mutated after persistence";
assert.equal((transcript?.messages[0] as { content: string }).content, "first assignment");
assert.equal((agentMessageDao.load(userId, child.id)?.messages[0] as { content: string }).content, "first assignment");
assert.equal(agentMessageDao.load(otherUserId, child.id), undefined, "Agent transcript reads are user scoped");
assert.equal(agentMessageDao.replaceFromTask({
  userId,
  agentId: child.id,
  taskId: contextTask.id,
  leaseGeneration: contextRunning.leaseGeneration,
  expectedVersion: 0,
  messages: [{ role: "user", content: "stale", timestamp: now + 25 }],
  savedAt: now + 26,
}), null, "a stale transcript writer loses its CAS");
assert.throws(
  () => agentMessageDao.replaceFromTask({
    userId,
    agentId: child.id,
    taskId: contextTask.id,
    leaseGeneration: contextRunning.leaseGeneration,
    expectedVersion: 1,
    messages: Array.from({ length: AGENT_TRANSCRIPT_MAX_MESSAGES + 1 }, () => null),
    savedAt: now + 27,
  }),
  /exceeds .* messages/,
);
assert.equal(agentMessageDao.load(userId, child.id)?.messages.length, 2, "a rejected replacement keeps prior context");
assert.throws(() => agentMessageDao.replaceFromTask({
  userId,
  agentId: child.id,
  taskId: contextTask.id,
  leaseGeneration: contextRunning.leaseGeneration,
  expectedVersion: 1,
  messages: [{ role: "assistant", content: [], timestamp: now + 27 }],
  savedAt: now + 27,
}), /assistant message .* incomplete/);
assert.throws(() => agentMessageDao.replaceFromTask({
  userId,
  agentId: child.id,
  taskId: contextTask.id,
  leaseGeneration: contextRunning.leaseGeneration,
  expectedVersion: 1,
  messages: [{
    role: "assistant",
    content: [],
    api: "mock",
    provider: "mock",
    model: "mock",
    usage: {},
    stopReason: "stop",
    timestamp: now + 27,
  }],
  savedAt: now + 27,
}), /assistant usage .* incomplete/);
assert.throws(() => agentMessageDao.replaceFromTask({
  userId,
  agentId: child.id,
  taskId: contextTask.id,
  leaseGeneration: contextRunning.leaseGeneration,
  expectedVersion: 1,
  messages: [{ role: "user", content: [null, { type: "bogus" }], timestamp: now + 27 }],
  savedAt: now + 27,
}), /invalid content block/);
const contextDone = runtimeTaskDao.transition({
  id: contextTask.id,
  userId,
  expectedVersion: contextRunning.version,
  expectedLeaseGeneration: contextRunning.leaseGeneration,
  nextStatus: "succeeded",
  at: now + 28,
});
assert.ok(contextDone);
console.log("  ✓ child Agent transcript replacement is bounded, atomic, and user scoped");

const utf8OverPayload = "界".repeat(Math.floor(TASK_PAYLOAD_MAX_BYTES / 3) + 1);
assert.throws(
  () => runtimeTaskDao.create({
    id: "task_payload_too_large",
    userId,
    sessionId: "session_owner",
    ownerSessionId: "session_owner",
    agentId: child.id,
    kind: "delegation",
    title: "oversize",
    payload: utf8OverPayload,
    awaitPolicy: "join",
    cancelPolicy: "linked",
    checkpointSafe: false,
    createdAt: now + 30,
  }),
  /exceeds .* UTF-8 bytes/,
);
assert.throws(
  () => taskResultDao.create({
    id: "result_too_large",
    taskId: task.id,
    userId,
    summary: "oversize",
    body: "界".repeat(Math.floor(TASK_RESULT_BODY_MAX_BYTES / 3) + 1),
    artifacts: [],
    expectedTaskVersion: succeeded!.version,
    expectedLeaseGeneration: succeeded!.leaseGeneration,
    createdAt: now + 31,
  }),
  /exceeds .* UTF-8 bytes/,
);
assert.equal(runtimeTaskDao.byId(userId, "task_payload_too_large"), undefined);
console.log("  ✓ payload caps measure UTF-8 bytes before persistence");

const lockOne = createTask("task_agent_lock_one", { at: now + 40 });
const lockTwo = createTask("task_agent_lock_two", { at: now + 41 });
const lockOneClaim = runtimeTaskDao.claim({ id: lockOne.id, userId, expectedVersion: lockOne.version, at: now + 42 })!;
assert.equal(
  runtimeTaskDao.claim({ id: lockTwo.id, userId, expectedVersion: lockTwo.version, at: now + 42 }),
  null,
  "one Agent context cannot execute two Tasks concurrently",
);
const lockOneFailed = runtimeTaskDao.transition({
  id: lockOne.id,
  userId,
  expectedVersion: lockOneClaim.version,
  expectedLeaseGeneration: lockOneClaim.leaseGeneration,
  nextStatus: "failed",
  at: now + 43,
})!;
assert.equal(lockOneFailed.status, "failed");
const lockTwoClaim = runtimeTaskDao.claim({ id: lockTwo.id, userId, expectedVersion: lockTwo.version, at: now + 44 })!;
assert.equal(lockTwoClaim.status, "starting", "the next Task can claim after its Agent is free");
assert.ok(runtimeTaskDao.transition({
  id: lockTwo.id,
  userId,
  expectedVersion: lockTwoClaim.version,
  expectedLeaseGeneration: lockTwoClaim.leaseGeneration,
  nextStatus: "failed",
  at: now + 45,
}));
console.log("  ✓ one Agent owns at most one active Task lease");

const closedChild = createChildAgent("agent_closed", "/root/closed");
const closedNode = agentNodeDao.transitionStatus({
  id: closedChild.id,
  userId,
  expectedVersion: closedChild.version,
  nextStatus: "closed",
  at: now + 46,
})!;
assert.equal(closedNode.status, "closed");
const closedTask = createTask("task_closed_agent", { agentId: closedChild.id, at: now + 47 });
assert.equal(
  runtimeTaskDao.claim({ id: closedTask.id, userId, expectedVersion: closedTask.version, at: now + 48 }),
  null,
  "closed Agents cannot acquire new Task leases",
);
console.log("  ✓ closed Agent identities cannot be scheduled");

const safeChild = createChildAgent("agent_safe", "/root/safe");
const unsafeChild = createChildAgent("agent_unsafe", "/root/unsafe");
const waitingChild = createChildAgent("agent_waiting", "/root/waiting");
for (let i = 0; i < ORCHESTRATION_QUERY_MAX + 7; i += 1) {
  createTask(`task_page_${String(i).padStart(3, "0")}`, { at: now + 100 });
}
const laterSameAgent = createTask("task_fifo_later", { at: now + 101 });
assert.equal(
  runtimeTaskDao.claim({ id: laterSameAgent.id, userId, expectedVersion: laterSameAgent.version, at: now + 102 }),
  null,
  "a direct claimant cannot bypass an earlier non-terminal Task in the same Agent FIFO",
);
const capped = runtimeTaskDao.listBySession(userId, "session_owner", { limit: 10_000 });
assert.equal(capped.length, ORCHESTRATION_QUERY_MAX);
const page1 = runtimeTaskDao.listByOwner(userId, { ownerSessionId: "session_owner", limit: 11 });
const last = page1.at(-1)!;
const page2 = runtimeTaskDao.listByOwner(userId, {
  ownerSessionId: "session_owner",
  limit: 11,
  before: { updatedAt: last.updatedAt, id: last.id },
});
assert.equal(new Set([...page1, ...page2].map((value) => value.id)).size, page1.length + page2.length);
assert.ok(page1.every((value) => value.ownerSessionId === "session_owner"));
assert.equal(runtimeTaskDao.listBySession(otherUserId, "session_owner").length, 0);
const waitingTask = createTask("task_old_waiting", { agentId: waitingChild.id, at: now + 50 });
const waitingClaim = runtimeTaskDao.claim({
  id: waitingTask.id,
  userId,
  expectedVersion: waitingTask.version,
  at: now + 51,
})!;
const waitingRunning = runtimeTaskDao.transition({
  id: waitingTask.id,
  userId,
  expectedVersion: waitingClaim.version,
  expectedLeaseGeneration: waitingClaim.leaseGeneration,
  nextStatus: "running",
  at: now + 52,
})!;
const waiting = runtimeTaskDao.transition({
  id: waitingTask.id,
  userId,
  expectedVersion: waitingRunning.version,
  expectedLeaseGeneration: waitingRunning.leaseGeneration,
  nextStatus: "waiting",
  waitReason: "approval",
  at: now + 53,
})!;
const priorityRoster = agentNodeDao.roster(userId, root.id)!;
assert.equal(priorityRoster.tasks.length, ORCHESTRATION_QUERY_MAX);
assert.ok(priorityRoster.tasks.some((value) => value.id === waitingTask.id), "waiting Tasks survive the SQL bound");
assert.equal(priorityRoster.counts.waiting, 1);
assert.ok(priorityRoster.counts.tasks > priorityRoster.tasks.length, "full-tree counts survive bounded rows");
console.log("  ✓ Session and owner queries are user scoped, capped, and keyset paginated");

const unsafe = createTask("task_unsafe_restart", { agentId: unsafeChild.id, at: now + 300, checkpointSafe: false });
const safe = createTask("task_safe_restart", { agentId: safeChild.id, at: now + 301, checkpointSafe: true });
const queued = createTask("task_queued_restart", { at: now + 302, checkpointSafe: false });
function start(id: string, version: number, at: number) {
  const claim = runtimeTaskDao.claim({ id, userId, expectedVersion: version, at });
  assert.ok(claim);
  const active = runtimeTaskDao.transition({
    id,
    userId,
    expectedVersion: claim.version,
    expectedLeaseGeneration: claim.leaseGeneration,
    nextStatus: "running",
    at: at + 1,
  });
  assert.ok(active);
  return active;
}
const childRunningNode = agentNodeDao.transitionStatus({
  id: child.id,
  userId,
  expectedVersion: childIdle!.version,
  nextStatus: "running",
  at: now + 309,
})!;
assert.ok(childRunningNode);
assert.ok(agentNodeDao.transitionStatus({
  id: safeChild.id,
  userId,
  expectedVersion: safeChild.version,
  nextStatus: "running",
  at: now + 309,
}));
assert.ok(agentNodeDao.transitionStatus({
  id: unsafeChild.id,
  userId,
  expectedVersion: unsafeChild.version,
  nextStatus: "running",
  at: now + 309,
}));
assert.ok(agentNodeDao.transitionStatus({
  id: waitingChild.id,
  userId,
  expectedVersion: waitingChild.version,
  nextStatus: "running",
  at: now + 309,
}));
const unsafeActive = start(unsafe.id, unsafe.version, now + 310);
const safeActive = start(safe.id, safe.version, now + 312);
const revisionBeforeRecovery = agentNodeDao.roster(userId, root.id)!.revision;
const recovered = runtimeTaskDao.recoverAfterRestart(now + 320, "boot_fixture_a");
assert.deepEqual(recovered, { interrupted: 1, requeued: 1, waiting: 1, cancelled: 0 });
const unsafeAfter = runtimeTaskDao.byId(userId, unsafe.id)!;
assert.equal(unsafeAfter.status, "interrupted");
assert.equal(unsafeAfter.version, unsafeActive.version + 1);
const safeAfter = runtimeTaskDao.byId(userId, safe.id)!;
assert.equal(safeAfter.status, "queued", "checkpoint-safe work returns to the queue");
assert.equal(safeAfter.leaseGeneration, safeActive.leaseGeneration + 1, "recovery fences the old safe worker");
assert.equal(runtimeTaskDao.byId(userId, queued.id)?.status, "queued", "unclaimed work is not interrupted");
const waitingAfter = runtimeTaskDao.byId(userId, waiting.id)!;
assert.equal(waitingAfter.status, "waiting");
assert.equal(waitingAfter.waitReason, "approval", "restart cannot bypass a durable waiting condition");
assert.equal(taskEventDao.listRecent(userId, unsafe.id).at(-1)?.type, "recovered:interrupted");
assert.equal(
  agentNodeDao.roster(userId, root.id)?.revision,
  revisionBeforeRecovery + 3,
  "each recovered Task advances the shared tree revision",
);
const revisionBeforeAgentRecovery = agentNodeDao.roster(userId, root.id)!.revision;
assert.equal(agentNodeDao.recoverAfterRestart(now + 320), 4);
assert.equal(agentNodeDao.byId(userId, child.id)?.status, "interrupted");
assert.equal(agentNodeDao.byId(userId, safeChild.id)?.status, "interrupted");
assert.equal(agentNodeDao.byId(userId, unsafeChild.id)?.status, "interrupted");
assert.equal(agentNodeDao.byId(userId, waitingChild.id)?.status, "interrupted");
assert.equal(
  agentNodeDao.roster(userId, root.id)?.revision,
  revisionBeforeAgentRecovery + 1,
  "one recovery transaction invalidates each changed tree once",
);
assert.equal(agentNodeDao.recoverAfterRestart(now + 321), 0);
assert.deepEqual(
  runtimeTaskDao.recoverAfterRestart(now + 321, "boot_fixture_a"),
  { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 },
  "recovery is idempotent",
);
const waitingGenerationAfterFirstBoot = waitingAfter.leaseGeneration;
assert.deepEqual(
  runtimeTaskDao.recoverAfterRestart(now + 322, "boot_fixture_b"),
  { interrupted: 0, requeued: 0, waiting: 1, cancelled: 0 },
  "a new process generation fences a prior waiting callback",
);
assert.equal(
  runtimeTaskDao.byId(userId, waiting.id)?.leaseGeneration,
  waitingGenerationAfterFirstBoot + 1,
);
assert.equal(agentMessageDao.replaceFromTask({
  userId,
  agentId: waitingChild.id,
  taskId: waiting.id,
  leaseGeneration: waitingGenerationAfterFirstBoot,
  expectedVersion: 0,
  messages: [{ role: "user", content: "stale waiter", timestamp: now + 322 }],
  savedAt: now + 322,
}), null, "a previous process cannot write through a waiting Task lease");
console.log("  ✓ restart recovery interrupts unsafe work and requeues safe work with a new lease");

sessionDao.delete("session_owner");
assert.equal(agentNodeDao.roster(userId, root.id), undefined);
assert.equal(agentNodeDao.byId(userId, child.id), undefined);
assert.equal(runtimeTaskDao.byId(userId, task.id), undefined);
console.log("  ✓ deleting a Session cascades its complete local Agent tree");

const tableNames = (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_nodes','agent_rosters','agent_transcripts','agent_messages','runtime_tasks','task_events','task_progress','task_results','workflows','teams') ORDER BY name",
).all() as unknown as Array<{ name: string }>).map((row) => row.name);
assert.deepEqual(tableNames, ["agent_messages", "agent_nodes", "agent_rosters", "agent_transcripts", "runtime_tasks", "task_events", "task_progress", "task_results", "teams", "workflows"]);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("agent task store checks passed");
