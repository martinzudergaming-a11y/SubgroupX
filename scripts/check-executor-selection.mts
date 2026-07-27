import assert from "node:assert/strict";
import { chooseAutomaticExecutor, modelExecutorAvailability } from "../web/src/platform/executors.ts";

const blocked = modelExecutorAvailability({
  models: [],
  e2b: false,
  executors: {
    local: { available: false, reason: "policy_disabled" },
    e2b: { available: false, reason: "capacity_unavailable" },
  },
});
assert.equal(chooseAutomaticExecutor(blocked, []), null, "no executor means no automatic session");
assert.deepEqual(
  chooseAutomaticExecutor(blocked, [{ id: "connector_example", online: true }]),
  { kind: "connector", targetId: "connector_example" },
  "an online Connector replaces unavailable E2B",
);
assert.equal(
  chooseAutomaticExecutor(blocked, [{ id: "connector_offline", online: false }]),
  null,
  "an offline Connector cannot make a usable session",
);
assert.deepEqual(
  chooseAutomaticExecutor(
    { local: { available: false, reason: "policy_disabled" }, e2b: { available: true } },
    [{ id: "connector_example", online: true }],
  ),
  { kind: "e2b", targetId: null },
  "healthy E2B retains the existing default",
);
assert.deepEqual(
  chooseAutomaticExecutor(
    { local: { available: true }, e2b: { available: false, reason: "not_configured" } },
    [],
  ),
  { kind: "local", targetId: null },
  "trusted local dev/e2e remains supported",
);

console.log("OK executor-selection: auto bootstrap chooses only a usable execution environment");
