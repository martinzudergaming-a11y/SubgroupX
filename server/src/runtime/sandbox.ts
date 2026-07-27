import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WORKSPACES_DIR, DATA_DIR, DB_PATH } from "../config.ts";
import { userDao } from "../persistence/index.ts";
import { E2BSandbox } from "./e2b-sandbox.ts";
import { SSHSandbox, type SSHTarget } from "./ssh-sandbox.ts";
import { ConnectorSandbox } from "./connector-sandbox.ts";
import { proxyEnv } from "./proxy-env.ts";
import type { SandboxMode, SandboxKind, FileEntry } from "../../../shared/src/protocol.ts";
import type { ExecResult, ExecOptions, ExecStream, ReadFileChunksOptions, SandboxLoad, PtySpawnOpts, PtyHandle, Sandbox } from "./sandbox-types.ts";
export type { ExecResult, ExecOptions, ExecStream, ReadFileChunksOptions, SandboxLoad, PtySpawnOpts, PtyHandle, Sandbox } from "./sandbox-types.ts";

const SEATBELT = process.env.AGENT_WEB_SEATBELT === "1" && process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
function localFileVersion(st: fs.Stats): string {
  return crypto.createHash("sha256")
    .update(`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`)
    .digest("base64url");
}

let bwrapState: "unknown" | "ok" | "unavailable" = IS_LINUX ? "unknown" : "unavailable";
function bwrapAvailable(): boolean {
  if (bwrapState === "unknown") {
    let ok = false;
    try {
      const r = spawnSync(
        "bwrap",
        ["--ro-bind", "/usr", "/usr", "--proc", "/proc", "--unshare-user", "--unshare-pid", "--", "/bin/true"],
        { timeout: 5000, stdio: "ignore" },
      );
      ok = r.status === 0;
    } catch {
      ok = false;
    }
    bwrapState = ok ? "ok" : "unavailable";
    console.info(
      `[sandbox] bubblewrap ${ok ? "available — local bash/PTY are namespace-confined" : "UNAVAILABLE (no private pid-ns) — local bash/PTY are disabled unless explicitly allowed"}`,
    );
  }
  return bwrapState === "ok";
}

export function buildBwrapArgs(opts: { root: string; mode: SandboxMode; networkAccess: boolean; tty: boolean }): string[] {
  const roTry = (p: string): string[] => ["--ro-bind-try", p, p];
  const args = [
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    ...roTry("/usr"),
    ...roTry("/bin"),
    ...roTry("/sbin"),
    ...roTry("/lib"),
    ...roTry("/lib64"),
    ...roTry("/etc"),
    ...roTry("/opt"),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  if (!opts.networkAccess) args.push("--unshare-net");
  if (!opts.tty) args.push("--new-session");
  args.push(opts.mode === "read-only" ? "--ro-bind" : "--bind", opts.root, opts.root);
  args.push("--chdir", opts.root);
  return args;
}

const UID_DROP =
  IS_LINUX &&
  typeof process.getuid === "function" &&
  process.getuid() === 0 &&
  process.env.AGENT_WEB_NO_UID_DROP !== "1";

let sharedPathsHardened = false;
export function hardenSharedDataPaths(): void {
  if (sharedPathsHardened || !UID_DROP) return;
  sharedPathsHardened = true;
  const chmod = (p: string, mode: number) => {
    try {
      fs.chmodSync(p, mode);
    } catch {
    }
  };
  chmod(DATA_DIR, 0o711);
  chmod(WORKSPACES_DIR, 0o711);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, path.join(DATA_DIR, "secrets.json")]) chmod(f, 0o600);
  let userDirs: string[] = [];
  try {
    userDirs = fs.readdirSync(WORKSPACES_DIR);
  } catch {
  }
  for (const userId of userDirs) {
    const dir = path.join(WORKSPACES_DIR, userId);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const uid = userDao.sandboxUid(userId);
      fs.chownSync(dir, uid, uid);
      fs.chmodSync(dir, 0o700);
    } catch {
    }
  }
}

export function idEntryAction(text: string, name: string, uid: number): "present" | "absent" | "conflict" {
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length >= 3 && f[0] === name) return f[2] === String(uid) ? "present" : "conflict";
  }
  return "absent";
}

function ensureSandboxIdentity(uid: number, home: string): void {
  if (!UID_DROP) return;
  const name = `agentweb${uid}`;
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  try {
    const p = idEntryAction(read("/etc/passwd"), name, uid);
    if (p === "conflict") {
      console.error(`[sandbox] #40 /etc/passwd already maps name ${name} to a different uid; not adding`);
    } else if (p === "absent") {
      fs.appendFileSync("/etc/passwd", `${name}:x:${uid}:${uid}:Agent Web sandbox uid ${uid}:${home}:/bin/bash\n`);
    }
    if (idEntryAction(read("/etc/group"), name, uid) === "absent") {
      fs.appendFileSync("/etc/group", `${name}:x:${uid}:\n`);
    }
  } catch (e) {
    console.error("[sandbox] #40 ensureSandboxIdentity failed (continuing):", e instanceof Error ? e.message : e);
  }
}

