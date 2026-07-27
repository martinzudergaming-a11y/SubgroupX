import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-compaction-audit-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "compaction-audit-check-secret-32chars";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://localhost:19972";
process.env.AGENT_WEB_JAIL_KEY = "fake-test-key-for-compaction-audit";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
  }
});

const {
  sessionDao,
  userDao,
  messageDao,
  auditEventDao,
  compactionDao,
  teamTaskDao,
  teamTurnOutcomeDao,
} = await import("../server/src/persistence/index.ts");
const { registerMockProvider, JAIL_PROVIDER, MOCK_PROVIDER, MOCK_MODEL_ID } = await import(
  "../server/src/runtime/providers.ts"
);
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { registerApiProvider } = await import("@earendil-works/pi-ai/compat");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

function resolveNestedPiAiDist(file: string): string {
  const pcaMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  let dir = path.dirname(pcaMain);
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  return path.join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", file);
}
const { registerApiProvider: registerNestedApiProvider } =
  (await import(pathToFileURL(resolveNestedPiAiDist("compat.js")).href)) as {
    registerApiProvider: typeof registerApiProvider;
  };
const { createAssistantMessageEventStream: createNestedStream } =
  (await import(pathToFileURL(resolveNestedPiAiDist("index.js")).href)) as {
    createAssistantMessageEventStream: typeof createAssistantMessageEventStream;
  };

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent } from "../shared/src/protocol.ts";
import type { AssistantMessage, Model, Context, StreamOptions } from "@earendil-works/pi-ai";

const AUDIT_STRING_CAP = 500;

registerMockProvider();

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const NOW = Date.now();
userDao.create({ id: "u_cmpaudit", email: "cmpaudit@test", password_hash: "x", created_at: NOW });

function makeRuntime(opts: {
  id: string;
  provider: string;
  model: string;
  messages: { role: string; content: string | { type: string; text: string }[] }[];
}): InstanceType<typeof AgentSessionRuntime> {
  const row: SessionRow = {
    id: opts.id,
    user_id: "u_cmpaudit",
    title: "cmp-audit-check",
    provider: opts.provider,
    model: opts.model,
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
  const piMessages = opts.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
    timestamp: NOW,
  }));
  messageDao.replaceAll(opts.id, piMessages);
  return new AgentSessionRuntime(row);
}

function callMaybeCompact(
  rt: InstanceType<typeof AgentSessionRuntime>,
  signal?: AbortSignal,
  force = false,
): Promise<boolean> {
  return (rt as unknown as { maybeCompact(s?: AbortSignal, f?: boolean): Promise<boolean> }).maybeCompact(
    signal,
    force,
  );
}

interface AuditRow {
  event: string;
  level: string;
  user_id: string | null;
  session_id: string | null;
  data_json: string;
}

function auditFor(sessionId: string): AuditRow[] {
  return (auditEventDao.recent(500) as unknown as AuditRow[]).filter((r) => r.session_id === sessionId);
}

const MSG_CHARS = 10_000;
const MSG_COUNT = 20;
const bigMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < MSG_COUNT; i++) {
  bigMessages.push({ role: "user", content: "u".repeat(MSG_CHARS) });
  bigMessages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(MSG_CHARS) }] });
}

const hugeMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < 60; i++) {
  hugeMessages.push({ role: "user", content: "u".repeat(MSG_CHARS) });
  hugeMessages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(MSG_CHARS) }] });
}

console.log("\n── Section 1: force=true provider failure degrades locally (post_overflow_retry) ──");

await acheck("force=true compaction emits start then commits a local fallback", async () => {
  const rt = makeRuntime({ id: "s_force_fail", provider: JAIL_PROVIDER, model: "operator-model", messages: bigMessages });
  const events: string[] = [];
  rt.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") events.push(ev.event.t);
  });
  const result = await callMaybeCompact(rt, undefined, true);
  rt.close();
  assert.equal(result, true, "summarizer refused → bounded local fallback still compacts");
  assert.ok(events.includes("compaction_start"), `compaction_start must fire. Events: [${events.join(", ")}]`);
  assert.ok(events.includes("compaction"), `committed fallback must emit compaction. Events: [${events.join(", ")}]`);
});

