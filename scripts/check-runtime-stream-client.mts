import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerEvent } from "../shared/src/protocol.ts";

process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { attachRuntimeStreamHost } = await import("../server/src/runtime/runtime-stream-host.ts");
const { RuntimeStreamClient } = await import("../server/src/runtime/runtime-stream-client.ts");
const { RemoteSessionGateway } = await import("../server/src/runtime/session-gateway.ts");
const { RUNTIME_STREAM_PROTOCOL_VERSION } = await import("../server/src/runtime/runtime-stream-protocol.ts");
const { RUNTIME_PROTOCOL_VERSION } = await import("../server/src/runtime/runtime-ipc.ts");
const { signup } = await import("../server/src/identity/auth.ts");
const { agentTurnDao, pendingMessageDao, timelineDao } = await import("../server/src/persistence/index.ts");

assert.equal(RUNTIME_STREAM_PROTOCOL_VERSION, 5, "pending admission remains an additive v5 capability");

process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
  if (e?.code === "EPIPE") return;
  console.error(e);
  process.exit(1);
});

registerMockProvider();
const sock = path.join(os.tmpdir(), `oiia-streamcli-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {  }
const server = http.createServer();
attachRuntimeStreamHost(server);
await new Promise<void>((r) => server.listen(sock, () => r()));

const user = await signup(`streamcli-${process.pid}@gmail.com`, "password123");
const session = sessionManager.createSession(user, {
  provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request",
});
timelineDao.append(session.id, {
  kind: "team_assignment",
  id: "team_assignment_runtime_stream",
  seq: 1,
  taskId: "task_runtime_stream",
  title: "Verify runtime compatibility",
  ts: Date.now(),
});
const runtime = sessionManager.getRuntime(user.id, session.id);
assert.ok(runtime);

const events: ServerEvent[] = [];
let closedCode: number | null = null;
const client = new RuntimeStreamClient({
  socketPath: sock,
  onEvent: (ev) => events.push(ev),
  onClose: (code) => { closedCode = code; },
});

try {
  await client.whenReady();
  assert.equal(client.supportsPendingMutationAdmission(), true, "new runtime advertises typed pending admission");

  const { epoch } = await client.subscribeSession(user.id, session.id, "always");
  assert.ok(typeof epoch === "string" && epoch.length > 0, "subscribe returns an epoch");
  await new Promise((r) => setTimeout(r, 150));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("timeline_replay"), `replay relayed (got ${types.join(",")})`);
  assert.ok(events.some((event) => event.type === "timeline_replay"
    && event.items.some((item) => item.kind === "team_assignment")),
  "new web capability keeps Team assignment rows on the split stream");
  assert.ok(types.includes("session_status"), "session_status relayed");
  assert.ok(types.includes("context_usage"), "context_usage relayed");

  const oldPeerEnvelopes: Array<Record<string, unknown>> = [];
  const oldPeer = new WebSocket(`ws+unix://${sock}:/runtime/stream`, { perMessageDeflate: false });
  oldPeer.on("message", (raw) => {
    oldPeerEnvelopes.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  const waitForOldPeer = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("old runtime-stream peer timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitForOldPeer(() => oldPeerEnvelopes.some((envelope) => envelope.kind === "runtime_hello"));
  oldPeer.send(JSON.stringify({
    kind: "subscribe_session",
    reqId: "old-web-subscribe",
    userId: user.id,
    sessionId: session.id,
    replay: "always",
  }));
  await waitForOldPeer(() => oldPeerEnvelopes.some(
    (envelope) => envelope.kind === "ack" && envelope.reqId === "old-web-subscribe",
  ));
  const oldReplay = oldPeerEnvelopes.find((envelope) => {
    const event = envelope.event as ServerEvent | undefined;
    return envelope.kind === "event" && event?.type === "timeline_replay";
  })?.event as Extract<ServerEvent, { type: "timeline_replay" }> | undefined;
  assert.ok(oldReplay);
  assert.equal(oldReplay.items.some((item) => item.kind === "team_assignment"), false);
  (runtime as unknown as { emitAgent: (event: Record<string, unknown>) => void }).emitAgent({
    t: "team_assignment",
    id: "team_assignment_runtime_stream_live",
    seq: 2,
    taskId: "task_runtime_stream_live",
    title: "Verify live compatibility",
    ts: Date.now(),
    turnId: "turn_runtime_stream_live",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(oldPeerEnvelopes.some((envelope) => {
    const event = envelope.event as ServerEvent | undefined;
    return envelope.kind === "event" && event?.type === "agent_event"
      && event.event.t === "team_assignment";
  }), false);
  oldPeer.close();
  console.log("  ✓ old web ↔ new runtime: Team assignment replay/live frames stay capability-gated");

  pendingMessageDao.append(session.id, { id: "invalid-kind-row", kind: "queue", text: "safe", ts: Date.now() });
  let eventMark = events.length;
  const missingEpochResult = await client.setPendingText(user.id, session.id, "invalid-kind-row", "MUST_NOT_APPLY");
  assert.equal(missingEpochResult.ok, false, "runtime-first old-web mutation fails closed without authEpoch");
  if (!missingEpochResult.ok) assert.equal(missingEpochResult.code, "auth_revoked");
  assert.ok(events.slice(eventMark).some((event) => event.type === "pending_queue"),
    "missing authEpoch still publishes truth for an old web optimistic rollback");
  assert.equal(pendingMessageDao.byId(session.id, "invalid-kind-row")?.text, "safe");

  eventMark = events.length;
  await assert.rejects(
    client.submitMessage(user.id, session.id, "OLD_WEB_STALE_RUNNING", "steer"),
    /sign-in session changed/i,
  );
  assert.ok(events.slice(eventMark).some((event) => event.type === "pending_queue"),
    "old-web pending-mode submit heals its optimistic chip before fail-closed refusal");
  assert.equal(agentTurnDao.list(session.id).length, 0, "missing-epoch submit claims no Turn");

  const runtimeState = runtime as unknown as {
    status: string;
    currentTurnId: string | null;
    turnAcceptingSteer: boolean;
    turnAbort: AbortController | null;
  };
  runtimeState.status = "running";
  runtimeState.currentTurnId = "turn_old_web_fixture";
  runtimeState.turnAcceptingSteer = true;
  runtimeState.turnAbort = new AbortController();
  eventMark = events.length;
  await assert.rejects(
    client.submitMessage(user.id, session.id, "OLD_WEB_BUSY_STEER", "steer"),
    /sign-in session changed/i,
  );
  assert.ok(events.slice(eventMark).some((event) => event.type === "pending_queue"),
    "old-web busy pending submit receives truth before its fail-closed refusal");
  assert.equal(pendingMessageDao.listPending(session.id).some((pending) => pending.text === "OLD_WEB_BUSY_STEER"), false);
  runtimeState.status = "idle";
  runtimeState.currentTurnId = null;
  runtimeState.turnAcceptingSteer = false;
  runtimeState.turnAbort = null;

  await assert.rejects(
    client.setPendingKind(user.id, session.id, "invalid-kind-row", "invalid" as "queue", 0),
    /invalid pending message kind/,
  );
  assert.equal(pendingMessageDao.byId(session.id, "invalid-kind-row")?.kind, "queue");

  client.unsubscribeSession(user.id, session.id, true);
  await new Promise((r) => setTimeout(r, 50));

  sessionManager.setDraining();
  await assert.rejects(
    client.submitMessage(user.id, session.id, "MUST_NOT_START_AFTER_DRAIN", undefined, undefined, 0),
    /server is restarting/,
  );
  assert.equal(agentTurnDao.list(session.id).length, 0, "drain-rejected stream submit creates no Turn");
  assert.equal(
    timelineDao.list(session.id).some((item) => item.kind === "user"),
    false,
    "drain-rejected stream submit creates no user Message",
  );

  assert.equal(closedCode, null, "stream stayed open through the exchange");
  client.close();
  console.log("OK runtime-stream-client: handshake + replay/ack + authoritative drain rejection over unix socket");
} finally {
  client.close();
  sessionManager.disposeUserRuntimes(user.id);
  server.close();
  try { fs.unlinkSync(sock); } catch {  }
}

const oldSock = path.join(os.tmpdir(), `oiia-streamcli-old-${process.pid}.sock`);
try { fs.unlinkSync(oldSock); } catch {  }
const oldServer = http.createServer();
const oldWss = new WebSocketServer({ noServer: true });
oldServer.on("upgrade", (request, socket, head) => {
  oldWss.handleUpgrade(request, socket, head, (webSocket) => oldWss.emit("connection", webSocket, request));
});
let receivedMutation = false;
let legacyReplayCarriedCursor = false;
oldWss.on("connection", (webSocket) => {
  webSocket.send(JSON.stringify({
    kind: "runtime_hello",
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    streamProtocolVersion: RUNTIME_STREAM_PROTOCOL_VERSION,
    ts: Date.now(),
  }));
  webSocket.on("message", (raw) => {
    const command = JSON.parse(raw.toString()) as { kind: string; reqId: string; resume?: unknown };
    if (command.kind === "set_pending_kind") {
      receivedMutation = true;
      webSocket.send(JSON.stringify({
        kind: "event",
        event: {
          type: "pending_queue",
          sessionId: "legacy-session",
          epoch: "legacy-epoch",
          version: 1,
          pending: [{ id: "p1", kind: "steer", text: "legacy applied", ts: 1, ord: 1 }],
        },
      }));
      webSocket.send(JSON.stringify({ kind: "ack", reqId: command.reqId, result: { found: true } }));
      return;
    }
    if (command.kind === "subscribe_session") {
      webSocket.send(JSON.stringify({
        kind: "ack",
        reqId: command.reqId,
        result: { topic: "session", sessionId: "legacy-session", epoch: "legacy-epoch" },
      }));
      return;
    }
    if (command.kind === "replay_session") {
      legacyReplayCarriedCursor = command.resume !== undefined;
      webSocket.send(JSON.stringify({
        kind: "event",
        event: {
          type: "timeline_replay",
          sessionId: "legacy-session",
          epoch: "legacy-epoch",
          version: 1,
          items: [],
          pending: [{ id: "p1", kind: "steer", text: "legacy applied", ts: 1, ord: 1 }],
        },
      }));
      webSocket.send(JSON.stringify({
        kind: "ack",
        reqId: command.reqId,
        result: {
          topic: "session",
          sessionId: "legacy-session",
          epoch: "legacy-epoch",
          replayProfile: { replayed: true, snapshotReadMs: 0, timelineItems: 0 },
        },
      }));
    }
  });
});
await new Promise<void>((resolve) => oldServer.listen(oldSock, resolve));
const legacyEvents: ServerEvent[] = [];
const oldClient = new RuntimeStreamClient({
  socketPath: oldSock,
  onEvent: (event) => legacyEvents.push(event),
  onClose: () => {},
});
try {
  await oldClient.whenReady();
  assert.equal(oldClient.supportsPendingMutationAdmission(), false, "capability is read only from old hello");
  assert.deepEqual(
    await oldClient.setPendingKind("legacy-user", "legacy-session", "p1", "steer", 0),
    { ok: true },
    "legacy ack normalizes to compatible success",
  );
  assert.equal(receivedMutation, true, "new web still sends the mutation command to old runtime");
  assert.equal(
    legacyEvents.find((event) => event.type === "pending_queue")?.type,
    "pending_queue",
    "old runtime snapshot reaches new web",
  );
  console.log("  ✓ new web ↔ old v5 runtime: command + snapshot + legacy ack remain compatible");
} finally {
  oldClient.close();
}

const legacyGatewayEvents: ServerEvent[] = [];
const legacyGateway = new RemoteSessionGateway(
  "legacy-user",
  (event) => legacyGatewayEvents.push(event),
  () => {},
  oldSock,
  0,
);
try {
  assert.equal(await legacyGateway.ensureSubscribed("legacy-session"), true);
  await legacyGateway.replaySubscribed("legacy-session", { epoch: "legacy-epoch", version: 1 });
  assert.equal(legacyReplayCarriedCursor, false, "cap=false omits cursor and forces legacy full replay");
  assert.ok(legacyGatewayEvents.some((event) => event.type === "timeline_replay"));
  console.log("  ✓ old v5 runtime cursor hit is forced through full replay");
} finally {
  legacyGateway.close();
  oldWss.close();
  await new Promise<void>((resolve) => oldServer.close(() => resolve()));
  try { fs.unlinkSync(oldSock); } catch {  }
}
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
