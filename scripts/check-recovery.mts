import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-recovery-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const { agentTurnDao, pendingMessageDao, sessionDao, timelineDao, userDao } = await import("../server/src/persistence/index.ts");
const { recoverInterruptedSessions } = await import("../server/src/runtime/recovery.ts");
import type { SessionRow } from "../server/src/persistence/index.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const check = (name: string, fn: () => void) => {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const now = Date.now();
userDao.create({ id: "u1", email: "u1@test", password_hash: "x", created_at: now });

function mkSession(id: string, status: SessionRow["status"]): void {
  sessionDao.create({
    id,
    user_id: "u1",
    title: "t",
    provider: "mock",
    model: "mock",
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status,
    thinking_level: "medium",
    cwd: "/tmp",
    created_at: now,
    updated_at: now,
  });
}
const userItem = (sessionId: string, seq: number, text: string, turnId?: string): void =>
  timelineDao.append(sessionId, { kind: "user", id: `u_${seq}`, seq, text, ts: now, turnId });
const interruptedOf = (sessionId: string): TimelineItem[] =>
  timelineDao.list(sessionId).filter((i) => i.kind === "interrupted");

mkSession("s_with", "running");
agentTurnDao.start({ sessionId: "s_with", id: "turn_with", startedAt: now, provider: "mock", model: "mock" });
userItem("s_with", 1, "build me a thing", "turn_with");
timelineDao.append("s_with", {
  kind: "tool",
  id: "tool_running",
  seq: 2,
  ts: now,
  name: "bash",
  toolKind: "shell",
  arguments: { command: "sleep 30" },
  status: "running",
  turnId: "turn_with",
  children: [{
    kind: "tool",
    id: "child_running",
    seq: 1_000,
    ts: now,
    name: "read_file",
    toolKind: "read",
    arguments: { path: "proof.txt" },
    status: "pending",
    turnId: "child_turn",
  }],
});
pendingMessageDao.append("s_with", {
  id: "pending_steer_survives_restart",
  kind: "steer",
  text: "accepted while the old Turn was running",
  ts: now,
});
mkSession("s_empty", "running");
agentTurnDao.start({ sessionId: "s_empty", id: "turn_empty", startedAt: now, provider: "mock", model: "mock" });
mkSession("s_idle", "idle");
userItem("s_idle", 1, "earlier message");
mkSession("s_terminal_race", "running");
agentTurnDao.start({ sessionId: "s_terminal_race", id: "turn_done", startedAt: now, provider: "mock", model: "mock" });
userItem("s_terminal_race", 1, "already answered", "turn_done");
timelineDao.append("s_terminal_race", { kind: "assistant", id: "a_done", seq: 2, ts: now + 1, blocks: [], turnId: "turn_done" });
agentTurnDao.complete("s_terminal_race", "turn_done", "completed", now + 2);
mkSession("s_error_race", "error");
agentTurnDao.start({ sessionId: "s_error_race", id: "turn_failed", startedAt: now, provider: "mock", model: "mock" });
userItem("s_error_race", 1, "failing request", "turn_failed");
timelineDao.append("s_error_race", { kind: "error", id: "e_failed", seq: 2, ts: now + 1, message: "failed", turnId: "turn_failed" });
mkSession("s_running_error_row", "running");
agentTurnDao.start({ sessionId: "s_running_error_row", id: "turn_running_failed", startedAt: now, provider: "mock", model: "mock" });
userItem("s_running_error_row", 1, "failing before status write", "turn_running_failed");
timelineDao.append("s_running_error_row", {
  kind: "tool",
  id: "tool_running_failed",
  seq: 2,
  ts: now,
  name: "write_file",
  toolKind: "write",
  arguments: { path: "never.txt" },
  status: "streaming_args",
  turnId: "turn_running_failed",
});
timelineDao.append("s_running_error_row", { kind: "error", id: "e_running_failed", seq: 3, ts: now + 1, message: "failed", turnId: "turn_running_failed" });
mkSession("s_legacy_tail", "running");
agentTurnDao.start({ sessionId: "s_legacy_tail", id: "turn_old", startedAt: now - 10, provider: "mock", model: "mock" });
userItem("s_legacy_tail", 1, "older scoped request", "turn_old");
agentTurnDao.complete("s_legacy_tail", "turn_old", "completed", now - 5);
userItem("s_legacy_tail", 2, "rollback request");
mkSession("s_pre_timeline", "running");
agentTurnDao.start({
  sessionId: "s_pre_timeline",
  id: "turn_pre_timeline",
  startedAt: now,
  provider: "mock",
  model: "mock",
  acceptedInput: "accepted before tool bootstrap",
});
mkSession("s_stale_then_legacy", "running");
agentTurnDao.start({
  sessionId: "s_stale_then_legacy",
  id: "turn_stale",
  startedAt: now - 10,
  provider: "mock",
  model: "mock",
  acceptedInput: "stale v5 request",
});
userItem("s_stale_then_legacy", 1, "stale v5 request", "turn_stale");
userItem("s_stale_then_legacy", 2, "newer rollback request");

const recovered = recoverInterruptedSessions();

check("settles all seven running sessions", () => assert.equal(recovered, 7));

