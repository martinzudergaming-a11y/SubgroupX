import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-overflow-recovery-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "overflow-recovery-check-secret-32c";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://localhost:19974";
process.env.AGENT_WEB_JAIL_KEY = "fake-test-key-for-overflow-recovery";

const { sessionDao, userDao, messageDao, timelineDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID, mockModel, JAIL_PROVIDER } = await import(
  "../server/src/runtime/providers.ts"
);
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { registerApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
const { createAssistantMessageEventStream, isContextOverflow } = await import("@earendil-works/pi-ai");
const { DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent } from "../shared/src/protocol.ts";
import type { AssistantMessage, Model, Context, StreamOptions } from "@earendil-works/pi-ai";

registerMockProvider();

let failed = 0;
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
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
userDao.create({ id: "u_overflow", email: "overflow@test", password_hash: "x", created_at: NOW });

function makeRuntime(opts: {
  id: string;
  provider: string;
  model: string;
  messages: { role: string; content: string | { type: string; text: string }[] }[];
}): InstanceType<typeof AgentSessionRuntime> {
  const row: SessionRow = {
    id: opts.id,
    user_id: "u_overflow",
    title: "overflow-check",
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
function callOnAgentEvent(
  rt: InstanceType<typeof AgentSessionRuntime>,
  event: unknown,
  signal: AbortSignal,
): Promise<void> {
  return (rt as unknown as { onAgentEvent(e: unknown, s: AbortSignal): Promise<void> }).onAgentEvent(
    event,
    signal,
  );
}
function getPrivate<T>(rt: InstanceType<typeof AgentSessionRuntime>, field: string): T {
  return (rt as unknown as Record<string, T>)[field];
}
function setPrivate(rt: InstanceType<typeof AgentSessionRuntime>, field: string, value: unknown): void {
  (rt as unknown as Record<string, unknown>)[field] = value;
}

const OVERFLOW_ERROR_MSG = "Your input exceeds the context window of this model (overflow test)";
const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeOverflowMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MOCK_PROVIDER,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: OVERFLOW_ERROR_MSG,
    timestamp: Date.now(),
  };
}

const contextWindow = (mockModel as { contextWindow?: number }).contextWindow ?? 128_000;
assert.ok(
  isContextOverflow(makeOverflowMessage(), contextWindow),
  "self-check: makeOverflowMessage() must be recognized as overflow by isContextOverflow()",
);

console.log("\n── Section 1: forceCompact gate (operator model, fake key, refused network) ──────────");

const BT_MSG_CHARS = 10_000;
const BT_MSG_COUNT = 20;

const btMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < BT_MSG_COUNT; i++) {
  btMessages.push({ role: "user", content: "u".repeat(BT_MSG_CHARS) });
  btMessages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(BT_MSG_CHARS) }] });
}

const rt1a = makeRuntime({ id: "s_bt_operator_a", provider: JAIL_PROVIDER, model: "operator-model", messages: btMessages });
const rt1b = makeRuntime({ id: "s_bt_operator_b", provider: JAIL_PROVIDER, model: "operator-model", messages: btMessages });

const usage1 = rt1a.getContextUsage();
console.log(
  `  info: operatorContextWindow=272000, compactAt=${usage1.compactAt}, used=${usage1.used}`,
);

await acheck("below-threshold transcript: used < compactAt", async () =>
  assert.ok(usage1.used < usage1.compactAt, `used=${usage1.used} must be < compactAt=${usage1.compactAt}`),
);

await acheck("maybeCompact(force=false) returns false (below threshold, no compaction_start)", async () => {
  const events: string[] = [];
  rt1a.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") events.push(ev.event.t);
  });
  const result = await callMaybeCompact(rt1a, undefined, false);
  assert.equal(result, false, `expected false from maybeCompact(force=false) below threshold`);
  assert.ok(
    !events.includes("compaction_start"),
    `compaction_start must NOT fire below threshold with force=false. Events: [${events.join(", ")}]`,
  );
});

await acheck("maybeCompact(force=true) emits compaction_start below soft threshold", async () => {
  const events: string[] = [];
  rt1b.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") events.push(ev.event.t);
  });
  await callMaybeCompact(rt1b, undefined, true).catch(() => {});
  assert.ok(
    events.includes("compaction_start"),
    `compaction_start MUST fire for force=true below threshold. Events: [${events.join(", ")}]`,
  );
});