await acheck("durable start + degraded + ok rows carry phase/source/timing", async () => {
  const rows = auditFor("s_force_fail");
  const startRow = rows.find((r) => r.event === "compaction_start");
  const degraded = rows.find((r) => r.event === "compaction_degraded");
  const okRow = rows.find((r) => r.event === "compaction_ok");
  assert.ok(startRow && degraded && okRow, `expected start/degraded/ok. Got: [${rows.map((r) => r.event).join(", ")}]`);
  const startData = JSON.parse(startRow!.data_json) as Record<string, unknown>;
  const degradedData = JSON.parse(degraded!.data_json) as Record<string, unknown>;
  const okData = JSON.parse(okRow!.data_json) as Record<string, unknown>;
  assert.equal(startData.phase, "post_overflow_retry");
  assert.equal(degradedData.phase, "post_overflow_retry");
  assert.equal(okData.source, "local_fallback");
  assert.ok(typeof startData.summaryInputCtx === "number" && (startData.summaryInputCtx as number) <= 96_000);
  assert.ok(typeof okData.durationMs === "number" && (okData.durationMs as number) >= 0);
});

await acheck("compaction_degraded reason is capped/redacted by the audit layer (≤ 500 chars)", async () => {
  const degraded = auditFor("s_force_fail").find((r) => r.event === "compaction_degraded");
  assert.ok(degraded, "expected compaction_degraded");
  const data = JSON.parse(degraded!.data_json) as Record<string, unknown>;
  assert.ok(
    typeof data.reason === "string" && (data.reason as string).length <= AUDIT_STRING_CAP,
    `reason length ${(data.reason as string)?.length} must be ≤ ${AUDIT_STRING_CAP}`,
  );
});

await acheck("compaction_degraded is warn and carries sessionId + userId", async () => {
  const degraded = auditFor("s_force_fail").find((r) => r.event === "compaction_degraded");
  assert.ok(degraded, "expected compaction_degraded");
  assert.equal(degraded!.level, "warn");
  assert.equal(degraded!.session_id, "s_force_fail");
  assert.equal(degraded!.user_id, "u_cmpaudit");
});

await acheck("recovered provider failure emits no terminal compaction_failed", async () => {
  const fails = auditFor("s_force_fail").filter((r) => r.event === "compaction_failed");
  assert.equal(fails.length, 0, `recovered degraded compaction must not count as terminal failure. Got ${fails.length}`);
});

console.log("\n── Section 2: force=false provider failure degrades with phase=proactive ──");

await acheck("over-threshold force=false provider failure → degraded local fallback", async () => {
  const rt = makeRuntime({ id: "s_proactive_fail", provider: JAIL_PROVIDER, model: "operator-model", messages: hugeMessages });
  const usage = rt.getContextUsage();
  assert.ok(usage.used > usage.compactAt, `transcript must exceed compactAt (used=${usage.used}, compactAt=${usage.compactAt})`);
  const result = await callMaybeCompact(rt, undefined, false);
  rt.close();
  assert.equal(result, true, "summarizer refused → fallback compacts");
  const rows = auditFor("s_proactive_fail");
  const degraded = rows.find((r) => r.event === "compaction_degraded");
  const okRow = rows.find((r) => r.event === "compaction_ok");
  assert.ok(degraded && okRow, "expected compaction_degraded + compaction_ok");
  const degradedData = JSON.parse(degraded!.data_json) as Record<string, unknown>;
  const okData = JSON.parse(okRow!.data_json) as Record<string, unknown>;
  assert.equal(degradedData.phase, "proactive");
  assert.equal(okData.source, "local_fallback");
});

console.log("\n── Section 3: below-threshold force=false emits NO compaction audit event ──");

