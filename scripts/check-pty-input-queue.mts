import assert from "node:assert/strict";
import { PtyInputQueue } from "../server/src/runtime/pty-input-queue.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const writes: string[] = [];

async function waitForWrites(count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (writes.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
let releaseFirst!: () => void;
const firstWriteCanFinish = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});

const q = new PtyInputQueue(async (data) => {
  writes.push(dec.decode(data));
  if (writes.length === 1) await firstWriteCanFinish;
});

q.enqueue(enc.encode("p"));
q.enqueue(enc.encode("w"));
q.enqueue(enc.encode("d"));
await waitForWrites(1);
assert.deepEqual([...writes], ["pwd"], "same-tick keystrokes should batch into one write");

q.enqueue(enc.encode(";"));
q.enqueue(enc.encode("\n"));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual([...writes], ["pwd"], "second batch must wait for the first backend write");

releaseFirst();
await waitForWrites(2);
assert.deepEqual([...writes], ["pwd", ";\n"], "later writes should remain ordered after the first resolves");

console.log("all pty input queue checks passed");