export function workspacePathFor(userId: string, sessionId: string): string {
  return path.join(WORKSPACES_DIR, userId, sessionId);
}

export class LocalSandbox implements Sandbox {
  readonly root: string;
  readonly mode: SandboxMode;
  private readonly networkAccess: boolean;
  private readonly proxyUrl?: string | null;
  private readonly sandboxUid?: number;

  constructor(root: string, mode: SandboxMode, proxyUrl?: string | null, sandboxUid?: number) {
    this.root = fs.realpathSync(root);
    this.mode = mode;
    this.networkAccess = mode === "danger-full-access";
    this.proxyUrl = proxyUrl;
    this.sandboxUid = sandboxUid;
  }

  private get dropCreds(): { uid: number; gid: number } | null {
    return UID_DROP && this.sandboxUid ? { uid: this.sandboxUid, gid: this.sandboxUid } : null;
  }

  private async chownToSandbox(abs: string): Promise<void> {
    const creds = this.dropCreds;
    if (!creds) return;
    let cur = path.resolve(abs);
    while (cur.startsWith(this.root + path.sep)) {
      try {
        await fsp.chown(cur, creds.uid, creds.gid);
      } catch {
      }
      cur = path.dirname(cur);
    }
  }

  canWrite(): boolean {
    return this.mode !== "read-only";
  }

  async metrics(): Promise<SandboxLoad> {
    const cores = os.cpus().length || 1;
    const cpuPct = Math.min(100, Math.round((os.loadavg()[0] / cores) * 100));
    const memTotal = os.totalmem();
    return { cpuPct, memUsed: memTotal - os.freemem(), memTotal };
  }

