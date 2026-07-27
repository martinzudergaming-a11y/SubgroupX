import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import { performance } from "node:perf_hooks";

const tokenCount = await import("../server/src/runtime/token-count.ts");
assert.equal(tokenCount.tokenizerReady(), false, "the hard-count regression starts before lazy tokenizer load");

const recentDense = "汉字变化".repeat(1_250);
const recentHard = await tokenCount.countTextHard(recentDense);
const recentExact = await tokenCount.countTextExact(recentDense);
assert.ok(recentHard >= recentExact, "a hard count never undercounts dense Unicode");

const largeDense = Array.from({ length: 115_000 }, (_, index) =>
  String.fromCodePoint(0x4E00 + (index % 18_000))).join("");
const started = performance.now();
const largeHard = await tokenCount.countTextHard(largeDense);
const elapsedMs = performance.now() - started;
assert.ok(largeHard > 100_000, "large dense Unicode cannot enter a 100K input budget");
assert.ok(elapsedMs < timeBudgetMs(5_000), `large hard count stays bounded (got ${elapsedMs.toFixed(0)}ms)`);

for (const sample of [
  "a".repeat(20_000),
  "const value = 0xDEADBEEF;\n".repeat(800),
  "😀汉字abc".repeat(3_000),
]) {
  const hard = await tokenCount.countTextHard(sample);
  const exact = await tokenCount.countTextExact(sample);
  assert.ok(hard >= exact, `chunked hard count ${hard} must cover exact ${exact}`);
  assert.ok(hard - exact <= 32, `chunk boundary overhead stays small (${hard - exact})`);
}

console.log(`hard token-count checks passed (${elapsedMs.toFixed(0)}ms large dense sample)`);
