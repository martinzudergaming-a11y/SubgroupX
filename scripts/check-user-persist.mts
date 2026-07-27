import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-user-persist-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "user-persist-check-secret-32-chars!";

const { db, sessionDao, userDao, messageDao, timelineDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { recoverInterruptedSessions } = await import("../server/src/runtime/recovery.ts");
const { buildShareSnapshot } = await import("../server/src/sharing/redact.ts");

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

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
userDao.create({ id: "u_persist", email: "persist@test", password_hash: "x", created_at: NOW });

function makeRuntime(opts: {
  id: string;
  messages: { role: string; content: string | { type: string; text: string }[] }[];
}): InstanceType<typeof AgentSessionRuntime> {
  const row: SessionRow = {
    id: opts.id,
    user_id: "u_persist",
    title: "persist-check",
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
  const piMessages = opts.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
    timestamp: NOW,
  }));
  messageDao.replaceAll(opts.id, piMessages);
  return new AgentSessionRuntime(row);
}

function getPrivate<T>(rt: InstanceType<typeof AgentSessionRuntime>, field: string): T {
  return (rt as unknown as Record<string, T>)[field];
}
function getAgent(rt: InstanceType<typeof AgentSessionRuntime>): { prompt: (s: string) => Promise<void>; state: { messages: unknown[] } } {
  return (rt as unknown as { agent: { prompt: (s: string) => Promise<void>; state: { messages: unknown[] } } }).agent;
}
const userRows = (sessionId: string): Extract<TimelineItem, { kind: "user" }>[] =>
  timelineDao.list(sessionId).filter((i): i is Extract<TimelineItem, { kind: "user" }> => i.kind === "user");

const SENT_TEXT = "implement the persist-at-send fix";

console.log("\n── Case 1: abort BEFORE message_start still persists the user row ──");

const rt1 = makeRuntime({ id: "s_abort", messages: [] });
let promptCalled = false;
let cutAtPrompt = -1;
{
  const agent = getAgent(rt1);
  agent.prompt = async () => {
    promptCalled = true;
    cutAtPrompt = agent.state.messages.length;
    throw new Error("simulated crash before message_start");
  };
}
await rt1.sendMessage(SENT_TEXT);

await acheck("agent.prompt was reached (pre-persist is on the path before prompt)", async () =>
  assert.equal(promptCalled, true),
);

let persistedRow: Extract<TimelineItem, { kind: "user" }> | undefined;
await acheck("user row is durably in the timeline after the pre-message_start abort", async () => {
  const rows = userRows("s_abort");
  assert.equal(rows.length, 1, `expected exactly 1 user row, got ${rows.length}`);
  persistedRow = rows[0];
  assert.equal(persistedRow.text, SENT_TEXT, "persisted text must be the user's original (stripped) text");
});

await acheck("user row has a stable u_ id", async () =>
  assert.ok(persistedRow!.id.startsWith("u_"), `id must start with u_, got ${persistedRow!.id}`),
);

await acheck("user row stores msg_cut = post-compaction transcript length (the prefix at prompt time)", async () => {
  const cut = timelineDao.msgCutAt("s_abort", persistedRow!.seq);
  assert.equal(cut, cutAtPrompt, `msg_cut=${cut} must equal transcript length at prompt=${cutAtPrompt}`);
});

console.log("\n── Case 2: recovery surfaces the persisted (previously-lost) user text ──");

db.prepare("DELETE FROM timeline WHERE session_id = ? AND json_extract(item_json, '$.kind') = 'error'").run("s_abort");
db.prepare(
  `UPDATE agent_turns SET status = 'in_progress', completed_at = NULL, duration_ms = NULL, end_seq = ?
   WHERE session_id = ? AND id = ?`,
).run(persistedRow!.seq, "s_abort", persistedRow!.turnId);
sessionDao.setStatus("s_abort", "running");
const recovered = recoverInterruptedSessions();

await acheck("recoverInterruptedSessions picked up the running session", async () =>
  assert.ok(recovered >= 1, `expected >=1 recovered, got ${recovered}`),
);
await acheck("interrupted notice resumeText equals the persisted (previously-lost) user text", async () => {
  const notice = timelineDao.list("s_abort").find((i) => i.kind === "interrupted");
  assert.ok(notice && notice.kind === "interrupted", "an interrupted notice must exist");
  assert.equal(notice.resumeText, SENT_TEXT);
});

console.log("\n── Case 3: normal turn yields exactly ONE user row (message_start reuses it) ──");

const rt3 = makeRuntime({ id: "s_normal", messages: [] });
await rt3.sendMessage("hello mock, write me a haiku");

await acheck("exactly one user row after a full normal turn (message_start did NOT add a 2nd)", async () => {
  const rows = userRows("s_normal");
  assert.equal(rows.length, 1, `expected exactly 1 user row, got ${rows.length}`);
});

let normalRow: Extract<TimelineItem, { kind: "user" }>;
await acheck("the single user row has the stable u_ id and the sent text", async () => {
  normalRow = userRows("s_normal")[0];
  assert.ok(normalRow.id.startsWith("u_"));
  assert.equal(normalRow.text, "hello mock, write me a haiku");
});

await acheck("user seq is strictly greater than latestCompactionSeq (rewind-to-this-user stays valid)", async () => {
  const compSeq = timelineDao.latestCompactionSeq("s_normal");
  assert.ok(normalRow.seq > compSeq, `user seq ${normalRow.seq} must be > latestCompactionSeq ${compSeq}`);
});

await acheck("pendingUserItem is cleared after the turn", async () =>
  assert.equal(getPrivate<unknown>(rt3, "pendingUserItem"), null),
);

await acheck("an assistant reply followed the single user row (turn completed normally)", async () => {
  const items = timelineDao.list("s_normal");
  assert.ok(items.some((i) => i.kind === "assistant"), "expected an assistant item in the timeline");
});

console.log("\n── Case 4: canvas context stays engine-only (Timeline + Share remain clean) ──");

const rt4 = makeRuntime({ id: "s_canvas", messages: [] });
const visibleCanvasText = "compare the selected chart";
const privateCanvasDiff = "secret field changed: internal-project-name";
await rt4.sendMessage(visibleCanvasText, privateCanvasDiff);

await acheck("canvas prompt produces exactly one visible user Message with original text", async () => {
  const rows = userRows("s_canvas");
  assert.equal(rows.length, 1, `expected exactly 1 user row, got ${rows.length}`);
  assert.equal(rows[0].text, visibleCanvasText);
  assert.ok(!rows[0].text.includes("canvas-interaction"));
  assert.ok(!rows[0].text.includes(privateCanvasDiff));
});

await acheck("public Share contains only the canonical visible Message", async () => {
  const snapshot = buildShareSnapshot(timelineDao.list("s_canvas"));
  const users = snapshot.items.filter((item) => item.kind === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0]?.kind === "user" ? users[0].text : null, visibleCanvasText);
  assert.ok(!JSON.stringify(snapshot).includes(privateCanvasDiff));
  assert.ok(!JSON.stringify(snapshot).includes("canvas-interaction"));
});

await acheck("engine transcript retains the injected canvas context for model reasoning", async () => {
  const transcript = JSON.stringify(messageDao.list("s_canvas"));
  assert.ok(transcript.includes("<canvas-interaction>"));
  assert.ok(transcript.includes(privateCanvasDiff));
  assert.ok(transcript.includes(visibleCanvasText));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} user-persist check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all user-persist checks passed");
