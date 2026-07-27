import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-pending-admission-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";
process.env.AGENT_WEB_SECRET = "pending-admission-check-secret";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";
process.env.AGENT_WEB_RESEND_KEY = "test-key";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.invalid>";

const [{ AgentSessionRuntime }, persistence, providers, gatewayModule, streamHost, emailVerify, ban, auth, browserWs] = await Promise.all([
  import("../server/src/runtime/agent-session.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/runtime/providers.ts"),
  import("../server/src/runtime/session-gateway.ts"),
  import("../server/src/runtime/runtime-stream-host.ts"),
  import("../server/src/identity/email-verify.ts"),
  import("../server/src/identity/ban.ts"),
  import("../server/src/identity/auth.ts"),
  import("../server/src/transport/ws-server.ts"),
]);
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const {
  db,
  agentTurnDao,
  messageDao,
  pendingMessageDao,
  sessionDao,
  timelineDao,
  userDao,
} = persistence;
const { LocalSessionGateway, RemoteSessionGateway } = gatewayModule;
providers.registerMockProvider();

import type { SessionRow } from "../server/src/persistence/index.ts";
import type { PendingMutationResult, ServerEvent } from "../shared/src/protocol.ts";
import type { SessionGateway } from "../server/src/runtime/session-gateway.ts";

let serial = 0;
function createUser(prefix: string): { id: string; email: string } {
  const id = `${prefix}_${++serial}`;
  const email = `${id}@example.invalid`;
  userDao.create({ id, email, password_hash: "x", created_at: Date.now() });
  return { id, email };
}

function createSession(userId: string, prefix: string): SessionRow {
  const now = Date.now();
  const row: SessionRow = {
    id: `${prefix}_${++serial}`,
    user_id: userId,
    title: "pending admission check",
    provider: providers.MOCK_PROVIDER,
    model: providers.MOCK_MODEL_ID,
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
  messageDao.replaceAll(row.id, []);
  return row;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), message);
}

function assertDenied(result: PendingMutationResult, code: "suspended" | "email_verification_required" | "draining"): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
}

async function waitForChildLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes(expected)) reject(new Error(`ban writer exited ${code}: ${output}`));
    });
  });
}

