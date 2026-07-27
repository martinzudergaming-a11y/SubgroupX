import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-session-switch-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "session-switch-secret";
process.env.AGENT_WEB_KEY_SECRET = "session-switch-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "500";
process.env.AGENT_WEB_SESSION_WARM_MAX = "2";
process.env.AGENT_WEB_SESSION_WARM_GLOBAL_MAX = "3";

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { timelineDao, db } = await import("../server/src/persistence/index.ts");
const { signup } = await import("../server/src/identity/auth.ts");
registerMockProvider();

const user = await signup(`switch-${process.pid}@gmail.com`, "password123");
const create = (owner: typeof user, title: string) => sessionManager.createSession(owner, {
  title,
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "on-request",
}).id;
const [sid1, sid2, sid3] = [create(user, "one"), create(user, "two"), create(user, "three")];

timelineDao.append(sid1, { kind: "user", id: "u1", seq: 1, text: "hello", ts: Date.now() });
const originalList = timelineDao.list.bind(timelineDao);
let listCalls = 0;
timelineDao.list = ((sid: string) => { listCalls++; return originalList(sid); }) as typeof timelineDao.list;

try {
  const rt1 = sessionManager.getRuntime(user.id, sid1)!;
  assert.equal(rt1.getTimeline().length, 1);
  assert.equal(rt1.getTimeline().length, 1);
  assert.equal(listCalls, 1, "a live runtime parses its persisted timeline only once");
  const versionBeforeTurn = rt1.getTimelineVersion();
  await rt1.sendMessage("hello");
  const cachedLength = rt1.getTimeline().length;
  assert.ok(cachedLength > 1, "new turn rows are visible through the live timeline cache");
  assert.ok(rt1.getTimelineVersion() > versionBeforeTurn, "persisted turn rows advance the replay cursor version");
  assert.equal(listCalls, 1, "persisted turn rows update the cache without a second DB read");

  sessionManager.releaseIfIdle(user.id, sid1);
  const rt1Warm = sessionManager.getRuntime(user.id, sid1)!;
  assert.equal(rt1Warm, rt1, "switch-back inside the warm grace reuses the runtime");
  assert.equal(rt1Warm.getEpoch(), rt1.getEpoch(), "warm switch-back preserves the epoch");
  assert.equal(rt1Warm.getTimeline().length, cachedLength);
  assert.equal(listCalls, 1, "warm replay uses the in-memory timeline cache");

  sessionManager.releaseIfIdle(user.id, sid1);
  sessionManager.getRuntime(user.id, sid2);
  sessionManager.releaseIfIdle(user.id, sid2);
  sessionManager.getRuntime(user.id, sid3);
  sessionManager.releaseIfIdle(user.id, sid3);
  const rt1AfterCap = sessionManager.getRuntime(user.id, sid1)!;
  assert.notEqual(rt1AfterCap, rt1, "warm cap evicts the oldest idle runtime");

  const rt2 = sessionManager.getRuntime(user.id, sid2)!;
  sessionManager.releaseIfIdle(user.id, sid2);
  await new Promise((r) => setTimeout(r, 650));
  const rt2AfterTtl = sessionManager.getRuntime(user.id, sid2)!;
  assert.notEqual(rt2AfterTtl, rt2, "warm grace eventually releases an idle runtime");

  sessionManager.disposeUserRuntimes(user.id);
  const user2 = await signup(`switch-2-${process.pid}@gmail.com`, "password123");
  const user3 = await signup(`switch-3-${process.pid}@gmail.com`, "password123");
  const [u2a, u2b] = [create(user2, "u2-a"), create(user2, "u2-b")];
  const [u3a, u3b] = [create(user3, "u3-a"), create(user3, "u3-b")];
  const oldestGlobal = sessionManager.getRuntime(user2.id, u2a)!;
  for (const [owner, sid] of [[user2, u2a], [user2, u2b], [user3, u3a], [user3, u3b]] as const) {
    sessionManager.getRuntime(owner.id, sid);
    sessionManager.releaseIfIdle(owner.id, sid);
  }
  assert.notEqual(sessionManager.getRuntime(user2.id, u2a), oldestGlobal, "global warm cap evicts the oldest runtime across users");
  sessionManager.disposeUserRuntimes(user2.id);
  sessionManager.disposeUserRuntimes(user3.id);

  console.log("OK session-switch: cached replay/update + warm reuse + per-user/global caps + timed release");
} finally {
  timelineDao.list = originalList;
  sessionManager.disposeUserRuntimes(user.id);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
