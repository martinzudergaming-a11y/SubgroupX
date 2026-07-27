import assert from "node:assert/strict";
import {
  applySessionActivity,
  removeSessionActivity,
  replaceSessionActivities,
} from "../web/src/platform/session-activity-state.ts";

const empty = {};
const running = applySessionActivity(empty, "session-a", "running");
assert.deepEqual(running, { "session-a": true });
assert.equal(applySessionActivity(running, "session-a", "running"), running, "same delta keeps identity");

const replaced = replaceSessionActivities(running, [
  { sessionId: "session-b", activity: "idle" },
  { sessionId: "session-c", activity: "running" },
]);
assert.deepEqual(replaced, { "session-c": true }, "snapshot atomically removes absent stale ids");
assert.equal(
  replaceSessionActivities(replaced, [{ sessionId: "session-c", activity: "running" }]),
  replaced,
  "equal snapshot keeps identity",
);

assert.deepEqual(removeSessionActivity(replaced, "session-c"), {}, "Session deletion clears activity");
assert.equal(removeSessionActivity(empty, "missing"), empty, "missing deletion keeps identity");
console.log("session activity state checks passed");
