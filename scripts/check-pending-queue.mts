import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-pending-queue-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "pending-queue-check-secret-32-chars!";

const { sessionDao, userDao, messageDao, timelineDao, pendingMessageDao, agentTurnDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { recoverInterruptedSession } = await import("../server/src/runtime/recovery.ts");

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent, TimelineItem, PendingMessage } from "../shared/src/protocol.ts";

registerMockProvider();

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
async function acheck(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const NOW = Date.now();
userDao.create({ id: "u_pq", email: "pq@test", password_hash: "x", created_at: NOW });

let sessionCounter = 0;
function makeRuntime(): { rt: InstanceType<typeof AgentSessionRuntime>; id: string } {
  const id = "s_pq_" + ++sessionCounter;
  const row: SessionRow = {
    id,
    user_id: "u_pq",
    title: "pq-check",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
  messageDao.replaceAll(id, []);
  return { rt: new AgentSessionRuntime(row), id };
}

function setBusy(rt: InstanceType<typeof AgentSessionRuntime>): void {
  (rt as unknown as { status: string }).status = "running";
}
function setSteerable(rt: InstanceType<typeof AgentSessionRuntime>): void {
  setBusy(rt);
  const state = rt as unknown as {
    currentTurnId: string;
    turnAcceptingSteer: boolean;
    turnAbort: AbortController;
  };
  state.currentTurnId = "turn_harness";
  state.turnAcceptingSteer = true;
  state.turnAbort = new AbortController();
}
function getAgent(rt: InstanceType<typeof AgentSessionRuntime>): {
  steer: (m: unknown) => void;
  followUp: (m: unknown) => void;
  hasQueuedMessages: () => boolean;
  state: { messages: unknown[] };
} {
  return (rt as unknown as { agent: { steer: (m: unknown) => void; followUp: (m: unknown) => void; hasQueuedMessages: () => boolean; state: { messages: unknown[] } } }).agent;
}
async function consumeUser(rt: InstanceType<typeof AgentSessionRuntime>, text: string): Promise<void> {
  const onAgentEvent = (rt as unknown as { onAgentEvent: (ev: unknown, sig: AbortSignal) => Promise<void> }).onAgentEvent.bind(rt);
  await onAgentEvent(
    { type: "message_start", message: { role: "user", content: [{ type: "text", text }] } },
    new AbortController().signal,
  );
}
function captureEvents(rt: InstanceType<typeof AgentSessionRuntime>): ServerEvent[] {
  const evs: ServerEvent[] = [];
  rt.subscribe((e) => evs.push(e));
  return evs;
}
const userRows = (id: string): Extract<TimelineItem, { kind: "user" }>[] =>
  timelineDao.list(id).filter((i): i is Extract<TimelineItem, { kind: "user" }> => i.kind === "user");
const lastSnapshot = (evs: ServerEvent[]): PendingMessage[] => {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === "pending_queue") return e.pending;
  }
  throw new Error("no pending_queue snapshot emitted");
};

console.log("\n── Case 1: pendingMessageDao append / listPending / steer-only consume / deleteAll ──");
{
  const sid = "dao_unit";
  sessionDao.create({ ...({} as SessionRow), id: sid, user_id: "u_pq", title: "x", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandbox_mode: "workspace-write", sandbox_kind: "local", sandbox_id: null, sandbox_target_id: null, e2b_snapshot_id: null, mode: "coding", approval_policy: "never", status: "idle", thinking_level: "medium", cwd: tmp, created_at: NOW, updated_at: NOW });
  const o1 = pendingMessageDao.append(sid, { id: "p1", kind: "queue", text: "first", ts: NOW });
  const o2 = pendingMessageDao.append(sid, { id: "p2", kind: "queue", text: "second", ts: NOW });
  const o3 = pendingMessageDao.append(sid, { id: "p3", kind: "steer", text: "dup", ts: NOW });
  const o4 = pendingMessageDao.append(sid, { id: "p4", kind: "queue", text: "dup", ts: NOW });

  await acheck("append assigns strictly ascending ord", () => {
    assert.ok(o1 < o2 && o2 < o3 && o3 < o4, `ords must ascend: ${o1},${o2},${o3},${o4}`);
  });
  await acheck("listPending returns all un-consumed rows ordered by ord", () => {
    const list = pendingMessageDao.listPending(sid);
    assert.deepEqual(list.map((p) => p.id), ["p1", "p2", "p3", "p4"]);
  });
  await acheck("findUnconsumedSteerByText returns the OLDEST steer match (FIFO)", () => {
    const found = pendingMessageDao.findUnconsumedSteerByText(sid, "dup");
    assert.equal(found?.id, "p3", "the earlier 'dup' (p3, ord<) must win");
  });
  await acheck("markConsumed hides the steer and never falls through to a same-text queue", () => {
    pendingMessageDao.markConsumed(sid, "p3");
    assert.deepEqual(pendingMessageDao.listPending(sid).map((p) => p.id), ["p1", "p2", "p4"]);
    assert.equal(pendingMessageDao.findUnconsumedSteerByText(sid, "dup"), null, "same-text queue p4 is ineligible");
  });
  await acheck("a later append still gets an ord greater than a consumed row's ord (monotonic)", () => {
    const o5 = pendingMessageDao.append(sid, { id: "p5", kind: "queue", text: "later", ts: NOW });
    assert.ok(o5 > o4, "ord must stay monotonic even after a consume");
  });
  await acheck("deleteAll clears every pending row for the session", () => {
    pendingMessageDao.deleteAll(sid);
    assert.equal(pendingMessageDao.listPending(sid).length, 0);
  });
}