console.log("\n── Section 2: forceCompact returns false when transcript is too small ──────────");

const tinyMessages = [
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
  { role: "user", content: "how are you" },
];
const rt2 = makeRuntime({ id: "s_tiny_operator", provider: JAIL_PROVIDER, model: "operator-model", messages: tinyMessages });

await acheck("maybeCompact(force=true) returns false for <4 messages (nothing to compact)", async () => {
  const events: string[] = [];
  rt2.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") events.push(ev.event.t);
  });
  const result = await callMaybeCompact(rt2, undefined, true);
  assert.equal(result, false, `expected false: messages.length=${tinyMessages.length} < 4`);
  assert.ok(
    !events.includes("compaction_start"),
    `compaction_start must NOT fire for <4 messages. Events: [${events.join(", ")}]`,
  );
});

console.log("\n── Section 3: overflow suppression via direct onAgentEvent injection ───────────");

const INJ_MSG_CHARS = 5_000;
const INJ_MSG_COUNT = 10;
const injMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < INJ_MSG_COUNT; i++) {
  injMessages.push({ role: "user", content: "u".repeat(INJ_MSG_CHARS) });
  injMessages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(INJ_MSG_CHARS) }] });
}

await acheck("injected overflow sets overflowRecoveryPending and clears currentAssistantId", async () => {
  const rt3 = makeRuntime({ id: "s_inj_1", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: injMessages });
  const sig = new AbortController().signal;

  const assistantMsg: AssistantMessage = {
    role: "assistant", content: [],
    api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  await callOnAgentEvent(rt3, { type: "message_start", message: assistantMsg }, sig);
  const assistantId = getPrivate<string | null>(rt3, "currentAssistantId");
  assert.ok(assistantId !== null, "currentAssistantId must be set after message_start");

  await callOnAgentEvent(rt3, { type: "message_end", message: makeOverflowMessage() }, sig);

  assert.equal(
    getPrivate<boolean>(rt3, "overflowRecoveryPending"),
    true,
    "overflowRecoveryPending must be set after first overflow",
  );
  assert.equal(
    getPrivate<string | null>(rt3, "currentAssistantId"),
    null,
    "currentAssistantId must be cleared after overflow suppression",
  );

  rt3.close();
});

await acheck("injected overflow emits assistant_end with empty blocks (cleanup bubble)", async () => {
  const rt3b = makeRuntime({ id: "s_inj_2", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: injMessages });
  const sig = new AbortController().signal;

  const emittedEvents: { t: string; blocks?: unknown[] }[] = [];
  rt3b.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") emittedEvents.push(ev.event as { t: string; blocks?: unknown[] });
  });

  const assistantMsg: AssistantMessage = {
    role: "assistant", content: [],
    api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  await callOnAgentEvent(rt3b, { type: "message_start", message: assistantMsg }, sig);
  await callOnAgentEvent(rt3b, { type: "message_end", message: makeOverflowMessage() }, sig);

  const cleanupEnds = emittedEvents.filter(
    (e) => e.t === "assistant_end" && Array.isArray(e.blocks) && e.blocks.length === 0,
  );
  assert.ok(
    cleanupEnds.length > 0,
    `Expected ≥1 assistant_end with empty blocks. Events: [${emittedEvents.map((e) => e.t).join(", ")}]`,
  );

  rt3b.close();
});

await acheck("injected overflow drops the errored assistant from agent.state.messages", async () => {
  const rt3c = makeRuntime({ id: "s_inj_3", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: injMessages });
  const sig = new AbortController().signal;

  const agent = getPrivate<{ state: { messages: { role: string }[] } }>(rt3c, "agent");

  const assistantMsg: AssistantMessage = {
    role: "assistant", content: [],
    api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  await callOnAgentEvent(rt3c, { type: "message_start", message: assistantMsg }, sig);

  await callOnAgentEvent(rt3c, { type: "message_end", message: makeOverflowMessage() }, sig);

  const msgs = agent.state.messages;
  const lastRole = msgs[msgs.length - 1]?.role;
  assert.notEqual(
    lastRole,
    "assistant",
    `Last message must not be assistant after overflow drop. Last role: ${lastRole}, total: ${msgs.length}`,
  );

  rt3c.close();
});

await acheck("second injected overflow (overflowRetryAttempted=true) is NOT suppressed", async () => {
  const rt3d = makeRuntime({ id: "s_inj_4", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: injMessages });
  const sig = new AbortController().signal;

  const emittedEvents: string[] = [];
  rt3d.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") emittedEvents.push(ev.event.t);
  });

  setPrivate(rt3d, "overflowRetryAttempted", true);
  setPrivate(rt3d, "overflowRecoveryPending", false);

  const assistantMsg: AssistantMessage = {
    role: "assistant", content: [],
    api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  await callOnAgentEvent(rt3d, { type: "message_start", message: assistantMsg }, sig);
  await callOnAgentEvent(rt3d, { type: "message_end", message: makeOverflowMessage() }, sig);

  assert.equal(
    getPrivate<boolean>(rt3d, "overflowRecoveryPending"),
    false,
    "overflowRecoveryPending must remain false when overflowRetryAttempted is set",
  );
  assert.ok(
    emittedEvents.includes("error"),
    `Expected error event on second overflow. Events: [${emittedEvents.join(", ")}]`,
  );

  rt3d.close();
});

