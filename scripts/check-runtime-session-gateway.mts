import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ServerEvent } from "../shared/src/protocol.ts";
type SessionGateway = import("../server/src/runtime/session-gateway.ts").SessionGateway;

process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
  if (e?.code === "EPIPE") return;
  console.error(e);
  process.exit(1);
});

process.env.AGENT_WEB_SESSION_WARM_MS = "0";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { attachRuntimeStreamHost } = await import("../server/src/runtime/runtime-stream-host.ts");
const { LocalSessionGateway, RemoteSessionGateway } = await import("../server/src/runtime/session-gateway.ts");
const { signup } = await import("../server/src/identity/auth.ts");

registerMockProvider();
const sock = path.join(os.tmpdir(), `oiia-gateway-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {  }
const server = http.createServer();
const wss = attachRuntimeStreamHost(server);
await new Promise<void>((r) => server.listen(sock, () => r()));

const settle = () => new Promise((r) => setTimeout(r, 60));
const NOISE = new Set(["sandbox_load"]);
let userN = 0;
async function freshUser() {
  return signup(`gw-${process.pid}-${++userN}@gmail.com`, "password123");
}
function newSession(user: Awaited<ReturnType<typeof signup>>) {
  return sessionManager.createSession(user, {
    provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request",
  }).id;
}

type Make = (userId: string, onEvent: (e: ServerEvent) => void) => SessionGateway;
const makeLocal: Make = (uid, onEvent) => new LocalSessionGateway(uid, onEvent, 0);
const makeRemote: Make = (uid, onEvent) => new RemoteSessionGateway(uid, onEvent, () => {}, sock, 0);

function recorder() {
  const frames: ServerEvent[] = [];
  const onEvent = (e: ServerEvent) => frames.push(e);
  const mark = () => {
    const n = frames.length;
    return {
      types: () => frames.slice(n).map((e) => e.type).filter((t) => !NOISE.has(t)),
      raw: () => frames.slice(n),
    };
  };
  return { frames, onEvent, mark };
}

async function runScenario(make: Make) {
  const user = await freshUser();
  const sid = newSession(user);
  const rec = recorder();
  const gw = make(user.id, rec.onEvent);

  let m = rec.mark();
  assert.equal(await gw.ensureSubscribed(sid), true, "ensureSubscribed binds an existing session");
  await gw.replaySubscribed(sid);
  await settle();
  const subscribeFrames = m.types();
  const replay1 = m.raw().find((e) => e.type === "timeline_replay") as Extract<ServerEvent, { type: "timeline_replay" }> | undefined;
  const epoch1 = replay1?.epoch;

  m = rec.mark();
  assert.equal(await gw.ensureSubscribed(sid), true, "warm ensureSubscribed keeps the binding");
  await gw.replaySubscribed(sid, replay1 && { epoch: replay1.epoch, version: replay1.version });
  await settle();
  const matchedResumeFrames = m.types();

  m = rec.mark();
  assert.equal(await gw.ensureSubscribed(sid), true, "re-ensure on a live binding");
  await settle();
  const reEnsureFrames = m.types();

  sessionManager.disposeUserRuntimes(user.id);
  await settle();
  m = rec.mark();
  assert.equal(await gw.ensureSubscribed(sid), true, "ensureSubscribed re-binds after an epoch bump");
  await gw.replaySubscribed(sid);
  await settle();
  const doubleReplayFrames = m.types();
  const epoch2 = (m.raw().find((e) => e.type === "timeline_replay") as Extract<ServerEvent, { type: "timeline_replay" }>)?.epoch;

  m = rec.mark();
  assert.equal(await gw.ensureSubscribed("nope-" + sid, "REQ1"), false, "ensureSubscribed false on missing session");
  await settle();
  const notFoundFrame = m.raw().find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;

  m = rec.mark();
  await gw.interrupt(sid);
  await gw.resolvePermission(sid, "no-such-request", "deny");
  await settle();
  const sideEffectFrames = m.types();

  const rewindResult = await gw.rewind(sid, 1);
  await settle();
  m = rec.mark();
  assert.equal(await gw.ensureSubscribed(sid), true, "re-ensure after refused rewind");
  await gw.replaySubscribed(sid);
  await settle();
  const restoreFrames = m.types();

  gw.close();
  await settle();
  return { subscribeFrames, matchedResumeFrames, reEnsureFrames, doubleReplayFrames, notFoundFrame, sideEffectFrames, rewindResult, restoreFrames, epoch1, epoch2, replayVersion: replay1?.version };
}

const FULL = ["timeline_replay", "session_status", "context_usage"];
const MINIMAL = ["timeline_replay", "session_status"];

function assertScenario(label: string, r: Awaited<ReturnType<typeof runScenario>>) {
  assert.deepEqual(r.subscribeFrames, FULL, `[${label}] explicit subscribe → full replay`);
  assert.deepEqual(r.matchedResumeFrames, ["pending_queue", "session_status", "context_usage"],
    `[${label}] matching cursor elides Timeline but refreshes pending truth`);
  assert.deepEqual(r.reEnsureFrames, [], `[${label}] re-ensure on a fresh epoch emits nothing`);
  assert.deepEqual(r.doubleReplayFrames, [...MINIMAL, ...FULL], `[${label}] stale explicit subscribe → minimal + full (double replay)`);
  assert.ok(r.notFoundFrame && r.notFoundFrame.reqId === "REQ1" && /not found/i.test(r.notFoundFrame.message),
    `[${label}] not-found error carries the browser reqId`);
  assert.deepEqual(r.sideEffectFrames, [], `[${label}] interrupt/resolve emit no browser frames`);
  assert.equal(r.rewindResult.ok, false, `[${label}] rewind on a message-less session is refused`);
  assert.deepEqual(r.restoreFrames, FULL, `[${label}] restore after refused rewind → full replay (binding kept)`);
  assert.ok(typeof r.epoch1 === "string" && r.epoch1.length > 0, `[${label}] replay carries an epoch`);
  assert.equal(r.replayVersion, 0, `[${label}] fresh runtime replay carries its snapshot version`);
  assert.notEqual(r.epoch2, r.epoch1, `[${label}] epoch changes after the runtime is rebuilt`);
}

async function runSwitchRelease(make: Make): Promise<{ first: string; firstAgain: string }> {
  const user = await freshUser();
  const sid1 = newSession(user);
  const sid2 = newSession(user);
  const rec = recorder();
  const gw = make(user.id, rec.onEvent);
  const epochOf = (m: ReturnType<typeof rec.mark>) =>
    (m.raw().find((e) => e.type === "timeline_replay") as Extract<ServerEvent, { type: "timeline_replay" }>)?.epoch ?? "";

  let m = rec.mark();
  await gw.ensureSubscribed(sid1); await gw.replaySubscribed(sid1); await settle();
  const first = epochOf(m);

  await gw.ensureSubscribed(sid2); await gw.replaySubscribed(sid2); await settle();

  m = rec.mark();
  await gw.ensureSubscribed(sid1); await gw.replaySubscribed(sid1); await settle();
  const firstAgain = epochOf(m);

  gw.close();
  await settle();
  return { first, firstAgain };
}

try {
  const local = await runScenario(makeLocal);
  assertScenario("local", local);
  const remote = await runScenario(makeRemote);
  assertScenario("remote", remote);
  assert.deepEqual(local.rewindResult, remote.rewindResult, "local and remote agree on the rewind result");

  for (const [label, make] of [["local", makeLocal], ["remote", makeRemote]] as const) {
    const sw = await runSwitchRelease(make);
    assert.ok(sw.first && sw.firstAgain, `[${label}] switch-release produced epochs`);
    assert.notEqual(sw.firstAgain, sw.first, `[${label}] switching away releases the first session (rebuilt with a new epoch on return)`);
  }

  const dropUser = await freshUser();
  const dropSid = newSession(dropUser);
  let closedCode: number | null = null;
  const gw = new RemoteSessionGateway(dropUser.id, () => {}, (code) => { closedCode = code; }, sock, 0);
  assert.equal(await gw.ensureSubscribed(dropSid), true, "remote bind before drop");
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(closedCode !== null, "remote gateway fires onClose when the runtime stream drops");
  gw.close();

  console.log("OK runtime-session-gateway: local≡remote frame-identical (full replay, cursor-hit pending refresh, re-ensure, double replay, not-found, refused-rewind keeps binding + restore) + switch releases + remote drop → onClose");
} finally {
  try { server.close(); } catch {  }
  try { wss.close(); } catch {  }
  try { fs.unlinkSync(sock); } catch {  }
}
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
