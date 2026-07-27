import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-compact-trigger-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "compaction-trigger-check-secret-32c";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://localhost:19973";
process.env.AGENT_WEB_JAIL_KEY = "fake-test-key-for-regression";

const { sessionDao, userDao, messageDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, mockModel, JAIL_PROVIDER } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { shouldCompact, DEFAULT_COMPACTION_SETTINGS, estimateTokens } = await import(
  "@earendil-works/pi-coding-agent"
);
import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent } from "../shared/src/protocol.ts";

registerMockProvider();

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
function check(name: string, fn: () => void): void {
  try {
    fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const now = Date.now();
userDao.create({ id: "u_compact", email: "compact@test", password_hash: "x", created_at: now });

function makeRuntime(
  opts: {
    id: string;
    provider: string;
    model: string;
    messages: { role: string; content: string | { type: string; text: string }[]; usage?: { totalTokens: number } }[];
  },
): InstanceType<typeof AgentSessionRuntime> {
  const row: SessionRow = {
    id: opts.id,
    user_id: "u_compact",
    title: "compact-check",
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
    created_at: now,
    updated_at: now,
  };
  sessionDao.create(row);
  const piMessages = opts.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
    timestamp: now,
    ...(m.usage ? { usage: m.usage } : {}),
  }));
  messageDao.replaceAll(opts.id, piMessages);
  return new AgentSessionRuntime(row);
}

const { reserveTokens } = DEFAULT_COMPACTION_SETTINGS;

const mockContextWindow: number = (mockModel as { contextWindow?: number }).contextWindow ?? 0;
const mockCompactAt = mockContextWindow - reserveTokens;

const operatorContextWindow = 272_000;
const operatorCompactAt = operatorContextWindow - reserveTokens;

console.log("\n── Section 1: trigger unit test (mock model, lastContextTokens=0) ──────────");

const LARGE_MSG_CHARS = 15_000;
const LARGE_MSG_COUNT = 30;

const largeMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < LARGE_MSG_COUNT; i++) {
  largeMessages.push({ role: "user", content: "u".repeat(LARGE_MSG_CHARS) });
  largeMessages.push({
    role: "assistant",
    content: [{ type: "text", text: "a".repeat(LARGE_MSG_CHARS) }],
  });
}

const rt1 = makeRuntime({ id: "s_large_mock", provider: "mock", model: "mock-coder", messages: largeMessages });

const usage1 = rt1.getContextUsage();
console.log(
  `  info: mockContextWindow=${mockContextWindow}, compactAt=${mockCompactAt}, ` +
  `used=${usage1.used}, measured=${usage1.measured}, pending=${usage1.pending}`,
);

check("lastContextTokens is 0 after rebuild (measured=0)", () => assert.equal(usage1.measured, 0));
check("used reflects the transcript estimate (not 0)", () => assert.ok(usage1.used > 0, `used=${usage1.used}`));
check("used exceeds compactAt — trigger fires with the FIX", () =>
  assert.ok(
    shouldCompact(usage1.used, mockContextWindow, DEFAULT_COMPACTION_SETTINGS),
    `shouldCompact(${usage1.used}, ${mockContextWindow}) must be true`,
  ),
);
check("shouldCompact(0, …) is false — would SKIP under the BUG", () =>
  assert.ok(
    !shouldCompact(0, mockContextWindow, DEFAULT_COMPACTION_SETTINGS),
    "shouldCompact(0) must be false — demonstrates the old guard was broken",
  ),
);
check("compactAt reported correctly by getContextUsage()", () =>
  assert.equal(usage1.compactAt, mockCompactAt),
);

console.log("\n── Section 2: sendMessage → compaction_start (operator model, fast-fail network) ─");

const OPERATOR_MSG_CHARS = 55_000;
const OPERATOR_MSG_COUNT = 20;

const operatorMessages: { role: string; content: string | { type: string; text: string }[] }[] = [];
for (let i = 0; i < OPERATOR_MSG_COUNT; i++) {
  operatorMessages.push({ role: "user", content: "u".repeat(OPERATOR_MSG_CHARS) });
  operatorMessages.push({
    role: "assistant",
    content: [{ type: "text", text: "a".repeat(OPERATOR_MSG_CHARS) }],
  });
}

const rt2 = makeRuntime({ id: "s_large_operator", provider: JAIL_PROVIDER, model: "operator-model", messages: operatorMessages });

const usage2 = rt2.getContextUsage();
console.log(
  `  info: operatorContextWindow=${operatorContextWindow}, compactAt=${operatorCompactAt}, ` +
  `used=${usage2.used}`,
);

check("operator session: used exceeds compactAt", () =>
  assert.ok(
    usage2.used > operatorCompactAt,
    `used=${usage2.used} must exceed compactAt=${operatorCompactAt}`,
  ),
);

const events2: string[] = [];
rt2.subscribe((ev: ServerEvent) => {
  if (ev.type === "agent_event") events2.push(ev.event.t);
});