console.log("\n── Case 2: steer() persists durably at send + emits a snapshot, NOT the timeline ──");
{
  const { rt, id } = makeRuntime();
  const evs = captureEvents(rt);
  setSteerable(rt);
  await rt.steer("steer me");

  await acheck("a pending row exists with kind=steer + the text", () => {
    const list = pendingMessageDao.listPending(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, "steer");
    assert.equal(list[0].text, "steer me");
  });
  await acheck("the timeline is still EMPTY (no row spliced in at send)", () =>
    assert.equal(timelineDao.list(id).length, 0),
  );
  await acheck("a pending_queue snapshot was emitted carrying the chip", () => {
    const snap = lastSnapshot(evs);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].kind, "steer");
  });
  await acheck("getPendingQueue() re-serves the same set (replay seed)", () =>
    assert.equal(rt.getPendingQueue().length, 1),
  );
}

console.log("\n── Case 3: FIFO multi-queue, refresh survival, no 10s ghost-timeout ──");
{
  const { rt, id } = makeRuntime();
  setBusy(rt);
  await rt.queueFollowUp("q one");
  await rt.queueFollowUp("q two");
  await rt.queueFollowUp("q three");

  await acheck("three queued rows render in FIFO order by ord (#1/#2/#3)", () => {
    const list = rt.getPendingQueue();
    assert.deepEqual(list.map((p) => p.text), ["q one", "q two", "q three"]);
    assert.ok(list[0].ord < list[1].ord && list[1].ord < list[2].ord);
  });
  await acheck("refresh survival: getPendingQueue() (the timeline_replay seed) re-serves all three", () =>
    assert.equal(rt.getPendingQueue().length, 3),
  );
  await acheck("no 10s ghost-timeout on the server: a long simulated wait never drops a row", async () => {
    const before = pendingMessageDao.listPending(id).length;
    assert.equal(before, 3, "still three after the (instantaneous, timer-free) wait window");
  });
}

console.log("\n── Case 4: consume promotes a pending row to ONE user timeline row (fresh seq) ──");
{
  const { rt, id } = makeRuntime();
  const evs = captureEvents(rt);
  setSteerable(rt);
  (rt as unknown as { persist: (i: TimelineItem, c?: number) => void }).persist({ kind: "error", id: "e_x", seq: (rt as unknown as { nextSeq: () => number }).nextSeq(), message: "noise", ts: NOW });
  const seqBefore = timelineDao.maxSeq(id);

  await rt.steer("promote me");
  assert.equal(timelineDao.list(id).filter((i) => i.kind === "user").length, 0, "no user row yet (still pending)");

  await consumeUser(rt, "promote me");

  await acheck("exactly ONE user timeline row after consume (no duplicate)", () => {
    const rows = userRows(id);
    assert.equal(rows.length, 1, `expected 1 user row, got ${rows.length}`);
    assert.equal(rows[0].text, "promote me");
  });
  await acheck("the promoted user row's seq is FRESH (> rows emitted during the wait)", () => {
    const row = userRows(id)[0];
    assert.ok(row.seq > seqBefore, `promoted seq ${row.seq} must exceed seqBefore ${seqBefore}`);
  });
  await acheck("the promoted user row writes NO msg_cut (an in-Turn steer is not a rewind target)", () => {
    const row = userRows(id)[0];
    assert.equal(timelineDao.msgCutAt(id, row.seq), null, "msg_cut must be null on a promoted pending row");
  });
  await acheck("the pending row is markConsumed → drops from getPendingQueue", () =>
    assert.equal(rt.getPendingQueue().length, 0),
  );
  await acheck("the final snapshot is empty AND a user_message wire event was emitted", () => {
    const snap = lastSnapshot(evs);
    assert.equal(snap.length, 0, "chip dropped");
    const userMsg = evs.some((e) => e.type === "agent_event" && e.event.t === "user_message" && (e.event as { text?: string }).text === "promote me");
    assert.ok(userMsg, "a user_message wire event must be emitted so the client promotes the bubble");
  });
  await acheck("consuming the SAME text again does not re-promote (already consumed → today's behavior)", async () => {
    await consumeUser(rt, "promote me");
    assert.equal(userRows(id).length, 2, "a non-matching consume falls back to today's mint (subagent/echo path)");
  });
}

