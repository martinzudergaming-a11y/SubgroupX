import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamInternalTurnInput } from "../server/src/orchestration/team-turn-executor.ts";
import type { ProvisionTeamSessionInput } from "../server/src/orchestration/team-coordinator.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-team-v2-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "local");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

if (process.env.AGENT_TEAM_SCHEMA !== "fresh") {
  const legacy = new DatabaseSync(path.join(tmp, "agent-web.db"));
  legacy.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE teams (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, owner_session_id TEXT NOT NULL,
    root_agent_id TEXT, lead_agent_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (root_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_agent_id) REFERENCES agent_nodes(id) ON DELETE SET NULL
  );
  CREATE TABLE runtime_tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    owner_session_id TEXT NOT NULL, owner_turn_id TEXT, owner_step_id TEXT,
    agent_id TEXT NOT NULL, parent_task_id TEXT, workflow_id TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
    status TEXT NOT NULL, await_policy TEXT NOT NULL, cancel_policy TEXT NOT NULL,
    checkpoint_safe INTEGER NOT NULL DEFAULT 0, activity TEXT, wait_reason TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER
  );
  `);
  legacy.close();
}

const persistence = await import("../server/src/persistence/index.ts");
const {
  EXACT_TEAM_WORK_MAIL_SQL,
  agentNodeDao,
  agentTaskDao,
  agentTurnDao,
  db,
  runtimeTaskDao,
  sessionDao,
  taskEventDao,
  taskResultDao,
  teamDao,
  teamMailDao,
  teamTaskDao,
  teamTurnOutcomeDao,
  userDao,
} = persistence;
const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
const { TeamCommandService } = await import("../server/src/orchestration/team-command-service.ts");
const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
const { reconcileTeamProvisioning } = await import("../server/src/orchestration/team-provisioning-reconciler.ts");
const { RuntimeTaskDispatcher } = await import("../server/src/orchestration/runtime-task-dispatcher.ts");
const { SessionManager } = await import("../server/src/runtime/manager.ts");
const { registerMockProvider } = await import("../server/src/runtime/providers.ts");
registerMockProvider();
const sagaManager = new SessionManager();

assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('teams') WHERE name='root_agent_id'").get() as { n: number }).n, 1);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('runtime_tasks') WHERE name='team_id'").get() as { n: number }).n, 1);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('team_mail') WHERE name='deadline_at'").get() as { n: number }).n, 1);
assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_team_members_active_agent'").get(), undefined);
const exactWorkLookupPlan = db.prepare(`EXPLAIN QUERY PLAN ${EXACT_TEAM_WORK_MAIL_SQL}`)
  .all("task-plan", "user-plan") as unknown as Array<{ detail: string }>;
assert.ok(
  exactWorkLookupPlan.some((row) => row.detail.includes("idx_team_mail_work_task (task_id=?)")),
  `exact Team mail lookup must seek by Task:\n${exactWorkLookupPlan.map((row) => row.detail).join("\n")}`,
);

let now = 1_820_000_000_000;
let serial = 0;
const userId = "user_team";
const otherUserId = "user_other";
userDao.create({ id: userId, email: "team@example.invalid", password_hash: "x", created_at: now });
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
createSession("session_existing");
createSession("session_other", otherUserId);

const provisioned: string[] = [];
const retired: string[] = [];
const ids = (kind: string) => `${kind}_${++serial}`;
function provisionWithManager(input: ProvisionTeamSessionInput) {
  return sagaManager.createTeamMemberSession(
    input.userId,
    input.actorSessionId,
    input.title ?? `${input.teamName} · ${input.role}`,
    {
      teamId: input.teamId,
      reservationId: input.reservationId,
      sessionId: input.sessionId,
      generation: input.provisionGeneration,
      claimToken: input.provisionClaimToken,
    },
  );
}
const provisionSession = async (input: ProvisionTeamSessionInput) => {
  const session = provisionWithManager(input);
  provisioned.push(session.id);
  return { sessionId: session.id };
};
const owner = new TeamCoordinator({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: ids,
  provisionSession,
  retireProvisionedSession: async (sessionId) => { retired.push(sessionId); sessionDao.delete(sessionId); },
});

const created = await owner.create({
  name: "Release review",
  ownerRole: "lead",
  idempotencyKey: "create-release-review",
  roles: [{ role: "analyst" }, { role: "reviewer" }],
});
assert.equal(created.members.length, 3);
assert.equal(created.team.ownerSessionId, "session_owner");
assert.equal(created.team.rootAgentId, agentNodeDao.rootBySession(userId, "session_owner")!.id);
assert.equal(created.team.leadAgentId, agentNodeDao.rootBySession(userId, "session_owner")!.id);
for (const sessionId of provisioned) {
  assert.ok(sessionDao.byId(sessionId), "a product-created role is a navigable real Session");
  const root = agentNodeDao.rootBySession(userId, sessionId)!;
  assert.equal(root.sessionId, sessionId);
  assert.equal(root.id, root.rootAgentId);
  assert.equal(root.kind, "session");
}
assert.deepEqual(retired, []);
const createdReplay = await owner.create({
  name: "Release review",
  ownerRole: "lead",
  idempotencyKey: "create-release-review",
  roles: [{ role: "analyst" }, { role: "reviewer" }],
});
assert.equal(createdReplay.team.id, created.team.id);
assert.equal(provisioned.length, 2, "exact create replay does not provision new Sessions");
const replayPaused = owner.transitionTeam(teamDao.byId(userId, created.team.id)!, "paused")!;
const pausedCreateReplay = await owner.create({
  name: "Release review",
  ownerRole: "lead",
  idempotencyKey: "create-release-review",
  roles: [{ role: "analyst" }, { role: "reviewer" }],
});
assert.equal(pausedCreateReplay.team.status, "paused");
assert.equal(provisioned.length, 2);
owner.transitionTeam(replayPaused, "active");
await assert.rejects(() => owner.create({
  name: "Conflicting review",
  ownerRole: "lead",
  idempotencyKey: "create-release-review",
  roles: [{ role: "analyst" }, { role: "reviewer" }],
}), /idempotency key conflicts/);

const teamId = created.team.id;
const ownerMember = created.members.find((member) => member.sessionId === "session_owner")!;
const analyst = created.members.find((member) => member.role === "analyst")!;
const reviewer = created.members.find((member) => member.role === "reviewer")!;
const analystCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: analyst.sessionId,
  now: () => now,
  id: ids,
});
const reviewerCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: reviewer.sessionId,
  now: () => now,
  id: ids,
});

const roleTeam = owner.createFromSessions({
  name: "Role replay",
  members: [{ sessionId: "session_owner", role: "lead" }],
  leadSessionId: "session_owner",
});

const cursorService = new TeamCommandService({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: ids,
  provisionSession: async () => { throw new Error("cursor fixture must not provision a Session"); },
  retireSession: async () => { throw new Error("cursor fixture must not retire a Session"); },
});
type TeamCommandPage = {
  teams: Array<{ id: string }>;
  cursor: { at: number; id: string } | null;
};
const firstTeamPage = cursorService.mail({ action: "list", limit: 1 }) as unknown as TeamCommandPage;
assert.equal(firstTeamPage.teams.length, 1);
assert.ok(firstTeamPage.cursor);
assert.ok(Number.isSafeInteger(firstTeamPage.cursor.at));
const secondTeamPage = cursorService.mail({
  action: "list",
  limit: 1,
  before: firstTeamPage.cursor,
}) as unknown as TeamCommandPage;
assert.equal(secondTeamPage.teams.length, 1);
assert.notEqual(secondTeamPage.teams[0]!.id, firstTeamPage.teams[0]!.id);

const roleMember = await owner.addRole(roleTeam.team.id, {
  role: "observer",
  idempotencyKey: "role-observer",
});
const provisionCountAfterRole = provisioned.length;
const roleReplay = await owner.addRole(roleTeam.team.id, {
  role: "observer",
  idempotencyKey: "role-observer",
});
assert.equal(roleReplay.id, roleMember.id);
assert.equal(provisioned.length, provisionCountAfterRole);

let cleanupSerial = 0;
let cleanupSessionId = "";
let cleanupAvailable = false;
const cleanupCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: (kind) => `${kind}_cleanup_${++cleanupSerial}`,
  provisionSession: async (input) => {
    cleanupSessionId = input.sessionId;
    provisionWithManager(input);
    throw new Error("fixture failed after Session creation");
  },
  retireProvisionedSession: async (sessionId) => {
    if (!cleanupAvailable) throw new Error("fixture cleanup unavailable");
    sessionDao.delete(sessionId);
  },
});
await assert.rejects(() => cleanupCoordinator.addRole(roleTeam.team.id, {
  role: "cleanup-proof",
  idempotencyKey: "role-cleanup-proof",
}), /cleanup remains pending/);
assert.ok(sessionDao.byId(cleanupSessionId));
const pendingCleanup = teamDao.recoverMemberReservations(now + 1).retire
  .find((entry) => entry.sessionId === cleanupSessionId)!;
assert.ok(pendingCleanup, "failed cleanup remains durable across recovery");
cleanupAvailable = true;
await assert.rejects(() => cleanupCoordinator.addRole(roleTeam.team.id, {
  role: "cleanup-proof",
  idempotencyKey: "role-cleanup-proof",
}), /cleanup completed/);
assert.equal(sessionDao.byId(cleanupSessionId), undefined);
assert.equal(
  teamDao.recoverMemberReservations(now + 3).retire.some((entry) => entry.sessionId === cleanupSessionId),
  false,
);
await assert.rejects(() => cleanupCoordinator.addRole(roleTeam.team.id, {
  role: "cleanup-proof",
  idempotencyKey: "role-cleanup-proof",
}), /operation is closed/);

const originalFailMemberProvisionClaim = teamDao.failMemberProvisionClaim;
const createProvisionError = new Error("fixture create provision failed");
const createCleanupError = new Error("fixture create cleanup failed");
let createFaultInput: ProvisionTeamSessionInput | undefined;
let createAggregate: unknown;
const aggregateCreateCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: (kind) => `${kind}_aggregate_create_${++serial}`,
  provisionSession: async (input) => {
    createFaultInput = input;
    teamDao.failMemberProvisionClaim = () => { throw createCleanupError; };
    throw createProvisionError;
  },
  retireProvisionedSession: async () => {},
});
try {
  await assert.rejects(
    () => aggregateCreateCoordinator.create({
      name: "Aggregate create fault",
      idempotencyKey: "create-aggregate-fault",
      roles: [{ role: "fault-probe" }],
    }),
    (error) => {
      createAggregate = error;
      return true;
    },
  );
} finally {
  teamDao.failMemberProvisionClaim = originalFailMemberProvisionClaim;
}
assert.ok(createAggregate instanceof AggregateError);
assert.equal(createAggregate.errors[0], createProvisionError);
assert.equal(createAggregate.errors[1], createCleanupError);
assert.ok(createFaultInput);
const createFaultTeam = db.prepare(
  "SELECT team_id FROM team_member_reservations WHERE id = ?",
).get(createFaultInput.reservationId) as { team_id: string };
assert.equal(originalFailMemberProvisionClaim({
  reservationId: createFaultInput.reservationId,
  userId,
  actorSessionId: "session_owner",
  teamId: createFaultTeam.team_id,
  generation: createFaultInput.provisionGeneration,
  claimToken: createFaultInput.provisionClaimToken,
  at: now,
}).owned, true);

const roleProvisionError = new Error("fixture role provision failed");
const roleCleanupError = new Error("fixture role cleanup failed");
let roleFaultInput: ProvisionTeamSessionInput | undefined;
let roleAggregate: unknown;
const aggregateRoleCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: (kind) => `${kind}_aggregate_role_${++serial}`,
  provisionSession: async (input) => {
    roleFaultInput = input;
    teamDao.failMemberProvisionClaim = () => { throw roleCleanupError; };
    throw roleProvisionError;
  },
  retireProvisionedSession: async () => {},
});
try {
  await assert.rejects(
    () => aggregateRoleCoordinator.addRole(roleTeam.team.id, {
      role: "aggregate-fault",
      idempotencyKey: "role-aggregate-fault",
    }),
    (error) => {
      roleAggregate = error;
      return true;
    },
  );
} finally {
  teamDao.failMemberProvisionClaim = originalFailMemberProvisionClaim;
}
assert.ok(roleAggregate instanceof AggregateError);
assert.equal(roleAggregate.errors[0], roleProvisionError);
assert.equal(roleAggregate.errors[1], roleCleanupError);
assert.ok(roleFaultInput);
assert.equal(originalFailMemberProvisionClaim({
  reservationId: roleFaultInput.reservationId,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  generation: roleFaultInput.provisionGeneration,
  claimToken: roleFaultInput.provisionClaimToken,
  at: now,
}).owned, true);

let partialSerial = 0;
const partialSessions: string[] = [];
const partialCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: "session_owner",
  now: () => now,
  id: (kind) => `${kind}_partial_${++partialSerial}`,
  provisionSession: async (input) => {
    const { sessionId } = input;
    const operation = db.prepare(
      `SELECT team.status, team.provision_state,
         (SELECT COUNT(*) FROM team_member_reservations reservation
          WHERE reservation.team_id = team.id) AS reservations
       FROM teams team JOIN team_member_reservations reservation ON reservation.team_id = team.id
       WHERE reservation.provisioned_session_id = ?`,
    ).get(sessionId) as { status: string; provision_state: string; reservations: number };
    assert.equal(operation.status, "paused");
    assert.equal(operation.provision_state, "provisioning");
    assert.equal(operation.reservations, 2);
    provisionWithManager(input);
    partialSessions.push(sessionId);
    if (partialSessions.length === 2) throw new Error("fixture second role failed");
    return { sessionId };
  },
  retireProvisionedSession: async (sessionId) => { sessionDao.delete(sessionId); },
});
await assert.rejects(() => partialCoordinator.create({
  name: "Partial create",
  idempotencyKey: "create-partial-proof",
  roles: [{ role: "one" }, { role: "two" }],
}), /second role failed/);
const failedProvision = db.prepare(
  `SELECT id, status, provision_state FROM teams
   WHERE user_id = ? AND owner_session_id = ? AND provision_key = ?`,
).get(userId, "session_owner", "create-partial-proof") as {
  id: string;
  status: string;
  provision_state: string;
};
assert.deepEqual(
  { status: failedProvision.status, provision_state: failedProvision.provision_state },
  { status: "closed", provision_state: "failed" },
);
assert.ok(partialSessions.every((sessionId) => !sessionDao.byId(sessionId)));
assert.equal(
  (db.prepare(
    `SELECT COUNT(*) AS count FROM team_member_reservations
     WHERE team_id = ? AND status <> 'cancelled'`,
  ).get(failedProvision.id) as { count: number }).count,
  0,
);

const ownerRoot = agentNodeDao.rootBySession(userId, "session_owner")!;
function beginCrashTeam(prefix: string, roleCount: number, at = Date.now()) {
  return teamDao.beginProvisioned({
    id: `team_${prefix}`,
    userId,
    ownerSessionId: "session_owner",
    actorSessionId: "session_owner",
    rootAgentId: ownerRoot.id,
    ownerMember: {
      id: `member_${prefix}_owner`,
      sessionId: "session_owner",
      agentId: ownerRoot.id,
      role: "lead",
    },
    name: `Crash ${prefix}`,
    idempotencyKey: `create-${prefix}`,
    request: { name: `Crash ${prefix}`, roles: roleCount },
    roles: Array.from({ length: roleCount }, (_, index) => ({
      reservationId: `reservation_${prefix}_${index}`,
      operationKey: `role-${index}`,
      request: { role: `worker-${index}`, title: `Worker ${index}` },
      role: `worker-${index}`,
      provisionedSessionId: `session_${prefix}_${index}`,
      provisionedAgentId: `agent_${prefix}_${index}`,
      memberId: `member_${prefix}_${index}`,
    })),
    createdAt: at,
  });
}

const slowTeam = beginCrashTeam("slow_publish", 2);
const slowFirst = teamDao.claimMemberProvision({
  reservationId: slowTeam.reservations[0]!.id,
  userId,
  actorSessionId: "session_owner",
  teamId: slowTeam.snapshot.team.id,
  claimToken: "claim-slow-first",
  at: Date.now(),
});
assert.equal(slowFirst.state, "claimed");
if (slowFirst.state !== "claimed") throw new Error("slow first role was not claimed");
const slowSession = sagaManager.createTeamMemberSession(
  userId,
  "session_owner",
  "Slow first role",
  {
    teamId: slowTeam.snapshot.team.id,
    reservationId: slowFirst.claim.reservation.id,
    sessionId: slowFirst.claim.reservation.provisionedSessionId,
    generation: slowFirst.claim.generation,
    claimToken: slowFirst.claim.claimToken,
  },
);
teamDao.finalizeReservedMember({
  reservationId: slowFirst.claim.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: slowTeam.snapshot.team.id,
  generation: slowFirst.claim.generation,
  claimToken: slowFirst.claim.claimToken,
  member: {
    id: slowFirst.claim.reservation.memberId,
    sessionId: slowSession.id,
    agentId: slowFirst.claim.reservation.provisionedAgentId,
    role: slowFirst.claim.reservation.role,
  },
  at: Date.now(),
});
assert.equal(sessionDao.byId(slowSession.id)!.team_provision_state, "provisional");
assert.equal(sagaManager.listSessions(userId).some((session) => session.id === slowSession.id), false);
assert.equal(sagaManager.getSessionInfo(userId, slowSession.id), null);
assert.equal(sagaManager.getRuntime(userId, slowSession.id), null);
assert.deepEqual(sagaManager.tryStartTurn(userId, slowSession.id, "must not run"), { error: "not-found" });
assert.equal(agentTurnDao.list(slowSession.id).length, 0);

const slowSecond = teamDao.claimMemberProvision({
  reservationId: slowTeam.reservations[1]!.id,
  userId,
  actorSessionId: "session_owner",
  teamId: slowTeam.snapshot.team.id,
  claimToken: "claim-slow-second",
  at: Date.now(),
});
assert.equal(slowSecond.state, "claimed");
if (slowSecond.state !== "claimed") throw new Error("slow second role was not claimed");
const slowFailure = teamDao.failMemberProvisionClaim({
  reservationId: slowSecond.claim.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: slowTeam.snapshot.team.id,
  generation: slowSecond.claim.generation,
  claimToken: slowSecond.claim.claimToken,
  at: Date.now(),
});
assert.equal(slowFailure.owned, true);
assert.equal(slowFailure.retire.length, 1);
for (const cleanup of slowFailure.retire) {
  assert.equal(sagaManager.deleteSession(cleanup.userId, cleanup.sessionId), true);
  assert.equal(teamDao.completeMemberReservationCleanup({ ...cleanup, at: Date.now() }), true);
}
assert.equal(sessionDao.byId(slowSession.id), undefined);
assert.equal(teamDao.byId(userId, slowTeam.snapshot.team.id)!.status, "closed");

const crashTeam = beginCrashTeam("startup_no_client", 2);
const startupStats = sagaManager.reconcileTeamProvisioning(100);
assert.ok(startupStats.provisioned >= 2);
const crashSnapshot = teamDao.snapshot(userId, crashTeam.snapshot.team.id)!;
assert.equal(crashSnapshot.team.status, "active");
assert.equal(crashSnapshot.members.length, 3);
for (const reservation of crashTeam.reservations) {
  assert.equal(sessionDao.byId(reservation.provisionedSessionId)!.team_provision_state, "published");
  assert.ok(sagaManager.getSessionInfo(userId, reservation.provisionedSessionId));
}

const bulkTeams = Array.from({ length: 8 }, (_, teamIndex) =>
  beginCrashTeam(`bulk_${teamIndex}`, 15, Date.now() + teamIndex));
const bulkStats = sagaManager.reconcileTeamProvisioning(4_000);
assert.ok(bulkStats.provisioned >= 120);
assert.equal(
  bulkTeams.reduce((count, team) => count + team.reservations.filter((reservation) =>
    sessionDao.byId(reservation.provisionedSessionId)?.team_provision_state === "published").length, 0),
  120,
);
assert.ok(bulkTeams.every((team) => teamDao.byId(userId, team.snapshot.team.id)?.status === "active"));

const raceAt = Date.now();
const raceReserved = teamDao.reserveMember({
  id: "reservation-generation-race",
  operationKey: "generation-race",
  request: { role: "generation-race" },
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  role: "generation-race",
  provisionedSessionId: "session-generation-race",
  provisionedAgentId: "agent-generation-race",
  memberId: "member-generation-race",
  at: raceAt,
});
const generationOne = teamDao.claimMemberProvision({
  reservationId: raceReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  claimToken: "claim-generation-one",
  at: raceAt,
  leaseMs: 1_000,
});
assert.equal(generationOne.state, "claimed");
if (generationOne.state !== "claimed") throw new Error("first generation race claim was not acquired");
const expiredGenerationFailure = teamDao.failMemberProvisionClaim({
  reservationId: raceReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  generation: generationOne.claim.generation,
  claimToken: generationOne.claim.claimToken,
  at: raceAt + 1_001,
});
assert.deepEqual(expiredGenerationFailure, { owned: false, retire: [] });
const generationTwo = teamDao.claimMemberProvision({
  reservationId: raceReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  claimToken: "claim-generation-two",
  at: raceAt + 1_001,
  leaseMs: 30_000,
});
assert.equal(generationTwo.state, "claimed");
if (generationTwo.state !== "claimed") throw new Error("second generation race claim was not acquired");
assert.equal(generationTwo.claim.generation, generationOne.claim.generation + 1);
assert.throws(() => sagaManager.createTeamMemberSession(
  userId,
  "session_owner",
  "Late generation",
  {
    teamId: roleTeam.team.id,
    reservationId: raceReserved.reservation.id,
    sessionId: raceReserved.reservation.provisionedSessionId,
    generation: generationOne.claim.generation,
    claimToken: generationOne.claim.claimToken,
  },
), /claim is no longer active/);
assert.equal(sessionDao.byId(raceReserved.reservation.provisionedSessionId), undefined);
const raceSession = sagaManager.createTeamMemberSession(
  userId,
  "session_owner",
  "Current generation",
  {
    teamId: roleTeam.team.id,
    reservationId: raceReserved.reservation.id,
    sessionId: raceReserved.reservation.provisionedSessionId,
    generation: generationTwo.claim.generation,
    claimToken: generationTwo.claim.claimToken,
  },
);
teamDao.finalizeReservedMember({
  reservationId: raceReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  generation: generationTwo.claim.generation,
  claimToken: generationTwo.claim.claimToken,
  member: {
    id: raceReserved.reservation.memberId,
    sessionId: raceSession.id,
    agentId: raceReserved.reservation.provisionedAgentId,
    role: raceReserved.reservation.role,
  },
  at: raceAt + 1_002,
});
assert.equal(teamDao.failMemberProvisionClaim({
  reservationId: raceReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  generation: generationOne.claim.generation,
  claimToken: generationOne.claim.claimToken,
  at: raceAt + 1_003,
}).owned, false);
assert.ok(sagaManager.getSessionInfo(userId, raceSession.id));

const retryAt = Date.now();
const retryReserved = teamDao.reserveMember({
  id: "reservation-cleanup-dispatcher",
  operationKey: "cleanup-dispatcher",
  request: { role: "cleanup-dispatcher" },
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  role: "cleanup-dispatcher",
  provisionedSessionId: "session-cleanup-dispatcher",
  provisionedAgentId: "agent-cleanup-dispatcher",
  memberId: "member-cleanup-dispatcher",
  at: retryAt,
});
const retryClaim = teamDao.claimMemberProvision({
  reservationId: retryReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  claimToken: "claim-cleanup-dispatcher",
  at: retryAt,
});
assert.equal(retryClaim.state, "claimed");
if (retryClaim.state !== "claimed") throw new Error("cleanup retry claim was not acquired");
sagaManager.createTeamMemberSession(userId, "session_owner", "Cleanup retry", {
  teamId: roleTeam.team.id,
  reservationId: retryReserved.reservation.id,
  sessionId: retryReserved.reservation.provisionedSessionId,
  generation: retryClaim.claim.generation,
  claimToken: retryClaim.claim.claimToken,
});
const retryFailure = teamDao.failMemberProvisionClaim({
  reservationId: retryReserved.reservation.id,
  userId,
  actorSessionId: "session_owner",
  teamId: roleTeam.team.id,
  generation: retryClaim.claim.generation,
  claimToken: retryClaim.claim.claimToken,
  at: retryAt + 1,
});
assert.equal(retryFailure.retire.length, 1);
let cleanupDeleteAttempts = 0;
let cleanupControl: import("../server/src/runtime/manager.ts").RuntimeTaskDispatchControl | undefined;
const cleanupDispatcher = new RuntimeTaskDispatcher({
  isDraining: () => false,
  attachRuntimeTaskDispatcher(control) {
    cleanupControl = control;
    return () => { cleanupControl = undefined; };
  },
  runtimeTaskDispatchCapacity: () => ({ limit: 1, active: 0, offered: 0 }),
  activateRuntimeTaskRoot: () => "missing" as const,
  reconcileTeamProvisioning: () => reconcileTeamProvisioning({
    provision: () => { throw new Error("unexpected provision during cleanup test"); },
    retire: (cleanupUserId, sessionId) => {
      cleanupDeleteAttempts += 1;
      if (cleanupDeleteAttempts === 1) throw new Error("transient cleanup failure");
      if (!sagaManager.deleteSession(cleanupUserId, sessionId) && sessionDao.byId(sessionId)) {
        throw new Error("cleanup ownership changed");
      }
    },
  }, {
    now: () => retryAt + cleanupDeleteAttempts + 2,
    maxProvision: 1,
  }),
}, { truthScanMs: 10, scanPageSize: 10, scanPagesPerPump: 1 }).start();
const cleanupDeadline = Date.now() + 2_000;
while (sessionDao.byId(retryReserved.reservation.provisionedSessionId)) {
  if (Date.now() >= cleanupDeadline) throw new Error("dispatcher did not retry Team cleanup");
  await new Promise((resolve) => setTimeout(resolve, 5));
}
cleanupDispatcher.stopClaiming();
assert.ok(cleanupDeleteAttempts >= 2);
assert.equal(
  (db.prepare("SELECT status FROM team_member_reservations WHERE id = ?")
    .get(retryReserved.reservation.id) as { status: string }).status,
  "cancelled",
);

const second = owner.createFromSessions({
  name: "Second team",
  members: [
    { sessionId: "session_owner", role: "lead" },
    { sessionId: analyst.sessionId, role: "member" },
  ],
  leadSessionId: "session_owner",
});
assert.equal(teamDao.listForSession(userId, analyst.sessionId).length, 2);
assert.ok(second.members.some((member) => member.sessionId === analyst.sessionId));

assert.throws(() => teamDao.updateMemberRole({
  userId,
  actorSessionId: analyst.sessionId,
  teamId,
  memberId: reviewer.id,
  expectedVersion: reviewer.version,
  role: "forged-admin",
  at: now,
}), /owner or active lead/);
assert.throws(() => new TeamCoordinator({
  userId: otherUserId,
  actorSessionId: "session_other",
}).createFromSessions({
  name: "foreign",
  members: [{ sessionId: "session_owner", role: "lead" }],
  leadSessionId: "session_owner",
}), /owned|Session/);

const note = owner.send({
  teamId,
  targetMemberId: analyst.id,
  kind: "note",
  subject: "Review scope",
  payload: { text: "Check the release." },
  idempotencyKey: "note-1",
});
assert.equal(note.created, true);
assert.equal(note.mail.sourceMemberId, ownerMember.id);
assert.equal(note.mail.sourceSessionId, "session_owner");
assert.equal(note.mail.targetSessionId, analyst.sessionId);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get() as { n: number }).n, 0);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM timeline").get() as { n: number }).n, 0);

const firstClaim = analystCoordinator.claimInbox("attempt-a", 1_000)!;
assert.equal(firstClaim.id, note.mail.id);
assert.equal(analystCoordinator.claimInbox("attempt-a", 1_000)!.id, firstClaim.id);
assert.equal(analystCoordinator.claimInbox("attempt-b", 1_000), undefined);
now += 1_001;
assert.deepEqual(teamMailDao.recoverLeases(userId, now), { requeued: 1, cancelled: 0 });
const secondClaim = analystCoordinator.claimInbox("attempt-b", 2_000)!;
assert.equal(secondClaim.claimGeneration, 2);
assert.equal(analystCoordinator.acknowledge(firstClaim), null, "a stale delivery lease cannot acknowledge redelivery");
assert.ok(analystCoordinator.renewClaim(secondClaim, 2_000));
assert.equal(analystCoordinator.acknowledge(secondClaim)!.status, "acknowledged");

now += 10;
assert.throws(() => owner.assignWork({
  teamId,
  targetMemberId: analyst.id,
  title: "Unsupported joined work",
  payload: {},
  idempotencyKey: "work-join-rejected",
  awaitPolicy: "join" as never,
}), /background await only/);
assert.equal(
  teamMailDao.byIdempotency(userId, teamId, "session_owner", "work-join-rejected"),
  undefined,
);
const work = owner.assignWork({
  teamId,
  targetMemberId: analyst.id,
  title: "Audit release",
  payload: { request: "Find blocking issues." },
  idempotencyKey: "work-1",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 6, maxTokens: 30_000 },
  checkpointSafe: true,
});
assert.equal(work.task.kind, "team_turn");
assert.equal(work.task.teamId, teamId);
assert.equal(work.task.sessionId, analyst.sessionId);
assert.equal(work.task.agentId, analyst.agentId);
assert.equal(work.task.agentOrd, 1);
assert.equal(work.mail.taskId, work.task.id);
assert.deepEqual(work.mail.budget, { maxModelCycles: 6, maxTokens: 30_000 });
assert.deepEqual(teamTaskDao.listOpenBySession(userId, analyst.sessionId).map((task) => task.id), [work.task.id]);
assert.deepEqual(runtimeTaskDao.listOpenByRoot(userId, analyst.agentId), [], "AgentSupervisor projection excludes Team Tasks");
assert.equal(analystCoordinator.claimInbox("generic-work-attempt", 1_000), undefined);
assert.equal(teamMailDao.byTask(userId, work.task.id)!.status, "queued", "generic inbox cannot consume work mail");
assert.throws(() => runtimeTaskDao.create({ ...work.task, id: "forged-team", createdAt: now } as never), /atomic Team assignment/);
assert.throws(() => agentTaskDao.create({
  agent: {
    id: "forged-agent", userId, sessionId: analyst.sessionId, rootAgentId: analyst.agentId,
    parentAgentId: analyst.agentId, path: "/root/forged", kind: "subagent", purpose: "addressable",
    provider: "mock", model: "mock", status: "idle", createdAt: now,
  },
  task: { ...work.task, id: "forged-agent-task", agentId: "forged-agent", createdAt: now },
  initialMessages: [],
} as never), /delegation Tasks only/);

let gatewayRuns = 0;
const executor = () => new TeamTurnExecutor({
  userId,
  now: () => now,
  id: ids,
  mailLeaseMs: 10_000,
  gateway: {
    activateSession: (_userId, sessionId) => ({
      beginInternalTeamTurn: (input) => ({ accepted: true as const, completion: (async () => {
        gatewayRuns += 1;
        assert.equal(sessionId, analyst.sessionId);
        assert.equal(input.task.id, work.task.id);
        assert.deepEqual(input.assignment, { request: "Find blocking issues." });
        assert.deepEqual(input.budget, { maxModelCycles: 6, maxTokens: 30_000 });
        agentTurnDao.start({
          id: input.turnId,
          sessionId,
          startedAt: now,
          provider: "mock",
          model: "mock",
          acceptedInput: undefined,
          source: "team",
          teamTaskId: input.task.id,
          teamTaskLeaseGeneration: input.lease.taskGeneration,
          teamMailClaimGeneration: input.lease.claimGeneration,
        });
        await Promise.resolve();
        teamTaskDao.consumeRouteBudget({
          userId,
          taskId: input.task.id,
          modelCycles: 2,
          tokens: 1_200,
          at: now + 4,
        });
        agentTurnDao.complete(sessionId, input.turnId, "completed", now + 5);
        teamTurnOutcomeDao.record({
          taskId: input.task.id,
          userId,
          sessionId,
          turnId: input.turnId,
          taskLeaseGeneration: input.lease.taskGeneration,
          mailClaimGeneration: input.lease.claimGeneration,
          status: "completed",
          summary: "Audit complete",
          body: { finding: "none" },
          artifacts: [],
          at: now + 5,
        });
        return {
          status: "completed" as const,
          completedAt: now + 5,
          summary: "Audit complete",
          body: { finding: "none" },
          artifacts: [],
          usage: { modelCycles: 2, tokens: 1_200 },
        };
      })() }),
    }),
  },
});
const raced = await Promise.all([executor().execute(work.task.id), executor().execute(work.task.id)]);
assert.equal(raced.filter((outcome) => outcome.status === "succeeded").length, 1);
assert.equal(raced.filter((outcome) => outcome.status === "skipped").length, 1);
assert.equal(gatewayRuns, 1);
assert.equal(runtimeTaskDao.byId(userId, work.task.id)!.status, "succeeded");
assert.equal(teamMailDao.byTask(userId, work.task.id)!.status, "acknowledged");
assert.equal(taskResultDao.byTask(userId, work.task.id)!.summary, "Audit complete");
assert.ok(taskEventDao.listRecent(userId, work.task.id, 20).some((event) => event.type === "claimed:team"));
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get() as { n: number }).n, 0);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_turns WHERE session_id = ?").get(analyst.sessionId) as { n: number }).n, 1);

const exactClaimWorks = Array.from({ length: 4 }, (_, index) => owner.assignWork({
  teamId,
  targetMemberId: analyst.id,
  title: `Exact claim ${index}`,
  payload: {},
  idempotencyKey: `work-exact-claim-${index}`,
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
}));
const unrelatedMail = owner.send({
  teamId,
  targetMemberId: analyst.id,
  kind: "note",
  subject: "Unrelated expired claim",
  payload: {},
  idempotencyKey: "unrelated-exact-claim",
}).mail;
const unrelatedClaim = analystCoordinator.claimInbox("claim-unrelated-exact", 1_000)!;
assert.equal(unrelatedClaim.id, unrelatedMail.id);
now += 1_001;
const historySeq = (db.prepare(
  "SELECT MAX(seq) AS seq FROM team_mail WHERE team_id = ?",
).get(teamId) as { seq: number }).seq;
db.prepare(
  `WITH RECURSIVE history(n) AS (
     SELECT 1
     UNION ALL SELECT n + 1 FROM history WHERE n < ?
   )
   INSERT INTO team_mail
     (id, team_id, user_id, seq, source_member_id, source_session_id,
      target_member_id, target_session_id, kind, subject, payload_json, payload_bytes,
      idempotency_key, hop, deadline_at, status, created_at, updated_at, acknowledged_at)
   SELECT printf('mail_exact_claim_history_%06d', n), ?, ?, ? + n,
     ?, ?, ?, ?, 'note', 'history', '{}', 2,
     printf('exact-claim-history-%06d', n), 0, ?, 'acknowledged', ?, ?, ?
   FROM history`,
).run(
  100_000,
  teamId,
  userId,
  historySeq,
  ownerMember.id,
  "session_owner",
  analyst.id,
  analyst.sessionId,
  now + 60_000,
  now - 1,
  now - 1,
  now - 1,
);
const exactClaimSamples: number[] = [];
for (const [index, exactWork] of exactClaimWorks.slice(0, 3).entries()) {
  const started = performance.now();
  const exactClaim = teamTaskDao.claimWithMail({
    id: exactWork.task.id,
    userId,
    expectedVersion: exactWork.task.version,
    claimToken: `claim-exact-history-${index}`,
    at: now,
    leaseMs: 30_000,
  });
  exactClaimSamples.push(performance.now() - started);
  assert.ok(exactClaim);
  assert.ok(teamTaskDao.fenceAttempt({
    userId,
    taskId: exactClaim.task.id,
    expectedTaskVersion: exactClaim.task.version,
    expectedLeaseGeneration: exactClaim.task.leaseGeneration,
    mailId: exactClaim.mail.id,
    claimToken: `claim-exact-history-${index}`,
    claimGeneration: exactClaim.mail.claimGeneration,
    resultId: `result-exact-history-${index}`,
    at: now,
    reason: "runtime_lost",
  }));
}
const exactClaimMedianMs = [...exactClaimSamples].sort((left, right) => left - right)[1]!;
assert.ok(
  exactClaimMedianMs < timeBudgetMs(20),
  `exact Team claim scanned 100k mail rows (${exactClaimMedianMs.toFixed(1)}ms median)`,
);
assert.equal(
  teamMailDao.byId(userId, unrelatedMail.id)!.status,
  "claimed",
  "an exact Team claim cannot recover unrelated mail",
);

const compatibilityWork = exactClaimWorks[3]!;
const claimWorkStarted = performance.now();
const compatibilityMail = teamMailDao.claimWork({
  userId,
  targetSessionId: analyst.sessionId,
  taskId: compatibilityWork.task.id,
  claimToken: "claim-work-exact-history",
  at: now,
  leaseMs: 1_000,
})!;
const claimWorkElapsedMs = performance.now() - claimWorkStarted;
assert.ok(claimWorkElapsedMs < timeBudgetMs(20), `claimWork scanned 100k mail rows (${claimWorkElapsedMs.toFixed(1)}ms)`);
assert.equal(teamMailDao.byId(userId, unrelatedMail.id)!.status, "claimed");
now += 1_001;
teamMailDao.recoverLeases(userId, now);
assert.equal(teamMailDao.byId(userId, compatibilityMail.id)!.status, "queued");
assert.equal(teamMailDao.byId(userId, unrelatedMail.id)!.status, "queued");

const unrelatedReclaim = analystCoordinator.claimInbox("claim-unrelated-exact-2", 1_000)!;
assert.equal(unrelatedReclaim.id, unrelatedMail.id);
now += 1_001;
const taskClaimStarted = performance.now();
const compatibilityTask = teamTaskDao.claim({
  id: compatibilityWork.task.id,
  userId,
  expectedVersion: compatibilityWork.task.version,
  at: now,
})!;
const taskClaimElapsedMs = performance.now() - taskClaimStarted;
assert.ok(taskClaimElapsedMs < timeBudgetMs(20), `Team Task claim scanned 100k mail rows (${taskClaimElapsedMs.toFixed(1)}ms)`);
assert.equal(teamMailDao.byId(userId, unrelatedMail.id)!.status, "claimed");
const finalCompatibilityMail = teamMailDao.claimWork({
  userId,
  targetSessionId: analyst.sessionId,
  taskId: compatibilityTask.id,
  claimToken: "claim-work-exact-history-final",
  at: now,
  leaseMs: 30_000,
})!;
assert.equal(teamMailDao.byId(userId, unrelatedMail.id)!.status, "claimed");
assert.ok(teamTaskDao.fenceAttempt({
  userId,
  taskId: compatibilityTask.id,
  expectedTaskVersion: compatibilityTask.version,
  expectedLeaseGeneration: compatibilityTask.leaseGeneration,
  mailId: finalCompatibilityMail.id,
  claimToken: "claim-work-exact-history-final",
  claimGeneration: finalCompatibilityMail.claimGeneration,
  resultId: "result-exact-history-compatibility",
  at: now,
  reason: "runtime_lost",
}));
teamMailDao.recoverLeases(userId, now);
assert.equal(teamMailDao.byId(userId, unrelatedMail.id)!.status, "queued");
db.prepare("DELETE FROM team_mail WHERE id GLOB 'mail_exact_claim_history_*'").run();
console.log(
  `  ✓ exact Team claims ignore 100k historical mail rows (atomic ${exactClaimMedianMs.toFixed(2)}ms; mail ${claimWorkElapsedMs.toFixed(2)}ms; Task ${taskClaimElapsedMs.toFixed(2)}ms)`,
);

for (const kind of ["result", "ack", "note"] as const) {
  const reply = analystCoordinator.send({
    teamId,
    targetMemberId: ownerMember.id,
    kind,
    subject: `${kind} reply`,
    payload: { kind },
    idempotencyKey: `work-1-${kind}`,
    parentMailId: work.mail.id,
  });
  assert.equal(reply.mail.deadlineAt, work.mail.deadlineAt);
  assert.equal(reply.mail.parentMailId, work.mail.id);
}

now += 20;
const handoff = analystCoordinator.handoff({
  teamId,
  targetMemberId: reviewer.id,
  title: "Independent review",
  payload: { request: "Verify the audit." },
  idempotencyKey: "handoff-1",
  parentMailId: work.mail.id,
  parentTaskId: work.task.id,
});
assert.equal(handoff.task.parentTaskId, work.task.id);
assert.equal(handoff.mail.hop, 1);
assert.equal(handoff.task.sessionId, reviewer.sessionId);
assert.equal(handoff.mail.deadlineAt, work.mail.deadlineAt);
assert.deepEqual(handoff.mail.budget, { maxModelCycles: 3, maxTokens: 14_400 });
assert.throws(() => analystCoordinator.handoff({
  teamId,
  targetMemberId: reviewer.id,
  title: "Expanded",
  payload: {},
  idempotencyKey: "handoff-expanded",
  parentMailId: work.mail.id,
  deadlineAt: work.mail.deadlineAt + 1,
  budget: { maxModelCycles: 6, maxTokens: 30_001 },
}), /deadline|budget/);
createSession("session_budget_analyst");
createSession("session_budget_reviewer");
const budgetAnalystCoordinator = new TeamCoordinator({
  userId,
  actorSessionId: "session_budget_analyst",
  now: () => now,
  id: ids,
});
const budgetTeam = owner.createFromSessions({
  name: "Fresh handoff budget",
  members: [
    { sessionId: "session_owner", role: "lead" },
    { sessionId: "session_budget_analyst", role: "analyst" },
    { sessionId: "session_budget_reviewer", role: "reviewer" },
  ],
  leadSessionId: "session_owner",
});
const budgetAnalyst = budgetTeam.members.find((member) => member.sessionId === "session_budget_analyst")!;
const budgetReviewer = budgetTeam.members.find((member) => member.sessionId === "session_budget_reviewer")!;
const budgetAnalystService = new TeamCommandService({
  userId,
  actorSessionId: budgetAnalyst.sessionId,
  now: () => now,
  id: ids,
  provisionSession: async () => { throw new Error("route lease fixture must not provision a Session"); },
  retireSession: async () => { throw new Error("route lease fixture must not retire a Session"); },
});

const staleParent = owner.assignWork({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetAnalyst.id,
  title: "Stale parent lease",
  payload: {},
  idempotencyKey: "stale-parent-lease",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 6, maxTokens: 30_000 },
});
const staleParentClaimToken = "claim-stale-parent-lease";
const staleParentClaim = teamTaskDao.claimWithMail({
  id: staleParent.task.id,
  userId,
  expectedVersion: staleParent.task.version,
  claimToken: staleParentClaimToken,
  at: now,
  leaseMs: 30_000,
})!;
const staleParentRunning = teamTaskDao.markRunning({
  userId,
  taskId: staleParent.task.id,
  expectedTaskVersion: staleParentClaim.task.version,
  expectedLeaseGeneration: staleParentClaim.task.leaseGeneration,
  at: now,
})!;
const staleParentLease = {
  taskId: staleParent.task.id,
  expectedTaskLeaseGeneration: staleParentRunning.leaseGeneration,
  mailId: staleParent.mail.id,
  claimToken: staleParentClaimToken,
  claimGeneration: staleParentClaim.mail.claimGeneration,
};
const replayableNote = {
  action: "send" as const,
  teamId: budgetTeam.team.id,
  targetMemberId: budgetReviewer.id,
  kind: "note" as const,
  subject: "Committed before parent fence",
  payload: { proof: "exact replay" },
  idempotencyKey: "note-before-parent-fence",
};
const firstNote = budgetAnalystService.mail(replayableNote, staleParentLease) as unknown as { created: boolean };
assert.equal(firstNote.created, true);
now += 1;
assert.ok(teamTaskDao.fenceAttempt({
  userId,
  taskId: staleParent.task.id,
  expectedTaskVersion: staleParentRunning.version,
  expectedLeaseGeneration: staleParentRunning.leaseGeneration,
  mailId: staleParent.mail.id,
  claimToken: staleParentClaimToken,
  claimGeneration: staleParentClaim.mail.claimGeneration,
  resultId: "result-stale-parent-lease",
  at: now,
  reason: "lease_lost",
}));
assert.equal(runtimeTaskDao.byId(userId, staleParent.task.id)!.status, "interrupted");
assert.equal(teamMailDao.byId(userId, staleParent.mail.id)!.status, "cancelled");
const exactNoteReplay = budgetAnalystService.mail(replayableNote, staleParentLease) as unknown as { created: boolean };
assert.equal(exactNoteReplay.created, false, "a committed exact replay remains idempotent after fencing");
assert.throws(() => budgetAnalystService.mail({
  ...replayableNote,
  subject: "Rejected after parent fence",
  idempotencyKey: "note-after-parent-fence",
}, staleParentLease), /parent lease is no longer valid/);
assert.throws(() => budgetAnalystService.assign({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetReviewer.id,
  title: "Rejected child after parent fence",
  payload: {},
  ownerStepId: "step-stale-parent-lease",
  idempotencyKey: "child-after-parent-fence",
}, staleParentLease), /parent lease is no longer valid/);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS count FROM team_mail WHERE subject = 'Rejected after parent fence'")
    .get() as { count: number }).count,
  0,
);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS count FROM runtime_tasks WHERE title = 'Rejected child after parent fence'")
    .get() as { count: number }).count,
  0,
);

const freshParent = owner.assignWork({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetAnalyst.id,
  title: "Fresh parent budget",
  payload: {},
  idempotencyKey: "fresh-parent-budget",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 6, maxTokens: 30_000 },
});
const freshParentClaim = teamTaskDao.claimWithMail({
  id: freshParent.task.id,
  userId,
  expectedVersion: freshParent.task.version,
  claimToken: "claim-fresh-parent-budget",
  at: now,
  leaseMs: 30_000,
})!;
const freshParentRunning = teamTaskDao.markRunning({
  userId,
  taskId: freshParent.task.id,
  expectedTaskVersion: freshParentClaim.task.version,
  expectedLeaseGeneration: freshParentClaim.task.leaseGeneration,
  at: now,
})!;
const freshParentFirstReservation = teamTaskDao.reserveProviderRequest({
  userId,
  taskId: freshParent.task.id,
  expectedTaskLeaseGeneration: freshParentRunning.leaseGeneration,
  mailId: freshParent.mail.id,
  claimToken: "claim-fresh-parent-budget",
  claimGeneration: freshParentClaim.mail.claimGeneration,
  at: now,
});
assert.equal(freshParentFirstReservation.reservedTokens, 30_000);
assert.deepEqual(teamTaskDao.reconcileProviderRequest({
  userId,
  taskId: freshParent.task.id,
  expectedTaskLeaseGeneration: freshParentRunning.leaseGeneration,
  mailId: freshParent.mail.id,
  claimToken: "claim-fresh-parent-budget",
  claimGeneration: freshParentClaim.mail.claimGeneration,
  reservedTokens: freshParentFirstReservation.reservedTokens,
  actualTokens: 1_000,
  at: now,
}), { overBudget: false });
assert.deepEqual(teamMailDao.remainingWorkBudget(userId, freshParent.mail.id), {
  maxModelCycles: 5,
  maxTokens: 29_000,
});
assert.throws(() => budgetAnalystCoordinator.handoff({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetReviewer.id,
  title: "Consumes parent continuation",
  payload: {},
  idempotencyKey: "fresh-child-expanded-cycles",
  parentMailId: freshParent.mail.id,
  parentTaskId: freshParent.task.id,
  budget: { maxModelCycles: 5, maxTokens: 14_500 },
}), /preserve the parent post-handoff model cycle/);
assert.throws(() => budgetAnalystCoordinator.handoff({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetReviewer.id,
  title: "Consumes parent continuation tokens",
  payload: {},
  idempotencyKey: "fresh-child-expanded-tokens",
  parentMailId: freshParent.mail.id,
  parentTaskId: freshParent.task.id,
  budget: { maxModelCycles: 4, maxTokens: 14_501 },
}), /preserve the parent post-handoff model cycle/);
const freshChild = budgetAnalystCoordinator.handoff({
  teamId: budgetTeam.team.id,
  targetMemberId: budgetReviewer.id,
  title: "Default bounded child",
  payload: {},
  idempotencyKey: "fresh-child-budget",
  parentMailId: freshParent.mail.id,
  parentTaskId: freshParent.task.id,
});
assert.deepEqual(freshChild.mail.budget, { maxModelCycles: 4, maxTokens: 14_500 });
assert.deepEqual(teamMailDao.remainingWorkBudget(userId, freshParent.mail.id), {
  maxModelCycles: 1,
  maxTokens: 14_500,
});
const freshParentSecondReservation = teamTaskDao.reserveProviderRequest({
  userId,
  taskId: freshParent.task.id,
  expectedTaskLeaseGeneration: freshParentRunning.leaseGeneration,
  mailId: freshParent.mail.id,
  claimToken: "claim-fresh-parent-budget",
  claimGeneration: freshParentClaim.mail.claimGeneration,
  at: now,
});
assert.equal(freshParentSecondReservation.reservedTokens, 14_500);
assert.deepEqual(teamTaskDao.reconcileProviderRequest({
  userId,
  taskId: freshParent.task.id,
  expectedTaskLeaseGeneration: freshParentRunning.leaseGeneration,
  mailId: freshParent.mail.id,
  claimToken: "claim-fresh-parent-budget",
  claimGeneration: freshParentClaim.mail.claimGeneration,
  reservedTokens: freshParentSecondReservation.reservedTokens,
  actualTokens: 500,
  at: now,
}), { overBudget: false });
const freshChildClaim = teamTaskDao.claimWithMail({
  id: freshChild.task.id,
  userId,
  expectedVersion: freshChild.task.version,
  claimToken: "claim-fresh-child-budget",
  at: now,
  leaseMs: 30_000,
})!;
const freshChildRunning = teamTaskDao.markRunning({
  userId,
  taskId: freshChild.task.id,
  expectedTaskVersion: freshChildClaim.task.version,
  expectedLeaseGeneration: freshChildClaim.task.leaseGeneration,
  at: now,
})!;
const freshChildReservation = teamTaskDao.reserveProviderRequest({
  userId,
  taskId: freshChild.task.id,
  expectedTaskLeaseGeneration: freshChildRunning.leaseGeneration,
  mailId: freshChild.mail.id,
  claimToken: "claim-fresh-child-budget",
  claimGeneration: freshChildClaim.mail.claimGeneration,
  at: now,
});
assert.equal(freshChildReservation.reservedTokens, 14_500);
assert.deepEqual(teamTaskDao.reconcileProviderRequest({
  userId,
  taskId: freshChild.task.id,
  expectedTaskLeaseGeneration: freshChildRunning.leaseGeneration,
  mailId: freshChild.mail.id,
  claimToken: "claim-fresh-child-budget",
  claimGeneration: freshChildClaim.mail.claimGeneration,
  reservedTokens: freshChildReservation.reservedTokens,
  actualTokens: 400,
  at: now,
}), { overBudget: false });
const freshRootLedger = db.prepare(
  `SELECT route_used_turns, route_used_tokens, route_reserved_turns, route_reserved_tokens,
          budget_remaining_turns, budget_remaining_tokens,
          child_reserved_turns, child_reserved_tokens
   FROM team_mail WHERE id = ?`,
).get(freshParent.mail.id) as Record<string, number>;
assert.deepEqual({ ...freshRootLedger }, {
  route_used_turns: 3,
  route_used_tokens: 1_900,
  route_reserved_turns: 3,
  route_reserved_tokens: 14_100,
  budget_remaining_turns: 0,
  budget_remaining_tokens: 14_000,
  child_reserved_turns: 4,
  child_reserved_tokens: 14_500,
});
assert.deepEqual(teamMailDao.remainingWorkBudget(userId, freshChild.mail.id), {
  maxModelCycles: 3,
  maxTokens: 14_100,
});
assert.equal(
  freshRootLedger.route_used_turns
    + freshRootLedger.route_reserved_turns
    + freshRootLedger.budget_remaining_turns,
  6,
);
assert.equal(
  freshRootLedger.route_used_tokens
    + freshRootLedger.route_reserved_tokens
    + freshRootLedger.budget_remaining_tokens,
  30_000,
);
owner.transitionTeam(teamDao.byId(userId, budgetTeam.team.id)!, "closed");

const currentTeam = teamDao.byId(userId, teamId)!;
const paused = owner.transitionTeam(currentTeam, "paused")!;
assert.equal(teamTaskDao.claim({
  id: handoff.task.id,
  userId,
  expectedVersion: handoff.task.version,
  at: now,
}), null);
const resumed = owner.transitionTeam(paused, "active")!;
assert.equal(resumed.status, "active");

const overageWork = owner.assignWork({
  teamId,
  targetMemberId: analyst.id,
  title: "Usage overage",
  payload: {},
  idempotencyKey: "work-overage",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 100_000 },
});
const overageClaim = teamTaskDao.claimWithMail({
  id: overageWork.task.id,
  userId,
  expectedVersion: overageWork.task.version,
  claimToken: "claim-overage",
  at: now,
  leaseMs: 30_000,
})!;
const overageRunning = teamTaskDao.markRunning({
  userId,
  taskId: overageWork.task.id,
  expectedTaskVersion: overageClaim.task.version,
  expectedLeaseGeneration: overageClaim.task.leaseGeneration,
  at: now,
})!;
const overageReservation = teamTaskDao.reserveProviderRequest({
  userId,
  taskId: overageWork.task.id,
  expectedTaskLeaseGeneration: overageRunning.leaseGeneration,
  mailId: overageClaim.mail.id,
  claimToken: "claim-overage",
  claimGeneration: overageClaim.mail.claimGeneration,
  at: now,
});
assert.equal(overageReservation.reservedTokens, 100_000);
assert.deepEqual(teamTaskDao.reconcileProviderRequest({
  userId,
  taskId: overageWork.task.id,
  expectedTaskLeaseGeneration: overageRunning.leaseGeneration,
  mailId: overageClaim.mail.id,
  claimToken: "claim-overage",
  claimGeneration: overageClaim.mail.claimGeneration,
  reservedTokens: overageReservation.reservedTokens,
  actualTokens: 100_001,
  at: now + 1,
}), { overBudget: true });
assert.deepEqual(teamTaskDao.usageByTask(userId, overageWork.task.id), {
  modelCycles: 1,
  tokens: 100_001,
});
assert.throws(() => teamTaskDao.reserveProviderRequest({
  userId,
  taskId: overageWork.task.id,
  expectedTaskLeaseGeneration: overageRunning.leaseGeneration,
  mailId: overageClaim.mail.id,
  claimToken: "claim-overage",
  claimGeneration: overageClaim.mail.claimGeneration,
  at: now + 2,
}), /remaining provider-request budget/);

const deadlineWork = analystCoordinator.assignWork({
  teamId,
  targetMemberId: ownerMember.id,
  title: "Deadline race",
  payload: {},
  idempotencyKey: "work-deadline-race",
  deadlineAt: now + 20,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
});
let deadlineInput: TeamInternalTurnInput | undefined;
const deadlineKeepAlive = setTimeout(() => {}, 1_000);
const deadlineOutcome = await new TeamTurnExecutor({
  userId,
  now: () => now,
  mailLeaseMs: 1_000,
  gateway: {
    activateSession: (_userId, sessionId) => ({
      beginInternalTeamTurn: (input) => {
        deadlineInput = input;
        agentTurnDao.start({
          id: input.turnId,
          sessionId,
          startedAt: now,
          provider: "mock",
          model: "mock",
          source: "team",
          teamTaskId: input.task.id,
          teamTaskLeaseGeneration: input.lease.taskGeneration,
          teamMailClaimGeneration: input.lease.claimGeneration,
        });
        return { accepted: true as const, completion: new Promise(() => {}) };
      },
    }),
    retireSessionTurn: (_userId, sessionId, taskId, turnId) => {
      assert.equal(deadlineInput?.turnId, turnId);
      agentTurnDao.complete(sessionId, turnId, "interrupted", now + 30);
      teamTurnOutcomeDao.record({
        taskId,
        userId,
        sessionId,
        turnId,
        taskLeaseGeneration: deadlineInput!.lease.taskGeneration,
        mailClaimGeneration: deadlineInput!.lease.claimGeneration,
        status: "interrupted",
        summary: "Deadline interrupted the exact Turn.",
        body: { reason: "deadline" },
        artifacts: [],
        at: now + 30,
      });
      return true;
    },
  },
}).execute(deadlineWork.task.id);
clearTimeout(deadlineKeepAlive);
assert.equal(deadlineOutcome.status, "interrupted");
assert.equal(runtimeTaskDao.byId(userId, deadlineWork.task.id)!.status, "interrupted");
assert.equal(taskResultDao.byTask(userId, deadlineWork.task.id)!.summary, "Deadline interrupted the exact Turn.");

const admissionDeadline = reviewerCoordinator.assignWork({
  teamId,
  targetMemberId: ownerMember.id,
  title: "No request after deadline",
  payload: {},
  idempotencyKey: "work-provider-deadline",
  deadlineAt: now + 1,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
});
const admissionClaim = teamTaskDao.claimWithMail({
  id: admissionDeadline.task.id,
  userId,
  expectedVersion: admissionDeadline.task.version,
  claimToken: "claim-provider-deadline",
  at: now,
  leaseMs: 1_000,
})!;
const admissionRunning = teamTaskDao.markRunning({
  userId,
  taskId: admissionDeadline.task.id,
  expectedTaskVersion: admissionClaim.task.version,
  expectedLeaseGeneration: admissionClaim.task.leaseGeneration,
  at: now,
})!;
assert.throws(() => teamTaskDao.reserveProviderRequest({
  userId,
  taskId: admissionDeadline.task.id,
  expectedTaskLeaseGeneration: admissionRunning.leaseGeneration,
  mailId: admissionClaim.mail.id,
  claimToken: "claim-provider-deadline",
  claimGeneration: admissionClaim.mail.claimGeneration,
  at: now + 1,
}), /remaining provider-request budget/);
teamTaskDao.fenceAttempt({
  userId,
  taskId: admissionDeadline.task.id,
  expectedTaskVersion: admissionRunning.version,
  expectedLeaseGeneration: admissionRunning.leaseGeneration,
  mailId: admissionClaim.mail.id,
  claimToken: "claim-provider-deadline",
  claimGeneration: admissionClaim.mail.claimGeneration,
  resultId: "result-provider-deadline",
  at: now + 1,
  reason: "deadline",
});

const crashWork = reviewerCoordinator.assignWork({
  teamId,
  targetMemberId: ownerMember.id,
  title: "Recover committed outcome",
  payload: {},
  idempotencyKey: "work-outcome-recovery",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
});
const crashClaim = teamTaskDao.claimWithMail({
  id: crashWork.task.id,
  userId,
  expectedVersion: crashWork.task.version,
  claimToken: "claim-outcome-recovery",
  at: now,
  leaseMs: 30_000,
})!;
const crashRunning = teamTaskDao.markRunning({
  userId,
  taskId: crashWork.task.id,
  expectedTaskVersion: crashClaim.task.version,
  expectedLeaseGeneration: crashClaim.task.leaseGeneration,
  at: now,
})!;
const crashTurnId = "turn-outcome-recovery";
agentTurnDao.start({
  id: crashTurnId,
  sessionId: ownerMember.sessionId,
  startedAt: now,
  provider: "mock",
  model: "mock",
  source: "team",
  teamTaskId: crashWork.task.id,
  teamTaskLeaseGeneration: crashRunning.leaseGeneration,
  teamMailClaimGeneration: crashClaim.mail.claimGeneration,
});
agentTurnDao.complete(ownerMember.sessionId, crashTurnId, "completed", now + 1);
teamTurnOutcomeDao.record({
  taskId: crashWork.task.id,
  userId,
  sessionId: ownerMember.sessionId,
  turnId: crashTurnId,
  taskLeaseGeneration: crashRunning.leaseGeneration,
  mailClaimGeneration: crashClaim.mail.claimGeneration,
  status: "completed",
  summary: "Recovered exact outcome.",
  body: { recovered: true },
  artifacts: [],
  at: now + 1,
});
const crashRecovered = teamTaskDao.recoverActiveBySession(
  userId,
  ownerMember.sessionId,
  now + 2,
  "team-outcome-crash",
);
assert.deepEqual(crashRecovered, { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 });
assert.equal(runtimeTaskDao.byId(userId, crashWork.task.id)!.status, "succeeded");
assert.equal(runtimeTaskDao.byId(userId, crashWork.task.id)!.leaseGeneration, crashRunning.leaseGeneration + 1);
assert.equal(teamMailDao.byTask(userId, crashWork.task.id)!.status, "acknowledged");
assert.equal(taskResultDao.byTask(userId, crashWork.task.id)!.summary, "Recovered exact outcome.");
assert.deepEqual(
  teamTaskDao.recoverActiveBySession(userId, ownerMember.sessionId, now + 3, "team-outcome-crash-repeat"),
  { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 },
);

for (const checkpointSafe of [false, true]) {
  now += 10;
  const suffix = checkpointSafe ? "safe" : "unsafe";
  const acceptedWork = reviewerCoordinator.assignWork({
    teamId,
    targetMemberId: ownerMember.id,
    title: `Accepted ${suffix} lease`,
    payload: {},
    idempotencyKey: `work-accepted-lease-${suffix}`,
    deadlineAt: now + 60_000,
    budget: { maxModelCycles: 1, maxTokens: 1_000 },
    checkpointSafe,
  });
  const acceptedClaim = teamTaskDao.claimWithMail({
    id: acceptedWork.task.id,
    userId,
    expectedVersion: acceptedWork.task.version,
    claimToken: `claim-accepted-${suffix}`,
    at: now,
    leaseMs: 1_000,
  })!;
  const acceptedRunning = teamTaskDao.markRunning({
    userId,
    taskId: acceptedWork.task.id,
    expectedTaskVersion: acceptedClaim.task.version,
    expectedLeaseGeneration: acceptedClaim.task.leaseGeneration,
    at: now,
  })!;
  const acceptedTurnId = `turn-accepted-${suffix}`;
  agentTurnDao.start({
    id: acceptedTurnId,
    sessionId: ownerMember.sessionId,
    startedAt: now,
    provider: "mock",
    model: "mock",
    source: "team",
    teamTaskId: acceptedWork.task.id,
    teamTaskLeaseGeneration: acceptedRunning.leaseGeneration,
    teamMailClaimGeneration: acceptedClaim.mail.claimGeneration,
  });
  const taskBeforeSweep = runtimeTaskDao.byId(userId, acceptedWork.task.id)!;
  const mailBeforeSweep = teamMailDao.byTask(userId, acceptedWork.task.id)!;
  const expiredAt = now + 1_001;
  teamMailDao.recoverLeases(userId, expiredAt);
  teamTaskDao.sweepBlockedAttempts(expiredAt, 100);
  assert.deepEqual(runtimeTaskDao.byId(userId, acceptedWork.task.id), taskBeforeSweep);
  assert.deepEqual(teamMailDao.byTask(userId, acceptedWork.task.id), mailBeforeSweep);
  agentTurnDao.complete(ownerMember.sessionId, acceptedTurnId, "interrupted", expiredAt);
  teamTurnOutcomeDao.record({
    taskId: acceptedWork.task.id,
    userId,
    sessionId: ownerMember.sessionId,
    turnId: acceptedTurnId,
    taskLeaseGeneration: acceptedRunning.leaseGeneration,
    mailClaimGeneration: acceptedClaim.mail.claimGeneration,
    status: "interrupted",
    summary: `Exact ${suffix} Turn retired.`,
    body: { reason: "lease_lost" },
    artifacts: [],
    at: expiredAt,
  });
  assert.equal(teamTaskDao.settleOutcome({
    userId,
    taskId: acceptedWork.task.id,
    resultId: `result-accepted-${suffix}`,
    at: expiredAt,
  })!.task.status, "interrupted");
  now = expiredAt + 1;
}

const acceptedCrash = reviewerCoordinator.assignWork({
  teamId,
  targetMemberId: ownerMember.id,
  title: "Accepted Turn without outbox",
  payload: {},
  idempotencyKey: "work-accepted-no-outbox",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
  checkpointSafe: true,
});
const acceptedCrashClaim = teamTaskDao.claimWithMail({
  id: acceptedCrash.task.id,
  userId,
  expectedVersion: acceptedCrash.task.version,
  claimToken: "claim-accepted-no-outbox",
  at: now,
  leaseMs: 30_000,
})!;
const acceptedCrashRunning = teamTaskDao.markRunning({
  userId,
  taskId: acceptedCrash.task.id,
  expectedTaskVersion: acceptedCrashClaim.task.version,
  expectedLeaseGeneration: acceptedCrashClaim.task.leaseGeneration,
  at: now,
})!;
const acceptedCrashTurnId = "turn-accepted-no-outbox";
agentTurnDao.start({
  id: acceptedCrashTurnId,
  sessionId: ownerMember.sessionId,
  startedAt: now,
  provider: "mock",
  model: "mock",
  source: "team",
  teamTaskId: acceptedCrash.task.id,
  teamTaskLeaseGeneration: acceptedCrashRunning.leaseGeneration,
  teamMailClaimGeneration: acceptedCrashClaim.mail.claimGeneration,
});
const acceptedCrashRecovery = teamTaskDao.recoverActiveBySession(
  userId,
  ownerMember.sessionId,
  now + 1,
  "team-accepted-no-outbox",
);
assert.equal(acceptedCrashRecovery.interrupted, 1);
assert.equal(runtimeTaskDao.byId(userId, acceptedCrash.task.id)!.status, "interrupted");
assert.equal(teamMailDao.byTask(userId, acceptedCrash.task.id)!.status, "cancelled");
assert.ok(taskResultDao.byTask(userId, acceptedCrash.task.id));
assert.equal(agentTurnDao.byTeamTask(ownerMember.sessionId, acceptedCrash.task.id)?.status, "interrupted");

for (let attempt = 0; attempt < 17; attempt += 1) {
  const queuedHandoff = runtimeTaskDao.byId(userId, handoff.task.id)!;
  const claimedHandoff = teamTaskDao.claimWithMail({
    id: handoff.task.id,
    userId,
    expectedVersion: queuedHandoff.version,
    claimToken: `claim-pre-admission-${attempt}`,
    at: now,
    leaseMs: 1_000,
  })!;
  assert.equal(claimedHandoff.task.status, "starting");
  const recovered = teamTaskDao.recoverActiveBySession(
    userId,
    reviewer.sessionId,
    now + 1,
    `team-pre-admission-${attempt}`,
  );
  assert.equal(recovered.requeued, 1, "a pre-admission claim can safely return to FIFO");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM team_mail_claims WHERE mail_id = ?")
      .get(handoff.mail.id) as { n: number }).n,
    0,
  );
}
for (let attempt = 1; attempt <= 16; attempt += 1) {
  db.prepare(
    `INSERT INTO team_mail_claims
       (mail_id, target_session_id, claim_token, claim_generation, claimed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(handoff.mail.id, reviewer.sessionId, `legacy-pre-admission-${attempt}`, attempt, now - attempt);
}
const legacyQueued = runtimeTaskDao.byId(userId, handoff.task.id)!;
const repairedLegacyClaim = teamTaskDao.claimWithMail({
  id: handoff.task.id,
  userId,
  expectedVersion: legacyQueued.version,
  claimToken: "claim-after-legacy-cap",
  at: now,
  leaseMs: 1_000,
});
assert.ok(repairedLegacyClaim, "queued legacy tombstones self-heal before the claim cap check");
teamTaskDao.recoverActiveBySession(userId, reviewer.sessionId, now + 1, "team-legacy-claim-repair");
assert.equal(
  (db.prepare("SELECT COUNT(*) AS n FROM team_mail_claims WHERE mail_id = ?")
    .get(handoff.mail.id) as { n: number }).n,
  0,
);

