import assert from "node:assert/strict";
import { reduceTimeline } from "../shared/src/timeline-reducer.ts";
import type { TimelineItem, WireAgentEvent } from "../shared/src/protocol.ts";

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

function startEv(id: string, summarizedCount = 10): WireAgentEvent {
  return { t: "compaction_start", id, summarizedCount };
}

function endEv(id: string): WireAgentEvent {
  return { t: "compaction_end", id };
}

function markerEv(id: string, opts?: { summarizedCount?: number; tokensBefore?: number; tokensAfter?: number }): WireAgentEvent {
  return {
    t: "compaction",
    id,
    compactionId: id,
    summarizedCount: opts?.summarizedCount ?? 10,
    tokensBefore: opts?.tokensBefore ?? 50_000,
    tokensAfter: opts?.tokensAfter ?? 12_000,
  };
}

function userItem(id: string, seq: number): TimelineItem {
  return { kind: "user", id, seq, text: "hello", ts: Date.now() };
}

check("compaction_start appends a compaction_pending placeholder", () => {
  const items: TimelineItem[] = [];
  const next = reduceTimeline(items, startEv("cmp_1"));
  assert.equal(next.length, 1);
  const item = next[0];
  assert.equal(item.kind, "compaction_pending");
  assert.equal(item.id, "cmp_1");
  assert.equal((item as Extract<TimelineItem, { kind: "compaction_pending" }>).summarizedCount, 10);
});

check("duplicate compaction_start is a no-op (idempotent)", () => {
  const base: TimelineItem[] = [];
  const after1 = reduceTimeline(base, startEv("cmp_dup"));
  assert.equal(after1.length, 1);

  const after2 = reduceTimeline(after1, startEv("cmp_dup"));
  assert.equal(after2.length, 1);
  assert.equal(after2[0].kind, "compaction_pending");
});

check("compaction_start then compaction morphs placeholder in place (length stays, position+seq preserved, kind flips, tokens carried)", () => {
  const user1 = userItem("u1", 1);
  const user2 = userItem("u2", 2);

  let state: TimelineItem[] = [user1];
  state = reduceTimeline(state, startEv("cmp_m", 8));
  state = [...state, user2];

  assert.equal(state.length, 3);
  assert.equal(state[1].kind, "compaction_pending");

  const pendingSeq = state[1].seq;

  const next = reduceTimeline(state, markerEv("cmp_m", { summarizedCount: 8, tokensBefore: 60_000, tokensAfter: 15_000 }));

  assert.equal(next.length, 3, "morph must not change list length");

  assert.equal(next[0].id, "u1", "user1 is still first");
  assert.equal(next[2].id, "u2", "user2 is still last");

  const marker = next[1];
  assert.equal(marker.kind, "compaction", "kind must flip from compaction_pending to compaction");
  assert.equal(marker.id, "cmp_m");

  assert.equal(marker.seq, pendingSeq, "morph must preserve the placeholder's seq");

  const cm = marker as Extract<TimelineItem, { kind: "compaction" }>;
  assert.equal(cm.summarizedCount, 8);
  assert.equal(cm.tokensBefore, 60_000);
  assert.equal(cm.tokensAfter, 15_000);
});

check("compaction_start then compaction_end removes the placeholder", () => {
  const user1 = userItem("u_a", 1);
  let state: TimelineItem[] = [user1];
  state = reduceTimeline(state, startEv("cmp_drop"));

  assert.equal(state.length, 2);
  assert.equal(state[1].kind, "compaction_pending");

  const next = reduceTimeline(state, endEv("cmp_drop"));
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "u_a");
});

check("compaction with no prior placeholder appends a fresh marker", () => {
  const user1 = userItem("u_b", 1);
  const state: TimelineItem[] = [user1];
  const next = reduceTimeline(state, markerEv("cmp_fresh", { summarizedCount: 5, tokensBefore: 40_000, tokensAfter: 10_000 }));

  assert.equal(next.length, 2);
  const marker = next[1];
  assert.equal(marker.kind, "compaction");
  assert.equal(marker.id, "cmp_fresh");
  const cm = marker as Extract<TimelineItem, { kind: "compaction" }>;
  assert.equal(cm.summarizedCount, 5);
  assert.equal(cm.tokensBefore, 40_000);
  assert.equal(cm.tokensAfter, 10_000);
});

check("replayed compaction marker (same id already a compaction) is idempotent", () => {
  let state: TimelineItem[] = [];
  state = reduceTimeline(state, markerEv("cmp_replay", { summarizedCount: 7, tokensBefore: 55_000, tokensAfter: 13_000 }));
  assert.equal(state.length, 1);
  assert.equal(state[0].kind, "compaction");

  const seqBefore = state[0].seq;

  const next = reduceTimeline(state, markerEv("cmp_replay", { summarizedCount: 999, tokensBefore: 1, tokensAfter: 1 }));
  assert.equal(next.length, 1);
  assert.equal(next[0].seq, seqBefore, "seq must not change on idempotent replay");
  const cm = next[0] as Extract<TimelineItem, { kind: "compaction" }>;
  assert.equal(cm.summarizedCount, 7, "idempotent replay must not overwrite marker fields");
});

check("compaction_end with no matching id is a no-op", () => {
  const user1 = userItem("u_c", 1);
  const state: TimelineItem[] = [user1];
  const next = reduceTimeline(state, endEv("cmp_ghost"));

  assert.equal(next.length, 1);
  assert.equal(next[0].id, "u_c");
});

check("compaction_end for an id that is a real compaction marker does NOT delete it", () => {
  let state: TimelineItem[] = [];
  state = reduceTimeline(state, markerEv("cmp_real"));
  assert.equal(state.length, 1);
  assert.equal(state[0].kind, "compaction");

  const next = reduceTimeline(state, endEv("cmp_real"));
  assert.equal(next.length, 1, "real compaction marker must NOT be deleted by compaction_end");
  assert.equal(next[0].kind, "compaction");
  assert.equal(next[0].id, "cmp_real");
});

check("morph: seq on the morphed marker equals the placeholder's seq (not a later counter value)", () => {
  let state: TimelineItem[] = [];
  for (let i = 0; i < 5; i++) {
    state = reduceTimeline(state, { t: "user_message", id: `u_adv_${i}`, text: "x" });
  }
  state = reduceTimeline(state, startEv("cmp_seq_test", 3));
  const placeholder = state.find((x) => x.id === "cmp_seq_test")!;
  assert.ok(placeholder, "placeholder must exist");
  const placeholderSeq = placeholder.seq;

  state = reduceTimeline(state, { t: "user_message", id: "u_adv_after", text: "y" });

  const next = reduceTimeline(state, markerEv("cmp_seq_test", { summarizedCount: 3 }));
  const morphed = next.find((x) => x.id === "cmp_seq_test")!;
  assert.ok(morphed, "morphed marker must exist");
  assert.equal(morphed.seq, placeholderSeq, "morphed marker seq must equal original placeholder seq");
  assert.equal(morphed.kind, "compaction");
});

if (failed > 0) {
  console.error(`\n${failed} compaction reducer check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all compaction reducer checks passed");
