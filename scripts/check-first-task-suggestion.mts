import assert from "node:assert/strict";
import {
  FIRST_TASK_SUGGESTIONS,
  shouldSuggestFirstTask,
  suggestionForSession,
} from "../web/src/dashboard/session/first-task-suggestion.ts";

assert.equal(shouldSuggestFirstTask({ hasActivity: false, draft: "" }), true);
assert.equal(shouldSuggestFirstTask({ hasActivity: false, draft: "L" }), false);

assert.equal(shouldSuggestFirstTask({ hasActivity: true, draft: "" }), false);
assert.equal(shouldSuggestFirstTask({ hasActivity: true, draft: "L" }), false);

const session = "s_9bcccca3-8cc0-4565-885d-8e9ebade4376";
assert.equal(suggestionForSession(session), suggestionForSession(session));

const picks = new Set(
  Array.from({ length: 400 }, (_, i) => suggestionForSession(`s_${i}-${i * 7}`)),
);
assert.equal(picks.size, FIRST_TASK_SUGGESTIONS.length, "every starter must be reachable");

for (const id of ["", "s", "s_" + "f".repeat(120), "会话-1"]) {
  assert.ok(
    FIRST_TASK_SUGGESTIONS.includes(suggestionForSession(id)),
    `suggestionForSession(${JSON.stringify(id)}) fell outside the set`,
  );
}

console.log("OK first-task-suggestion: empty field only, stable per session, every starter reachable");