now += 100;
const expiring = owner.assignWork({
  teamId,
  targetMemberId: reviewer.id,
  title: "Expiring work",
  payload: {},
  idempotencyKey: "work-expire",
  deadlineAt: now + 1_000,
  budget: { maxModelCycles: 1, maxTokens: 100 },
});
now += 1_001;
const expiry = teamMailDao.recoverLeases(userId, now);
assert.ok(expiry.cancelled >= 1);
assert.equal(teamMailDao.byTask(userId, expiring.task.id)!.status, "cancelled");
assert.equal(runtimeTaskDao.byId(userId, expiring.task.id)!.status, "cancelled");

const linkedOwnerTurnId = "turn-team-linked-owner";
agentTurnDao.start({
  id: linkedOwnerTurnId,
  sessionId: ownerMember.sessionId,
  startedAt: now,
  provider: "mock",
  model: "mock",
});
const linkedTeamWork = [0, 1].map((index) => owner.assignWork({
  teamId,
  targetMemberId: reviewer.id,
  title: `Linked Team sweep ${index}`,
  payload: {},
  idempotencyKey: `work-linked-sweep-${index}`,
  ownerTurnId: linkedOwnerTurnId,
  cancelPolicy: "linked",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 1, maxTokens: 1_000 },
}));
agentTurnDao.complete(ownerMember.sessionId, linkedOwnerTurnId, "completed", now + 1);
assert.equal(teamTaskDao.sweepBlockedAttempts(now + 2, 1), 1);
const firstLinked = linkedTeamWork.find((entry) =>
  runtimeTaskDao.byId(userId, entry.task.id)!.status === "cancelled"
)!;
const secondLinked = linkedTeamWork.find((entry) => entry.task.id !== firstLinked.task.id)!;
assert.equal(teamMailDao.byTask(userId, firstLinked.task.id)!.status, "cancelled");
assert.ok(taskResultDao.byTask(userId, firstLinked.task.id));
assert.equal(runtimeTaskDao.cancelOrphanedLinked(now + 3, 100), 0);
assert.equal(runtimeTaskDao.byId(userId, secondLinked.task.id)!.status, "queued");
assert.equal(teamMailDao.byTask(userId, secondLinked.task.id)!.status, "queued");
assert.equal(taskResultDao.byTask(userId, secondLinked.task.id), undefined);
assert.equal(teamTaskDao.sweepBlockedAttempts(now + 4, 1), 1);
assert.equal(runtimeTaskDao.byId(userId, secondLinked.task.id)!.status, "cancelled");
assert.equal(teamMailDao.byTask(userId, secondLinked.task.id)!.status, "cancelled");
assert.ok(taskResultDao.byTask(userId, secondLinked.task.id));
assert.equal(
  taskEventDao.listRecent(userId, secondLinked.task.id, 20)
    .some((event) => event.type === "cancel:linked_owner_gone"),
  false,
);