await acheck("below-threshold force=false: neither compaction_failed nor compaction_ok", async () => {
  const rt = makeRuntime({ id: "s_below", provider: JAIL_PROVIDER, model: "operator-model", messages: bigMessages });
  const usage = rt.getContextUsage();
  assert.ok(usage.used < usage.compactAt, `must be below threshold (used=${usage.used}, compactAt=${usage.compactAt})`);
  const result = await callMaybeCompact(rt, undefined, false);
  rt.close();
  assert.equal(result, false, "below soft threshold → returns false without attempting");
  const rows = auditFor("s_below");
  const cmp = rows.filter((r) => r.event === "compaction_failed" || r.event === "compaction_ok");
  assert.equal(cmp.length, 0, `no compaction audit event expected below threshold. Got: [${cmp.map((r) => r.event).join(", ")}]`);
});

console.log("\n── Section 4: successful compaction emits compaction_ok ──");

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let observedSummaryMaxTokens: number | undefined;
let observedSummaryTimeoutMs: number | undefined;
let observedSummaryHasSignal = false;
let successfulProviderCalls = 0;

function makeSummaryStream(
  model: Model<string>,
  _context: Context,
  options?: StreamOptions,
): ReturnType<typeof createNestedStream> {
  successfulProviderCalls++;
  observedSummaryMaxTokens = options?.maxTokens;
  observedSummaryTimeoutMs = (options as (StreamOptions & { timeoutMs?: number }) | undefined)?.timeoutMs;
  observedSummaryHasSignal = Boolean(options?.signal);
  const stream = createNestedStream();
  const text = "SUMMARY: the earlier conversation was about repeated test messages.";
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api, provider: model.provider, model: model.id,
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...msg, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...msg, content: [{ type: "text", text: "" }] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: { ...msg } });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: "stop" as never, message: msg });
    stream.end(msg);
  });
  return stream;
}

function pushToolCall(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<string>,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  usage: typeof ZERO_USAGE,
): void {
  const toolCall = { type: "toolCall" as const, ...call };
  const message: AssistantMessage = {
    role: "assistant",
    content: [toolCall],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const partial = { ...message, content: [] as typeof message.content };
  stream.push({ type: "start", partial });
  partial.content = [{ ...toolCall, arguments: {} }];
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...partial } });
  partial.content[0] = toolCall;
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(call.arguments),
    partial: { ...partial },
  });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: { ...partial } });
  stream.push({ type: "done", reason: "toolUse" as never, message });
  stream.end(message);
}

function pushAssistant(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<string>,
  text: string,
  usage: typeof ZERO_USAGE,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop" as never, message });
  stream.end(message);
}

await acheck("successful force=true compaction emits compaction_ok with sane fields", async () => {
  registerApiProvider({ api: "openai-responses", stream: makeSummaryStream, streamSimple: makeSummaryStream }, "compaction-audit-summary");
  registerNestedApiProvider({ api: "openai-responses", stream: makeSummaryStream, streamSimple: makeSummaryStream }, "compaction-audit-summary");
  const rt = makeRuntime({ id: "s_ok", provider: JAIL_PROVIDER, model: "operator-model", messages: hugeMessages });
  const result = await callMaybeCompact(rt, undefined, true);
  rt.close();
  assert.equal(result, true, "summary committed → maybeCompact returns true");
  const rows = auditFor("s_ok");
  const oks = rows.filter((r) => r.event === "compaction_ok");
  assert.ok(oks.length > 0, `expected a compaction_ok audit row. Got: [${rows.map((r) => r.event).join(", ")}]`);
  assert.equal(oks[0].level, "info", `compaction_ok must be level=info, got ${oks[0].level}`);
  const data = JSON.parse(oks[0].data_json) as Record<string, unknown>;
  assert.equal(data.phase, "post_overflow_retry", `phase must be post_overflow_retry, got ${String(data.phase)}`);
  assert.ok(typeof data.summarizedCount === "number" && (data.summarizedCount as number) > 0, "summarizedCount must be > 0");
  assert.ok(typeof data.ctxWindow === "number" && (data.ctxWindow as number) > 0, "ctxWindow must be > 0");
  assert.ok(typeof data.ctxBefore === "number" && (data.ctxBefore as number) > 0, "ctxBefore must be > 0 (not redacted)");
  assert.equal(data.source, "llm", "normal provider success must record source=llm");
  assert.ok(typeof data.summaryInputCtx === "number" && (data.summaryInputCtx as number) <= 96_000, "summary input is hard-capped");
  assert.equal(observedSummaryMaxTokens, 4_096, "hidden summary output must be clamped to 4K");
  assert.equal(observedSummaryTimeoutMs, 60_000, "SDK receives the primary summary deadline");
  assert.equal(observedSummaryHasSignal, true, "provider receives the composed cancellation signal");
  assert.ok(compactionDao.listForSession("s_ok").length > 0, "successful compaction must write a compactions row");
  assert.equal(auditFor("s_ok").filter((r) => r.event === "compaction_failed").length, 0, "no compaction_failed on success");
});

