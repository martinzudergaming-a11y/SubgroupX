import assert from "node:assert/strict";
import {
  knownProviders,
  listModelsForProviders,
  resolveModel,
} from "../server/src/runtime/providers.ts";

assert.ok(knownProviders().includes("kimi-coding"), "kimi-coding is a key-configurable provider");

const models = listModelsForProviders(["kimi-coding"]);
const kimi = models.filter((m) => m.provider === "kimi-coding");
assert.ok(kimi.length >= 2, `Kimi Code catalog is exposed (got ${kimi.length} models)`);
const k3 = kimi.find((m) => m.id === "k3");
assert.ok(k3, "Kimi K3 is listed");
assert.equal(k3!.reasoning, true);

assert.deepEqual(k3!.thinkingLevels, ["low", "medium", "high", "max"], "K3 surfaces exactly the extras its model map declares — max, and no xhigh");

const mock = models.find((m) => m.mock);
assert.ok(mock && !("thinkingLevels" in mock && mock.thinkingLevels), "trio models leave thinkingLevels off the wire");

const resolved = resolveModel("kimi-coding", "k3");
assert.equal(resolved.api, "anthropic-messages", "Kimi Code speaks the Anthropic messages protocol");
assert.equal(resolved.baseUrl, "https://api.kimi.com/coding", "the DEDICATED coding entry, not moonshot.ai");
assert.match(
  String((resolved.headers as Record<string, string> | undefined)?.["User-Agent"] ?? ""),
  /^KimiCLI\//,
  "resolved model carries pi's KimiCLI User-Agent (no oiia-side override)",
);
assert.equal((resolved as { compat?: { forceAdaptiveThinking?: boolean } }).compat?.forceAdaptiveThinking, true, "adaptive thinking compat");
assert.equal(
  (resolved as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap?.max,
  "max",
  "pi maps our max level to Kimi's max effort",
);

console.log(`check-kimi-provider: Kimi Code entry, K3 thinking levels and transport shape hold (${kimi.length} models)`);
