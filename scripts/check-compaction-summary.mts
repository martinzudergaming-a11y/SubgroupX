import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { countMessage, countText } from "../server/src/runtime/token-count.ts";
import {
  buildExtractiveCompactionSummary,
  CompactionSummaryAbortedError,
  CompactionSummaryTimeoutError,
  runBoundedCompactionSummary,
  selectCompactionSummaryInput,
} from "../server/src/runtime/compaction-summary.ts";

const now = Date.now();
const messages: Message[] = [];
for (let i = 0; i < 30; i++) {
  messages.push({ role: "user", content: `request-${i} ${"x".repeat(4_000)}`, timestamp: now + i * 2 });
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: `answer-${i} ${"y".repeat(4_000)}` }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: now + i * 2 + 1,
  });
}

const selected = selectCompactionSummaryInput(messages, 8_000);
assert.ok(selected.messages.length > 0 && selected.messages.length < messages.length);
assert.equal(selected.messages[0].role, "user", "summary input starts at a complete user boundary");
assert.ok(selected.ctx <= 8_000, `selection exceeded cap: ${selected.ctx}`);
assert.equal(selected.ctx, selected.messages.reduce((n, message) => n + countMessage(message), 0));

const hugeTool: Message = {
  role: "toolResult",
  toolCallId: "call_huge",
  toolName: "read_file",
  content: [{ type: "text", text: "head-marker " + "密".repeat(80_000) + " tail-marker" }],
  isError: false,
  timestamp: now,
};
const pathological = selectCompactionSummaryInput([hugeTool], 2_000);
assert.equal(pathological.messages.length, 1, "one giant non-user message becomes one synthetic excerpt");
assert.equal(pathological.messages[0].role, "user");
assert.ok(pathological.ctx <= 2_000, `synthetic excerpt exceeded cap: ${pathological.ctx}`);

const fallback = buildExtractiveCompactionSummary(
  [...messages.slice(-5), hugeTool],
  "previous-summary-marker " + "p".repeat(20_000),
  3_000,
);
assert.ok(fallback.includes("Semantic summarization was unavailable"));
assert.ok(fallback.includes("tail-marker"), "middle clipping keeps the recent tool result tail");
assert.ok(fallback.includes("previous-summary-marker"), "prior compacted context remains represented");
assert.ok(countText(fallback) <= 3_000, `fallback exceeded cap: ${countText(fallback)}`);

const timeoutStarted = performance.now();
await assert.rejects(
  runBoundedCompactionSummary(25, undefined, async () => await new Promise<string>(() => {})),
  CompactionSummaryTimeoutError,
);
assert.ok(performance.now() - timeoutStarted < 500, "timeout bounds even a provider that ignores AbortSignal");

const parent = new AbortController();
const abortStarted = performance.now();
const aborted = runBoundedCompactionSummary(10_000, parent.signal, async () => await new Promise<string>(() => {}));
parent.abort();
await assert.rejects(aborted, CompactionSummaryAbortedError);
assert.ok(performance.now() - abortStarted < 500, "turn Stop bounds even a provider that ignores AbortSignal");

console.log("OK compaction-summary: bounded input/output fallback + hard timeout/abort boundaries");