console.log("\n── Section 4b: Team budget pressure compacts before provider admission ──");

await acheck("Team-only history below model threshold compacts to fit its smaller Task budget", async () => {
  const userId = "u_cmpaudit";
  const ownerId = "s_team_budget_owner";
  const workerId = "s_team_budget_worker";
  const ownerRow: SessionRow = {
    id: ownerId,
    user_id: userId,
    title: "Team owner",
    provider: JAIL_PROVIDER,
    model: "operator-model",
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
  sessionDao.create(ownerRow);

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x51f15e;
  const denseText = (length: number) => {
    let text = "";
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      text += alphabet[state & 63];
    }
    return text;
  };
  const teamHistory: { role: string; content: string | { type: string; text: string }[] }[] = [];
  for (let index = 0; index < 30; index += 1) {
    teamHistory.push({ role: "user", content: denseText(4_000) });
    teamHistory.push({ role: "assistant", content: [{ type: "text", text: denseText(4_000) }] });
  }
  const runtime = makeRuntime({
    id: workerId,
    provider: JAIL_PROVIDER,
    model: "operator-model",
    messages: teamHistory,
  });
  const beforeUsage = runtime.getContextUsage();
  assert.ok(beforeUsage.used < beforeUsage.compactAt, `${beforeUsage.used} must stay below ${beforeUsage.compactAt}`);
  const beforeMessageCount = messageDao.list(workerId).length;

  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: ownerId,
    id: (kind) => `team_budget_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Budget pressure",
    members: [
      { sessionId: ownerId, role: "lead" },
      { sessionId: workerId, role: "worker" },
    ],
    leadSessionId: ownerId,
  });
  const member = team.members.find((entry) => entry.sessionId === workerId)!;
  const work = coordinator.assignWork({
    teamId: team.team.id,
    targetMemberId: member.id,
    title: "Continue a long Team context",
    payload: { request: "Return one short result." },
    idempotencyKey: "team-budget-pressure",
    deadlineAt: Date.now() + 60_000,
    budget: { maxModelCycles: 1, maxTokens: 100_000 },
  });
  const callsBefore = successfulProviderCalls;
  const executor = new TeamTurnExecutor({
    userId,
    gateway: { activateSession: () => runtime },
    id: (kind) => `team_budget_execute_${kind}`,
  });
  const execution = await executor.execute(work.task.id);
  runtime.close();

  assert.equal(execution.status, "succeeded");
  assert.ok(messageDao.list(workerId).length < beforeMessageCount, "the persisted Team transcript shrinks");
  assert.ok(compactionDao.listForSession(workerId).length > 0, "Team compaction archives its older slice");
  assert.equal(successfulProviderCalls - callsBefore, 2, "one hidden summary and one real Team provider call run");
  assert.deepEqual(teamTaskDao.usageByTask(userId, work.task.id), {
    modelCycles: 1,
    tokens: 100_000,
  });
  assert.equal(teamTurnOutcomeDao.byTask(userId, work.task.id)?.usage.modelCycles, 1);
});

console.log("\n── Section 4c: Team per-cycle budget fit is prospective ──");

await acheck("a later tool cycle compacts against the remaining Team budget before admission", async () => {
  let calls = 0;
  const actualProviderInputs: string[] = [];
  const firstUsage = {
    ...ZERO_USAGE,
    input: 105_000,
    totalTokens: 110_000,
    output: 5_000,
    cost: { ...ZERO_USAGE.cost },
  };
  const finalUsage = {
    ...ZERO_USAGE,
    input: 15_000,
    totalTokens: 20_000,
    output: 5_000,
    cost: { ...ZERO_USAGE.cost },
  };
  const middleUsage = {
    ...ZERO_USAGE,
    input: 4_000,
    totalTokens: 5_000,
    output: 1_000,
    cost: { ...ZERO_USAGE.cost },
  };
  const multiCycleProvider = (model: Model<string>, context: Context) => {
    const stream = createAssistantMessageEventStream();
    const call = calls++;
    if (call !== 1) actualProviderInputs.push(JSON.stringify(context.messages));
    queueMicrotask(() => {
      if (call === 0) {
        pushToolCall(stream, model, {
          id: "team-budget-read",
          name: "read_file",
          arguments: { path: "cycle-proof.txt" },
        }, firstUsage);
      } else if (call === 1) {
        pushAssistant(stream, model, "SUMMARY: compacted for the next Team cycle.", ZERO_USAGE);
      } else if (call === 2) {
        pushToolCall(stream, model, {
          id: "team-budget-read-again",
          name: "read_file",
          arguments: { path: "cycle-proof.txt" },
        }, middleUsage);
      } else {
        pushAssistant(stream, model, "Third model cycle completed.", finalUsage);
      }
    });
    return stream;
  };
  registerApiProvider(
    { api: "openai-responses", stream: multiCycleProvider, streamSimple: multiCycleProvider },
    "compaction-audit-team-multi-cycle",
  );
  registerNestedApiProvider(
    { api: "openai-responses", stream: multiCycleProvider, streamSimple: multiCycleProvider },
    "compaction-audit-team-multi-cycle",
  );

  fs.writeFileSync(path.join(tmp, "cycle-proof.txt"), "small tool result");
  const history: { role: string; content: string | { type: string; text: string }[] }[] = [];
  for (let index = 0; index < 12; index += 1) {
    history.push({ role: "user", content: `request-${index}:${String(index).padStart(4, "0")}:${"a".repeat(3_500)}` });
    history.push({ role: "assistant", content: [{ type: "text", text: `answer-${index}:${"b".repeat(3_500)}` }] });
  }
  const userId = "u_cmpaudit";
  const ownerId = "s_team_cycle_owner";
  const workerId = "s_team_cycle_worker";
  sessionDao.create({
    id: ownerId,
    user_id: userId,
    title: "Cycle owner",
    provider: JAIL_PROVIDER,
    model: "operator-model",
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
  });
  const runtime = makeRuntime({ id: workerId, provider: JAIL_PROVIDER, model: "operator-model", messages: history });
  const beforeCount = messageDao.list(workerId).length;
  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: ownerId,
    id: (kind) => `team_cycle_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Per-cycle fit",
    members: [
      { sessionId: ownerId, role: "lead" },
      { sessionId: workerId, role: "worker" },
    ],
    leadSessionId: ownerId,
  });
  const work = coordinator.assignWork({
    teamId: team.team.id,
    targetMemberId: team.members.find((member) => member.sessionId === workerId)!.id,
    title: "Use one tool and continue",
    payload: {},
    idempotencyKey: "team-cycle-fit",
    deadlineAt: Date.now() + 60_000,
    budget: { maxModelCycles: 3, maxTokens: 200_000 },
  });
  const executor = new TeamTurnExecutor({
    userId,
    gateway: { activateSession: () => runtime },
    id: (kind) => `team_cycle_execute_${kind}`,
  });
  const execution = await executor.execute(work.task.id);
  runtime.close();

  assert.equal(execution.status, "succeeded");
  assert.equal(calls, 4, "first cycle + hidden summary + two post-compaction cycles");
  assert.equal(actualProviderInputs.length, 3);
  assert.doesNotMatch(actualProviderInputs[1]!, /request-0:/, "cycle two uses the compacted transcript");
  assert.doesNotMatch(actualProviderInputs[2]!, /request-0:/, "cycle three cannot resurrect archived history");
  assert.ok(messageDao.list(workerId).length < beforeCount, "the later-cycle preflight commits a smaller transcript");
  assert.deepEqual(teamTaskDao.usageByTask(userId, work.task.id), {
    modelCycles: 3,
    tokens: 135_000,
  });
});

