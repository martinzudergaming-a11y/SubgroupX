import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { ServerEvent } from "../shared/src/protocol.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-subscribe-profile-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "subscribe-profile-secret";
process.env.AGENT_WEB_KEY_SECRET = "subscribe-profile-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "60000";
process.env.AGENT_WEB_SUBSCRIBE_PROFILE_RATE = "1";
process.env.AGENT_WEB_SUBSCRIBE_PROFILE_SLOW_MS = "100000";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { signup, issueToken } = await import("../server/src/identity/auth.ts");
const { timelineDao, auditEventDao, db } = await import("../server/src/persistence/index.ts");
const { createWebSocketServer } = await import("../server/src/transport/ws-server.ts");
registerMockProvider();

const user = await signup(`subscribe-profile-${process.pid}@gmail.com`, "password123");
const sessionId = sessionManager.createSession(user, {
  title: "subscribe profile fixture",
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "never",
}).id;
for (let index = 0; index < 24; index++) {
  timelineDao.append(sessionId, {
    kind: "user",
    id: `row-${index}`,
    seq: index + 1,
    text: `fixture row ${index} `.repeat(64),
    ts: 1_700_000_000_000 + index,
  });
}

const wss = createWebSocketServer();
const server = http.createServer();
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(issueToken(user))}`);
const frames: ServerEvent[] = [];
ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as ServerEvent));

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const rows = () => auditEventDao.recent(100)
  .filter((row) => row.event === "session_subscribe_profile" && row.session_id === sessionId)
  .map((row) => ({ ...row, data: JSON.parse(row.data_json) as Record<string, unknown> }));

try {
  await waitFor(() => frames.some((event) => event.type === "hello"), "hello");
  ws.send(JSON.stringify({ type: "subscribe", sessionId, reqId: "cold" }));
  await waitFor(() => frames.some((event) => event.type === "ack" && event.reqId === "cold"), "cold ack");
  const replay = frames.find((event): event is Extract<ServerEvent, { type: "timeline_replay" }> => event.type === "timeline_replay");
  assert.ok(replay, "cold subscribe emits the Timeline replay");
  await waitFor(() => rows().length >= 1, "cold audit row");

  ws.send(JSON.stringify({
    type: "subscribe",
    sessionId,
    reqId: "warm",
    resume: { epoch: replay.epoch, version: replay.version },
  }));
  await waitFor(() => frames.some((event) => event.type === "ack" && event.reqId === "warm"), "warm ack");
  await waitFor(() => rows().length >= 2, "warm audit row");

  const byRequest = new Map(rows().map((row) => [row.request_id, row.data]));
  const cold = byRequest.get("cold");
  const warm = byRequest.get("warm");
  assert.ok(cold && warm, "both request ids are persisted");
  assert.equal(cold.replayed, true);
  assert.equal(cold.resumeOffered, false);
  assert.equal(cold.timelineItems, 24);
  assert.ok(Number(cold.jsonBytes) > 1_000, "cold row records replay bytes");
  assert.equal(warm.replayed, false);
  assert.equal(warm.resumeOffered, true);
  assert.equal(warm.timelineItems, 0);
  assert.equal(warm.snapshotReadMs, 0);
  for (const [label, data] of [["cold", cold], ["warm", warm]] as const) {
    for (const key of [
      "runtimeResolveMs", "bindGatewayMs", "snapshotReadMs", "replayGatewayMs",
      "serverJsonMs", "socketCallbackWallMs", "socketCallbackWaitTotalMs", "totalUntilAckMs",
    ]) {
      assert.ok(Number.isFinite(data[key]) && Number(data[key]) >= 0, `${label}.${key} is a non-negative finite duration`);
    }
  }
  console.log("OK session-subscribe-profile: real WS cold/full + warm/resume audit phases and socket callback boundary");
} finally {
  ws.close();
  sessionManager.disposeUserRuntimes(user.id);
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
