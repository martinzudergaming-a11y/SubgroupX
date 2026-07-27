import assert from "node:assert/strict";
import { reduceTimeline, mergeReplayWithPending } from "../shared/src/timeline-reducer.ts";
import type { PendingOptimistic } from "../shared/src/timeline-reducer.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const userItem = (id: string, seq: number, text: string): TimelineItem => ({ kind: "user", id, seq, text, ts: Date.now() });

console.log("\n── timeline_replay merge preserves still-pending optimistic items ──");

check("a pending optimistic item whose text is ABSENT from the replay survives the merge", () => {
  const replay: TimelineItem[] = [userItem("u_server1", 1, "earlier message")];
  const pending: PendingOptimistic[] = [{ localId: "local_u_5", text: "the unconfirmed one" }];
  const merged = mergeReplayWithPending(replay, pending);
  assert.equal(merged.length, 2, "merged must keep the replay item AND the pending one");
  const survivor = merged.find((i) => i.kind === "user" && i.text === "the unconfirmed one");
  assert.ok(survivor, "the pending optimistic bubble must survive");
  assert.equal(survivor!.id, "local_u_5", "it must keep its local_u_ id so the echo can rename it in place");
});

check("a pending item whose text is ALREADY in the replay is NOT duplicated", () => {
  const replay: TimelineItem[] = [userItem("u_server2", 1, "already persisted")];
  const pending: PendingOptimistic[] = [{ localId: "local_u_6", text: "already persisted" }];
  const merged = mergeReplayWithPending(replay, pending);
  assert.equal(merged.length, 1, "no duplicate: the server row already covers this text");
  assert.equal(merged[0].id, "u_server2", "the authoritative server row is kept");
});

check("no pending items → replay is returned unchanged (identity)", () => {
  const replay: TimelineItem[] = [userItem("u_a", 1, "x")];
  const merged = mergeReplayWithPending(replay, []);
  assert.equal(merged, replay, "empty pending must return the same array reference");
});

console.log("\n── reducer: user_message is idempotent by id ──");

check("feeding the same user_message twice (same id) leaves list length unchanged", () => {
  let state: TimelineItem[] = [];
  state = reduceTimeline(state, { t: "user_message", id: "u_dup", text: "hi", seq: 7 });
  assert.equal(state.length, 1);
  const after = reduceTimeline(state, { t: "user_message", id: "u_dup", text: "hi", seq: 7 });
  assert.equal(after.length, 1, "duplicate user_message by id must be a no-op");
  assert.equal(after, state, "idempotent replay returns the same array reference");
});

check("the optimistic bubble + server echo collapse to ONE item (rename-then-dedup)", () => {
  let state: TimelineItem[] = [userItem("local_u_9", Date.now(), "write a haiku")];
  state = state.map((it) => (it.id === "local_u_9" ? { ...it, id: "u_realserver", seq: 42 } : it));
  const after = reduceTimeline(state, { t: "user_message", id: "u_realserver", text: "write a haiku", seq: 42 });
  assert.equal(after.length, 1, "exactly one user item after optimistic+echo+message_start collapse");
  assert.equal(after[0].id, "u_realserver");
  assert.equal(after[0].seq, 42, "the real server seq is retained (needed as the rewind toSeq)");
});

console.log("\n── agent_event stale-epoch filter ──");

function shouldDrop(replayEpoch: string | null, eventEpoch: string): boolean {
  return replayEpoch !== null && eventEpoch !== replayEpoch;
}

check("event from the current epoch is kept", () =>
  assert.equal(shouldDrop("epoch-2", "epoch-2"), false),
);
check("event from a STALE epoch (pre-rewind) is dropped", () =>
  assert.equal(shouldDrop("epoch-2", "epoch-1"), true),
);
check("before any replay anchors an epoch (null), events pass through", () =>
  assert.equal(shouldDrop(null, "epoch-1"), false),
);

if (failed > 0) {
  console.error(`\n${failed} replay-merge check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all replay-merge checks passed");