await acheck("an impossible Team fit leaves the existing transcript intact and sends no provider request", async () => {
  let calls = 0;
  const refusingProvider = (model: Model<string>) => {
    calls += 1;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => pushAssistant(stream, model, "must not run", ZERO_USAGE));
    return stream;
  };
  registerApiProvider(
    { api: "openai-responses", stream: refusingProvider, streamSimple: refusingProvider },
    "compaction-audit-team-impossible-fit",
  );
  registerNestedApiProvider(
    { api: "openai-responses", stream: refusingProvider, streamSimple: refusingProvider },
    "compaction-audit-team-impossible-fit",
  );

  const userId = "u_cmpaudit";
  const ownerId = "s_team_small_owner";
  const workerId = "s_team_small_worker";
  sessionDao.create({
    id: ownerId,
    user_id: userId,
    title: "Small budget owner",
    provider: JAIL_PROVIDER,
    model: "operator-model",
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
  });
  const history = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}:${"z".repeat(2_000)}`,
  }));
  const runtime = makeRuntime({ id: workerId, provider: JAIL_PROVIDER, model: "operator-model", messages: history });
  const before = JSON.stringify(messageDao.list(workerId));
  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: ownerId,
    id: (kind) => `team_small_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Impossible fit",
    members: [
      { sessionId: ownerId, role: "lead" },
      { sessionId: workerId, role: "worker" },
    ],
    leadSessionId: ownerId,
  });
  const work = coordinator.assignWork({
    teamId: team.team.id,
    targetMemberId: team.members.find((member) => member.sessionId === workerId)!.id,
    title: "Cannot fit base prompt",
    payload: {},
    idempotencyKey: "team-impossible-fit",
    deadlineAt: Date.now() + 60_000,
    budget: { maxModelCycles: 1, maxTokens: 30_000 },
  });
  const executor = new TeamTurnExecutor({
    userId,
    gateway: { activateSession: () => runtime },
    id: (kind) => `team_small_execute_${kind}`,
  });
  const execution = await executor.execute(work.task.id);
  runtime.close();

  assert.equal(execution.status, "failed");
  assert.equal(calls, 0, "neither a hidden summary nor a real request is sent when the fixed request shape cannot fit");
  assert.equal(compactionDao.listForSession(workerId).length, 0, "no compaction is committed");
  assert.equal(JSON.stringify(messageDao.list(workerId).slice(0, history.length)), before, "the pre-existing transcript remains byte-identical");
});

