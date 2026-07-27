import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } from "../server/src/runtime/providers.ts";
import { sessionManager } from "../server/src/runtime/manager.ts";
import { attachRuntimePtyHost } from "../server/src/runtime/runtime-pty-host.ts";
import { LocalPtyGateway } from "../server/src/runtime/pty-gateway.ts";
import { RemotePtyGateway } from "../server/src/runtime/pty-gateway.ts";
import type { PtyGateway } from "../server/src/runtime/pty-gateway.ts";
import type { RuntimePtyServerControl } from "../server/src/runtime/runtime-pty-protocol.ts";
import { signup } from "../server/src/identity/auth.ts";
import { truncateCloseReason } from "../server/src/transport/ws-util.ts";

process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
  if (e?.code === "EPIPE") return;
  console.error(e);
  process.exit(1);
});

registerMockProvider();
const sock = path.join(os.tmpdir(), `oiia-pty-${process.pid}.sock`);
try { fs.unlinkSync(sock); } catch {  }
const server = http.createServer();
const wss = attachRuntimePtyHost(server);
await new Promise<void>((r) => server.listen(sock, () => r()));

let userN = 0;
async function freshSession() {
  const user = await signup(`pty-${process.pid}-${++userN}@gmail.com`, "password123");
  const sid = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, sandboxMode: "workspace-write", approvalPolicy: "on-request",
  }).id;
  return { user, sid };
}

function drive(gw: PtyGateway, create: boolean) {
  const control: RuntimePtyServerControl[] = [];
  let dataBytes = 0;
  let closed = false;
  const ready = gw.attach({
    cols: 80, rows: 24, create,
    onData: (chunk) => { dataBytes += chunk.length; },
    onControl: (ev) => control.push(ev),
    onClose: () => { closed = true; },
  });
  return { ready, control, get dataBytes() { return dataBytes; }, get closed() { return closed; } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForControl(d: { control: RuntimePtyServerControl[] }, type: string, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (d.control.some((c) => c.type === type)) return true;
    await wait(30);
  }
  return false;
}

try {
  {
    const long = "💥".repeat(200);
    const t = truncateCloseReason(long);
    const bytes = new TextEncoder().encode(t);
    assert.ok(bytes.length <= 123, `truncated reason within WS limit (${bytes.length} bytes)`);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(bytes), t, "no lone surrogate (valid UTF-8)");
    assert.ok(!/[\uD800-\uDFFF]/.test(t) || /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(t), "no unpaired surrogate");
  }

  for (const [label, make] of [
    ["local", (uid: string, sid: string) => new LocalPtyGateway(uid, sid)],
    ["remote", (uid: string, sid: string) => new RemotePtyGateway(uid, sid, sock)],
  ] as const) {
    const { user, sid } = await freshSession();
    const gw = make(user.id, sid);
    const d = drive(gw, false);
    await d.ready;
    assert.ok(await waitForControl(d, "no_terminal"), `[${label}] attach-only probe emits no_terminal`);
    assert.deepEqual(d.control.map((c) => c.type), ["no_terminal"], `[${label}] probe emits ONLY no_terminal`);
    assert.equal(d.dataBytes, 0, `[${label}] probe streams no PTY data`);
    gw.close();
    await wait(40);
  }

  const spawnOk: Record<string, boolean> = {};
  for (const [label, make] of [
    ["local", (uid: string, sid: string) => new LocalPtyGateway(uid, sid)],
    ["remote", (uid: string, sid: string) => new RemotePtyGateway(uid, sid, sock)],
  ] as const) {
    const { user, sid } = await freshSession();
    const gw = make(user.id, sid);
    const d = drive(gw, true);
    await d.ready;
    const gotReady = await waitForControl(d, "ready", 4000);
    if (!gotReady) {
      const err = d.control.find((c) => c.type === "error");
      console.log(`SKIP real-shell (${label}): no node-pty spawn here${err ? " (" + (err as { message?: string }).message + ")" : ""}`);
      spawnOk[label] = false;
      gw.close();
      await wait(40);
      continue;
    }
    spawnOk[label] = true;
    gw.write(new TextEncoder().encode("exit\n"));
    assert.ok(await waitForControl(d, "exit", 4000), `[${label}] shell exit surfaces an exit frame`);
    gw.close();
    await wait(60);
  }
  assert.equal(spawnOk.local, spawnOk.remote, "spawn coverage must be symmetric (asymmetric skip = a one-path regression)");
  if (!spawnOk.local) console.log("NOTE: real-shell spawn path skipped on BOTH paths (no node-pty in this env)");

  {
    const { user, sid } = await freshSession();
    const gw = new RemotePtyGateway(user.id, sid, sock);
    const d = drive(gw, true);
    await d.ready;
    const gotReady = await waitForControl(d, "ready", 4000);
    if (!gotReady) {
      assert.ok(!spawnOk.remote, "remote-drop: {ready} not observed though spawn proved node-pty works → remote attach regression");
      console.log("SKIP remote-drop: no node-pty in this env (consistent with the spawn test)");
    } else {
      assert.ok(!d.closed, "remote channel is LIVE (not already closed) before the drop");
      for (const c of wss.clients) c.terminate();
      await wait(200);
      assert.ok(d.closed, "remote pty gateway fires onClose when a live channel drops");
    }
    gw.close();
  }

  console.log("OK runtime-pty-gateway: local≡remote no_terminal probe + symmetric spawn→ready→exit + live remote drop → onClose");
} finally {
  try { sessionManager.disposeUserRuntimes; } catch {  }
  try { server.close(); } catch {  }
  try { wss.close(); } catch {  }
  try { fs.unlinkSync(sock); } catch {  }
}
await wait(200);
process.exit(0);