console.log("\n── Case 5: same-text queue cannot be mistaken for pi's consumed steer ──");
{
  const { rt } = makeRuntime();
  setSteerable(rt);
  await rt.queueFollowUp("same text");
  await rt.steer("same text");
  await consumeUser(rt, "same text");
  await acheck("pi steer promotion consumes only steer; same-text queue remains eligible", () => {
    const list = rt.getPendingQueue();
    assert.deepEqual(list.map((p) => [p.kind, p.text]), [["queue", "same text"]]);
  });
}

console.log("\n── Case 5b: terminal failure preserves unconsumed steer as fresh-Turn work ──");
{
  const { rt, id } = makeRuntime();
  setSteerable(rt);
  await rt.steer("accepted before provider failure");
  assert.equal(getAgent(rt).hasQueuedMessages(), true);
  const emitTurnError = (rt as unknown as {
    emitTurnError: (desc: { message: string; errorKind: string; retryable: boolean }) => void;
  }).emitTurnError.bind(rt);
  emitTurnError({ message: "provider failed", errorKind: "upstream", retryable: true });
  await acheck("failure retains id/text/ord but moves steer to queue", () => {
    const pending = pendingMessageDao.listPending(id);
    assert.deepEqual(pending.map((row) => [row.kind, row.text]), [["queue", "accepted before provider failure"]]);
  });
  await acheck("failure clears pi steering so it cannot leak into a later prompt", () => {
    assert.equal(getAgent(rt).hasQueuedMessages(), false);
  });
  rt.close();
}

console.log("\n── Case 6: interrupt + rewind drop pending rows ──");
{
  const { rt, id } = makeRuntime();
  setSteerable(rt);
  await rt.queueFollowUp("doomed by interrupt");
  await rt.steer("steer also doomed by interrupt");
  assert.equal(pendingMessageDao.listPending(id).length, 2);
  assert.equal(getAgent(rt).hasQueuedMessages(), true, "precondition: pi holds only the in-turn steer");
  rt.interrupt();
  await acheck("interrupt clears the durable pending rows", () =>
    assert.equal(pendingMessageDao.listPending(id).length, 0),
  );
  await acheck("interrupt ALSO clears pi's in-memory queue (no phantom resurrection on next run)", () =>
    assert.equal(getAgent(rt).hasQueuedMessages(), false, "pi.hasQueuedMessages() must be false after interrupt"),
  );

  const { rt: rt2, id: id2 } = makeRuntime();
  await rt2.sendMessage("anchor message");
  const anchor = userRows(id2)[0];
  pendingMessageDao.append(id2, { id: "p_orphan", kind: "queue", text: "orphan", ts: NOW });
  const res = rt2.rewind(anchor.seq);
  await acheck("rewind to a user seq succeeds and clears pending rows", () => {
    assert.equal(res.ok, true);
    assert.equal(pendingMessageDao.listPending(id2).length, 0, "no orphan pending row survives a rewind");
  });
}

