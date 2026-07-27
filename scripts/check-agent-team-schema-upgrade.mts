import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const stage = process.env.AGENT_TEAM_UPGRADE_STAGE;
const dataDir = process.env.AGENT_WEB_DATA_DIR;
const now = 1_821_000_000_000;

function assertProvisioningGuards(
  db: DatabaseSync,
  input: { userId: string; teamId: string; actorSessionId: string; suffix: string },
): void {
  const sessionId = `guard_session_${input.suffix}`;
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, user_id, title, provider, model, sandbox_mode, approval_policy,
        status, cwd, team_provision_team_id, team_provision_reservation_id,
        team_provision_state, created_at, updated_at)
     VALUES (?, ?, ?, 'mock', 'mock', 'workspace-write', 'never', 'idle', '.', ?, ?, ?, ?, ?)`,
  );
  assert.throws(() => insertSession.run(
    `${sessionId}_invalid`,
    input.userId,
    "invalid state",
    input.teamId,
    `guard_reservation_${input.suffix}_invalid`,
    "invalid",
    now,
    now,
  ));
  insertSession.run(
    sessionId,
    input.userId,
    "valid state",
    input.teamId,
    `guard_reservation_${input.suffix}`,
    "provisional",
    now,
    now,
  );
  assert.throws(() => db.prepare(
    "UPDATE sessions SET team_provision_state = 'invalid' WHERE id = ?",
  ).run(sessionId));
  db.prepare("UPDATE sessions SET team_provision_state = 'published' WHERE id = ?").run(sessionId);
  assert.equal(
    (db.prepare("SELECT team_provision_state AS state FROM sessions WHERE id = ?")
      .get(sessionId) as { state: string }).state,
    "published",
  );

  const reservationId = `guard_member_reservation_${input.suffix}`;
  const insertReservation = db.prepare(
    `INSERT INTO team_member_reservations
       (id, team_id, user_id, actor_session_id, role, provisioned_session_id,
        provisioned_agent_id, member_id, status, provision_generation,
        expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
  );
  assert.throws(() => insertReservation.run(
    `${reservationId}_invalid`,
    input.teamId,
    input.userId,
    input.actorSessionId,
    `${sessionId}_member_invalid`,
    `guard_agent_${input.suffix}_invalid`,
    `guard_member_${input.suffix}_invalid`,
    -1,
    now + 60_000,
    now,
    now,
  ));
  insertReservation.run(
    reservationId,
    input.teamId,
    input.userId,
    input.actorSessionId,
    `${sessionId}_member`,
    `guard_agent_${input.suffix}`,
    `guard_member_${input.suffix}`,
    0,
    now + 60_000,
    now,
    now,
  );
  assert.throws(() => db.prepare(
    "UPDATE team_member_reservations SET provision_generation = -1 WHERE id = ?",
  ).run(reservationId));
  db.prepare(
    "UPDATE team_member_reservations SET provision_generation = 1 WHERE id = ?",
  ).run(reservationId);
  assert.equal(
    (db.prepare(
      "SELECT provision_generation AS generation FROM team_member_reservations WHERE id = ?",
    ).get(reservationId) as { generation: number }).generation,
    1,
  );
  db.prepare("DELETE FROM team_member_reservations WHERE id = ?").run(reservationId);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