let turnDone2 = false;
const turnPromise2 = rt2.sendMessage("hello").finally(() => {
  turnDone2 = true;
});
await Promise.race([
  turnPromise2,
  new Promise<void>((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 30_000)),
]).catch((e) => {
  if (e instanceof Error && e.message === "turn timed out") throw e;
});

console.log(`  info: events observed: ${events2.join(", ") || "(none)"}`);

check("sendMessage emits compaction_start when used>compactAt and apiKey is present", () =>
  assert.ok(
    events2.includes("compaction_start"),
    `Expected compaction_start in events. Got: [${events2.join(", ")}]`,
  ),
);

console.log("\n── Section 3: negative control (small transcript, no compaction) ────────────");

const smallMessages = [
  { role: "user", content: "hello world" },
  { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  { role: "user", content: "how are you" },
  { role: "assistant", content: [{ type: "text", text: "I am fine" }] },
];

const rt3 = makeRuntime({ id: "s_small_mock", provider: "mock", model: "mock-coder", messages: smallMessages });

const usage3 = rt3.getContextUsage();
console.log(`  info: small transcript: used=${usage3.used}, compactAt=${usage3.compactAt}`);

check("small transcript: used is far below compactAt", () =>
  assert.ok(
    usage3.used < usage3.compactAt,
    `used=${usage3.used} must be < compactAt=${usage3.compactAt}`,
  ),
);
check("shouldCompact(small_used, …) is false — no trigger", () =>
  assert.ok(
    !shouldCompact(usage3.used, mockContextWindow, DEFAULT_COMPACTION_SETTINGS),
    `shouldCompact(${usage3.used}) must be false`,
  ),
);

const events3: string[] = [];
rt3.subscribe((ev: ServerEvent) => {
  if (ev.type === "agent_event") events3.push(ev.event.t);
});

await rt3.sendMessage("hello");
console.log(`  info: small session events: ${events3.join(", ") || "(none)"}`);

check("small transcript: no compaction_start on turn", () =>
  assert.ok(
    !events3.includes("compaction_start"),
    `compaction_start must NOT fire on small transcript. Got: [${events3.join(", ")}]`,
  ),
);

console.log("\n── Section 4: measured-base re-seed from transcript on rebuild (#20) ─────────");

const SEED_USAGE = 90_000;
const rt4a = makeRuntime({
  id: "s_seed_valid",
  provider: "mock",
  model: "mock-coder",
  messages: [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }], usage: { totalTokens: 10 } },
    { role: "user", content: "later question" },
    { role: "assistant", content: [{ type: "text", text: "later answer" }], usage: { totalTokens: SEED_USAGE } },
  ],
});
const usage4a = rt4a.getContextUsage();
console.log(`  info: seeded measured=${usage4a.measured} (expected ${SEED_USAGE})`);
check("rebuild seeds measured from the last assistant usage (not 0)", () =>
  assert.equal(usage4a.measured, SEED_USAGE),
);
check("seeded measured drives the trigger off the REAL count, not the 1.3× estimate", () =>
  assert.ok(!shouldCompact(usage4a.used, mockContextWindow, DEFAULT_COMPACTION_SETTINGS), `used=${usage4a.used}`),
);

const rt4b = makeRuntime({
  id: "s_seed_stale",
  provider: "mock",
  model: "mock-coder",
  messages: [
    { role: "user", content: "old question" },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], usage: { totalTokens: 250_000 } },
    { role: "user", content: "[Context note] The earlier part of this conversation was compacted to fit the model's context window. Summary of what happened so far:\n\nstuff" },
    { role: "user", content: "fresh question after compaction" },
  ],
});
const usage4b = rt4b.getContextUsage();
console.log(`  info: post-compaction seeded measured=${usage4b.measured} (expected 0 — stale usage rejected)`);
check("rebuild rejects pre-compaction stale usage (measured=0 when a summary marker is newer)", () =>
  assert.equal(usage4b.measured, 0),
);

const FRESH_USAGE = 30_000;
const rt4c = makeRuntime({
  id: "s_seed_fresh_after_marker",
  provider: "mock",
  model: "mock-coder",
  messages: [
    { role: "user", content: "very old question" },
    { role: "assistant", content: [{ type: "text", text: "very old answer" }], usage: { totalTokens: 250_000 } },
    { role: "user", content: "[Context note] The earlier part of this conversation was compacted to fit the model's context window. Summary of what happened so far:\n\nstuff" },
    { role: "user", content: "question after compaction" },
    { role: "assistant", content: [{ type: "text", text: "answer after compaction" }], usage: { totalTokens: FRESH_USAGE } },
  ],
});
const usage4c = rt4c.getContextUsage();
console.log(`  info: fresh-after-marker seeded measured=${usage4c.measured} (expected ${FRESH_USAGE})`);
check("rebuild seeds the fresh post-compaction usage when an OLDER marker precedes it", () =>
  assert.equal(usage4c.measured, FRESH_USAGE),
);

rt1.close();
rt2.close();
rt3.close();
rt4a.close();
rt4b.close();
rt4c.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} compaction-trigger check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all compaction-trigger checks passed");
