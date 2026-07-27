import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const sock = path.join(os.tmpdir(), `oiia-rt-split-${process.pid}.sock`);
process.env.AGENT_WEB_RUNTIME_SOCKET = sock;
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_DEFAULT_SANDBOX_KIND = "local";
process.env.AGENT_WEB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `oiia-rt-split-data-${process.pid}-`));

process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
  if (e?.code === "EPIPE") return;
  console.error(e);
  process.exit(1);
});

const { RUNTIME_SOCKET } = await import("../server/src/config.ts");
const { runtimeClient, sessionManager } = await import("../server/src/runtime/manager.ts");
const { createRuntimeHost } = await import("../server/src/runtime/runtime-ipc.ts");
const { attachRuntimeStreamHost } = await import("../server/src/runtime/runtime-stream-host.ts");
const { attachRuntimePtyHost } = await import("../server/src/runtime/runtime-pty-host.ts");
const { createSessionGateway } = await import("../server/src/runtime/session-gateway.ts");
const { createPtyGateway } = await import("../server/src/runtime/pty-gateway.ts");
const { boundedRuntimeClient, runtimeUsesIpc } = await import("../server/src/runtime/runtime-client.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { signup } = await import("../server/src/identity/auth.ts");
const { RemoteSessionGateway } = await import("../server/src/runtime/session-gateway.ts");
const { RemotePtyGateway } = await import("../server/src/runtime/pty-gateway.ts");
const { workspacePathFor } = await import("../server/src/runtime/sandbox.ts");
const { openPreviewStream } = await import("../server/src/http/routes/files.ts");
type ServerEvent = import("../shared/src/protocol.ts").ServerEvent;
type RuntimePtyServerControl = import("../server/src/runtime/runtime-pty-protocol.ts").RuntimePtyServerControl;

assert.equal(RUNTIME_SOCKET, sock, "config.RUNTIME_SOCKET reflects the env set before import");
assert.equal(runtimeUsesIpc, true, "runtimeUsesIpc latched true — boundedRuntimeClient is the REMOTE http client");
const sgProbe = createSessionGateway("u_probe", 0, () => {}, () => {});
const pgProbe = createPtyGateway("u_probe", "s_probe");
assert.ok(sgProbe instanceof RemoteSessionGateway, "createSessionGateway returns the REMOTE gateway (env-before-import ordering is correct)");
assert.ok(pgProbe instanceof RemotePtyGateway, "createPtyGateway returns the REMOTE gateway (env-before-import ordering is correct)");
sgProbe.close();
pgProbe.close();

registerMockProvider();
try { fs.unlinkSync(sock); } catch {  }
const server = createRuntimeHost(runtimeClient, sock);
attachRuntimeStreamHost(server);
attachRuntimePtyHost(server);
await new Promise<void>((r) => server.once("listening", () => r()));

const settle = () => new Promise((r) => setTimeout(r, 60));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let userN = 0;
async function freshSession() {
  const user = await signup(`split-${process.pid}-${++userN}@gmail.com`, "password123");
  const sid = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request",
  }).id;
  return { user, sid };
}

