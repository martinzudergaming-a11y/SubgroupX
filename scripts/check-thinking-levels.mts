import assert from "node:assert/strict";
import { isThinkingLevel, THINKING_LEVELS } from "../shared/src/protocol.ts";

assert.deepEqual(
  [...THINKING_LEVELS],
  ["low", "medium", "high", "xhigh", "max"],
  "levels are ordered weakest to strongest; the picker renders in array order",
);

for (const good of THINKING_LEVELS) assert.equal(isThinkingLevel(good), true, `${good} is a level`);
for (const bad of ["off", "minimal", "MAX", "", "highest", null, undefined, 3]) {
  assert.equal(isThinkingLevel(bad), false, `${String(bad)} is not a session level`);
}
console.log("  OK vocabulary and validation");

const { AGENT_THINKING_LEVELS_ARE_WIDER } = { AGENT_THINKING_LEVELS_ARE_WIDER: true };
assert.equal(AGENT_THINKING_LEVELS_ARE_WIDER, true);

process.env.AGENT_WEB_JAIL_KEY = "test-key";
process.env.AGENT_WEB_JAIL_BASE_URL = "https://upstream.invalid/v1";
process.env.AGENT_WEB_JAIL_MODEL = "alpha";
process.env.AGENT_WEB_JAIL_MODELS = "beta,gamma";
process.env.AGENT_WEB_JAIL_MODEL_LEVELS = "alpha=xhigh,max;beta=xhigh";

const { listModelsForProviders } = await import("../server/src/runtime/providers.ts");
const models = listModelsForProviders([]);
const byId = (id: string) => models.find((m) => m.id === id);

assert.deepEqual(
  byId("alpha")?.thinkingLevels,
  ["low", "medium", "high", "xhigh", "max"],
  "a model configured with both extras offers both",
);
assert.deepEqual(
  byId("beta")?.thinkingLevels,
  ["low", "medium", "high", "xhigh"],
  "xhigh is offered WITHOUT max — the two are independent",
);
assert.equal(
  byId("gamma")?.thinkingLevels,
  undefined,
  "an unconfigured id advertises nothing extra, and the client falls back to the base three",
);
console.log("  OK operator channel reads its efforts from config");

process.env.AGENT_WEB_JAIL_MODEL_LEVELS = "alpha=max,xhigh";
const reordered = await import(`../server/src/runtime/providers.ts?v=${Date.now()}`);
assert.deepEqual(
  reordered.listModelsForProviders([]).find((m: { id: string }) => m.id === "alpha")?.thinkingLevels,
  ["low", "medium", "high", "xhigh", "max"],
  "config order does not leak into the picker",
);
console.log("  OK level order is normalised");

process.env.AGENT_WEB_JAIL_MODEL_LEVELS = "alpha=xhigh,max;beta=xhigh";
const clampMod = await import(`../server/src/runtime/providers.ts?clamp=${Date.now()}`);
const { effectiveThinkingLevel, resolveModel, JAIL_PROVIDER } = clampMod;
const alpha = resolveModel(JAIL_PROVIDER, "alpha");
const beta = resolveModel(JAIL_PROVIDER, "beta");
const gamma = resolveModel(JAIL_PROVIDER, "gamma");

assert.equal(effectiveThinkingLevel(alpha, "max"), "max", "a supported effort passes through");
assert.equal(effectiveThinkingLevel(beta, "max"), "xhigh",
  "max on an xhigh-only model steps DOWN to xhigh, not to medium — the user asked for as much as possible");
assert.equal(effectiveThinkingLevel(gamma, "max"), "high", "with no extras at all, max lands on high");
assert.equal(effectiveThinkingLevel(gamma, "xhigh"), "high", "same for xhigh");
assert.equal(effectiveThinkingLevel(beta, "low"), "low", "a weaker stored effort is untouched");
assert.equal(effectiveThinkingLevel(alpha, null), "medium", "an unset column is medium");
assert.equal(effectiveThinkingLevel(alpha, "garbage"), "medium", "an unparseable column is medium");
assert.equal(effectiveThinkingLevel({ ...alpha, reasoning: false }, "max"), "off",
  "a non-reasoning model carries no effort at all");
console.log("  OK a stored effort is clamped to what the current model accepts");

console.log("OK thinking-levels: vocabulary, validation, discovery, operator config and the stored-effort clamp all hold.");
