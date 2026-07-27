import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-fork-check-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "fork-check-fixed-secret-32chars!!";

const { agentTurnDao, sessionDao, timelineDao, messageDao, compactionDao, userDao } =
  await import("../server/src/persistence/index.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const NOW = Date.now();
userDao.create({ id: "u_fork", email: "fork@test", password_hash: "x", created_at: NOW });

function seedSession(id: string): void {
  const row: SessionRow = {
    id,
    user_id: "u_fork",
    title: `Session ${id}`,
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
    cwd: "/tmp",
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
}

function appendUser(sessionId: string, seq: number, text: string, msgCut: number): void {
  const item: TimelineItem = { kind: "user", id: `uid_${sessionId}_${seq}`, seq, text, ts: NOW };
  timelineDao.append(sessionId, item, msgCut);
}

function appendUserNoMsgCut(sessionId: string, seq: number, text: string): void {
  const item: TimelineItem = { kind: "user", id: `uid_${sessionId}_${seq}`, seq, text, ts: NOW };
  timelineDao.append(sessionId, item, undefined);
}

function appendAssistant(sessionId: string, seq: number, text: string): void {
  const item: TimelineItem = {
    kind: "assistant",
    id: `aid_${sessionId}_${seq}`,
    seq,
    blocks: [{ type: "text", text }],
    ts: NOW,
  };
  timelineDao.append(sessionId, item);
}

function appendCompaction(sessionId: string, seq: number, compactionId: string): void {
  const item: TimelineItem = {
    kind: "compaction",
    id: compactionId,
    compactionId,
    seq,
    summarizedCount: 2,
    tokensBefore: 50_000,
    tokensAfter: 12_000,
    ts: NOW,
  };
  timelineDao.append(sessionId, item);
}

console.log("\n── 1. HAPPY PATH ──────────────────────────────────────────────────");

await check("fork returns ok:true with info", async () => {
  const srcId = "s_happy_src";
  seedSession(srcId);

  appendUser(srcId, 1, "hello", 0);
  appendAssistant(srcId, 2, "hi there");
  appendUser(srcId, 3, "second message", 1);
  appendAssistant(srcId, 4, "second reply");
  appendUser(srcId, 5, "third message", 2);

  const msgs = [{ role: "user", content: "hello" }, { role: "user", content: "second" }, { role: "user", content: "third" }];
  messageDao.replaceAll(srcId, msgs);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok, `expected ok:true, got: ${JSON.stringify(out)}`);
  assert.ok(out.ok && out.info, "expected info in result");
});

await check("forked session exists in sessionDao", async () => {
  const srcId = "s_happy_src2";
  seedSession(srcId);
  appendUser(srcId, 1, "msg1", 0);
  appendAssistant(srcId, 2, "reply1");
  appendUser(srcId, 3, "msg2", 1);
  messageDao.replaceAll(srcId, [{ role: "user", content: "msg1" }, { role: "user", content: "msg2" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok);
  const newId = out.ok ? out.info.id : null;
  assert.ok(newId, "fork must return a new id");
  const newRow = sessionDao.byId(newId!);
  assert.ok(newRow, "forked session must exist in sessionDao");
  assert.equal(newRow!.user_id, "u_fork");
  assert.equal(newRow!.status, "idle");
});

await check("forked timeline has exactly the prefix [..fromSeq]", async () => {
  const srcId = "s_happy_src3";
  seedSession(srcId);
  appendUser(srcId, 1, "msg1", 0);
  appendAssistant(srcId, 2, "reply1");
  appendUser(srcId, 3, "msg2", 1);
  appendAssistant(srcId, 4, "reply2");
  appendUser(srcId, 5, "msg3", 2);
  messageDao.replaceAll(srcId, [
    { role: "user", content: "msg1" },
    { role: "user", content: "msg2" },
    { role: "user", content: "msg3" },
  ]);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok);
  const newId = out.ok ? out.info.id : "";

  const forkedItems = timelineDao.list(newId);
  assert.equal(forkedItems.length, 3, `expected 3 items, got ${forkedItems.length}`);
  const seqs = forkedItems.map((i) => i.seq);
  assert.deepEqual(seqs, [1, 2, 3], `expected seqs [1,2,3], got ${JSON.stringify(seqs)}`);
});

await check("forked messages = source.slice(0, msgCutAt(fromSeq))", async () => {
  const srcId = "s_happy_src4";
  seedSession(srcId);
  appendUser(srcId, 1, "msg1", 0);
  appendAssistant(srcId, 2, "reply1");
  appendUser(srcId, 3, "msg2", 1);
  appendAssistant(srcId, 4, "reply2");
  appendUser(srcId, 5, "msg3", 2);
  const srcMsgs = [
    { role: "user", content: "msg1" },
    { role: "user", content: "msg2" },
    { role: "user", content: "msg3" },
  ];
  messageDao.replaceAll(srcId, srcMsgs);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok);
  const newId = out.ok ? out.info.id : "";

  const forkedMsgs = messageDao.list(newId);
  assert.equal(forkedMsgs.length, 1, `expected 1 message, got ${forkedMsgs.length}`);
  assert.deepEqual(forkedMsgs[0], srcMsgs[0]);
});

await check("source session timeline is UNCHANGED after fork", async () => {
  const srcId = "s_happy_src5";
  seedSession(srcId);
  appendUser(srcId, 1, "msg1", 0);
  appendAssistant(srcId, 2, "reply1");
  appendUser(srcId, 3, "msg2", 1);
  appendAssistant(srcId, 4, "reply2");
  messageDao.replaceAll(srcId, [{ role: "user", content: "msg1" }, { role: "user", content: "msg2" }]);

  const srcBefore = timelineDao.list(srcId).map((i) => i.seq);
  const srcMsgsBefore = messageDao.list(srcId);

  await sessionManager.forkSession("u_fork", srcId, 3);

  const srcAfter = timelineDao.list(srcId).map((i) => i.seq);
  const srcMsgsAfter = messageDao.list(srcId);

  assert.deepEqual(srcAfter, srcBefore, "source timeline must be unchanged");
  assert.deepEqual(srcMsgsAfter, srcMsgsBefore, "source messages must be unchanged");
});

await check("fork preserves complete Agent Turns and marks the boundary-clipped Turn interrupted", async () => {
  const srcId = "s_happy_turns";
  seedSession(srcId);
  agentTurnDao.start({ sessionId: srcId, id: "turn_complete", startedAt: NOW, provider: "mock", model: "mock-coder" });
  timelineDao.append(srcId, { kind: "user", id: "tu1", seq: 1, text: "first", ts: NOW, turnId: "turn_complete" }, 0);
  timelineDao.append(srcId, { kind: "assistant", id: "ta1", seq: 2, blocks: [{ type: "text", text: "done" }], ts: NOW + 1, turnId: "turn_complete" });
  agentTurnDao.complete(srcId, "turn_complete", "completed", NOW + 2);
  agentTurnDao.start({ sessionId: srcId, id: "turn_clipped", startedAt: NOW + 3, provider: "mock", model: "mock-coder" });
  timelineDao.append(srcId, { kind: "user", id: "tu2", seq: 3, text: "fork here", ts: NOW + 3, turnId: "turn_clipped" }, 2);
  timelineDao.append(srcId, { kind: "assistant", id: "ta2", seq: 4, blocks: [{ type: "text", text: "not copied" }], ts: NOW + 4, turnId: "turn_clipped" });
  agentTurnDao.complete(srcId, "turn_clipped", "completed", NOW + 5);
  messageDao.replaceAll(srcId, [{ role: "user", content: "first" }, { role: "assistant", content: "done" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok);
  const copied = agentTurnDao.list(out.ok ? out.info.id : "");
  assert.deepEqual(copied.map((turn) => [turn.id, turn.status, turn.startSeq, turn.endSeq]), [
    ["turn_complete", "completed", 1, 2],
    ["turn_clipped", "interrupted", 3, 3],
  ]);
});

console.log("\n── 2. COMPACTION REMAP ────────────────────────────────────────────");

await check("forked compaction marker has a freshly-minted id (not the original)", async () => {
  const srcId = "s_cmp_src";
  seedSession(srcId);

  const origCmpId = "cmp_" + crypto.randomUUID();
  appendUser(srcId, 1, "msg1", 0);
  appendCompaction(srcId, 2, origCmpId);
  appendUser(srcId, 3, "msg2", 2);
  appendAssistant(srcId, 4, "reply2");
  appendUser(srcId, 5, "msg3", 3);

  compactionDao.create({
    id: origCmpId,
    session_id: srcId,
    seq: 2,
    summarized_count: 1,
    tokens_before: 50_000,
    tokens_after: 10_000,
    summary_text: "summary of first message",
    archived_json: JSON.stringify([{ role: "user", content: "msg1" }]),
    created_at: NOW,
  });

  messageDao.replaceAll(srcId, [
    { role: "assistant", content: "summary" },
    { role: "user", content: "msg2" },
    { role: "user", content: "msg3" },
  ]);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok, `expected ok:true, got: ${JSON.stringify(out)}`);
  const newId = out.ok ? out.info.id : "";

  const forkedItems = timelineDao.list(newId);
  const cmpItem = forkedItems.find((i) => i.kind === "compaction") as Extract<TimelineItem, { kind: "compaction" }> | undefined;
  assert.ok(cmpItem, "forked timeline must contain a compaction marker");
  assert.notEqual(cmpItem!.compactionId, origCmpId, "forked compaction must have a new id, not the original");
  assert.notEqual(cmpItem!.id, origCmpId, "forked compaction item.id must also be remapped");
});

await check("forked compaction detail is reachable via compactionDao.byId with new id", async () => {
  const srcId = "s_cmp_src2";
  seedSession(srcId);

  const origCmpId = "cmp_" + crypto.randomUUID();
  appendUser(srcId, 1, "msg1", 0);
  appendCompaction(srcId, 2, origCmpId);
  appendUser(srcId, 3, "after compaction", 2);

  compactionDao.create({
    id: origCmpId,
    session_id: srcId,
    seq: 2,
    summarized_count: 1,
    tokens_before: 40_000,
    tokens_after: 8_000,
    summary_text: "the summary",
    archived_json: JSON.stringify([]),
    created_at: NOW,
  });

  messageDao.replaceAll(srcId, [
    { role: "assistant", content: "the summary" },
    { role: "user", content: "after compaction" },
  ]);

  const out = await sessionManager.forkSession("u_fork", srcId, 3);
  assert.ok(out.ok);
  const newId = out.ok ? out.info.id : "";

  const forkedItems = timelineDao.list(newId);
  const cmpItem = forkedItems.find((i) => i.kind === "compaction") as Extract<TimelineItem, { kind: "compaction" }> | undefined;
  assert.ok(cmpItem, "forked timeline must have a compaction marker");

  const newCmpId = cmpItem!.compactionId;
  const detail = compactionDao.byId(newId, newCmpId);
  assert.ok(detail, `compactionDao.byId must find the detail row for new id ${newCmpId}`);
  assert.equal(detail!.session_id, newId);
  assert.equal(detail!.summary_text, "the summary");
});

await check("source compaction row is UNCHANGED after fork (original id still resolves)", async () => {
  const srcId = "s_cmp_src3";
  seedSession(srcId);

  const origCmpId = "cmp_" + crypto.randomUUID();
  appendUser(srcId, 1, "msg1", 0);
  appendCompaction(srcId, 2, origCmpId);
  appendUser(srcId, 3, "after compaction", 2);

  compactionDao.create({
    id: origCmpId,
    session_id: srcId,
    seq: 2,
    summarized_count: 1,
    tokens_before: 35_000,
    tokens_after: 7_000,
    summary_text: "original summary",
    archived_json: JSON.stringify([]),
    created_at: NOW,
  });

  messageDao.replaceAll(srcId, [
    { role: "assistant", content: "original summary" },
    { role: "user", content: "after compaction" },
  ]);

  await sessionManager.forkSession("u_fork", srcId, 3);

  const srcDetail = compactionDao.byId(srcId, origCmpId);
  assert.ok(srcDetail, "source compaction row must still be reachable after fork");
  assert.equal(srcDetail!.id, origCmpId);
  assert.equal(srcDetail!.session_id, srcId);
});

console.log("\n── 3. FLOOR REJECT ────────────────────────────────────────────────");

await check("fork at seq <= latestCompactionSeq → reason 'compacted'", async () => {
  const srcId = "s_floor_src";
  seedSession(srcId);

  const cmpId = "cmp_" + crypto.randomUUID();
  appendUser(srcId, 1, "msg1", 0);
  appendCompaction(srcId, 3, cmpId);
  appendUser(srcId, 5, "msg after", 2);

  compactionDao.create({
    id: cmpId,
    session_id: srcId,
    seq: 3,
    summarized_count: 1,
    tokens_before: 30_000,
    tokens_after: 5_000,
    summary_text: "summary",
    archived_json: JSON.stringify([]),
    created_at: NOW,
  });
  messageDao.replaceAll(srcId, [{ role: "assistant", content: "summary" }, { role: "user", content: "msg after" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 1);
  assert.equal(out.ok, false, `expected ok:false, got: ${JSON.stringify(out)}`);
  assert.ok(!out.ok && out.reason === "compacted", `expected reason "compacted", got "${!out.ok ? out.reason : "n/a"}"`);
});

await check("fork exactly AT latestCompactionSeq (seq===floor) → reason 'compacted'", async () => {
  const srcId = "s_floor_eq_src";
  seedSession(srcId);

  const cmpId2 = "cmp_" + crypto.randomUUID();
  appendUser(srcId, 1, "early msg", 0);
  appendCompaction(srcId, 2, cmpId2);
  appendUser(srcId, 3, "later msg", 1);

  compactionDao.create({
    id: cmpId2,
    session_id: srcId,
    seq: 2,
    summarized_count: 1,
    tokens_before: 20_000,
    tokens_after: 4_000,
    summary_text: "s",
    archived_json: "[]",
    created_at: NOW,
  });
  messageDao.replaceAll(srcId, [{ role: "assistant", content: "s" }, { role: "user", content: "later msg" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 1);
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.reason === "compacted", `expected "compacted", got "${!out.ok ? out.reason : "n/a"}"`);
});

console.log("\n── 4. NOT-FORKABLE / TOO-OLD ──────────────────────────────────────");

await check("fork at an assistant row → reason 'not-forkable'", async () => {
  const srcId = "s_nf_asst";
  seedSession(srcId);
  appendUser(srcId, 1, "user msg", 0);
  appendAssistant(srcId, 2, "assistant reply");
  messageDao.replaceAll(srcId, [{ role: "user", content: "user msg" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 2);
  assert.equal(out.ok, false, `expected ok:false, got: ${JSON.stringify(out)}`);
  assert.ok(!out.ok && out.reason === "not-forkable", `expected "not-forkable", got "${!out.ok ? out.reason : "n/a"}"`);
});

await check("fork at a user row with null msg_cut → reason 'too-old'", async () => {
  const srcId = "s_too_old";
  seedSession(srcId);
  appendUserNoMsgCut(srcId, 1, "ancient message");
  appendAssistant(srcId, 2, "reply");
  appendUser(srcId, 3, "newer msg", 1);
  messageDao.replaceAll(srcId, [{ role: "user", content: "ancient message" }, { role: "user", content: "newer msg" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 1);
  assert.equal(out.ok, false, `expected ok:false, got: ${JSON.stringify(out)}`);
  assert.ok(!out.ok && out.reason === "too-old", `expected "too-old", got "${!out.ok ? out.reason : "n/a"}"`);
});

console.log("\n── 5. ISOLATION ───────────────────────────────────────────────────");

await check("forkSession completes without throwing (no runtime construction error)", async () => {
  const srcId = "s_iso_src";
  seedSession(srcId);
  appendUser(srcId, 1, "iso msg", 0);
  messageDao.replaceAll(srcId, [{ role: "user", content: "iso msg" }]);

  const out = await sessionManager.forkSession("u_fork", srcId, 1);
  assert.ok(out.ok, `forkSession threw / returned ok:false — a runtime may have been constructed: ${JSON.stringify(out)}`);
  console.log("    (note: runtimes map is private; isolation confirmed indirectly — no throw)");
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} fork check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall fork checks passed`);
