import assert from "node:assert/strict";
import {
  publishOrchestrationInvalidation,
  publishOrchestrationInvalidationSnapshot,
  readOrchestrationInvalidation,
  subscribeOrchestrationInvalidation,
} from "../web/src/orchestration/invalidation-store.ts";

const counts = new Map<string, number>();
const watch = (key: Parameters<typeof subscribeOrchestrationInvalidation>[0]) =>
  subscribeOrchestrationInvalidation(key, () => counts.set(key, (counts.get(key) ?? 0) + 1));

const dispose = [
  watch("activity"),
  watch("workflows"),
  watch("teams"),
  watch("session:session-visible"),
  watch("session:session-omitted"),
  watch("workflow:workflow-visible"),
  watch("team:team-visible"),
];

publishOrchestrationInvalidation({ resource: "workflow", workflowId: "workflow-visible", version: 4 });
publishOrchestrationInvalidation({ resource: "workflow", workflowId: "workflow-visible", version: 5 });
publishOrchestrationInvalidation({ resource: "team", teamId: "team-visible", version: 7 });
await Promise.resolve();

assert.equal(counts.get("workflow:workflow-visible"), 1, "a synchronous Workflow burst must coalesce");
assert.equal(counts.get("workflows"), 1, "one Workflow must invalidate its global collection");
assert.equal(counts.get("team:team-visible"), 1, "Team detail must wake once");
assert.equal(counts.get("teams"), 1, "one Team must invalidate its global collection");

publishOrchestrationInvalidation({ resource: "workflow", workflowId: "workflow-visible", version: 3 });
await Promise.resolve();
assert.equal(counts.get("workflow:workflow-visible"), 1, "an older object version must not wake detail");
assert.equal(counts.get("workflows"), 2, "object versions are not compared across the collection");

publishOrchestrationInvalidationSnapshot({
  stale: true,
  activityRevision: 9,
  sessionRuns: [{ sessionId: "session-visible", revision: 11 }],
  truncated: true,
});
await Promise.resolve();

for (const key of [
  "activity",
  "workflows",
  "teams",
  "session:session-visible",
  "session:session-omitted",
  "workflow:workflow-visible",
  "team:team-visible",
] as const) {
  assert.ok((counts.get(key) ?? 0) >= 1, `reconnect must wake mounted ${key}`);
  assert.ok(readOrchestrationInvalidation(key) >= 1, `generation must advance for ${key}`);
}

for (const stop of dispose) stop();
console.log(JSON.stringify({ ok: true, notifications: Object.fromEntries(counts) }));