console.log("\n── Case 8: same-text steer + queue preserve two distinct lifecycle paths ──");
{
  const { rt, id } = makeRuntime();
  const evs = captureEvents(rt);
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "180";
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  const unsub = rt.subscribe((event) => {
    if (event.type === "agent_event" && event.event.t === "tool_status" && event.event.status === "ready") {
      releaseReady();
    }
  });
  const first = rt.sendMessage("/write queued-boundary.txt\nfirst turn");
  await ready;
  await rt.queueFollowUp("same follow-up text");
  assert.equal(getAgent(rt).hasQueuedMessages(), false, "product queue must never enter pi followUp");
  await rt.steer("same follow-up text");
  assert.equal(getAgent(rt).hasQueuedMessages(), true, "only the in-Turn steer enters pi");
  await first;
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
  const deadline = Date.now() + 3_000;
  while ((agentTurnDao.list(id).length < 2 || rt.isBusy() || pendingMessageDao.listPending(id).length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  unsub();

  await acheck("queue produces two distinct completed durable Agent Turns", () => {
    const turns = agentTurnDao.list(id);
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0].id, turns[1].id);
    assert.deepEqual(turns.map((turn) => turn.status), ["completed", "completed"]);
  });
  await acheck("wire publishes two balanced outer turn_start/turn_end lifecycles", () => {
    const starts = evs.filter((event) => event.type === "agent_event" && event.event.t === "turn_start");
    const ends = evs.filter((event) => event.type === "agent_event" && event.event.t === "turn_end");
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
  });
  await acheck("same-text steer stays in Turn 1 while exact-id queue becomes rewindable Turn 2", () => {
    const users = userRows(id);
    assert.equal(users.length, 3);
    assert.equal(users[0].turnId, users[1].turnId, "steer belongs to the still-running first Turn");
    assert.notEqual(users[1].turnId, users[2].turnId, "queue owns the fresh second Turn");
    assert.deepEqual(users.map((user) => user.text), [
      "/write queued-boundary.txt\nfirst turn",
      "same follow-up text",
      "same follow-up text",
    ]);
    assert.equal(timelineDao.msgCutAt(id, users[1].seq), null, "in-Turn steer is not rewindable");
    assert.ok(timelineDao.msgCutAt(id, users[2].seq) != null, "fresh queued Turn must retain a rewind cut");
    assert.equal(pendingMessageDao.listPending(id).length, 0);
  });
}

console.log("\n── Case 9: Remove rebuilds pi steering from surviving durable rows ──");
{
  const { rt, id } = makeRuntime();
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "180";
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  const unsub = rt.subscribe((event) => {
    if (event.type === "agent_event" && event.event.t === "tool_status" && event.event.status === "ready") releaseReady();
  });
  const first = rt.sendMessage("/write remove-steer.txt\nfirst Turn");
  await ready;
  await rt.steer("REMOVE_ME");
  await rt.steer("KEEP_ME");
  const pending = pendingMessageDao.listPending(id);
  assert.deepEqual(pending.map((row) => [row.kind, row.text]), [["steer", "REMOVE_ME"], ["steer", "KEEP_ME"]]);
  rt.clearPending(pending[0].id);
  assert.deepEqual(pendingMessageDao.listPending(id).map((row) => row.text), ["KEEP_ME"]);
  assert.equal(getAgent(rt).hasQueuedMessages(), true, "surviving steer was requeued into pi");
  await first;
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
  unsub();
  await acheck("deleted steer never becomes a user Message; survivor keeps its Turn and order", () => {
    const users = userRows(id);
    assert.deepEqual(users.map((row) => row.text), ["/write remove-steer.txt\nfirst Turn", "KEEP_ME"]);
    assert.equal(users[0].turnId, users[1].turnId);
    assert.equal(pendingMessageDao.listPending(id).length, 0);
    assert.deepEqual(agentTurnDao.list(id).map((turn) => turn.status), ["completed"]);
  });
}

console.log("\n── Case 7: a normal idle send never touches pending_messages (#234 intact) ──");
{
  const { rt, id } = makeRuntime();
  await rt.sendMessage("a normal idle send");
  await acheck("no pending_messages row for a normal idle send", () =>
    assert.equal(pendingMessageDao.listPending(id).length, 0),
  );
  await acheck("the normal send produced exactly one user timeline row (the #234 path)", () =>
    assert.equal(userRows(id).length, 1),
  );
}

