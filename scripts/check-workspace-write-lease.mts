import assert from "node:assert/strict";
import { WorkspaceWriteLease } from "../server/src/orchestration/workspace-lease.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lease = new WorkspaceWriteLease();
const events: string[] = [];
const first = lease.run(async () => {
  events.push("a:start");
  await sleep(30);
  events.push("a:end");
  return "a";
});
const second = lease.run(async () => {
  events.push("b:start");
  await sleep(5);
  events.push("b:end");
  return "b";
});
assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
assert.equal(lease.pending, 0);

await assert.rejects(lease.run(async () => {
  throw new Error("expected failure");
}), /expected failure/);
assert.equal(await lease.run(async () => 42), 42);

const gate = new WorkspaceWriteLease();
const abort = new AbortController();
const order: string[] = [];
const active = gate.run(async () => {
  order.push("active:start");
  await sleep(35);
  order.push("active:end");
});
const cancelled = gate.run(async () => {
  order.push("cancelled:ran");
}, abort.signal);
const after = gate.run(async () => {
  order.push("after");
});
abort.abort();
await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
await Promise.all([active, after]);
assert.deepEqual(order, ["active:start", "active:end", "after"]);

const already = new AbortController();
already.abort();
await assert.rejects(
  gate.run(async () => undefined, already.signal),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
assert.equal(gate.pending, 0);

console.log("workspace write lease checks passed");