  resolve(relPath: string): string {
    const clean = relPath.replace(/^[/\\]+/, "");
    const abs = path.resolve(this.root, clean);
    const rootWithSep = this.root + path.sep;
    const inside = (p: string) => p === this.root || p.startsWith(rootWithSep);
    if (!inside(abs)) throw new Error(`path escapes workspace: ${relPath}`);

    let existing = abs;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      existing = path.dirname(existing);
    }
    if (!inside(fs.realpathSync(existing))) {
      throw new Error(`path escapes workspace via symlink: ${relPath}`);
    }
    return abs;
  }

  toRel(absPath: string): string {
    const rel = path.relative(this.root, absPath);
    return rel === "" ? "." : rel;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.sandboxBlocked()) {
      return {
        stdout: "",
        stderr:
          "local sandbox unavailable: required OS-level isolation could not start. Use E2B, SSH, or a connector instead.",
        exitCode: 126,
        timedOut: false,
      };
    }
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const { file, args } = this.buildExecArgv(command);

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(file, args, {
        cwd: this.root,
        detached: true,
        env: this.buildEnv(),
        ...(this.dropCreds ?? {}),
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const MAX = 256 * 1024;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        resolve({
          stdout: stdout.slice(0, MAX),
          stderr: stderr.slice(0, MAX),
          exitCode,
          timedOut,
        });
      };

      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      };

      const onAbort = () => {
        killTree();
        finish(130);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        finish(124);
      }, timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort);
      }

      child.stdout?.on("data", (d) => {
        if (stdout.length < MAX) stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        if (stderr.length < MAX) stderr += d.toString();
      });
      child.on("error", (err) => {
        stderr += String(err);
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 0));
    });
  }

  execStream(command: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): ExecStream {
    const { file, args } = this.buildExecArgv(command);
    const child = spawn(file, args, {
      cwd: this.root,
      detached: true,
      env: this.buildEnv(),
      ...(this.dropCreds ?? {}),
    });
    const abort = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    };
    const timer = setTimeout(abort, opts.timeoutMs ?? 180_000);
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    const done = new Promise<number>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", abort);
        resolve(code ?? 0);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
    });
    return { stdout: child.stdout as Readable, abort, done };
  }

  async openPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    if (this.sandboxBlocked()) {
      opts.onData(
        new TextEncoder().encode(
          "\r\n[sandbox] local terminal unavailable: required OS-level isolation could not start. Use E2B, SSH, or a connector instead.\r\n",
        ),
      );
      opts.onExit(126);
      return { write: () => {}, resize: () => {}, kill: () => {} };
    }
    const pty = await import("@homebridge/node-pty-prebuilt-multiarch");
    const { file, args } = bwrapAvailable()
      ? {
          file: "bwrap",
          args: [...buildBwrapArgs({ root: this.root, mode: this.mode, networkAccess: this.networkAccess, tty: true }), "/bin/bash", "-l"],
        }
      : { file: "/bin/bash", args: ["-l"] };
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: this.root,
      env: { ...this.buildEnv(), TERM: "xterm-256color" } as Record<string, string>,
      ...(this.dropCreds ?? {}),
    });
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      opts.onExit(code);
    };
    const encoder = new TextEncoder();
    proc.onData((d) => opts.onData(encoder.encode(d)));
    proc.onExit(({ exitCode }) => finish(exitCode));
    return {
      write: (data) => proc.write(Buffer.from(data).toString("utf8")),
      resize: (cols, rows) => {
        try {
          proc.resize(cols, rows);
        } catch {
        }
      },
      kill: () => {
        try {
          proc.kill();
        } catch {
        }
      },
    };
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.root,
      TMPDIR: os.tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      TERM: "dumb",
      AGENT_WEB_SANDBOX: "1",
      ...(this.sandboxUid ? { USER: `agentweb${this.sandboxUid}`, LOGNAME: `agentweb${this.sandboxUid}` } : {}),
      ...proxyEnv(this.proxyUrl),
    };
  }

  private sandboxBlocked(): boolean {
    if (!IS_LINUX) return false;
    if (bwrapAvailable()) return false;
    return process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL !== "1";
  }

  private buildExecArgv(command: string): { file: string; args: string[] } {
    if (SEATBELT) {
      const profile = this.seatbeltProfile();
      return {
        file: "/usr/bin/sandbox-exec",
        args: ["-p", profile, "/bin/bash", "-lc", command],
      };
    }
    if (bwrapAvailable()) {
      const wrap = buildBwrapArgs({ root: this.root, mode: this.mode, networkAccess: this.networkAccess, tty: false });
      return { file: "bwrap", args: [...wrap, "/bin/bash", "-lc", command] };
    }
    return { file: "/bin/bash", args: ["-lc", command] };
  }

  private seatbeltProfile(): string {
    const root = this.root;
    const tmp = os.tmpdir();
    const net = this.networkAccess ? "(allow network*)" : "(deny network*)";
    const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
    if (this.mode !== "read-only") {
      lines.push(
        `(allow file-write* (subpath "${root}") (subpath "${tmp}") ` +
          `(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") ` +
          `(literal "/dev/dtracehelper") (literal "/dev/tty") (subpath "/dev/fd"))`,
      );
    }
    lines.push(net);
    return lines.join("\n");
  }

  private async openInsideRoot(relPath: string, flags: number): Promise<fsp.FileHandle> {
    const abs = this.resolve(relPath);
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(abs, flags | fs.constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`refusing to follow a symlink at the path: ${relPath}`);
      }
      throw e;
    }
    try {
      const real =
        process.platform === "linux"
          ? await fsp.realpath(`/proc/self/fd/${fh.fd}`)
          : await fsp.realpath(abs);
      const rootWithSep = this.root + path.sep;
      if (!(real === this.root || real.startsWith(rootWithSep))) {
        throw new Error(`path escapes workspace (resolved to ${real}): ${relPath}`);
      }
    } catch (e) {
      await fh.close();
      throw e;
    }
    return fh;
  }

  async readFile(relPath: string): Promise<string> {
    const fh = await this.openInsideRoot(relPath, fs.constants.O_RDONLY);
    try {
      return await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  }

  async statFile(relPath: string): Promise<FileEntry | null> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await this.openInsideRoot(relPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile() && !st.isDirectory()) return null;
      const clean = relPath.replace(/^[/\\]+/, "") || ".";
      return {
        name: path.basename(clean),
        path: clean,
        kind: st.isDirectory() ? "directory" : "file",
        size: st.size,
        modifiedAt: Math.floor(st.mtimeMs),
        version: localFileVersion(st),
      };
    } finally {
      await fh.close();
    }
  }

  async readFileBytes(relPath: string): Promise<Uint8Array> {
    const fh = await this.openInsideRoot(relPath, fs.constants.O_RDONLY);
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  async *readFileChunks(relPath: string, opts: ReadFileChunksOptions = {}): AsyncGenerator<Uint8Array> {
    const start = Math.max(0, Math.floor(opts.start ?? 0));
    const endExclusive = opts.endExclusive == null ? null : Math.max(start, Math.floor(opts.endExclusive));
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("file read aborted");
    const fh = await this.openInsideRoot(relPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let position = start;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error("preview source is not a regular file");
      if (opts.expectedVersion && localFileVersion(st) !== opts.expectedVersion) {
        throw new Error("preview file changed before read");
      }
      while (endExclusive == null || position < endExclusive) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("file read aborted");
        const length = Math.min(64 * 1024, endExclusive == null ? 64 * 1024 : endExclusive - position);
        if (length <= 0) break;
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(chunk, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        yield bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead);
      }
    } finally {
      await fh.close();
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    if (!this.canWrite()) throw new Error("workspace is read-only");
    await this.writeViaFd(relPath, Buffer.from(content, "utf8"));
  }

  async writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void> {
    if (!opts?.allowReadOnly && !this.canWrite()) throw new Error("workspace is read-only");
    await this.writeViaFd(relPath, Buffer.from(data));
  }

  private async writeViaFd(relPath: string, data: Buffer): Promise<void> {
    const abs = this.resolve(relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const fh = await this.openInsideRoot(relPath, fs.constants.O_WRONLY | fs.constants.O_CREAT);
    try {
      await fh.truncate(0);
      await fh.write(data, 0, data.length, 0);
    } finally {
      await fh.close();
    }
    await this.chownToSandbox(abs);
  }

  async listDir(relPath: string): Promise<FileEntry[]> {
    const fh = await this.openInsideRoot(relPath || ".", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    let dirents: fs.Dirent[];
    let realDir: string;
    try {
      realDir = process.platform === "linux" ? await fsp.realpath(`/proc/self/fd/${fh.fd}`) : this.resolve(relPath || ".");
      const readFrom = process.platform === "linux" ? `/proc/self/fd/${fh.fd}` : realDir;
      dirents = await fsp.readdir(readFrom, { withFileTypes: true });
    } finally {
      await fh.close();
    }
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (d.name === ".git") continue;
      const childAbs = path.join(realDir, d.name);
      let size = 0;
      let modifiedAt = 0;
      let version: string | undefined;
      try {
        const st = await fsp.lstat(childAbs);
        size = st.size;
        modifiedAt = st.mtimeMs;
        version = localFileVersion(st);
      } catch {
      }
      entries.push({
        name: d.name,
        path: this.toRel(childAbs),
        kind: d.isDirectory() ? "directory" : "file",
        size,
        modifiedAt,
        version,
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }
}

const SSH_REMOTE_ROOT = process.env.AGENT_WEB_SSH_REMOTE_ROOT || "/tmp/oiia";

export interface CreateSandboxOptions {
  kind?: SandboxKind;
  sandboxId?: string | null;
  onSandboxId?: (id: string) => void;
  proxyUrl?: string | null;
  sshTarget?: SSHTarget;
  sshUnconfined?: boolean;
  connectorTarget?: { id: string; workspaceRoot: string; unconfined?: boolean; expectedGeneration?: string };
  onConnecting?: (connecting: boolean) => void;
  snapshotId?: string | null;
  onSnapshotId?: (snapshotId: string) => void;
  e2bExistingOnly?: boolean;
}

export function createSandbox(
  userId: string,
  sessionId: string,
  mode: SandboxMode,
  opts: CreateSandboxOptions = {},
): Sandbox {
  if (opts.kind === "e2b") {
    return new E2BSandbox({ userId, mode, sandboxId: opts.sandboxId ?? undefined, onSandboxId: opts.onSandboxId, proxyUrl: opts.proxyUrl, onConnecting: opts.onConnecting, snapshotId: opts.snapshotId ?? undefined, onSnapshotId: opts.onSnapshotId, existingOnly: opts.e2bExistingOnly });
  }
  if (opts.kind === "ssh" && opts.sshTarget) {
    return new SSHSandbox({ root: `${SSH_REMOTE_ROOT}/${sessionId}`, mode, target: opts.sshTarget, unconfined: opts.sshUnconfined, onConnecting: opts.onConnecting });
  }
  if (opts.kind === "connector") {
    if (!opts.connectorTarget) throw new Error("connector target missing");
    return new ConnectorSandbox({
      connectorId: opts.connectorTarget.id,
      sessionId,
      mode,
      workspaceRoot: opts.connectorTarget.workspaceRoot,
      unconfined: opts.connectorTarget.unconfined,
      expectedGeneration: opts.connectorTarget.expectedGeneration,
    });
  }
  const root = workspacePathFor(userId, sessionId);
  fs.mkdirSync(root, { recursive: true });
  let sandboxUid: number | undefined;
  if (UID_DROP) {
    hardenSharedDataPaths();
    sandboxUid = userDao.sandboxUid(userId);
    try {
      fs.chownSync(path.dirname(root), sandboxUid, sandboxUid);
      fs.chmodSync(path.dirname(root), 0o700);
      fs.chownSync(root, sandboxUid, sandboxUid);
      fs.chmodSync(root, 0o700);
    } catch {
    }
    ensureSandboxIdentity(sandboxUid, path.dirname(root));
  }
  return new LocalSandbox(root, mode, opts.proxyUrl, sandboxUid);
}
