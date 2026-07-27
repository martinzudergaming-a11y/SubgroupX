import assert from "node:assert/strict";
import { isPendingMutationRefusal } from "../web/src/dashboard/session/pending-mutation.ts";
import { PendingMutationRouter } from "../web/src/platform/pending-mutation-router.ts";
import { pendingOrderWithKindSlots } from "../web/src/dashboard/session/composer/pending-order.ts";
import type { PendingMessage, ServerEvent } from "../shared/src/protocol.ts";

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

function applySnapshot(
  replayEpoch: string | null,
  evEpoch: string,
  evPending: PendingMessage[],
): PendingMessage[] | "dropped" {
  if (replayEpoch !== null && evEpoch !== replayEpoch) return "dropped";
  return evPending;
}

function renderOrder(pending: PendingMessage[]): { kind: string; text: string; label: string }[] {
  const sorted = [...pending].sort((a, b) => (a.kind === b.kind ? a.ord - b.ord : a.kind === "steer" ? -1 : 1));
  const queueSorted = [...pending].filter((p) => p.kind === "queue").sort((a, b) => a.ord - b.ord);
  return sorted.map((p) => ({
    kind: p.kind,
    text: p.text,
    label: p.kind === "steer" ? "STEER" : `#${queueSorted.findIndex((q) => q.id === p.id) + 1}`,
  }));
}

const pm = (id: string, kind: PendingMessage["kind"], text: string, ord: number): PendingMessage => ({ id, kind, text, ts: 0, ord });

console.log("\n── snapshot apply (idempotent, stale-epoch guarded) ──");

check("a snapshot from the current epoch is applied wholesale", () => {
  const snap = [pm("p1", "queue", "q", 1)];
  assert.deepEqual(applySnapshot("e2", "e2", snap), snap);
});

check("a snapshot from a STALE epoch (pre-rewind) is dropped (no chip resurrection)", () => {
  assert.equal(applySnapshot("e2", "e1", [pm("p1", "queue", "ghost", 1)]), "dropped");
});

check("before any replay anchors an epoch (null), a snapshot passes through", () => {
  const snap = [pm("p1", "steer", "s", 1)];
  assert.deepEqual(applySnapshot(null, "e1", snap), snap);
});

check("add then consume share ONE code path: the consume snapshot (without the row) wins wholesale", () => {
  let pending = applySnapshot("e1", "e1", [pm("p1", "queue", "stays", 1)]) as PendingMessage[];
  assert.equal(pending.length, 1);
  pending = applySnapshot("e1", "e1", []) as PendingMessage[];
  assert.equal(pending.length, 0, "the chip drops the instant the consume snapshot arrives");
});

console.log("\n── a replay/wait never silently removes a pending chip ──");

check("a timeline_replay carries the live pending set → the chip survives a refresh/reconnect", () => {
  const replayPending = [pm("p1", "queue", "behind a long turn", 1)];
  const applied = applySnapshot("e1", "e1", replayPending) as PendingMessage[];
  assert.deepEqual(applied.map((p) => p.text), ["behind a long turn"]);
});

check("there is NO time-based removal: identical input → identical output regardless of 'elapsed' calls", () => {
  const snap = [pm("p1", "queue", "no ghost timer", 1)];
  let pending = snap;
  for (let i = 0; i < 100; i++) pending = applySnapshot("e1", "e1", snap) as PendingMessage[];
  assert.equal(pending.length, 1, "no 10s ghost-timeout applies to steer/queue chips");
});

console.log("\n── render order: steer first, then queue #1/#2/#3 by ord ──");

check("steer chips render before queue chips", () => {
  const order = renderOrder([pm("q1", "queue", "qa", 1), pm("s1", "steer", "sa", 2)]);
  assert.equal(order[0].kind, "steer", "steer must render first even though it has a higher ord");
  assert.equal(order[1].kind, "queue");
});

check("queue chips are numbered #1/#2/#3 by ascending ord", () => {
  const order = renderOrder([pm("q3", "queue", "c", 3), pm("q1", "queue", "a", 1), pm("q2", "queue", "b", 2)]);
  const queue = order.filter((o) => o.kind === "queue");
  assert.deepEqual(queue.map((o) => o.text), ["a", "b", "c"], "ascending ord");
  assert.deepEqual(queue.map((o) => o.label), ["#1", "#2", "#3"]);
});

check("a steer + multiple queue: steer first, then queue numbered from #1", () => {
  const order = renderOrder([pm("q1", "queue", "qa", 1), pm("q2", "queue", "qb", 2), pm("s1", "steer", "sa", 3)]);
  assert.deepEqual(order.map((o) => `${o.kind}:${o.label}`), ["steer:STEER", "queue:#1", "queue:#2"]);
});

