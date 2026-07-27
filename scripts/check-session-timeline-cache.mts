import assert from "node:assert/strict";
import {
  SESSION_TIMELINE_CACHE_MAX_ITEMS,
  SESSION_TIMELINE_CACHE_MAX_ITEMS_PER_SESSION,
  SESSION_TIMELINE_CACHE_MAX_SESSIONS,
  SESSION_TIMELINE_CACHE_MAX_CHARS,
  SESSION_TIMELINE_CACHE_MAX_CHARS_PER_SESSION,
  SessionTimelineCache,
  type SessionTimelineSnapshot,
} from "../web/src/dashboard/session/session-timeline-cache.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

const items = (count: number, prefix: string): TimelineItem[] => Array.from({ length: count }, (_, index) => ({
  kind: "user",
  id: `${prefix}_${index}`,
  seq: index + 1,
  text: `${prefix} ${index}`,
  ts: index + 1,
}));
const snapshot = (sessionId: string, count = 1, epoch = `epoch_${sessionId}`, approxChars = count * 100): SessionTimelineSnapshot => ({
  sessionId,
  epoch,
  version: 0,
  items: items(count, sessionId),
  pending: [],
  approxChars,
});

const cache = new SessionTimelineCache();
assert.equal(cache.write(snapshot("unanchored", 1, "")), false, "never cache state before a server replay epoch");
assert.equal(cache.read("unanchored"), null);
assert.equal(cache.write({ ...snapshot("legacy"), version: Number.NaN }), false, "never resume from a missing/invalid snapshot version");

const withLocal = snapshot("stable", 2);
withLocal.items.push({ kind: "user", id: "local_u_1", seq: 3, text: "optimistic", ts: 3 });
withLocal.pending.push({ id: "local_p_1", kind: "queue", text: "optimistic", ts: 3, ord: 3 });
assert.equal(cache.write(withLocal), true);
assert.deepEqual(cache.read("stable")?.items.map((item) => item.id), ["stable_0", "stable_1"], "timer-owned optimistic rows are not cached");
assert.deepEqual(cache.read("stable")?.pending, [], "optimistic pending chips are not cached");

assert.equal(cache.write(snapshot("too-large", SESSION_TIMELINE_CACHE_MAX_ITEMS_PER_SESSION + 1)), false, "one huge session cannot pin the heap");
assert.equal(cache.read("too-large"), null);
assert.equal(cache.write(snapshot("too-wide", 1, "epoch_wide", SESSION_TIMELINE_CACHE_MAX_CHARS_PER_SESSION + 1)), false, "one huge text payload cannot pin the heap");
assert.equal(cache.read("too-wide"), null);
const oversizedPending = snapshot("pending-too-wide", 0, "epoch_pending", 1);
oversizedPending.pending.push({
  id: "p_oversized",
  kind: "queue",
  text: "x".repeat(SESSION_TIMELINE_CACHE_MAX_CHARS_PER_SESSION + 1),
  ts: 1,
  ord: 1,
});
assert.equal(cache.write(oversizedPending), false, "a replacement pending_queue snapshot cannot bypass the character bound");
assert.equal(cache.read("pending-too-wide"), null);
const combinedWide = snapshot("combined-too-wide", 0, "epoch_combined", 16 * 1024 * 1024);
combinedWide.pending.push({
  id: "p_combined",
  kind: "steer",
  text: "y".repeat(9 * 1024 * 1024),
  ts: 2,
  ord: 2,
});
assert.equal(cache.write(combinedWide), false, "Timeline and replacement-pending retained sizes are additive, not max-of-two");
assert.equal(cache.read("combined-too-wide"), null);

const stablePending = snapshot("stable-pending", 1, "epoch_stable", 100);
stablePending.pending.push({ id: "p_stable", kind: "queue", text: "hello", ts: 3, ord: 3 });
assert.equal(cache.write(stablePending), true);
const firstWeight = cache.stats().chars;
const stableRead = cache.read("stable-pending")!;
assert.equal(cache.write(stableRead), true);
assert.equal(cache.stats().chars, firstWeight, "read/write cycles must not repeatedly add pending weight");

cache.clear();
for (let index = 0; index < SESSION_TIMELINE_CACHE_MAX_SESSIONS; index++) {
  assert.equal(cache.write(snapshot(`s${index}`)), true);
}
cache.read("s0");
cache.write(snapshot("s3"));
assert.equal(cache.read("s1"), null, "LRU evicts the least recently used session");
assert.deepEqual(cache.stats().ids.sort(), ["s0", "s2", "s3"]);

cache.clear();
const half = Math.floor(SESSION_TIMELINE_CACHE_MAX_ITEMS / 2);
cache.write(snapshot("heavy-a", half));
cache.write(snapshot("heavy-b", half));
cache.write(snapshot("heavy-c", 1));
assert.equal(cache.read("heavy-a"), null, "global item budget evicts the oldest large snapshot");
assert.ok(cache.stats().items <= SESSION_TIMELINE_CACHE_MAX_ITEMS);

cache.clear();
const halfChars = Math.floor(SESSION_TIMELINE_CACHE_MAX_CHARS / 2);
cache.write(snapshot("wide-a", 1, "epoch_a", halfChars));
cache.write(snapshot("wide-b", 1, "epoch_b", halfChars));
cache.write(snapshot("wide-c", 1, "epoch_c", 1));
assert.equal(cache.read("wide-a"), null, "global character budget evicts the oldest wide snapshot");
assert.ok(cache.stats().chars <= SESSION_TIMELINE_CACHE_MAX_CHARS);

console.log("OK session-timeline-cache: epoch gate + optimistic cleanup + LRU + item/character bounds");