check("running→idle for the session with history", () =>
  assert.equal(sessionDao.byId("s_with")?.status, "idle"));
check("running→idle for the empty session", () =>
  assert.equal(sessionDao.byId("s_empty")?.status, "idle"));

check("appends exactly one interrupted notice (with history)", () =>
  assert.equal(interruptedOf("s_with").length, 1));
check("interrupted notice is the LAST timeline item", () => {
  const items = timelineDao.list("s_with");
  assert.equal(items[items.length - 1].kind, "interrupted");
});
check("notice carries the last user message as resumeText", () => {
  const it = interruptedOf("s_with")[0];
  assert.equal(it.kind === "interrupted" && it.resumeText, "build me a thing");
  assert.equal(it.kind === "interrupted" && it.turnId, "turn_with");
});
check("empty session: notice has no resumeText", () => {
  const it = interruptedOf("s_empty")[0];
  assert.ok(it && it.kind === "interrupted" && it.resumeText === undefined);
  assert.equal(it.kind === "interrupted" && it.turnId, "turn_empty");
});
check("durable Agent Turns become interrupted before the sessions return idle", () => {
  assert.equal(agentTurnDao.list("s_with")[0]?.status, "interrupted");
  assert.equal(agentTurnDao.list("s_empty")[0]?.status, "interrupted");
});
check("restart terminalizes parent and nested persisted Steps", () => {
  const tool = timelineDao.list("s_with").find((item) => item.kind === "tool" && item.id === "tool_running");
  assert.equal(tool?.kind === "tool" && tool.status, "denied");
  assert.equal(tool?.kind === "tool" && tool.termination, "cancelled");
  assert.equal(tool?.kind === "tool" && tool.children?.[0]?.kind === "tool" && tool.children[0].status, "denied");
  assert.equal(tool?.kind === "tool" && tool.children?.[0]?.kind === "tool" && tool.children[0].termination, "cancelled");
});
check("restart preserves an unconsumed steer as a fresh queued Turn", () => {
  assert.deepEqual(
    pendingMessageDao.listPending("s_with").map((pending) => [pending.id, pending.kind, pending.text]),
    [["pending_steer_survives_restart", "queue", "accepted while the old Turn was running"]],
  );
});

check("idle control session is untouched (still idle)", () =>
  assert.equal(sessionDao.byId("s_idle")?.status, "idle"));
check("idle control session got no interrupted notice", () =>
  assert.equal(interruptedOf("s_idle").length, 0));
check("terminalization race returns idle without fabricating an interruption", () => {
  assert.equal(sessionDao.byId("s_terminal_race")?.status, "idle");
  assert.equal(interruptedOf("s_terminal_race").length, 0);
  assert.equal(agentTurnDao.list("s_terminal_race")[0]?.status, "completed");
});
check("error-before-finally race closes the orphaned Agent Turn as failed", () => {
  assert.equal(sessionDao.byId("s_error_race")?.status, "error");
  assert.equal(interruptedOf("s_error_race").length, 0);
  assert.equal(agentTurnDao.list("s_error_race")[0]?.status, "failed");
});
check("scoped error row outranks stale running status without a false interruption", () => {
  assert.equal(sessionDao.byId("s_running_error_row")?.status, "error");
  assert.equal(interruptedOf("s_running_error_row").length, 0);
  assert.equal(agentTurnDao.list("s_running_error_row")[0]?.status, "failed");
  const tool = timelineDao.list("s_running_error_row").find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.status, "error");
  assert.equal(tool?.kind === "tool" && tool.isError, true);
});
check("unscoped rollback tail after a terminal v5 Turn remains recoverable", () => {
  const notice = interruptedOf("s_legacy_tail")[0];
  assert.equal(sessionDao.byId("s_legacy_tail")?.status, "idle");
  assert.equal(notice?.kind === "interrupted" && notice.resumeText, "rollback request");
  assert.equal(notice?.turnId, undefined);
});
check("pre-Timeline crash refills from durable accepted input, then clears the duplicate", () => {
  const notice = interruptedOf("s_pre_timeline")[0];
  assert.equal(notice?.kind === "interrupted" && notice.resumeText, "accepted before tool bootstrap");
  assert.equal(notice?.turnId, "turn_pre_timeline");
  assert.equal(agentTurnDao.acceptedInput("s_pre_timeline", "turn_pre_timeline"), null);
});
check("newer unscoped rollback prompt outranks a stale in-progress v5 Turn", () => {
  const notice = interruptedOf("s_stale_then_legacy")[0];
  assert.equal(notice?.kind === "interrupted" && notice.resumeText, "newer rollback request");
  assert.equal(notice?.turnId, undefined);
  assert.equal(agentTurnDao.list("s_stale_then_legacy")[0]?.status, "interrupted");
  assert.equal(agentTurnDao.acceptedInput("s_stale_then_legacy", "turn_stale"), null);
});

const second = recoverInterruptedSessions();
check("second sweep is a no-op (0 recovered)", () => assert.equal(second, 0));
check("no duplicate notice after second sweep", () =>
  assert.equal(interruptedOf("s_with").length, 1));

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} recovery checks FAILED`);
  process.exit(1);
}
console.log(`\nall recovery checks passed`);