if (stage === "bootstrap") {
  if (!dataDir) throw new Error("bootstrap requires AGENT_WEB_DATA_DIR");
  const {
    agentTurnDao,
    db,
    sessionDao,
    teamTaskDao,
    teamTurnOutcomeDao,
    userDao,
  } = await import("../server/src/persistence/index.ts");
  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const userId = "upgrade_user";
  userDao.create({ id: userId, email: "upgrade@example.invalid", password_hash: "x", created_at: now });
  for (const id of ["upgrade_owner", "upgrade_member"]) {
    sessionDao.create({
      id,
      user_id: userId,
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
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: "upgrade_owner",
    now: () => now,
    id: (kind) => `upgrade_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Upgrade fixture",
    members: [
      { sessionId: "upgrade_owner", role: "lead" },
      { sessionId: "upgrade_member", role: "reviewer" },
    ],
    leadSessionId: "upgrade_owner",
  });
  const target = team.members.find((member) => member.sessionId === "upgrade_member")!;
  for (let index = 0; index < 2; index += 1) {
    const assignment = coordinator.assignWork({
      teamId: team.team.id,
      targetMemberId: target.id,
      title: `Upgrade work ${index}`,
      payload: { index },
      idempotencyKey: `upgrade-work-${index}`,
      deadlineAt: now + 60_000,
      budget: { maxModelCycles: 2, maxTokens: 2_000 },
    });
    const claimed = teamTaskDao.claimWithMail({
      id: assignment.task.id,
      userId,
      expectedVersion: assignment.task.version,
      claimToken: `upgrade-claim-${index}`,
      at: now + index,
      leaseMs: 30_000,
    })!;
    const running = teamTaskDao.markRunning({
      userId,
      taskId: assignment.task.id,
      expectedTaskVersion: claimed.task.version,
      expectedLeaseGeneration: claimed.task.leaseGeneration,
      at: now + index + 1,
    })!;
    const turnId = `upgrade_turn_${index}`;
    agentTurnDao.start({
      id: turnId,
      sessionId: target.sessionId,
      startedAt: now + index + 2,
      provider: "mock",
      model: "mock",
      source: "team",
      teamTaskId: assignment.task.id,
      teamTaskLeaseGeneration: running.leaseGeneration,
      teamMailClaimGeneration: claimed.mail.claimGeneration,
    });
    agentTurnDao.complete(target.sessionId, turnId, "completed", now + index + 3);
    teamTurnOutcomeDao.record({
      taskId: assignment.task.id,
      userId,
      sessionId: target.sessionId,
      turnId,
      taskLeaseGeneration: running.leaseGeneration,
      mailClaimGeneration: claimed.mail.claimGeneration,
      status: "completed",
      summary: `Outcome ${index}`,
      body: { index },
      artifacts: [],
      at: now + index + 3,
    });
    assert.ok(teamTaskDao.settleOutcome({
      userId,
      taskId: assignment.task.id,
      resultId: `upgrade_result_${index}`,
      at: now + index + 4,
    }));
  }
  assertProvisioningGuards(db, {
    userId,
    teamId: team.team.id,
    actorSessionId: "upgrade_owner",
    suffix: "fresh",
  });
  process.exit(0);
}

if (stage === "verify") {
  if (!dataDir) throw new Error("verify requires AGENT_WEB_DATA_DIR");
  const { db, sessionDao, teamDao } = await import("../server/src/persistence/index.ts");
  const outcomes = db.prepare(
    `SELECT task_id, task_lease_generation, mail_claim_generation, status
     FROM team_turn_outcomes ORDER BY task_id`,
  ).all() as unknown as Array<{
    task_id: string;
    task_lease_generation: number;
    mail_claim_generation: number;
    status: string;
  }>;
  assert.equal(outcomes.length, 2);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.task_lease_generation, outcome.mail_claim_generation]),
    [[7, 7], [7, 7]],
    "exact Agent Turn and historical claim evidence recover the same generation",
  );
  const generationColumns = db.prepare("PRAGMA table_info('team_turn_outcomes')").all() as unknown as Array<{
    name: string;
    dflt_value: string | null;
  }>;
  for (const name of ["task_lease_generation", "mail_claim_generation"]) {
    assert.equal(generationColumns.find((column) => column.name === name)?.dflt_value, null);
  }
  db.prepare("UPDATE team_turn_outcomes SET status = 'cancelled' WHERE task_id = ?")
    .run(outcomes[0]!.task_id);
  assert.equal(
    (db.prepare("SELECT status FROM team_turn_outcomes WHERE task_id = ?")
      .get(outcomes[0]!.task_id) as { status: string }).status,
    "cancelled",
  );

  const teamBefore = teamDao.listForSession("upgrade_user", "upgrade_owner")[0]!;
  const teamId = teamBefore.id;
  const rootSnapshot = teamBefore.rootAgentId;
  assertProvisioningGuards(db, {
    userId: "upgrade_user",
    teamId,
    actorSessionId: "upgrade_owner",
    suffix: "upgrade",
  });
  sessionDao.delete("upgrade_owner");
  const preserved = teamDao.byId("upgrade_user", teamId)!;
  assert.equal(preserved.ownerSessionId, "upgrade_owner");
  assert.equal(preserved.rootAgentId, rootSnapshot);
  assert.equal(preserved.ownerSessionRef, undefined);
  assert.equal(preserved.rootAgentRef, undefined);
  const teamFks = db.prepare("PRAGMA foreign_key_list('teams')").all() as unknown as Array<{ from: string }>;
  assert.ok(!teamFks.some((foreignKey) =>
    foreignKey.from === "owner_session_id" || foreignKey.from === "root_agent_id"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-agent-team-upgrade-"));
const script = fileURLToPath(import.meta.url);
const tsx = path.resolve("node_modules/.bin/tsx");
const commonEnv = {
  ...process.env,
  AGENT_WEB_DATA_DIR: tmp,
  AGENT_WEB_LOCAL_ROOT: path.join(tmp, "local"),
  AGENT_WEB_ALLOW_UNCONFINED_LOCAL: "1",
};
const runStage = (name: "bootstrap" | "verify") => {
  const child = spawnSync(tsx, [script], {
    cwd: process.cwd(),
    env: { ...commonEnv, AGENT_TEAM_UPGRADE_STAGE: name },
    encoding: "utf8",
  });
  if (child.status !== 0) {
    process.stderr.write(child.stdout);
    process.stderr.write(child.stderr);
    throw new Error(`Team schema ${name} stage failed`);
  }
};

runStage("bootstrap");
const legacy = new DatabaseSync(path.join(tmp, "agent-web.db"));
legacy.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
try {
  const work = legacy.prepare(
    `SELECT task.id AS task_id, mail.id AS mail_id, outcome.turn_id, outcome.created_at
     FROM runtime_tasks task
     JOIN team_mail mail ON mail.task_id = task.id AND mail.kind = 'work'
     JOIN team_turn_outcomes outcome ON outcome.task_id = task.id
     ORDER BY task.created_at, task.id`,
  ).all() as unknown as Array<{ task_id: string; mail_id: string; turn_id: string; created_at: number }>;
  assert.equal(work.length, 2);
  for (const [index, row] of work.entries()) {
    legacy.prepare(
      `UPDATE runtime_tasks SET lease_generation = 8 WHERE id = ?`,
    ).run(row.task_id);
    legacy.prepare(
      `UPDATE team_mail SET claim_generation = 8, claimed_at = ? WHERE id = ?`,
    ).run(row.created_at + 100, row.mail_id);
    legacy.prepare(
      `DELETE FROM team_mail_claims WHERE mail_id = ?`,
    ).run(row.mail_id);
    legacy.prepare(
      `INSERT INTO team_mail_claims
         (mail_id, target_session_id, claim_token, claim_generation, claimed_at)
       VALUES (?, 'upgrade_member', ?, 7, ?)`,
    ).run(row.mail_id, `historic-claim-${index}`, row.created_at - 1);
    legacy.prepare(
      `UPDATE agent_turns SET team_task_lease_generation = ?, team_mail_claim_generation = ?
       WHERE session_id = 'upgrade_member' AND id = ?`,
    ).run(index === 0 ? 7 : null, index === 0 ? 7 : null, row.turn_id);
  }

  legacy.exec(`
    DROP INDEX IF EXISTS idx_sessions_team_provision_reservation;
    DROP INDEX IF EXISTS idx_team_member_reservations_provision_claim;
    DROP INDEX IF EXISTS idx_team_member_reservations_claim_token;
    DROP TRIGGER IF EXISTS sessions_team_provision_state_insert_guard;
    DROP TRIGGER IF EXISTS sessions_team_provision_state_update_guard;
    DROP TRIGGER IF EXISTS team_member_reservations_generation_insert_guard;
    DROP TRIGGER IF EXISTS team_member_reservations_generation_update_guard;
    ALTER TABLE sessions DROP COLUMN team_provision_state;
    ALTER TABLE sessions DROP COLUMN team_provision_reservation_id;
    ALTER TABLE sessions DROP COLUMN team_provision_team_id;
    ALTER TABLE team_member_reservations DROP COLUMN provision_claim_expires_at;
    ALTER TABLE team_member_reservations DROP COLUMN provision_claim_token;
    ALTER TABLE team_member_reservations DROP COLUMN provision_generation;

    DROP INDEX IF EXISTS idx_team_turn_outcomes_user;
    CREATE TABLE team_turn_outcomes_legacy (
      task_id        TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      turn_id        TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('completed','failed','interrupted')),
      summary        TEXT NOT NULL,
      body_json      TEXT NOT NULL CHECK (json_valid(body_json)),
      artifacts_json TEXT NOT NULL CHECK (json_valid(artifacts_json)),
      model_cycles   INTEGER NOT NULL CHECK (model_cycles >= 0),
      tokens         INTEGER NOT NULL CHECK (tokens >= 0),
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id, turn_id) REFERENCES agent_turns(session_id, id) ON DELETE CASCADE,
      UNIQUE (session_id, turn_id)
    );
    INSERT INTO team_turn_outcomes_legacy
      (task_id, user_id, session_id, turn_id, status, summary, body_json,
       artifacts_json, model_cycles, tokens, created_at, updated_at)
    SELECT task_id, user_id, session_id, turn_id, status, summary, body_json,
      artifacts_json, model_cycles, tokens, created_at, updated_at
    FROM team_turn_outcomes;
    DROP TABLE team_turn_outcomes;
    ALTER TABLE team_turn_outcomes_legacy RENAME TO team_turn_outcomes;

    DROP TRIGGER IF EXISTS team_member_history_insert;
    DROP TRIGGER IF EXISTS team_member_history_update;
    DROP TRIGGER IF EXISTS team_member_history_delete;
    CREATE TABLE teams_legacy (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      root_agent_id TEXT,
      lead_agent_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','closed')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (root_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_agent_id) REFERENCES agent_nodes(id) ON DELETE SET NULL
    );
    INSERT INTO teams_legacy
      (id, user_id, owner_session_id, root_agent_id, lead_agent_id, name,
       status, version, created_at, updated_at)
    SELECT id, user_id, owner_session_id, root_agent_id, lead_agent_id, name,
      status, version, created_at, updated_at FROM teams;
    DROP TABLE teams;
    ALTER TABLE teams_legacy RENAME TO teams;
    COMMIT;
  `);
} catch (error) {
  try { legacy.exec("ROLLBACK;"); } catch {  }
  throw error;
} finally {
  legacy.close();
}

runStage("verify");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("agent team schema upgrade: ok");