console.log("\n── Section 4: full turn via stateful overflow stream ────────────────────────────");

const FULL_MSG_CHARS = 10_000;
const FULL_MSG_COUNT = 10;
const fullMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < FULL_MSG_COUNT; i++) {
  fullMessages.push({ role: "user", content: "u".repeat(FULL_MSG_CHARS) });
  fullMessages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(FULL_MSG_CHARS) }] });
}

let overflowCallCount = 0;

function makeOverflowStream(
  _model: Model<string>,
  _context: Context,
  _options?: StreamOptions,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const callIndex = overflowCallCount++;

  queueMicrotask(async () => {
    if (callIndex === 0) {
      const errMsg = makeOverflowMessage();
      stream.push({ type: "start", partial: { ...errMsg, content: [] } });
      stream.push({ type: "done", reason: "error" as any, message: errMsg });
      stream.end(errMsg);
    } else {
      const successMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Recovery successful." }],
        api: MOCK_PROVIDER, provider: MOCK_PROVIDER, model: MOCK_MODEL_ID,
        usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
      };
      const partial = { ...successMsg, content: [] as typeof successMsg.content };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...successMsg, content: [{ type: "text", text: "" }] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Recovery successful.", partial: { ...successMsg } });
      stream.push({ type: "text_end", contentIndex: 0, content: "Recovery successful.", partial: successMsg });
      stream.push({ type: "done", reason: "stop" as any, message: successMsg });
      stream.end(successMsg);
    }
  });
  return stream;
}

overflowCallCount = 0;
registerApiProvider({ api: "mock", stream: makeOverflowStream, streamSimple: makeOverflowStream }, "overflow-test");

await acheck("overflow turn: no raw-overflow text in persisted error timeline items", async () => {
  overflowCallCount = 0;
  const rt4a = makeRuntime({ id: "s_full_1", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: fullMessages });
  await rt4a.sendMessage("hello").catch(() => {});
  rt4a.close();

  const timeline = timelineDao.list("s_full_1");
  const rawOverflowItems = timeline.filter(
    (i) =>
      i.kind === "error" &&
      "message" in i &&
      typeof i.message === "string" &&
      i.message.toLowerCase().includes("exceeds the context window"),
  );
  assert.equal(
    rawOverflowItems.length,
    0,
    `Timeline must NOT contain raw overflow error text. Offending items: ${JSON.stringify(rawOverflowItems)}`,
  );
});

await acheck("overflow turn: assistant_end with empty blocks (cleanup bubble) was emitted", async () => {
  overflowCallCount = 0;
  const rt4b = makeRuntime({ id: "s_full_2", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: fullMessages });

  const agentEvents: { t: string; blocks?: unknown[] }[] = [];
  rt4b.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") agentEvents.push(ev.event as { t: string; blocks?: unknown[] });
  });

  await rt4b.sendMessage("hello").catch(() => {});
  rt4b.close();

  const emptyEnds = agentEvents.filter(
    (e) => e.t === "assistant_end" && Array.isArray(e.blocks) && e.blocks.length === 0,
  );
  assert.ok(
    emptyEnds.length > 0,
    `Expected ≥1 assistant_end with empty blocks. Events: [${agentEvents.map((e) => e.t).join(", ")}]`,
  );
});

