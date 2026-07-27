import assert from "node:assert/strict";
import { PredictionEngine, isPredictableChar, looksLikeSecretPrompt } from "../web/src/dashboard/session/terminal/predict-echo.ts";

const enc = (s: string) => new TextEncoder().encode(s);
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

check("predict queues chars; pendingChars reflects order", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  e.predict("b", 0);
  assert.deepEqual([...e.pendingChars], ["a", "b"]);
  assert.equal(e.count, 2);
});

check("reconcile consumes exactly the matching echo, leaves the rest pending", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  e.predict("b", 0);
  const r = e.reconcile(enc("a"));
  assert.deepEqual(r, { consumed: 1, flush: false });
  assert.deepEqual([...e.pendingChars], ["b"]);
  const r2 = e.reconcile(enc("b"));
  assert.deepEqual(r2, { consumed: 1, flush: false });
  assert.equal(e.isEmpty, true);
});

check("echo followed by trailing output: consume prediction, rest is authoritative", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  const r = e.reconcile(enc("a\r\n$ "));
  assert.deepEqual(r, { consumed: 1, flush: false });
  assert.equal(e.isEmpty, true);
});

check("divergence (escape sequence before echo) flushes remaining predictions", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  const r = e.reconcile(enc("\x1b[K"));
  assert.equal(r.consumed, 0);
  assert.equal(r.flush, true);
  assert.equal(e.isEmpty, true);
});

check("misprediction (different char echoed) flushes", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  const r = e.reconcile(enc("x"));
  assert.equal(r.consumed, 0);
  assert.equal(r.flush, true);
  assert.equal(e.isEmpty, true);
});

check("partial match then divergence: consume the match, flush the rest", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  e.predict("b", 0);
  const r = e.reconcile(enc("a\x1b"));
  assert.equal(r.consumed, 1);
  assert.equal(r.flush, true);
  assert.equal(e.isEmpty, true);
});

check("backspace drops the last pending prediction", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  e.predict("b", 0);
  assert.equal(e.backspace(), true);
  assert.deepEqual([...e.pendingChars], ["a"]);
  assert.equal(e.backspace(), true);
  assert.equal(e.isEmpty, true);
  assert.equal(e.backspace(), false);
});

check("size bound: predict refuses past maxPending", () => {
  const e = new PredictionEngine({ maxPending: 2 });
  assert.equal(e.predict("a", 0), true);
  assert.equal(e.predict("b", 0), true);
  assert.equal(e.predict("c", 0), false);
  assert.equal(e.count, 2);
});

check("age bound: expire flushes stale predictions", () => {
  const e = new PredictionEngine({ maxAgeMs: 500 });
  e.predict("a", 1000);
  assert.equal(e.expire(1400), false);
  assert.equal(e.expire(1600), true);
  assert.equal(e.isEmpty, true);
});

check("flush clears everything", () => {
  const e = new PredictionEngine();
  e.predict("a", 0);
  e.predict("b", 0);
  assert.equal(e.flush(), true);
  assert.equal(e.isEmpty, true);
  assert.equal(e.flush(), false);
});

check("reconcile with empty queue is a no-op (all bytes authoritative)", () => {
  const e = new PredictionEngine();
  const r = e.reconcile(enc("hello world\r\n"));
  assert.deepEqual(r, { consumed: 0, flush: false });
});

check("isPredictableChar: printable ASCII only, single char", () => {
  assert.equal(isPredictableChar("a"), true);
  assert.equal(isPredictableChar(" "), true);
  assert.equal(isPredictableChar("~"), true);
  assert.equal(isPredictableChar("\x7f"), false);
  assert.equal(isPredictableChar("\r"), false);
  assert.equal(isPredictableChar("\x1b"), false);
  assert.equal(isPredictableChar("ab"), false);
  assert.equal(isPredictableChar("é"), false);
});

check("looksLikeSecretPrompt matches common secret prompts, not normal prompts", () => {
  assert.equal(looksLikeSecretPrompt("Password: "), true);
  assert.equal(looksLikeSecretPrompt("[sudo] password for user: "), true);
  assert.equal(looksLikeSecretPrompt("Enter passphrase for key '/x': "), true);
  assert.equal(looksLikeSecretPrompt("API key: "), true);
  assert.equal(looksLikeSecretPrompt("user@host:~/proj$ "), false);
  assert.equal(looksLikeSecretPrompt("Enter your name: "), false);
});

if (failed) {
  console.error(`\n${failed} predict-echo checks FAILED`);
  process.exit(1);
}
console.log(`\nall predict-echo checks passed`);