console.log("\n── Section 5: archive failure emits compaction_failed phase=archive ──");

await acheck("archiveCompaction throw → compaction_failed phase=archive (transcript still reduced)", async () => {
  const origCreate = compactionDao.create;
  (compactionDao as { create: unknown }).create = () => {
    throw new Error("forced archive failure for check");
  };
  try {
    const rt = makeRuntime({ id: "s_archive", provider: JAIL_PROVIDER, model: "operator-model", messages: hugeMessages });
    const result = await callMaybeCompact(rt, undefined, true);
    rt.close();
    assert.equal(result, true, "maybeCompact still returns true (transcript reduced) when only the archive failed");
  } finally {
    (compactionDao as { create: unknown }).create = origCreate;
  }
  const fails = auditFor("s_archive").filter((r) => r.event === "compaction_failed");
  assert.ok(fails.length > 0, "expected a compaction_failed audit row for the archive failure");
  const data = JSON.parse(fails[0].data_json) as Record<string, unknown>;
  assert.equal(data.phase, "archive", `phase must be archive, got ${String(data.phase)}`);
  assert.equal(fails[0].level, "warn", "archive failure must be level=warn");
  assert.ok(typeof data.reason === "string" && (data.reason as string).length <= AUDIT_STRING_CAP, "archive reason must be capped");
});

console.log("\n── Section 6: post-overflow unrecovered emits compaction_failed phase=post_overflow_unrecovered ──");