try {
  {
    const { user, sid } = await freshSession();
    const gw = createSessionGateway(user.id, 0, () => {}, () => {});
    assert.ok(gw instanceof RemoteSessionGateway, "createSessionGateway picks the REMOTE gateway when the socket is set");

    const frames: ServerEvent[] = [];
    const gw2 = createSessionGateway(user.id, 0, (e) => frames.push(e), () => {});
    gw.close();
    assert.equal(await gw2.ensureSubscribed(sid), true, "remote ensureSubscribed binds the live runtime over the socket");
    await gw2.replaySubscribed(sid);
    await settle();
    const types = frames.map((f) => f.type).filter((t) => t !== "sandbox_load");
    assert.deepEqual(types, ["timeline_replay", "session_status", "context_usage"], "chat subscribe→replay round-trips a full replay over the socket");
    const replay = frames.find((f) => f.type === "timeline_replay") as Extract<ServerEvent, { type: "timeline_replay" }>;
    assert.ok(typeof replay.epoch === "string" && replay.epoch.length > 0, "replay carries the runtime's epoch");
    gw2.close();
    await settle();
  }

  {
    const cuid = (await signup(`split-conn-${process.pid}@gmail.com`, "password123")).id;
    try {
      const created = await boundedRuntimeClient.connectorCreateToken(cuid, "split-test", "~/.agent-web/workspaces");
      assert.ok(created.token && created.info?.id, "connectorCreateToken round-trips token+info over /rpc");
      const listed = await boundedRuntimeClient.connectorList(cuid);
      assert.ok(listed.some((c) => c.id === created.info.id), "the created connector is listed back over /rpc");
      await assert.rejects(
        boundedRuntimeClient.connectorTelemetry(created.info.id),
        /offline/i,
        "connectorTelemetry crosses /rpc and preserves the offline error",
      );
      await boundedRuntimeClient.connectorDelete(cuid, created.info.id);
      assert.ok(!(await boundedRuntimeClient.connectorList(cuid)).some((c) => c.id === created.info.id), "connector removed after delete over /rpc");
    } finally {
      for (const c of runtimeClient.connectorList(cuid)) runtimeClient.connectorDelete(cuid, c.id);
    }
  }

  {
    const { user, sid } = await freshSession();
    const gw = createPtyGateway(user.id, sid);
    assert.ok(gw instanceof RemotePtyGateway, "createPtyGateway picks the REMOTE gateway when the socket is set");
    const control: RuntimePtyServerControl[] = [];
    const ready = gw.attach({
      cols: 80, rows: 24, create: false,
      onData: () => {}, onControl: (ev) => control.push(ev), onClose: () => {},
    });
    await ready;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !control.some((c) => c.type === "no_terminal")) await wait(30);
    assert.deepEqual(control.map((c) => c.type), ["no_terminal"], "PTY no_terminal probe round-trips over the socket");
    gw.close();
    await settle();
  }

  {
    const { user, sid } = await freshSession();
    const root = workspacePathFor(user.id, sid);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "split.pdf"), Buffer.from("%PDF-split-preview"));
    const prepared = await boundedRuntimeClient.prepareFilePreview(user.id, sid, "./split.pdf");
    assert.ok(prepared?.ok, "preview preflight round-trips over runtime IPC");
    assert.equal(prepared.path, "split.pdf", "runtime canonicalizes the signed path");
    const chunk = await boundedRuntimeClient.readFilePreviewChunk(user.id, sid, prepared.path, {
      start: 0,
      endExclusive: 5,
      expectedSize: prepared.size,
      expectedModifiedAt: prepared.modifiedAt,
      expectedVersion: prepared.version,
      expectedBackendVersion: prepared.backendVersion,
    });
    assert.ok(chunk?.ok, "preview bytes round-trip over runtime IPC");
    assert.equal(Buffer.from(chunk.dataBase64, "base64").toString("ascii"), "%PDF-");

    const streamed = await openPreviewStream(user.id, sid, prepared.path, {
      start: 0,
      endExclusive: prepared.size,
      expectedSize: prepared.size,
      expectedModifiedAt: prepared.modifiedAt,
      expectedVersion: prepared.version,
      expectedBackendVersion: prepared.backendVersion,
      signal: new AbortController().signal,
    });
    assert.ok(streamed?.ok, "web preview wrapper keeps AbortSignal out of split RPC JSON");
    const bytes: Buffer[] = [];
    for await (const part of streamed.stream.chunks) bytes.push(Buffer.from(part));
    streamed.stream.close();
    assert.equal(Buffer.concat(bytes).toString("ascii"), "%PDF-split-preview");
  }

  console.log("OK runtime-split: chat + connector management + PTY + file-preview data all round-trip over ONE unix socket");
} finally {
  try { server.close(); } catch {  }
  try { fs.unlinkSync(sock); } catch {  }
}
await wait(200);
process.exit(0);