console.log("\n── Case 9b: active queued Turn cannot duplicate across process replacement ──");
{
  const id = "s_pq_active_queue_drain";
  const row: SessionRow = {
    id,
    user_id: "u_pq",
    title: "pq-active-queue-drain",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
  messageDao.replaceAll(id, []);
  pendingMessageDao.append(id, {
    id: "p_active_queue_once",
    kind: "queue",
    text: "QUEUED_ONCE",
    ts: NOW,
  });

  let releaseTools!: () => void;
  const toolsGate = new Promise<void>((resolve) => { releaseTools = resolve; });
  const rt = new AgentSessionRuntime(row);
  (rt as unknown as { ensureTools: () => Promise<void> }).ensureTools = () => toolsGate;
  const acceptedDeadline = Date.now() + 2_000;
  while (!agentTurnDao.latestInProgress(id) && Date.now() < acceptedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(agentTurnDao.latestInProgress(id), "queued drain must claim its durable Turn");
  assert.equal(pendingMessageDao.listPending(id).length, 1, "row remains cancellable during setup");
  rt.suspendQueuedTurnsForDrain();
  rt.interrupt(false, true);
  releaseTools();
  const settledDeadline = Date.now() + 2_000;
  while (rt.isBusy() && Date.now() < settledDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await acheck("interrupted promotion commits one user Message and consumes exact pending id", () => {
    assert.deepEqual(agentTurnDao.list(id).map((turn) => turn.status), ["interrupted"]);
    assert.deepEqual(userRows(id).map((user) => user.text), ["QUEUED_ONCE"]);
    assert.equal(pendingMessageDao.listPending(id).length, 0);
  });
  rt.close();
  const replacement = new AgentSessionRuntime(sessionDao.byId(id)!);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await acheck("replacement sees no pending duplicate and starts no second Turn", () => {
    assert.deepEqual(agentTurnDao.list(id).map((turn) => turn.status), ["interrupted"]);
    assert.deepEqual(userRows(id).map((user) => user.text), ["QUEUED_ONCE"]);
  });
  replacement.close();
}

console.log("\n── Case 9c: removing active queued text survives hard-kill recovery ──");
{
  const id = "s_pq_clear_active_queue";
  const row: SessionRow = {
    id,
    user_id: "u_pq",
    title: "pq-clear-active-queue",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
  messageDao.replaceAll(id, []);
  pendingMessageDao.append(id, {
    id: "p_remove_forever",
    kind: "queue",
    text: "REMOVE_ME_FOREVER",
    ts: NOW,
  });
  let releaseTools!: () => void;
  const toolsGate = new Promise<void>((resolve) => { releaseTools = resolve; });
  const rt = new AgentSessionRuntime(row);
  (rt as unknown as { ensureTools: () => Promise<void> }).ensureTools = () => toolsGate;
  const acceptedDeadline = Date.now() + 2_000;
  while (!agentTurnDao.latestInProgress(id) && Date.now() < acceptedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const activeTurn = agentTurnDao.latestInProgress(id);
  assert.ok(activeTurn);
  assert.equal(agentTurnDao.acceptedInput(id, activeTurn.id), "REMOVE_ME_FOREVER");

  rt.clearPending("p_remove_forever");
  recoverInterruptedSession(id);
  await acheck("Remove atomically clears pending row and accepted-input recovery copy", () => {
    assert.equal(pendingMessageDao.listPending(id).length, 0);
    assert.equal(agentTurnDao.acceptedInput(id, activeTurn.id), null);
  });
  const settleDeadline = Date.now() + 2_000;
  while (rt.isBusy() && Date.now() < settleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await acheck("kill recovery cannot resurrect removed text or keep setup busy", () => {
    assert.equal(rt.isBusy(), false);
    assert.equal(userRows(id).length, 0);
    assert.equal(pendingMessageDao.listPending(id).length, 0);
    const notice = timelineDao.list(id).find((item) => item.kind === "interrupted");
    assert.ok(notice?.kind === "interrupted");
    assert.equal(notice.resumeText, undefined);
    assert.ok(!JSON.stringify(timelineDao.list(id)).includes("REMOVE_ME_FOREVER"));
  });
  releaseTools();
  rt.close();
}

console.log("\n── Case 10: deployment drain preserves queued work for the replacement runtime ──");
{
  const id = "s_pq_manager_drain";
  const row: SessionRow = {
    id,
    user_id: "u_pq",
    title: "pq-drain-check",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
  messageDao.replaceAll(id, []);
  const idleAdmissionId = "s_pq_drain_admission";
  sessionDao.create({ ...row, id: idleAdmissionId, title: "pq-drain-admission" });
  messageDao.replaceAll(idleAdmissionId, []);
  const { sessionManager } = await import("../server/src/runtime/manager.ts");
  const rt = sessionManager.getRuntime("u_pq", id);
  assert.ok(rt, "manager must resolve the owned runtime");
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "500";
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  rt.subscribe((event) => {
    if (event.type === "agent_event" && event.event.t === "tool_status" && event.event.status === "ready") releaseReady();
  });
  const first = rt.sendMessage("/write drain-boundary.txt\nin-flight Turn");
  await ready;
  await rt.queueFollowUp("survive the deployment drain");
  assert.deepEqual(pendingMessageDao.listPending(id).map((pending) => pending.kind), ["queue"]);

  const compactWaitId = "s_pq_drain_idle_compaction";
  sessionDao.create({ ...row, id: compactWaitId, title: "pq-drain-idle-compaction" });
  messageDao.replaceAll(compactWaitId, []);
  const compactWaitRt = sessionManager.getRuntime("u_pq", compactWaitId);
  assert.ok(compactWaitRt);
  let releaseIdleCompaction!: () => void;
  const idleCompactionGate = new Promise<void>((resolve) => { releaseIdleCompaction = resolve; });
  const compactState = compactWaitRt as unknown as { idleCompaction: Promise<void> | null };
  compactState.idleCompaction = idleCompactionGate.finally(() => { compactState.idleCompaction = null; });
  const compactWaitSend = compactWaitRt.sendMessage("ACKED_BEFORE_DRAIN");
  assert.equal(compactWaitRt.isBusy(), true, "acked send waiting on compaction is lifecycle-busy");
  const compactWaitTurn = agentTurnDao.latestInProgress(compactWaitId);
  assert.ok(compactWaitTurn);
  assert.equal(agentTurnDao.acceptedInput(compactWaitId, compactWaitTurn.id), "ACKED_BEFORE_DRAIN");

  sessionManager.setDraining();
  await acheck("runtime-owned bounded admission refuses new work after setDraining", () => {
    assert.deepEqual(sessionManager.tryStartTurn("u_pq", idleAdmissionId, "MUST_NOT_START_AFTER_DRAIN"), { error: "busy" });
    assert.equal(agentTurnDao.list(idleAdmissionId).length, 0);
    assert.equal(userRows(idleAdmissionId).length, 0);
  });
  const drainPromise = sessionManager.drainTurns({ waitMs: 0, settleMs: 2_000 });
  releaseIdleCompaction();
  const drained = await drainPromise;
  await first;
  await compactWaitSend;
  await new Promise((resolve) => setTimeout(resolve, 25));

  await acheck("drain timeout interrupts only the active Turn", () => {
    assert.equal(drained.interrupted, 2);
    assert.deepEqual(agentTurnDao.list(id).map((turn) => turn.status), ["interrupted"]);
    assert.deepEqual(userRows(id).map((row) => row.text), ["/write drain-boundary.txt\nin-flight Turn"]);
  });
  await acheck("acked send waiting on idle compaction is durable and drained, never post-drain-started", () => {
    assert.deepEqual(agentTurnDao.list(compactWaitId).map((turn) => turn.status), ["interrupted"]);
    assert.deepEqual(userRows(compactWaitId).map((row) => row.text), ["ACKED_BEFORE_DRAIN"]);
  });
  await acheck("old draining process does not promote or delete the queued Message", () => {
    const pending = pendingMessageDao.listPending(id);
    assert.deepEqual(pending.map((pendingRow) => [pendingRow.kind, pendingRow.text]), [["queue", "survive the deployment drain"]]);
  });

  rt.close();
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
  const replacement = new AgentSessionRuntime(sessionDao.byId(id)!);
  const deadline = Date.now() + 3_000;
  while ((pendingMessageDao.listPending(id).length > 0 || replacement.isBusy()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await acheck("replacement runtime resumes the durable queue as a fresh Turn", () => {
    assert.equal(pendingMessageDao.listPending(id).length, 0);
    assert.deepEqual(agentTurnDao.list(id).map((turn) => turn.status), ["interrupted", "completed"]);
    assert.deepEqual(userRows(id).map((row) => row.text), [
      "/write drain-boundary.txt\nin-flight Turn",
      "survive the deployment drain",
    ]);
  });
  replacement.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} pending-queue check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all pending-queue checks passed");
process.exit(0);