const OVERFLOW_ERROR_MSG = "Your input exceeds the context window of this model (overflow audit check)";
function makeOverflowMessage(): AssistantMessage {
  return {
    role: "assistant", content: [],
    api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
    usage: ZERO_USAGE, stopReason: "error", errorMessage: OVERFLOW_ERROR_MSG, timestamp: Date.now(),
  };
}
let overflowCalls = 0;
function makeOverflowStream(
  _model: Model<string>,
  _context: Context,
  _options?: StreamOptions,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const idx = overflowCalls++;
  queueMicrotask(() => {
    const errMsg = makeOverflowMessage();
    if (idx === 0) {
      stream.push({ type: "start", partial: { ...errMsg, content: [] } });
      stream.push({ type: "done", reason: "error" as never, message: errMsg });
      stream.end(errMsg);
    } else {
      const m: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "ok" }],
        api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
        usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...m, content: [] } });
      stream.push({ type: "done", reason: "stop" as never, message: m });
      stream.end(m);
    }
  });
  return stream;
}

await acheck("overflow turn, force-compact can't reduce → compaction_failed phase=post_overflow_unrecovered", async () => {
  overflowCalls = 0;
  registerApiProvider({ api: MOCK_PROVIDER, stream: makeOverflowStream, streamSimple: makeOverflowStream }, "compaction-audit-overflow");
  const rt = makeRuntime({ id: "s_unrecovered", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: hugeMessages });
  await rt.sendMessage("trigger overflow").catch(() => {});
  rt.close();
  const fails = auditFor("s_unrecovered").filter((r) => r.event === "compaction_failed");
  assert.ok(fails.length > 0, `expected a compaction_failed audit row. Got: [${auditFor("s_unrecovered").map((r) => r.event).join(", ")}]`);
  const unrec = fails.find((r) => {
    const d = JSON.parse(r.data_json) as Record<string, unknown>;
    return d.phase === "post_overflow_unrecovered";
  });
  assert.ok(unrec, `expected phase=post_overflow_unrecovered. Phases: [${fails.map((r) => (JSON.parse(r.data_json) as { phase?: string }).phase).join(", ")}]`);
  const data = JSON.parse(unrec!.data_json) as Record<string, unknown>;
  assert.equal(unrec!.level, "warn", "must be level=warn");
  assert.ok(typeof data.ctxUsed === "number", "ctxUsed must be present + numeric (LOW-1 enrichment)");
  assert.ok(typeof data.ctxWindow === "number", "ctxWindow must be present + numeric (LOW-1 enrichment)");
});

console.log("\n── Section 6b: Team provider overflow compacts and resumes in place ──");

