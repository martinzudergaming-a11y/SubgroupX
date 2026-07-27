import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-runtime-stream-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const [providers, { sessionManager }, { attachRuntimeStreamHost }, streamProtocol, runtimeProtocol, auth] =
  await Promise.all([
    import("../server/src/runtime/providers.ts"),
    import("../server/src/runtime/manager.ts"),
    import("../server/src/runtime/runtime-stream-host.ts"),
    import("../server/src/runtime/runtime-stream-protocol.ts"),
    import("../server/src/runtime/runtime-ipc.ts"),
    import("../server/src/identity/auth.ts"),
  ]);
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = providers;
const { RUNTIME_STREAM_PROTOCOL_VERSION } = streamProtocol;
const { RUNTIME_PROTOCOL_VERSION } = runtimeProtocol;
const { signup } = auth;

registerMockProvider();
const sock = path.join(os.tmpdir(), `oiia-stream-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {  }
const server = http.createServer();
attachRuntimeStreamHost(server);
await new Promise<void>((r) => server.listen(sock, () => r()));

const user = await signup(`stream-check-${process.pid}@gmail.com`, "password123");
const session = sessionManager.createSession(user, {
  provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request",
});
const liveRuntime = sessionManager.getRuntime(user.id, session.id)!;

function makeClient(): Promise<{ ws: WebSocket; next: (t?: number) => Promise<any> }> {
  const ws = new WebSocket(`ws+unix://${sock}:/runtime/stream`);
  const q: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(m);
    else q.push(m);
  });
  const next = (timeoutMs = 4000): Promise<any> =>
    new Promise((res, rej) => {
      if (q.length) return res(q.shift());
      const t = setTimeout(() => rej(new Error("stream message timeout")), timeoutMs);
      waiters.push((m) => { clearTimeout(t); res(m); });
    });
  return new Promise((res, rej) => { ws.once("open", () => res({ ws, next })); ws.once("error", rej); });
}

try {
  const { ws, next: nextMsg } = await makeClient();

  const hello = await nextMsg();
  assert.equal(hello.kind, "runtime_hello", "first frame is runtime_hello");
  assert.equal(hello.runtimeProtocolVersion, RUNTIME_PROTOCOL_VERSION, "hello runtime version");
  assert.equal(hello.streamProtocolVersion, RUNTIME_STREAM_PROTOCOL_VERSION, "hello stream version");

  ws.send(JSON.stringify({ kind: "ping", reqId: "p1" }));
  assert.deepEqual(await nextMsg(), { kind: "pong", reqId: "p1" }, "ping → pong");

  ws.send(JSON.stringify({ kind: "subscribe_session", reqId: "s1", userId: user.id, sessionId: session.id, replay: "always" }));
  const types: string[] = [];
  let ack: any = null;
  for (let i = 0; i < 30 && !ack; i++) {
    const m = await nextMsg();
    if (m.kind === "event") types.push(m.event.type);
    else if (m.kind === "ack" && m.reqId === "s1") ack = m;
  }
  assert.ok(ack, "subscribe acked"); assert.equal(ack.result.topic, "session", "ack topic=session");
  assert.equal(ack.result.sessionId, session.id, "ack sessionId");
  const iReplay = types.indexOf("timeline_replay");
  const iStatus = types.indexOf("session_status");
  const iCtx = types.indexOf("context_usage");
  assert.equal(iReplay, 0, "timeline_replay is first");
  assert.ok(iReplay < iStatus && iStatus < iCtx, `replay order timeline<status<context (got ${types.join(",")})`);

  ws.send(JSON.stringify({ kind: "subscribe_user_status", reqId: "u1", userId: user.id }));
  const statusEvents: any[] = [];
  let statusAck: any = null;
  for (let i = 0; i < 30 && !statusAck; i++) {
    const m = await nextMsg();
    if (m.kind === "event") statusEvents.push(m.event);
    else if (m.kind === "ack" && m.reqId === "u1") statusAck = m;
  }
  assert.ok(statusAck, "account status feed acked");
  const activitySnapshot = statusEvents.find((event) => event.type === "session_activity_snapshot");
  assert.ok(activitySnapshot, "account status feed includes an activity snapshot");
  assert.ok(Array.isArray(activitySnapshot.activities), "activity snapshot is bounded structured data");
  const orchestrationSnapshot = statusEvents.find((event) => event.type === "orchestration_invalidation_snapshot");
  assert.ok(orchestrationSnapshot, "account status feed includes the reconnect stale edge");
  assert.equal(orchestrationSnapshot.snapshot.stale, true);
  assert.equal(typeof orchestrationSnapshot.snapshot.activityRevision, "number");

  const runner = (liveRuntime as unknown as {
    createAgentOrchestrationRunner(): {
      spawn(input: { taskName: string; message: string; context: "none" }): Promise<unknown>;
    };
  }).createAgentOrchestrationRunner();
  await runner.spawn({ taskName: "stream_probe", message: "Reply with stream-probe", context: "none" });
  let invalidation: any = null;
  for (let i = 0; i < 30 && !invalidation; i++) {
    const m = await nextMsg();
    if (m.kind === "event" && m.event.type === "orchestration_invalidated") invalidation = m.event;
  }
  assert.ok(invalidation, "Agent mutation emits a lightweight invalidation over split stream");
  assert.deepEqual(
    { resource: invalidation.resource, sessionId: invalidation.sessionId },
    { resource: "session_run", sessionId: session.id },
  );
  assert.equal(typeof invalidation.revision, "number");
  assert.equal("payload" in invalidation, false);
  assert.equal("result" in invalidation, false);

  ws.send(JSON.stringify({ kind: "subscribe_session", reqId: "s2", userId: user.id, sessionId: "s_nope", replay: "always" }));
  let err: any = null;
  for (let i = 0; i < 30 && !err; i++) {
    const m = await nextMsg();
    if (m.kind === "error") err = m;
  }
  assert.ok(err, "unknown session → error"); assert.equal(err.code, "not_found", "code=not_found");

  ws.close();
  console.log("OK runtime-stream: hello + ping + subscribe replay order + not_found over unix socket");
} finally {
  server.close();
  try { fs.unlinkSync(sock); } catch {  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