now += 10;
const closeWork = owner.assignWork({
  teamId,
  targetMemberId: reviewer.id,
  title: "Close work",
  payload: {},
  idempotencyKey: "work-close",
  deadlineAt: now + 60_000,
  budget: { maxModelCycles: 2, maxTokens: 1_000 },
});
const closed = owner.transitionTeam(teamDao.byId(userId, teamId)!, "closed")!;
assert.equal(closed.status, "closed");
assert.equal(runtimeTaskDao.byId(userId, closeWork.task.id)!.status, "cancelled");
assert.equal(teamMailDao.byTask(userId, closeWork.task.id)!.status, "cancelled");
assert.ok(sessionDao.byId(analyst.sessionId), "closing a Team never deletes member Sessions");

const deleteTeam = owner.createFromSessions({
  name: "Delete cascade",
  members: [
    { sessionId: "session_owner", role: "owner" },
    { sessionId: analyst.sessionId, role: "lead" },
    { sessionId: reviewer.sessionId, role: "worker" },
  ],
  leadSessionId: analyst.sessionId,
});
const deleteMail = analystCoordinator.send({
  teamId: deleteTeam.team.id,
  targetMemberId: deleteTeam.members.find((member) => member.sessionId === reviewer.sessionId)!.id,
  kind: "note",
  subject: "Before delete",
  payload: {},
  idempotencyKey: "delete-note",
});
sessionDao.delete(analyst.sessionId);
assert.equal(teamDao.byId(userId, deleteTeam.team.id)!.status, "paused");
assert.equal(teamMailDao.byId(userId, deleteMail.mail.id)!.status, "cancelled");
assert.equal(agentNodeDao.rootBySession(userId, analyst.sessionId), undefined);