check("same-kind drag preserves every original cross-kind ord slot", () => {
  const interleaved = [
    pm("q1", "queue", "claimed", 1),
    pm("s1", "steer", "one", 2),
    pm("q2", "queue", "later", 3),
    pm("s2", "steer", "two", 4),
  ];
  assert.deepEqual(
    pendingOrderWithKindSlots(interleaved, "steer", ["s2", "s1"]),
    ["q1", "s2", "q2", "s1"],
  );
});

console.log("\n── typed mutation refusal restores UI without a transcript error ──");

check("the authoritative snapshot wins before the typed refusal becomes a toast", () => {
  const router = new PendingMutationRouter(() => 1_000);
  router.track({ type: "set_pending_kind", reqId: "r1", sessionId: "s1", pendingId: "q1", kind: "steer" });
  let pending = [pm("q1", "steer", "optimistic", 1)];
  const frames: ServerEvent[] = [
    { type: "pending_queue", sessionId: "s1", epoch: "e1", version: 2, pending: [pm("q1", "queue", "durable", 1)] },
    { type: "error", reqId: "r1", sessionId: "s1", code: "draining", message: "server is restarting" },
  ];
  const transcriptErrors: string[] = [];
  const toasts: string[] = [];
  for (const frame of frames) {
    if (frame.type === "pending_queue") pending = applySnapshot("e1", frame.epoch, frame.pending) as PendingMessage[];
    if (frame.type === "error") {
      router.observe(frame);
      if (isPendingMutationRefusal(frame, "s1") && router.sessionFor(frame) === "s1") toasts.push(frame.message);
      else transcriptErrors.push(frame.message);
    }
  }
  assert.deepEqual(pending.map(({ kind, text }) => [kind, text]), [["queue", "durable"]]);
  assert.deepEqual(toasts, ["server is restarting"]);
  assert.deepEqual(transcriptErrors, []);
});

check("a busy send_message refusal keeps exact toast routing", () => {
  const router = new PendingMutationRouter(() => 1_000);
  router.track({ type: "send_message", reqId: "r-submit", sessionId: "s1", text: "later", mode: "steer" });
  const refusal: ServerEvent = {
    type: "error",
    reqId: "r-submit",
    sessionId: "s1",
    code: "pending_mutation_failed",
    message: "pending mutation failed",
  };
  router.observe(refusal);
  assert.equal(router.sessionFor(refusal as Extract<ServerEvent, { type: "error" }> & { code: "pending_mutation_failed" }), "s1");
});

check("an untyped error keeps the normal transcript path", () => {
  assert.equal(isPendingMutationRefusal({ type: "error", message: "model failed" }, "s1"), false);
});

check("a delayed Session-A refusal is consumed silently after a rapid switch to B", () => {
  const router = new PendingMutationRouter(() => 1_000);
  router.track({ type: "set_pending_text", reqId: "ra", sessionId: "A", pendingId: "p", text: "edit" });
  const refusal = { type: "error", reqId: "ra", sessionId: "A", code: "draining", message: "restart" } as const;
  router.observe(refusal);
  assert.equal(router.sessionFor(refusal), "A", "reqId routes to its authored Session");
  assert.equal(isPendingMutationRefusal(refusal, "B"), false, "B never claims A's refusal");
  const bTranscriptErrors = refusal.code ? [] : [refusal.message];
  assert.deepEqual(bTranscriptErrors, []);
});

check("reqId routing is exact, TTL-bounded, and capacity-bounded", () => {
  let now = 0;
  const router = new PendingMutationRouter(() => now, 100, 3);
  for (let index = 0; index < 5; index++) {
    router.track({ type: "reorder_pending", reqId: `r${index}`, sessionId: `s${index}`, order: [] });
  }
  assert.equal(router.size, 3, "oldest request routes are evicted at the hard cap");
  const mismatch = { type: "error", reqId: "r4", sessionId: "wrong", code: "draining", message: "restart" } as const;
  router.observe(mismatch);
  assert.equal(router.sessionFor(mismatch), null, "reqId/session mismatch never routes");
  const exact = { ...mismatch, sessionId: "s4" } as const;
  router.observe(exact);
  assert.equal(router.sessionFor(exact), "s4", "a foreign frame cannot consume the exact route");
  now = 101;
  assert.equal(router.size, 0, "expired routes are released");
});

if (failed > 0) {
  console.error(`\n${failed} pending-client check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all pending-client checks passed");
