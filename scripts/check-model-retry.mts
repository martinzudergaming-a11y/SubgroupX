import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-model-retry-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "model-retry-check-secret-32c";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const { classifyError } = await import("../server/src/foundation/errors.ts");
const { modelRetryBackoffMs, modelRetryLimit } = await import("../server/src/runtime/model-retry.ts");
const { sessionDao, userDao, messageDao, timelineDao, auditEventDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { registerApiProvider } = await import("@earendil-works/pi-ai/compat");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

import type { AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent, WireAgentEvent } from "../shared/src/protocol.ts";

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NOW = Date.now();
userDao.create({ id: "u_retry", email: "retry@example.invalid", password_hash: "x", created_at: NOW });
registerMockProvider();

function makeRuntime(id: string): InstanceType<typeof AgentSessionRuntime> {
  const row: SessionRow = {
    id,
    user_id: "u_retry",
    title: "model-retry-check",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: NOW,
    updated_at: NOW,
  };
  sessionDao.create(row);
  messageDao.replaceAll(id, []);
  return new AgentSessionRuntime(row);
}

function assistant(stopReason: AssistantMessage["stopReason"], text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: MOCK_PROVIDER,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function cyberError(): AssistantMessage {
  const m = assistant("error");
  m.errorMessage = "request rejected: cyber_policy";
  return m;
}

function pushSuccess(stream: ReturnType<typeof createAssistantMessageEventStream>): void {
  const done = assistant("stop", "Recovered in place.");
  const partial = { ...done, content: [] as AssistantMessage["content"] };
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial: { ...done, content: [{ type: "text", text: "" }] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "Recovered in place.", partial: done });
  stream.push({ type: "text_end", contentIndex: 0, content: "Recovered in place.", partial: done });
  stream.push({ type: "done", reason: "stop", message: done });
  stream.end(done);
}

let providerCalls = 0;
function flakyCyberStream(_model: Model<string>, _context: Context, _options?: StreamOptions) {
  const stream = createAssistantMessageEventStream();
  const call = providerCalls++;
  queueMicrotask(() => {
    if (call < 2) {
      const m = cyberError();
      stream.push({ type: "start", partial: { ...m, content: [] } });
      stream.push({ type: "error", reason: "error", error: m });
      stream.end(m);
    } else {
      pushSuccess(stream);
    }
  });
  return stream;
}

registerApiProvider({ api: "mock", stream: flakyCyberStream, streamSimple: flakyCyberStream }, "model-retry-check");

console.log("\n── retry classification + budgets ──");
assert.deepEqual(classifyError("request rejected: cyber_policy"), { errorKind: "cyber_policy", retryable: true });
assert.deepEqual(classifyError("OpenAI API error (400): model_price_error: model has not been priced"), { errorKind: "provider_config", retryable: false });
assert.deepEqual(classifyError("OpenAI API error (400): invalid parameter"), { errorKind: "request", retryable: false });
assert.deepEqual(classifyError("OpenAI API error (429): insufficient_quota"), { errorKind: "quota", retryable: false });
assert.deepEqual(
  classifyError("Team provider request exceeds its remaining token budget"),
  { errorKind: "team_budget", retryable: false },
);
assert.deepEqual(
  classifyError("Team provider request cannot fit the provider's minimum output allowance"),
  { errorKind: "team_budget", retryable: false },
);
assert.deepEqual(
  classifyError("Team provider request has no active durable lease"),
  { errorKind: "team_state", retryable: false },
);
assert.equal(modelRetryLimit("cyber_policy"), 10);
assert.equal(modelRetryLimit("server"), 10);
assert.equal(modelRetryLimit("unknown"), 3);
assert.equal(modelRetryLimit("provider_config"), 0);
assert.equal(modelRetryLimit("team_budget"), 0);
assert.deepEqual([1, 2, 3, 6].map(modelRetryBackoffMs), [500, 1_000, 2_000, 8_000]);
console.log("  ✓ deterministic 4xx/config failures do not enter the retry loop");
console.log("  ✓ 5xx/cyber-policy get ten retries with capped exponential backoff");

console.log("\n── full turn: fail twice, continue in place, then recover ──");
providerCalls = 0;
const runtime = makeRuntime("s_retry_success");
const live: WireAgentEvent[] = [];
runtime.subscribe((event: ServerEvent) => {
  if (event.type === "agent_event") live.push(event.event);
});
await runtime.sendMessage("one user turn");
runtime.close();

assert.equal(providerCalls, 3, "initial call + two in-place retries");
assert.equal(live.filter((e) => e.t === "user_message").length, 1, "retry must not replay the user message");
assert.equal(live.filter((e) => e.t === "error").length, 0, "intermediate refusals stay invisible");
assert.deepEqual(
  live.filter((e) => e.t === "model_retry").map((e) => e.t === "model_retry" && [e.attempt, e.limit, e.delayMs]),
  [[1, 10, 500], [2, 10, 1_000]],
);
assert.ok(live.some((e) => e.t === "assistant_end" && e.blocks.some((b) => b.type === "text" && b.text.includes("Recovered"))));
const persisted = timelineDao.list("s_retry_success");
assert.equal(persisted.filter((i) => i.kind === "user").length, 1);
assert.equal(persisted.filter((i) => i.kind === "error").length, 0);
assert.equal(persisted.filter((i) => i.kind === "assistant").length, 1);

const audits = auditEventDao.recent(100);
const retryAudits = audits.filter((row) => row.event === "model_retry");
assert.equal(retryAudits.length, 2);
assert.deepEqual(retryAudits.map((row) => JSON.parse(row.data_json).attempt).sort(), [1, 2]);
assert.equal(audits.filter((row) => row.event === "model_retry_recovered").length, 1);
const turnEnd = audits.find((row) => row.event === "turn_end");
assert.ok(turnEnd);
assert.equal(JSON.parse(turnEnd!.data_json).modelRetryAttempts, 2);
assert.equal(JSON.parse(turnEnd!.data_json).modelRetryRecovered, true);
console.log("  ✓ one user row, no intermediate error, final assistant persisted");
console.log("  ✓ live retry progress + attempt logs + one recovery log");

console.log("\n── manual retry continues without another user Message ──");
providerCalls = 2;
const manual = makeRuntime("s_retry_manual");
const manualEvents: WireAgentEvent[] = [];
manual.subscribe((event: ServerEvent) => { if (event.type === "agent_event") manualEvents.push(event.event); });
const manualAgent = (manual as unknown as { agent: { state: { messages: unknown[] } } }).agent;
manualAgent.state.messages = [
  { role: "user", content: [{ type: "text", text: "original prompt" }], timestamp: Date.now() },
  cyberError(),
];
await manual.retryModelResponse();
manual.close();
assert.equal(providerCalls, 3, "manual retry makes one continuation call");
assert.equal(manualEvents.filter((event) => event.t === "user_message").length, 0, "manual retry must not emit a user Message");
assert.ok(manualEvents.some((event) => event.t === "assistant_end" && event.blocks.some((block) => block.type === "text" && block.text.includes("Recovered"))));
console.log("  ✓ Retry calls continue() from the failed boundary and emits no user Message");

async function injectFinalError(message: AssistantMessage, usedRetries: number): Promise<WireAgentEvent> {
  const rt = makeRuntime(`s_retry_final_${usedRetries}_${Math.random().toString(36).slice(2)}`);
  const events: WireAgentEvent[] = [];
  rt.subscribe((event: ServerEvent) => { if (event.type === "agent_event") events.push(event.event); });
  const signal = new AbortController().signal;
  await (rt as unknown as { onAgentEvent(e: unknown, s: AbortSignal): Promise<void> }).onAgentEvent(
    { type: "message_start", message: { ...message, stopReason: "stop", errorMessage: undefined } }, signal,
  );
  (rt as unknown as { modelRetries: number }).modelRetries = usedRetries;
  await (rt as unknown as { onAgentEvent(e: unknown, s: AbortSignal): Promise<void> }).onAgentEvent(
    { type: "message_end", message }, signal,
  );
  rt.close();
  const error = events.find((event) => event.t === "error");
  assert.ok(error, `expected final error; got ${events.map((event) => event.t).join(",")}`);
  return error!;
}

console.log("\n── final user-facing error metadata ──");
const exhausted = await injectFinalError(cyberError(), modelRetryLimit("cyber_policy"));
assert.equal(exhausted.t, "error");
if (exhausted.t === "error") {
  assert.equal(exhausted.errorKind, "cyber_policy");
  assert.equal(exhausted.retryable, true);
}
const price = assistant("error");
price.errorMessage = "OpenAI API error (400): model_price_error: model has not been priced";
const disabled = await injectFinalError(price, 0);
assert.equal(disabled.t, "error");
if (disabled.t === "error") {
  assert.equal(disabled.errorKind, "provider_config");
  assert.equal(disabled.retryable, false);
}
const teamBudget = assistant("error");
teamBudget.errorMessage = "Team provider request cannot fit the provider's minimum output allowance";
const budgetDisabled = await injectFinalError(teamBudget, 0);
assert.equal(budgetDisabled.t, "error");
if (budgetDisabled.t === "error") {
  assert.equal(budgetDisabled.errorKind, "team_budget");
  assert.equal(budgetDisabled.retryable, false);
}
console.log("  ✓ exhausted cyber refusal exposes a manual-retryable classified error");
console.log("  ✓ deterministic provider configuration failure is actionable and non-retryable");
console.log("  ✓ exhausted Team budget settles immediately without an in-place model retry");

console.log("\n── browser retry geometry ──");
const timelineSource = fs.readFileSync(path.join(process.cwd(), "web/src/dashboard/session/timeline/Timeline.tsx"), "utf8");
const blockSource = fs.readFileSync(path.join(process.cwd(), "web/src/dashboard/session/timeline/TimelineBlock.tsx"), "utf8");
const mainContentSource = fs.readFileSync(path.join(process.cwd(), "web/src/dashboard/session/MainContent.tsx"), "utf8");
const activitySource = fs.readFileSync(path.join(process.cwd(), "web/src/dashboard/session/composer/AgentActivityOrb.tsx"), "utf8");
assert.match(timelineSource, /onRetry=\{item\.id === lastErrorId \? handleRetry : undefined\} retrying=\{status === 'running'/);
assert.match(blockSource, /disabled=\{retrying\}/, "the Retry action must keep its layout slot while disabled");
assert.match(
  mainContentSource,
  /\[items, perm, composerH, status, modelRetryProgress\?\.attempt, modelRetryProgress\?\.limit\]/,
  "status/progress reflow must re-pin before paint",
);
assert.match(activitySource, /data-retry-progress=.*attempt.*limit/);
assert.match(activitySource, /chat\.actRetryingModel/);
assert.doesNotMatch(timelineSource, /data-testid="live-activity"/);
console.log("  ✓ retry keeps stable geometry and reports progress in the fixed Composer seat");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nOK: model retry flow passed");