await acheck("Team overflow recovery compacts, retries once, and excludes its summary from usage", async () => {
  let calls = 0;
  const overflowThenRecover = (model: Model<string>) => {
    const stream = createAssistantMessageEventStream();
    const call = calls++;
    queueMicrotask(() => {
      if (call === 0) {
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: "error",
          errorMessage: OVERFLOW_ERROR_MSG,
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "error" as never, message });
        stream.end(message);
        return;
      }
      const text = call === 1 ? "SUMMARY: bounded Team history." : "Recovered Team result.";
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop" as never, message });
      stream.end(message);
    });
    return stream;
  };
  registerApiProvider(
    { api: "openai-responses", stream: overflowThenRecover, streamSimple: overflowThenRecover },
    "compaction-audit-team-overflow",
  );
  registerNestedApiProvider(
    { api: "openai-responses", stream: overflowThenRecover, streamSimple: overflowThenRecover },
    "compaction-audit-team-overflow",
  );

  const userId = "u_cmpaudit";
  const ownerId = "s_team_overflow_owner";
  const workerId = "s_team_overflow_worker";
  sessionDao.create({
    id: ownerId,
    user_id: userId,
    title: "Overflow owner",
    provider: JAIL_PROVIDER,
    model: "operator-model",
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
  });
  const runtime = makeRuntime({
    id: workerId,
    provider: JAIL_PROVIDER,
    model: "operator-model",
    messages: bigMessages,
  });
  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: ownerId,
    id: (kind) => `team_overflow_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Overflow recovery",
    members: [
      { sessionId: ownerId, role: "lead" },
      { sessionId: workerId, role: "worker" },
    ],
    leadSessionId: ownerId,
  });
  const work = coordinator.assignWork({
    teamId: team.team.id,
    targetMemberId: team.members.find((member) => member.sessionId === workerId)!.id,
    title: "Recover one overflow",
    payload: {},
    idempotencyKey: "team-overflow-recovery",
    deadlineAt: Date.now() + 60_000,
    budget: { maxModelCycles: 2, maxTokens: 4_000_000 },
  });
  const executor = new TeamTurnExecutor({
    userId,
    gateway: { activateSession: () => runtime },
    id: (kind) => `team_overflow_execute_${kind}`,
  });
  const execution = await executor.execute(work.task.id);
  runtime.close();

  assert.equal(execution.status, "succeeded");
  assert.equal(calls, 3, "overflow + hidden summary + one resumed provider call");
  assert.equal(teamTaskDao.usageByTask(userId, work.task.id).modelCycles, 2);
  assert.ok(compactionDao.listForSession(workerId).length > 0);
  assert.ok(auditFor(workerId).some((row) =>
    row.event === "compaction_ok"
    && (JSON.parse(row.data_json) as { phase?: string }).phase === "post_overflow_retry"));
});

await acheck("Team overflow without a remaining model cycle does not compact for an impossible retry", async () => {
  let calls = 0;
  const overflowOnly = (model: Model<string>) => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "error",
        errorMessage: OVERFLOW_ERROR_MSG,
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "error" as never, message });
      stream.end(message);
    });
    return stream;
  };
  registerApiProvider(
    { api: "openai-responses", stream: overflowOnly, streamSimple: overflowOnly },
    "compaction-audit-team-overflow-no-cycle",
  );
  registerNestedApiProvider(
    { api: "openai-responses", stream: overflowOnly, streamSimple: overflowOnly },
    "compaction-audit-team-overflow-no-cycle",
  );

  const userId = "u_cmpaudit";
  const ownerId = "s_team_overflow_no_cycle_owner";
  const workerId = "s_team_overflow_no_cycle_worker";
  sessionDao.create({
    id: ownerId,
    user_id: userId,
    title: "Overflow no-cycle owner",
    provider: JAIL_PROVIDER,
    model: "operator-model",
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
  });
  const runtime = makeRuntime({
    id: workerId,
    provider: JAIL_PROVIDER,
    model: "operator-model",
    messages: bigMessages,
  });
  const before = JSON.stringify(messageDao.list(workerId));
  const { TeamCoordinator } = await import("../server/src/orchestration/team-coordinator.ts");
  const { TeamTurnExecutor } = await import("../server/src/orchestration/team-turn-executor.ts");
  let serial = 0;
  const coordinator = new TeamCoordinator({
    userId,
    actorSessionId: ownerId,
    id: (kind) => `team_overflow_no_cycle_${kind}_${++serial}`,
  });
  const team = coordinator.createFromSessions({
    name: "Overflow without retry cycle",
    members: [
      { sessionId: ownerId, role: "lead" },
      { sessionId: workerId, role: "worker" },
    ],
    leadSessionId: ownerId,
  });
  const work = coordinator.assignWork({
    teamId: team.team.id,
    targetMemberId: team.members.find((member) => member.sessionId === workerId)!.id,
    title: "Do not compact without a retry cycle",
    payload: {},
    idempotencyKey: "team-overflow-no-cycle",
    deadlineAt: Date.now() + 60_000,
    budget: { maxModelCycles: 1, maxTokens: 4_000_000 },
  });
  const executor = new TeamTurnExecutor({
    userId,
    gateway: { activateSession: () => runtime },
    id: (kind) => `team_overflow_no_cycle_execute_${kind}`,
  });
  const execution = await executor.execute(work.task.id);
  runtime.close();

  assert.equal(execution.status, "failed");
  assert.equal(calls, 1, "the overflow is the only provider request");
  assert.equal(compactionDao.listForSession(workerId).length, 0, "no unusable retry compaction is committed");
  assert.equal(JSON.stringify(messageDao.list(workerId).slice(0, bigMessages.length)), before, "existing transcript stays byte-identical");
  assert.deepEqual(teamTaskDao.usageByTask(userId, work.task.id).modelCycles, 1);
});

if (failed) {
  console.error(`\n${failed} compaction-audit check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all compaction-audit checks passed");