await acheck("overflow turn: clean 'too large' error (not raw provider overflow message)", async () => {
  overflowCallCount = 0;
  const rt4c = makeRuntime({ id: "s_full_3", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: fullMessages });

  const errorMessages: string[] = [];
  rt4c.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event" && ev.event.t === "error") {
      errorMessages.push((ev.event as { t: string; message: string }).message);
    }
  });

  await rt4c.sendMessage("hello").catch(() => {});
  rt4c.close();

  assert.ok(errorMessages.length > 0, "Expected at least one error event from the overflow turn");

  const hasRaw = errorMessages.some((m) => m.toLowerCase().includes("exceeds the context window"));
  assert.ok(
    !hasRaw,
    `Error must NOT be raw overflow text. Got: ${errorMessages.join("; ")}`,
  );

  const hasClean = errorMessages.some(
    (m) =>
      m.includes("conversation is too large") ||
      m.includes("context window") ||
      m.includes("start a new session") ||
      m.includes("too long") ||
      m.includes("large"),
  );
  assert.ok(hasClean, `Expected a clean 'too large' error. Got: ${errorMessages.join("; ")}`);
  console.log(`    (info: clean error message: "${errorMessages[0]}")`);
});

await acheck("overflow event sequence: one outer turn_end after the clean error", async () => {
  overflowCallCount = 0;
  const rt4d = makeRuntime({ id: "s_full_4", provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, messages: fullMessages });

  const eventSeq: string[] = [];
  rt4d.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") eventSeq.push(ev.event.t);
  });

  await rt4d.sendMessage("hello").catch(() => {});
  rt4d.close();

  console.log(`    (info: event sequence: ${eventSeq.join(", ")})`);

  assert.ok(eventSeq.includes("error"), `event sequence must include 'error'. Got: [${eventSeq.join(", ")}]`);

  const errorIdx = eventSeq.indexOf("error");
  const prematureTurnEnd = eventSeq.slice(0, errorIdx).includes("turn_end");
  assert.ok(
    !prematureTurnEnd,
    `turn_end must not appear before error. Sequence: [${eventSeq.join(", ")}]`,
  );
  assert.equal(eventSeq.filter((event) => event === "turn_end").length, 1, "exactly one outer turn_end");
  assert.equal(eventSeq.includes("agent_end"), false, "pi agent_end is not a product lifecycle boundary");
});

console.log("    (info: overflow stream remains registered; standard mock not re-registered)");

console.log("\n── Section 5: isContextOverflow unit (no runtime needed) ────────────────────────");

await acheck("isContextOverflow detects error+matching errorMessage", async () => {
  const m = makeOverflowMessage();
  assert.ok(isContextOverflow(m, contextWindow), "should detect overflow for error+pattern");
});

await acheck("isContextOverflow does not flag a normal stop message", async () => {
  const m: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "ok" }],
    api: "mock", provider: "mock", model: "mock-coder",
    usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now(),
  };
  assert.ok(!isContextOverflow(m, contextWindow), "normal stop must NOT be flagged as overflow");
});

await acheck("isContextOverflow does not flag a rate-limit error (non-overflow exclusion)", async () => {
  const m: AssistantMessage = {
    role: "assistant", content: [],
    api: "mock", provider: "mock", model: "mock-coder",
    usage: ZERO_USAGE, stopReason: "error",
    errorMessage: "Rate limit: too many requests from this API key",
    timestamp: Date.now(),
  };
  assert.ok(!isContextOverflow(m, contextWindow), "rate limit error must NOT be flagged as overflow");
});

console.log("\n── Section 5b: operator-provider baseline turn (expected fast-fail, not a hang) ─────");

await acheck("operator turn with refused network errors cleanly (does not hang)", async () => {
  const rtGw = makeRuntime({
    id: "s_operator_baseline",
    provider: JAIL_PROVIDER,
    model: "operator-model",
    messages: [{ role: "user", content: "hi" }],
  });
  const events: string[] = [];
  rtGw.subscribe((ev: ServerEvent) => {
    if (ev.type === "agent_event") events.push(ev.event.t);
  });

  await Promise.race([
    rtGw.sendMessage("hi").catch(() => {}),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("operator baseline turn timed out")), 15_000),
    ),
  ]);

  rtGw.close();

  assert.ok(events.length > 0, `Expected events from operator baseline turn. Got: [${events.join(", ")}]`);
});

rt1a.close();
rt1b.close();
rt2.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failed) {
  console.error(`${failed} overflow-recovery check(s) FAILED`);
  process.exit(1);
}
console.log("OK: all overflow-recovery checks passed");