function spawnEpochWriter(userId: string, epoch: number, holdMs = 750): ReturnType<typeof spawn> {
  return spawn(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
db.prepare("UPDATE users SET password_changed_at = ? WHERE id = ?").run(Number(process.argv[3]), process.argv[2]);
process.stdout.write("epoch-locked\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[4]));`,
    path.join(tmp, "agent-web.db"),
    userId,
    String(epoch),
    String(holdMs),
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

const sock = path.join(os.tmpdir(), `oiia-pending-admission-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {  }
const server = http.createServer();
const wss = streamHost.attachRuntimeStreamHost(server);
await new Promise<void>((resolve) => server.listen(sock, resolve));

type GatewayFactory = (userId: string, onEvent: (event: ServerEvent) => void) => SessionGateway;
const gateways: Array<[string, GatewayFactory]> = [
  ["monolith", (userId, onEvent) => new LocalSessionGateway(userId, onEvent, 0)],
  ["split", (userId, onEvent) => new RemoteSessionGateway(userId, onEvent, () => {}, sock, 0)],
];

try {
  for (const [topology, makeGateway] of gateways) {
    const user = createUser(`u_${topology}`);
    const row = createSession(user.id, `s_${topology}`);
    const events: ServerEvent[] = [];
    const gateway = makeGateway(user.id, (event) => events.push(event));
    assert.equal(await gateway.ensureSubscribed(row.id), true);
    await gateway.replaySubscribed(row.id);
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);

    process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "350";
    const first = runtime.sendMessage(`/write ${topology}.txt\nfirst Turn`);
    await waitFor(() => runtime.canSteer(), `${topology}: first Turn becomes steerable`);
    await runtime.queueFollowUp(`DEFERRED_${topology}`);
    const queued = pendingMessageDao.listPending(row.id).find((pending) => pending.kind === "queue");
    assert.ok(queued);

    runtime.suspendQueuedTurnsForDrain();
    const eventMark = events.length;
    const denied = await gateway.setPendingKind(row.id, queued.id, "steer");
    assertDenied(denied, "draining");
    const refusalEvents = events.slice(eventMark);
    const truth = refusalEvents.findLast((event): event is Extract<ServerEvent, { type: "pending_queue" }> =>
      event.type === "pending_queue");
    assert.equal(truth?.pending.find((pending) => pending.id === queued.id)?.kind, "queue",
      `${topology}: refusal emits authoritative queue truth`);
    assert.equal(pendingMessageDao.byId(row.id, queued.id)?.kind, "queue");

    await first;
    assert.deepEqual(
      timelineDao.list(row.id).filter((item) => item.kind === "user").map((item) => item.text),
      [`/write ${topology}.txt\nfirst Turn`],
      `${topology}: denied queue never enters the active Turn`,
    );
    assert.equal(pendingMessageDao.byId(row.id, queued.id)?.kind, "queue");

    const reconnectMark = events.length;
    await gateway.replaySubscribed(row.id, {
      epoch: runtime.getEpoch(),
      version: runtime.getTimelineVersion(),
    });
    const reconnectFrames = events.slice(reconnectMark);
    assert.equal(reconnectFrames.some((event) => event.type === "timeline_replay"), false,
      `${topology}: matching cursor elides heavy Timeline`);
    assert.equal(
      reconnectFrames.find((event): event is Extract<ServerEvent, { type: "pending_queue" }> =>
        event.type === "pending_queue")?.pending.find((pending) => pending.id === queued.id)?.kind,
      "queue",
      `${topology}: cursor hit still repairs pending truth`,
    );

    gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    sessionManager.releaseIfIdle(user.id, row.id);
    process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
    const replacement = sessionManager.getRuntime(user.id, row.id);
    assert.ok(replacement && replacement !== runtime, `${topology}: replacement runtime is fresh`);
    await waitFor(
      () => pendingMessageDao.listPending(row.id).length === 0 && !replacement.isBusy(),
      `${topology}: replacement consumes the durable queue`,
    );
    const turns = agentTurnDao.list(row.id);
    assert.deepEqual(turns.map((turn) => turn.status), ["completed", "completed"]);
    const users = timelineDao.list(row.id).filter((item) => item.kind === "user");
    assert.deepEqual(users.map((item) => item.text), [
      `/write ${topology}.txt\nfirst Turn`,
      `DEFERRED_${topology}`,
    ]);
    assert.notEqual(users[0].turnId, users[1].turnId, `${topology}: replacement starts a fresh Agent Turn`);
    sessionManager.releaseIfIdle(user.id, row.id);
    console.log(`  ✓ ${topology}: typed drain refusal, snapshot recovery, no injection, replacement resume`);
  }

  for (const [topology, makeGateway] of gateways) {
    const user = createUser(`u_settle_${topology}`);
    const row = createSession(user.id, `s_settle_${topology}`);
    const events: ServerEvent[] = [];
    const gateway = makeGateway(user.id, (event) => events.push(event));
    assert.equal(await gateway.ensureSubscribed(row.id), true);
    const mark = events.length;
    assert.equal(await gateway.submitMessage(row.id, `SETTLED_${topology}`, "steer", `settle-${topology}`), true);
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);
    await waitFor(
      () => !runtime.isBusy() && timelineDao.list(row.id).some((item) => item.kind === "user" && item.text === `SETTLED_${topology}`),
      `${topology}: stale-running request completes as fresh Turn`,
    );
    const frames = events.slice(mark);
    const snapshotIndex = frames.findIndex((event) => event.type === "pending_queue");
    const userIndex = frames.findIndex((event) =>
      event.type === "agent_event" && event.event.t === "user_message" && event.event.text === `SETTLED_${topology}`);
    assert.ok(snapshotIndex >= 0 && userIndex > snapshotIndex,
      `${topology}: authoritative empty pending snapshot clears the chip before the real Message`);
    gateway.close();
    sessionManager.disposeUserRuntimes(user.id);
  }
  console.log("  ✓ local/split status-settle race: stale pending mode converges before fresh Message");

  {
    const user = createUser("u_claimed");
    const row = createSession(user.id, "s_claimed");
    const runtime = new AgentSessionRuntime(row);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      currentQueuedPendingId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
    };
    state.status = "running";
    state.currentTurnId = "turn_claimed_harness";
    state.currentQueuedPendingId = "claimed";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    pendingMessageDao.append(row.id, { id: "claimed", kind: "queue", text: "claimed", ts: Date.now() });
    pendingMessageDao.append(row.id, { id: "later-1", kind: "queue", text: "later one", ts: Date.now() });
    pendingMessageDao.append(row.id, { id: "later-2", kind: "queue", text: "later two", ts: Date.now() });

    assert.throws(
      () => pendingMessageDao.setKindById(row.id, "later-1", "invalid" as "queue"),
      /invalid pending message kind/,
      "DAO rejects an invalid kind before SQLite",
    );
    assert.throws(
      () => db.prepare("UPDATE pending_messages SET kind = 'invalid' WHERE session_id = ? AND id = ?")
        .run(row.id, "later-1"),
      /invalid pending message kind/,
      "schema trigger rejects an invalid kind on existing databases",
    );

    assert.deepEqual(runtime.reorderPending(["later-1", "claimed", "later-2"]), { ok: true });
    assert.deepEqual(
      pendingMessageDao.listPending(row.id).map((pending) => pending.id),
      ["claimed", "later-1", "later-2"],
      "no later row can cross the active claim",
    );
    assert.deepEqual(runtime.reorderPending(["claimed", "later-2", "later-1"]), { ok: true });
    assert.deepEqual(
      pendingMessageDao.listPending(row.id).map((pending) => pending.id),
      ["claimed", "later-2", "later-1"],
      "the unclaimed suffix remains reorderable",
    );
    state.status = "idle";
    state.currentTurnId = null;
    state.currentQueuedPendingId = null;
    state.turnAcceptingSteer = false;
    state.turnAbort = null;
    runtime.close();
    console.log("  ✓ claimed queue prefix is immutable while its unclaimed suffix remains reorderable");
  }

  {
    const user = createUser("u_pi_rollback");
    const row = createSession(user.id, "s_pi_rollback");
    const runtime = new AgentSessionRuntime(row);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
      agent: {
        steer: (message: unknown) => void;
        clearSteeringQueue: () => void;
        hasQueuedMessages: () => boolean;
      };
    };
    state.status = "running";
    state.currentTurnId = "turn_pi_rollback_harness";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    pendingMessageDao.append(row.id, { id: "s1", kind: "steer", text: "steer one", ts: Date.now() });
    pendingMessageDao.append(row.id, { id: "s2", kind: "steer", text: "steer two", ts: Date.now() });
    state.agent.steer({ role: "user", content: "steer one", timestamp: Date.now() });
    state.agent.steer({ role: "user", content: "steer two", timestamp: Date.now() });

    const originalSteer = state.agent.steer.bind(state.agent);
    const restored: string[] = [];
    let failFirstRebuild = true;
    state.agent.steer = (message) => {
      if (failFirstRebuild) {
        failFirstRebuild = false;
        throw new Error("pi rebuild fixture");
      }
      restored.push((message as { content: string }).content);
      originalSteer(message);
    };
    const failedEdit = runtime.setPendingText("s1", "changed steer");
    assert.equal(failedEdit.ok, false);
    if (!failedEdit.ok) assert.equal(failedEdit.code, "pending_mutation_failed");
    state.agent.steer = originalSteer;
    assert.equal(pendingMessageDao.byId(row.id, "s1")?.text, "steer one", "pi failure rolls back DB text");
    assert.deepEqual(restored, ["steer one", "steer two"], "pi failure restores prior steering bytes in FIFO order");
    assert.equal(state.agent.hasQueuedMessages(), true, "restored pi steering remains executable");

    let failClearRebuild = true;
    state.agent.steer = (message) => {
      if (failClearRebuild) {
        failClearRebuild = false;
        throw new Error("clear rebuild fixture");
      }
      originalSteer(message);
    };
    const failedClear = runtime.clearPending("s1");
    state.agent.steer = originalSteer;
    assert.equal(failedClear.ok, false);
    if (!failedClear.ok) assert.equal(failedClear.code, "pending_mutation_failed");
    assert.ok(pendingMessageDao.byId(row.id, "s1"), "failed clear rolls its durable delete back");
    assert.equal(state.agent.hasQueuedMessages(), true, "failed clear restores prior pi steering");

    const sqlite = db as unknown as { exec: (sql: string) => void };
    const originalExec = sqlite.exec.bind(sqlite);
    let failCommit = true;
    sqlite.exec = (sql) => {
      if (failCommit && sql === "COMMIT") {
        failCommit = false;
        originalExec("ROLLBACK");
        throw new Error("commit fault fixture");
      }
      originalExec(sql);
    };
    const failedCommit = runtime.setPendingText("s1", "commit must roll back");
    sqlite.exec = originalExec;
    assert.equal(failedCommit.ok, false);
    if (!failedCommit.ok) assert.equal(failedCommit.code, "pending_mutation_failed");
    assert.equal(pendingMessageDao.byId(row.id, "s1")?.text, "steer one", "COMMIT fault restores DB truth");
    assert.equal(state.agent.hasQueuedMessages(), true, "COMMIT fault restores pi steering");

    const originalClear = state.agent.clearSteeringQueue.bind(state.agent);
    let livePi: string[] = [];
    state.agent.clearSteeringQueue = () => {
      livePi = [];
      originalClear();
    };
    state.agent.steer = (message) => {
      livePi.push((message as { content: string }).content);
      originalSteer(message);
    };

    const unsubscribeThrower = runtime.subscribe(() => { throw new Error("publish fixture"); });
    assert.deepEqual(runtime.setPendingText("s1", "publish already committed"), { ok: true });
    unsubscribeThrower();
    assert.equal(pendingMessageDao.byId(row.id, "s1")?.text, "publish already committed");
    assert.deepEqual(livePi, ["publish already committed", "steer two"],
      "post-COMMIT publication failure leaves DB and pi on the same state");

    let loseCommitAck = true;
    sqlite.exec = (sql) => {
      if (loseCommitAck && sql === "COMMIT") {
        loseCommitAck = false;
        originalExec("COMMIT");
        throw new Error("commit acknowledgement lost fixture");
      }
      originalExec(sql);
    };
    const committedDespiteError = runtime.setPendingText("s1", "commit actually applied");
    sqlite.exec = originalExec;
    assert.equal(committedDespiteError.ok, false);
    if (!committedDespiteError.ok) assert.equal(committedDespiteError.code, "pending_mutation_failed");
    assert.equal(pendingMessageDao.byId(row.id, "s1")?.text, "commit actually applied");
    assert.deepEqual(pendingMessageDao.listPending(row.id).map((pending) => pending.kind), ["queue", "queue"],
      "unknown COMMIT outcome downgrades every durable steer");
    assert.equal(state.agent.hasQueuedMessages(), false, "unknown COMMIT outcome clears old pi instructions");
    assert.equal(runtime.canSteer(), false, "unknown COMMIT outcome quarantines the runtime");
    state.agent.clearSteeringQueue = originalClear;
    state.agent.steer = originalSteer;

    state.status = "idle";
    state.currentTurnId = null;
    state.turnAcceptingSteer = false;
    state.turnAbort = null;
    runtime.close();
    console.log("  ✓ pi/clear/COMMIT fault matrix: rollback restores; unknown outcome quarantines; observer stays fail-open");
  }

  {
    const user = createUser("u_post_commit_poke");
    const row = createSession(user.id, "s_post_commit_poke");
    const runtime = new AgentSessionRuntime(row);
    const state = runtime as unknown as {
      agentSupervisor: { poke: () => void };
    };
    const originalPoke = state.agentSupervisor.poke.bind(state.agentSupervisor);
    let pokeFaults = 0;
    state.agentSupervisor.poke = () => {
      pokeFaults += 1;
      throw new Error("post-COMMIT poke fixture");
    };
    await runtime.sendMessage("first survives a scheduling hint fault");
    state.agentSupervisor.poke = originalPoke;
    await runtime.sendMessage("second proves the runtime is reusable");
    assert.equal(pokeFaults, 1);
    assert.equal(runtime.isBusy(), false);
    assert.equal(sessionDao.byId(row.id)?.status, "idle");
    assert.deepEqual(agentTurnDao.list(row.id).map((turn) => turn.status), ["completed", "completed"]);
    assert.deepEqual(
      timelineDao.list(row.id).filter((item) => item.kind === "user").map((item) => item.text),
      ["first survives a scheduling hint fault", "second proves the runtime is reusable"],
    );
    runtime.close();
    console.log("  ✓ post-COMMIT supervisor hint fault: accepted Turn settles and runtime remains reusable");
  }

  {
    const user = createUser("u_post_commit_listener");
    const row = createSession(user.id, "s_post_commit_listener");
    const runtime = new AgentSessionRuntime(row);
    let listenerFaults = 0;
    const observed: ServerEvent[] = [];
    const unsubscribeThrower = runtime.subscribe(() => {
      listenerFaults += 1;
      throw new Error("post-COMMIT listener fixture");
    });
    const unsubscribeObserver = runtime.subscribe((event) => observed.push(event));
    await runtime.sendMessage("first survives a transport observer fault");
    unsubscribeThrower();
    assert.ok(listenerFaults > 0, "fault injection reached the real subscriber boundary");
    assert.ok(observed.some((event) => event.type === "agent_event" && event.event.t === "turn_end"),
      "a broken subscriber cannot starve a healthy subscriber");
    await runtime.sendMessage("second proves listener failure did not strand busy state");
    unsubscribeObserver();
    assert.equal(runtime.isBusy(), false);
    assert.equal(sessionDao.byId(row.id)?.status, "idle");
    assert.deepEqual(agentTurnDao.list(row.id).map((turn) => turn.status), ["completed", "completed"]);
    runtime.close();
    console.log("  ✓ post-COMMIT subscriber fault: healthy observer, durable Turn, and reuse all survive");
  }

  {
    const user = createUser("u_pi_fail_closed");
    const row = createSession(user.id, "s_pi_fail_closed");
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
      agent: {
        steer: (message: unknown) => void;
        hasQueuedMessages: () => boolean;
      };
    };
    state.status = "running";
    state.currentTurnId = "turn_pi_fail_closed";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    pendingMessageDao.append(row.id, { id: "fatal-s1", kind: "steer", text: "never execute one", ts: Date.now() });
    pendingMessageDao.append(row.id, { id: "fatal-s2", kind: "steer", text: "never execute two", ts: Date.now() });
    const originalSteer = state.agent.steer.bind(state.agent);
    originalSteer({ role: "user", content: "never execute one", timestamp: Date.now() });
    originalSteer({ role: "user", content: "never execute two", timestamp: Date.now() });
    state.agent.steer = () => { throw new Error("pi restore also failed"); };
    const events: ServerEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const result = runtime.setPendingText("fatal-s1", "changed bytes");
    state.agent.steer = originalSteer;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "pending_mutation_failed");
    assert.deepEqual(pendingMessageDao.listPending(row.id).map((pending) => pending.kind), ["queue", "queue"]);
    assert.equal(state.agent.hasQueuedMessages(), false, "quarantine removes every old pi instruction");
    assert.equal(runtime.canSteer(), false, "quarantined runtime exposes no consume point");
    assert.equal(events.at(-1)?.type, "pending_queue", "fail-closed downgrade emits authoritative truth");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const managerState = sessionManager as unknown as { runtimes: Map<string, AgentSessionRuntime> };
    assert.equal(managerState.runtimes.has(row.id), false, "manager removes the exact poisoned runtime");
    assert.ok(events.some((event) => event.type === "session_status" && event.status !== "running"),
      "existing subscriber receives recovered status before isolation detaches it");
    console.log("  ✓ failed pi recovery downgrades durable steers and quarantines old instructions");
  }

  {
    const user = createUser("u_browser_compat");
    const row = createSession(user.id, "s_browser_compat");
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
    };
    state.status = "running";
    state.currentTurnId = "turn_browser_compat";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    pendingMessageDao.append(row.id, { id: "compat-q", kind: "queue", text: "compat queue", ts: Date.now() });
    runtime.suspendQueuedTurnsForDrain();

    const browserWss = browserWs.createWebSocketServer();
    const browserServer = http.createServer();
    browserServer.on("upgrade", (request, socket, head) => {
      browserWss.handleUpgrade(request, socket, head, (webSocket) => browserWss.emit("connection", webSocket, request));
    });
    await new Promise<void>((resolve) => browserServer.listen(0, "127.0.0.1", resolve));
    const address = browserServer.address();
    assert.ok(address && typeof address === "object");

    const connect = async (protocolVersion: number) => {
      const frames: ServerEvent[] = [];
      const webSocket = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(auth.issueToken(user))}&protocolVersion=${protocolVersion}`,
      );
      webSocket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as ServerEvent));
      await waitFor(() => frames.some((event) => event.type === "hello"), `browser v${protocolVersion} hello`);
      webSocket.send(JSON.stringify({ type: "subscribe", reqId: `sub-${protocolVersion}`, sessionId: row.id }));
      await waitFor(
        () => frames.some((event) => event.type === "ack" && event.reqId === `sub-${protocolVersion}`),
        `browser v${protocolVersion} subscribe`,
      );
      return { webSocket, frames };
    };

    const oldBrowser = await connect(5);
    let mark = oldBrowser.frames.length;
    oldBrowser.webSocket.send(JSON.stringify({
      type: "set_pending_kind",
      reqId: "mut-v5",
      sessionId: row.id,
      pendingId: "compat-q",
      kind: "steer",
    }));
    await waitFor(() => oldBrowser.frames.some((event) => event.type === "ack" && event.reqId === "mut-v5"), "v5 mutation ack");
    const oldMutationFrames = oldBrowser.frames.slice(mark);
    assert.ok(oldMutationFrames.some((event) => event.type === "pending_queue"), "v5 receives recovery snapshot");
    assert.equal(oldMutationFrames.some((event) => event.type === "error"), false, "v5 never receives typed refusal");
    mark = oldBrowser.frames.length;
    oldBrowser.webSocket.send(JSON.stringify({
      type: "send_message",
      reqId: "submit-drain-v5",
      sessionId: row.id,
      text: "OLD_TAB_MUST_NOT_KEEP_A_GHOST",
      mode: "steer",
    }));
    await waitFor(
      () => oldBrowser.frames.some((event) => event.type === "ack" && event.reqId === "submit-drain-v5"),
      "v5 busy submit downgrade ack",
    );
    const oldSubmitFrames = oldBrowser.frames.slice(mark);
    assert.ok(oldSubmitFrames.some((event) => event.type === "pending_queue"),
      "v5 busy submit receives recovery snapshot");
    assert.equal(oldSubmitFrames.some((event) => event.type === "error"), false,
      "v5 busy submit never receives a typed refusal");
    const oldClosed = new Promise<void>((resolve) => oldBrowser.webSocket.once("close", () => resolve()));
    oldBrowser.webSocket.close();
    await oldClosed;

    const newBrowser = await connect(6);
    newBrowser.webSocket.send(JSON.stringify({
      type: "set_pending_kind",
      reqId: "mut-invalid-kind",
      sessionId: row.id,
      pendingId: "compat-q",
      kind: "invalid",
    }));
    await waitFor(
      () => newBrowser.frames.some((event) => event.type === "error" && event.reqId === "mut-invalid-kind"),
      "invalid browser pending kind rejection",
    );
    assert.equal(pendingMessageDao.byId(row.id, "compat-q")?.kind, "queue");
    mark = newBrowser.frames.length;
    newBrowser.webSocket.send(JSON.stringify({
      type: "set_pending_kind",
      reqId: "mut-v6",
      sessionId: row.id,
      pendingId: "compat-q",
      kind: "steer",
    }));
    await waitFor(
      () => newBrowser.frames.some((event) => event.type === "error" && event.reqId === "mut-v6"),
      "v6 typed mutation refusal",
    );
    const newMutationFrames = newBrowser.frames.slice(mark);
    assert.ok(newMutationFrames.some((event) => event.type === "pending_queue"), "v6 receives recovery snapshot");
    const typed = newMutationFrames.find((event): event is Extract<ServerEvent, { type: "error" }> =>
      event.type === "error" && event.reqId === "mut-v6");
    assert.equal(typed?.code, "draining");
    mark = newBrowser.frames.length;
    newBrowser.webSocket.send(JSON.stringify({
      type: "send_message",
      reqId: "submit-drain-v6",
      sessionId: row.id,
      text: "MUST_NOT_BECOME_OPTIMISTIC_GHOST",
      mode: "steer",
    }));
    await waitFor(
      () => newBrowser.frames.some((event) => event.type === "error" && event.reqId === "submit-drain-v6"),
      "busy submit drain refusal",
    );
    const busySubmitFrames = newBrowser.frames.slice(mark);
    const busySnapshotIndex = busySubmitFrames.findIndex((event) => event.type === "pending_queue");
    const busyErrorIndex = busySubmitFrames.findIndex((event) =>
      event.type === "error" && event.reqId === "submit-drain-v6");
    assert.ok(busySnapshotIndex >= 0 && busyErrorIndex > busySnapshotIndex,
      "busy send_message publishes truth before typed drain refusal");
    const busyRefusal = busySubmitFrames[busyErrorIndex] as Extract<ServerEvent, { type: "error" }>;
    assert.equal(busyRefusal.code, "draining");
    assert.equal(pendingMessageDao.listPending(row.id).some((pending) =>
      pending.text === "MUST_NOT_BECOME_OPTIMISTIC_GHOST"), false);
    const newClosed = new Promise<void>((resolve) => newBrowser.webSocket.once("close", () => resolve()));
    newBrowser.webSocket.close();
    await newClosed;

    state.status = "idle";
    state.currentTurnId = null;
    state.turnAcceptingSteer = false;
    state.turnAbort = null;
    sessionManager.disposeUserRuntimes(user.id);
    browserWss.close();
    await new Promise<void>((resolve) => browserServer.close(() => resolve()));
    console.log("  ✓ real browser WS: v5 snapshot+ack downgrade; v6 snapshot+typed refusal");
  }

  {
    const user = createUser("u_auth_ws");
    const row = createSession(user.id, "s_auth_ws");
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
      agent: { steer: (message: unknown) => void };
    };
    state.status = "running";
    state.currentTurnId = "turn_auth_ws";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    pendingMessageDao.append(row.id, { id: "auth-steer", kind: "steer", text: "original", ts: Date.now() });
    state.agent.steer({ role: "user", content: "original", timestamp: Date.now() });

    const browserWss = browserWs.createWebSocketServer();
    const browserServer = http.createServer();
    browserServer.on("upgrade", (request, socket, head) => {
      browserWss.handleUpgrade(request, socket, head, (webSocket) => browserWss.emit("connection", webSocket, request));
    });
    await new Promise<void>((resolve) => browserServer.listen(0, "127.0.0.1", resolve));
    const address = browserServer.address();
    assert.ok(address && typeof address === "object");
    const frames: ServerEvent[] = [];
    const webSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(auth.issueToken(user))}&protocolVersion=6`,
    );
    webSocket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as ServerEvent));
    await waitFor(() => frames.some((event) => event.type === "hello"), "auth-race browser hello");
    webSocket.send(JSON.stringify({ type: "subscribe", reqId: "auth-sub", sessionId: row.id }));
    await waitFor(() => frames.some((event) => event.type === "ack" && event.reqId === "auth-sub"), "auth-race subscribe");

    const originalSteer = state.agent.steer.bind(state.agent);
    let failBrowserRebuild = true;
    state.agent.steer = (message) => {
      if (failBrowserRebuild) {
        failBrowserRebuild = false;
        throw new Error("browser pi rebuild fixture");
      }
      originalSteer(message);
    };
    let mark = frames.length;
    webSocket.send(JSON.stringify({
      type: "set_pending_text",
      reqId: "pi-fault-mutate",
      sessionId: row.id,
      pendingId: "auth-steer",
      text: "MUST_ROLL_BACK",
    }));
    await waitFor(
      () => frames.some((event) => event.type === "error" && event.reqId === "pi-fault-mutate"),
      "browser pi failure response",
    );
    state.agent.steer = originalSteer;
    const piFailureFrames = frames.slice(mark);
    const piSnapshotIndex = piFailureFrames.findIndex((event) => event.type === "pending_queue");
    const piErrorIndex = piFailureFrames.findIndex((event) => event.type === "error" && event.reqId === "pi-fault-mutate");
    assert.ok(piSnapshotIndex >= 0 && piErrorIndex > piSnapshotIndex, "pi recovery snapshot precedes correlated failure");
    assert.equal((piFailureFrames[piErrorIndex] as Extract<ServerEvent, { type: "error" }>).code, "pending_mutation_failed");
    assert.equal(pendingMessageDao.byId(row.id, "auth-steer")?.text, "original");

    const writer = spawnEpochWriter(user.id, 1);
    const writerExit = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`epoch writer exited ${code}`)));
    });
    await waitForChildLine(writer, "epoch-locked");
    mark = frames.length;
    webSocket.send(JSON.stringify({
      type: "set_pending_text",
      reqId: "auth-mutate",
      sessionId: row.id,
      pendingId: "auth-steer",
      text: "MUST_NOT_APPLY",
    }));
    await waitFor(
      () => frames.some((event) => event.type === "error" && event.reqId === "auth-mutate"),
      "auth-race typed refusal",
      3_000,
    );
    await writerExit;
    const mutationFrames = frames.slice(mark);
    const snapshotIndex = mutationFrames.findIndex((event) => event.type === "pending_queue");
    const errorIndex = mutationFrames.findIndex((event) => event.type === "error" && event.reqId === "auth-mutate");
    assert.ok(snapshotIndex >= 0 && errorIndex > snapshotIndex, "authoritative pending truth precedes auth refusal");
    const refusal = mutationFrames[errorIndex] as Extract<ServerEvent, { type: "error" }>;
    assert.equal(refusal.code, "auth_revoked");
    assert.equal(pendingMessageDao.byId(row.id, "auth-steer")?.text, "original");
    const closed = new Promise<void>((resolve) => webSocket.once("close", () => resolve()));
    webSocket.close();
    await closed;
    state.status = "idle";
    state.currentTurnId = null;
    state.turnAcceptingSteer = false;
    state.turnAbort = null;
    sessionManager.disposeUserRuntimes(user.id);
    browserWss.close();
    await new Promise<void>((resolve) => browserServer.close(() => resolve()));
    console.log("  ✓ real browser WS + second SQLite: pwc commit wins before pending CAS");
  }

  {
    const user = createUser("u_auth_local_submit");
    const row = createSession(user.id, "s_auth_local_submit");
    const events: ServerEvent[] = [];
    const gateway = new LocalSessionGateway(user.id, (event) => events.push(event), 0);
    assert.equal(await gateway.ensureSubscribed(row.id), true);
    const writer = spawnEpochWriter(user.id, 1);
    const writerExit = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`epoch writer exited ${code}`)));
    });
    await waitForChildLine(writer, "epoch-locked");
    assert.equal(await gateway.submitMessage(row.id, "MUST_NOT_START", undefined, "local-submit-stale"), false);
    await writerExit;
    const refusal = events.find((event) => event.type === "error" && event.reqId === "local-submit-stale");
    assert.ok(refusal?.type === "error");
    assert.equal(refusal.sessionId, row.id);
    assert.equal(refusal.code, undefined, "fresh-Turn refusal has no pending-state result code");
    assert.equal(agentTurnDao.list(row.id).length, 0, "stale local submit creates no Agent Turn");
    assert.equal(sessionDao.byId(row.id)?.status, "idle");
    gateway.close();
    sessionManager.disposeUserRuntimes(user.id);
    console.log("  ✓ local submit_message + second SQLite: stale pwc cannot claim a Turn");
  }

  {
    const user = createUser("u_auth_split_fresh");
    const row = createSession(user.id, "s_auth_split_fresh");
    const events: ServerEvent[] = [];
    const gateway = new RemoteSessionGateway(user.id, (event) => events.push(event), () => {}, sock, 0);
    assert.equal(await gateway.ensureSubscribed(row.id), true);
    const writer = spawnEpochWriter(user.id, 1);
    const writerExit = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`epoch writer exited ${code}`)));
    });
    await waitForChildLine(writer, "epoch-locked");
    assert.equal(await gateway.submitMessage(row.id, "MUST_NOT_START_SPLIT", undefined, "split-fresh-stale"), false);
    await writerExit;
    const refusal = events.find((event) => event.type === "error" && event.reqId === "split-fresh-stale");
    assert.ok(refusal?.type === "error");
    assert.equal(refusal.sessionId, row.id);
    assert.equal(refusal.code, undefined, "split fresh-Turn refusal matches local untyped UX");
    assert.equal(agentTurnDao.list(row.id).length, 0, "stale split fresh send creates no Agent Turn");
    gateway.close();
    sessionManager.disposeUserRuntimes(user.id);
    console.log("  ✓ split fresh submit + second SQLite: stale pwc refuses without typed-UI divergence");
  }

  {
    const user = createUser("u_auth_split_submit");
    const row = createSession(user.id, "s_auth_split_submit");
    const events: ServerEvent[] = [];
    const gateway = new RemoteSessionGateway(user.id, (event) => events.push(event), () => {}, sock, 0);
    assert.equal(await gateway.ensureSubscribed(row.id), true);
    const runtime = sessionManager.getRuntime(user.id, row.id);
    assert.ok(runtime);
    const state = runtime as unknown as {
      status: string;
      currentTurnId: string | null;
      turnAcceptingSteer: boolean;
      turnAbort: AbortController | null;
    };
    state.status = "running";
    state.currentTurnId = "turn_auth_split_submit";
    state.turnAcceptingSteer = true;
    state.turnAbort = new AbortController();
    const writer = spawnEpochWriter(user.id, 1);
    const writerExit = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`epoch writer exited ${code}`)));
    });
    await waitForChildLine(writer, "epoch-locked");
    assert.equal(await gateway.submitMessage(row.id, "MUST_NOT_STEER", "steer", "submit-stale"), false);
    await writerExit;
    assert.equal(pendingMessageDao.listPending(row.id).length, 0, "stale split submit adds no pending row");
    const splitRefusal = events.find((event) => event.type === "error" && event.reqId === "submit-stale");
    assert.ok(splitRefusal?.type === "error", "split submit refusal keeps browser correlation");
    assert.equal(splitRefusal.sessionId, row.id);
    assert.equal(splitRefusal.code, "auth_revoked");
    state.status = "idle";
    state.currentTurnId = null;
    state.turnAcceptingSteer = false;
    state.turnAbort = null;
    gateway.close();
    sessionManager.disposeUserRuntimes(user.id);
    console.log("  ✓ Unix submit_message + second SQLite: stale pwc cannot enqueue execution");
  }

  const user = createUser("u_access");
  db.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").run(user.id);
  const row = createSession(user.id, "s_access");
  await emailVerify.prepareVerificationEmail(user.email);
  const runtime = new AgentSessionRuntime(row);
  const state = runtime as unknown as {
    status: string;
    currentTurnId: string | null;
    turnAcceptingSteer: boolean;
    turnAbort: AbortController | null;
    agent: {
      steer: (message: unknown) => void;
      hasQueuedMessages: () => boolean;
    };
  };
  state.status = "running";
  state.currentTurnId = "turn_pending_admission_harness";
  state.turnAcceptingSteer = true;
  state.turnAbort = new AbortController();
  const events: ServerEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  pendingMessageDao.append(row.id, { id: "q1", kind: "queue", text: "queued one", ts: Date.now() });
  pendingMessageDao.append(row.id, { id: "s1", kind: "steer", text: "steer one", ts: Date.now() });
  pendingMessageDao.append(row.id, { id: "s2", kind: "steer", text: "steer two", ts: Date.now() });
  state.agent.steer({ role: "user", content: "steer one", timestamp: Date.now() });
  state.agent.steer({ role: "user", content: "steer two", timestamp: Date.now() });

  assertDenied(runtime.setPendingKind("q1", "steer"), "email_verification_required");
  assertDenied(runtime.setPendingText("s1", "changed steer"), "email_verification_required");
  assertDenied(runtime.reorderPending(["q1", "s2", "s1"]), "email_verification_required");
  assert.deepEqual(pendingMessageDao.listPending(row.id).map(({ id, kind, text }) => [id, kind, text]), [
    ["q1", "queue", "queued one"],
    ["s1", "steer", "steer one"],
    ["s2", "steer", "steer two"],
  ]);
  assert.equal(events.at(-1)?.type, "pending_queue", "denial ends with authoritative pending truth");

  const banWriter = spawn(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
db.prepare("UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?").run(Date.now(), "race suspension", process.argv[2]);
process.stdout.write("ban-locked\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 150);`,
    path.join(tmp, "agent-web.db"),
    user.id,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const banExit = new Promise<void>((resolve, reject) => {
    banWriter.once("error", reject);
    banWriter.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ban writer exited ${code}`)));
  });
  await waitForChildLine(banWriter, "ban-locked");
  assertDenied(runtime.setPendingText("s1", "banned edit"), "suspended");
  await banExit;
  assert.equal(pendingMessageDao.byId(row.id, "s1")?.text, "steer one", "ban-before mutation leaves DB truth unchanged");
  assert.equal(state.agent.hasQueuedMessages(), true, "ban-before mutation leaves pi steering intact");
  ban.unbanUser(user.id);
  console.log("  ✓ cross-process ban linearizes before pending CAS and leaves DB/pi steering unchanged");

  assert.deepEqual(runtime.setPendingKind("s1", "queue"), { ok: true });
  assert.equal(pendingMessageDao.byId(row.id, "s1")?.kind, "queue");
  assert.equal(state.agent.hasQueuedMessages(), true, "the surviving steer remains in pi");
  runtime.clearPending("s2");
  assert.equal(state.agent.hasQueuedMessages(), false, "Remove clears the final live steer");
  assert.deepEqual(runtime.setPendingText("q1", "edited queued one"), { ok: true });
  assert.deepEqual(runtime.reorderPending(["s1", "q1"]), { ok: true });
  assert.deepEqual(pendingMessageDao.listPending(row.id).map((pending) => pending.id), ["s1", "q1"]);

  state.status = "idle";
  state.currentTurnId = null;
  state.turnAcceptingSteer = false;
  state.turnAbort = null;
  runtime.close();
  console.log("  ✓ verification/ban deny steer creation, edit, and reorder; demotion/remove stay safe");
  console.log("OK pending-admission: runtime authority + monolith/split parity + replacement durability");
} finally {
  try { wss.close(); } catch {  }
  try { server.close(); } catch {  }
  try { fs.unlinkSync(sock); } catch {  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
