process.env.AGENT_WEB_SSH_ALLOW_INTERNAL ||= "1";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import type { Connection, AuthContext, Session, ServerChannel, SFTPWrapper, FileEntry as SftpFileEntry, Attributes } from "ssh2";
import type { SSHSandbox as SSHSandboxType } from "../server/src/runtime/ssh-sandbox.ts";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

let failed = 0;
function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}
function fail(label: string, e: unknown): void {
  failed++;
  console.error(`  ✗ ${label}: ${e instanceof Error ? e.message : e}`);
}

const rsaPem = () =>
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
const hostKey = rsaPem();
const clientKey = rsaPem();
const clientPrivPem = clientKey.privateKey;
const allowedKey = utils.parseKey(clientPrivPem);
if (allowedKey instanceof Error) throw allowedKey;
const allowedPubSSH = allowedKey.getPublicSSH();

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sbx-srv-"));
let sftpSessions = 0;

function attachSftp(sftp: SFTPWrapper): void {
  let nextHandle = 0;
  type Open = { path: string; fd: number };
  type Dir = { entries: SftpFileEntry[]; pos: number };
  const files = new Map<number, Open>();
  const dirs = new Map<number, Dir>();
  const handleBuf = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const toAttrs = (st: fs.Stats): Attributes => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });

  const statLike = (reqId: number, p: string) => {
    try {
      sftp.attrs(reqId, toAttrs(fs.statSync(p)));
    } catch {
      sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    }
  };
  sftp.on("STAT", statLike);
  sftp.on("LSTAT", statLike);

  sftp.on("REALPATH", (reqId, p) => {
    const resolved = path.posix.normalize(p || ".");
    const entry: SftpFileEntry = { filename: resolved, longname: resolved, attrs: {} as Attributes };
    sftp.name(reqId, [entry]);
  });

  sftp.on("MKDIR", (reqId, p) => {
    try {
      fs.mkdirSync(p, { recursive: true });
      sftp.status(reqId, STATUS_CODE.OK);
    } catch {
      sftp.status(reqId, STATUS_CODE.FAILURE);
    }
  });

  sftp.on("OPEN", (reqId, filename, flags) => {
    let fsFlags = "r";
    if (flags & OPEN_MODE.WRITE && flags & OPEN_MODE.READ) fsFlags = "w+";
    else if (flags & OPEN_MODE.WRITE) fsFlags = "w";
    try {
      const fd = fs.openSync(filename, fsFlags);
      const h = nextHandle++;
      files.set(h, { path: filename, fd });
      sftp.handle(reqId, handleBuf(h));
    } catch {
      sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on("WRITE", (reqId, handle, offset, data) => {
    const open = files.get(handle.readUInt32BE(0));
    if (!open) return sftp.status(reqId, STATUS_CODE.FAILURE);
    try {
      fs.writeSync(open.fd, data, 0, data.length, offset);
      sftp.status(reqId, STATUS_CODE.OK);
    } catch {
      sftp.status(reqId, STATUS_CODE.FAILURE);
    }
  });

  sftp.on("READ", (reqId, handle, offset, len) => {
    const open = files.get(handle.readUInt32BE(0));
    if (!open) return sftp.status(reqId, STATUS_CODE.FAILURE);
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(open.fd, buf, 0, len, offset);
      if (n === 0) sftp.status(reqId, STATUS_CODE.EOF);
      else sftp.data(reqId, buf.subarray(0, n));
    } catch {
      sftp.status(reqId, STATUS_CODE.FAILURE);
    }
  });

  sftp.on("OPENDIR", (reqId, p) => {
    try {
      const names = fs.readdirSync(p);
      const entries: SftpFileEntry[] = names.map((name) => {
        const st = fs.statSync(path.join(p, name));
        return { filename: name, longname: name, attrs: toAttrs(st) };
      });
      const h = nextHandle++;
      dirs.set(h, { entries, pos: 0 });
      sftp.handle(reqId, handleBuf(h));
    } catch {
      sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on("READDIR", (reqId, handle) => {
    const dir = dirs.get(handle.readUInt32BE(0));
    if (!dir) return sftp.status(reqId, STATUS_CODE.FAILURE);
    if (dir.pos >= dir.entries.length) return sftp.status(reqId, STATUS_CODE.EOF);
    const batch = dir.entries.slice(dir.pos);
    dir.pos = dir.entries.length;
    sftp.name(reqId, batch);
  });

  sftp.on("CLOSE", (reqId, handle) => {
    const id = handle.readUInt32BE(0);
    const open = files.get(id);
    if (open) {
      try {
        fs.closeSync(open.fd);
      } catch {
      }
      files.delete(id);
    }
    dirs.delete(id);
    sftp.status(reqId, STATUS_CODE.OK);
  });
}

const limits = {
  sessionLimit: Infinity,
  perConnAccepted: [] as number[],
  refused: 0,
  refusedConns: new Set<number>(),
  connections: 0,
  closedConns: new Set<number>(),
  executed: [] as string[],
  liveExecs: 0,
  peakExecs: 0,
};

function startServer(): Promise<{ port: number; close: () => void }> {
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (conn: Connection) => {
    const connIndex = limits.connections++;
    limits.perConnAccepted[connIndex] = 0;
    conn.on("close", () => { limits.closedConns.add(connIndex); });
    conn.on("error", () => {});
    conn.on("authentication", (ctx: AuthContext) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      if (!Buffer.isBuffer(ctx.key.data)) return ctx.reject();
      const incoming = utils.parseKey(ctx.key.data);
      if (incoming instanceof Error) return ctx.reject();
      if (!incoming.getPublicSSH().equals(allowedPubSSH)) return ctx.reject();
      ctx.accept();
    });

    conn.on("session", (acceptSession, rejectSession) => {
      if (limits.perConnAccepted[connIndex] >= limits.sessionLimit) {
        limits.refused++;
        limits.refusedConns.add(connIndex);
        rejectSession();
        return;
      }
      limits.perConnAccepted[connIndex]++;
      const session: Session = acceptSession();

      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream: ServerChannel = acceptExec();
        limits.executed.push(info.command);
        limits.liveExecs++;
        if (limits.liveExecs > limits.peakExecs) limits.peakExecs = limits.liveExecs;
        let counted = true;
        const done = () => { if (counted) { counted = false; limits.liveExecs--; } };
        const child = spawn("/bin/sh", ["-c", info.command], { cwd: workRoot });
        child.stdout.on("data", (d) => stream.write(d));
        child.stderr.on("data", (d) => stream.stderr.write(d));
        child.on("close", (code) => {
          done();
          stream.exit(code ?? 0);
          stream.end();
        });
        child.on("error", () => {
          done();
          stream.exit(1);
          stream.end();
        });
      });

      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => {
        const stream: ServerChannel = acceptShell();
        stream.on("data", (d: Buffer) => stream.write(d));
      });

      session.on("sftp", (acceptSftp) => {
        sftpSessions++;
        const sftp: SFTPWrapper = acceptSftp();
        attachSftp(sftp);
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function main(): Promise<void> {
  const { SSHSandbox } = (await import("../server/src/runtime/ssh-sandbox.ts")) as {
    SSHSandbox: typeof SSHSandboxType;
  };

  const { port, close } = await startServer();
  let recordedFp: string | null = null;

  const sandbox = new SSHSandbox({
    root: workRoot,
    mode: "workspace-write",
    target: {
      host: "127.0.0.1",
      port,
      username: "tester",
      privateKey: clientPrivPem,
      hostFingerprint: null,
      onFingerprint: (fp) => {
        recordedFp = fp;
      },
    },
  });

  try {
    const res = await sandbox.exec("echo hi");
    assert.equal(res.exitCode, 0, `exit code (stderr=${res.stderr})`);
    assert.equal(res.stdout.trim(), "hi", `stdout was ${JSON.stringify(res.stdout)}`);
    ok('exec "echo hi" → stdout "hi", exitCode 0');
  } catch (e) {
    fail("exec echo", e);
  }

  try {
    assert.ok(recordedFp && recordedFp.startsWith("SHA256:"), `onFingerprint not called / bad fp: ${recordedFp}`);
    ok(`TOFU recorded fingerprint on first connect (${recordedFp})`);
  } catch (e) {
    fail("TOFU first-connect fingerprint", e);
  }

  try {
    const content = "hello from ssh sandbox\n";
    await sandbox.writeFile("notes/hello.txt", content);
    const back = await sandbox.readFile("notes/hello.txt");
    assert.equal(back, content, "round-trip content mismatch");
    assert.equal(fs.readFileSync(path.join(workRoot, "notes/hello.txt"), "utf8"), content);
    ok("writeFile → readFile round-trips (via SFTP)");
  } catch (e) {
    fail("writeFile/readFile round-trip", e);
  }

  try {
    const entries = await sandbox.listDir("notes");
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("hello.txt"), `listDir(notes) = ${JSON.stringify(names)}`);
    ok("listDir shows the written file");
  } catch (e) {
    fail("listDir", e);
  }

  try {
    const stat = await sandbox.statFile("notes/hello.txt");
    assert.equal(stat?.size, Buffer.byteLength("hello from ssh sandbox\n"));
    const chunks: Uint8Array[] = [];
    for await (const chunk of sandbox.readFileChunks("notes/hello.txt", { start: 6, endExclusive: 14 })) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), "from ssh");
    assert.equal(sftpSessions, 1, "file ops should share one multiplexed SFTP subsystem");
    ok("statFile + bounded range are exact and reuse one SFTP subsystem");
  } catch (e) {
    fail("statFile/readFileChunks", e);
  }

  sandbox.close();

  try {
    const evil = new SSHSandbox({
      root: workRoot,
      mode: "workspace-write",
      target: {
        host: "127.0.0.1",
        port,
        username: "tester",
        privateKey: clientPrivPem,
        hostFingerprint: "SHA256:THISisNOTtheRealHostKeyFingerprintAtAll00000000000",
      },
    });
    let connected = false;
    let mitmMessage = "";
    try {
      await evil.exec("echo should-not-run");
      connected = true;
    } catch (e) {
      mitmMessage = e instanceof Error ? e.message : String(e);
    }
    assert.match(mitmMessage, /SECURITY CHECK/, `host-key rejection must be marked as such; got: ${mitmMessage}`);
    assert.match(mitmMessage, /Do NOT retry/, "must tell the agent not to work around it");
    assert.doesNotMatch(mitmMessage, /machine is up/, "must NOT be reported as an unreachable host");
    evil.close();
    assert.equal(connected, false, "connect SUCCEEDED with a wrong host fingerprint (MITM not rejected!)");
    ok("TOFU: wrong hostFingerprint → connect rejected (MITM blocked)");
  } catch (e) {
    fail("TOFU mismatch rejection", e);
  }

  const churn = new SSHSandbox({
    root: workRoot,
    mode: "workspace-write",
    target: { host: "127.0.0.1", port, username: "tester", privateKey: clientPrivPem, hostFingerprint: null },
  });
  try {
    limits.sessionLimit = 3;
    const before = { conns: limits.connections, refused: limits.refused };
    const marker = "echo recovered-after-exhaustion";
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await churn.exec(marker);
      results.push(res.stdout.trim());
    }
    assert.deepEqual(
      results,
      Array(6).fill("recovered-after-exhaustion"),
      "every command must succeed — a refused channel is recovered from, not surfaced",
    );
    assert.ok(limits.refused > before.refused, "the test server did refuse channels (otherwise this proves nothing)");
    assert.ok(
      limits.connections > before.conns,
      "recovery must come from a NEW connection — a fresh one gets a fresh session budget",
    );
    await new Promise((r) => setTimeout(r, 250));
    const refusedHere = [...limits.refusedConns].filter((i) => i >= before.conns);
    assert.ok(refusedHere.length > 0, "a connection must actually have refused us");
    for (const index of refusedHere) {
      assert.ok(
        limits.closedConns.has(index),
        `connection #${index} refused a channel and was retired, but never hung up — ` +
          "the sessions stuck on it are released only by closing it",
      );
    }
    assert.ok(
      !refusedHere.some((i) => i === limits.perConnAccepted.length - 1),
      "the connection now serving traffic must not be one that was retired",
    );
    assert.equal(
      limits.executed.filter((c) => c.includes(marker)).length,
      6,
      "a retried command must run exactly once per call — never twice",
    );
    ok(`exhausted channels recover by reconnecting (${limits.refused - before.refused} refusals absorbed, exactly-once preserved)`);
  } catch (e) {
    fail("channel exhaustion recovery", e);
  }

  try {
    const entries = await churn.listDir("notes");
    assert.ok(entries.map((e) => e.name).includes("hello.txt"), "file tools must work after a reconnect");
    ok("SFTP is re-established on the replacement connection");
  } catch (e) {
    fail("SFTP after reconnect", e);
  }

  try {
    limits.sessionLimit = 0;
    let message = "";
    try {
      await churn.exec("echo unreachable");
      message = "(no error thrown)";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.doesNotMatch(
      message,
      /^\(SSH\) Channel open failure/,
      "the raw ssh2 string must not be what the agent reads — it names no cause and no remedy",
    );
    for (const [label, needle] of [
      ["says it is the environment, not the command", /ENVIRONMENT FAILURE/],
      ["names the actual limit", /MaxSessions/],
      ["says retrying is pointless", /will NOT help/i],
      ["tells the agent to surface it to the user", /Tell the user/i],
    ] as const) {
      assert.match(message, needle, `the agent-visible error must ${label}; got: ${message}`);
    }
    ok("an unrecoverable channel refusal reaches the agent as an actionable environment error");
  } catch (e) {
    fail("agent-visible environment error", e);
  }

  try {
    const unreachable = new SSHSandbox({
      root: workRoot,
      mode: "workspace-write",
      target: { host: "127.0.0.1", port: 1, username: "tester", privateKey: clientPrivPem, hostFingerprint: null },
    });
    let message = "";
    try {
      await unreachable.exec("echo hi");
      message = "(no error thrown)";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    unreachable.close();
    assert.match(message, /ENVIRONMENT FAILURE/, `must be marked as environment; got: ${message}`);
    assert.match(message, /127\.0\.0\.1:1/, "must name the host that could not be reached");
    assert.match(message, /will not help/i, "must say retrying is pointless");
    assert.match(message, /ECONNREFUSED/, "must keep the underlying cause for the operator");
    ok("an unreachable host is reported as an environment failure, naming the host and the cause");
  } catch (e) {
    fail("unreachable-host error", e);
  }

  try {
    limits.sessionLimit = Infinity;
    limits.peakExecs = 0;
    await Promise.all(Array.from({ length: 14 }, (_, i) => churn.exec(`sleep 0.2; echo par-${i}`)));
    assert.ok(limits.peakExecs > 1, `the burst must actually overlap (peak was ${limits.peakExecs})`);
    assert.ok(
      limits.peakExecs <= 6,
      `14 parallel execs opened ${limits.peakExecs} channels at once; the ceiling is 6`,
    );
    ok(`a 14-way parallel burst is queued to ${limits.peakExecs} concurrent channels`);
  } catch (e) {
    fail("exec channel ceiling", e);
  }

  churn.close();

  close();

  try {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import { resolveSafeSshHost } from ${JSON.stringify(path.resolve("server/src/runtime/ssh-guard.ts"))};
         resolveSafeSshHost("127.0.0.1").then(
           () => { console.error("RESOLVED"); process.exit(2); },
           () => { process.exit(0); },
         );`,
      ],
      { env: { ...process.env, AGENT_WEB_SSH_ALLOW_INTERNAL: "" }, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `resolveSafeSshHost("127.0.0.1") did NOT reject without the allow flag (status=${probe.status}, ${probe.stderr})`);
    ok('SSRF guard: resolveSafeSshHost("127.0.0.1") rejected without AGENT_WEB_SSH_ALLOW_INTERNAL');
  } catch (e) {
    fail("SSRF guard default-deny", e);
  }

  await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});

  if (failed) {
    console.error(`\n${failed} ssh-sandbox check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ssh-sandbox checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