const capSessions = ["session_owner"];
for (let i = 1; i < 15; i += 1) {
  const sessionId = `session_cap_${i}`;
  createSession(sessionId);
  capSessions.push(sessionId);
}
const capTeam = owner.createFromSessions({
  name: "Reservation cap",
  members: capSessions.map((sessionId, index) => ({ sessionId, role: index === 0 ? "lead" : "member" })),
  leadSessionId: "session_owner",
});
teamDao.reserveMember({
  id: "reservation-cap-final",
  operationKey: "reservation-cap-final",
  request: { role: "final" },
  userId,
  actorSessionId: "session_owner",
  teamId: capTeam.team.id,
  role: "final",
  provisionedSessionId: "session_cap_final",
  provisionedAgentId: "agent_cap_final",
  memberId: "member_cap_final",
  at: now,
});
createSession("session_cap_join");
assert.throws(() => owner.joinSession(capTeam.team.id, {
  sessionId: "session_cap_join",
  role: "overflow",
}), /member limit/);
createSession("session_cap_final");
agentNodeDao.create({
  id: "agent_cap_final",
  userId,
  sessionId: "session_cap_final",
  rootAgentId: "agent_cap_final",
  path: "/root",
  kind: "session",
  purpose: "addressable",
  status: "idle",
  createdAt: now,
});
const sagaRecovery = teamDao.recoverMemberReservations(now + 1);
assert.equal(sagaRecovery.finalized, 1);
assert.equal(teamDao.snapshot(userId, capTeam.team.id)!.members.length, 16);
assert.equal(sagaRecovery.retire.length, 0);

const ownerDeleteTeam = owner.createFromSessions({
  name: "Owner tombstone",
  members: [
    { sessionId: "session_owner", role: "owner" },
    { sessionId: reviewer.sessionId, role: "survivor" },
  ],
  leadSessionId: reviewer.sessionId,
});
const ownerDeleteMail = owner.send({
  teamId: ownerDeleteTeam.team.id,
  targetMemberId: ownerDeleteTeam.members.find((member) => member.sessionId === reviewer.sessionId)!.id,
  kind: "note",
  subject: "Keep this audit row",
  payload: { retained: true },
  idempotencyKey: "owner-delete-note",
});
sessionDao.delete("session_owner");
const tombstone = teamDao.byId(userId, ownerDeleteTeam.team.id)!;
assert.equal(tombstone.status, "closed");
assert.equal(tombstone.ownerAvailable, false);
assert.equal(tombstone.ownerSessionId, "session_owner");
assert.equal(teamMailDao.byId(userId, ownerDeleteMail.mail.id)!.payload.retained, true);
assert.ok(teamDao.memberHistory(userId, ownerDeleteTeam.team.id).some(
  (member) => member.sessionId === "session_owner" && member.status === "removed",
));
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

console.log("agent team: ok");
