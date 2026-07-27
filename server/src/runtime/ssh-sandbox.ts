import crypto from "node:crypto";
import { errorMessage } from "../foundation/errors.ts";
import path from "node:path";
import { Client } from "ssh2";
import type { SFTPWrapper, ClientChannel } from "ssh2";
import type { SandboxMode, FileEntry } from "../../../shared/src/protocol.ts";
import type { Sandbox, ExecResult, ExecOptions, ReadFileChunksOptions, SandboxLoad, PtyHandle, PtySpawnOpts } from "./sandbox.ts";
import { resolveSafeSshHost } from "./ssh-guard.ts";
import { logAudit } from "../observability/audit-log.ts";

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("file read aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("file read aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

const EXEC_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 15_000;
const MAX = 256 * 1024;

const MAX_CONCURRENT_EXEC = 6;

const CHANNEL_CLOSE_GRACE_MS = 10_000;

function isChannelOpenFailure(err: unknown): boolean {
  return /channel open failure/i.test(errorMessage(err));
}

const CHANNEL_EXHAUSTED_HINT =
  "ENVIRONMENT FAILURE (not a problem with this command): the remote SSH server refused to open a " +
  "new session channel, because its MaxSessions limit is full — this connection and a freshly " +
  "established one were both refused. Commands that keep running after the tool call that started " +
  "them returned (backgrounded processes, container execs) hold sessions open on the remote and " +
  "cause this. Re-running or rewording the command will NOT help. Tell the user their host is " +
  "refusing new SSH sessions, and that raising MaxSessions in its sshd_config, or ending the " +
  "leftover processes, is what resolves it.";

function isHostKeyRejection(cause: unknown): boolean {
  return /host denied|verification failed|handshake failed/i.test(errorMessage(cause));
}

const HOST_KEY_CHANGED =
  "ENVIRONMENT FAILURE — SECURITY CHECK (not a problem with this command): the SSH host key does " +
  "NOT match the fingerprint pinned when this target was first connected, so the connection was " +
  "refused. Either the host was rebuilt or reprovisioned with a new key, or the connection is " +
  "being intercepted. Do NOT retry, and do NOT work around it. Tell the user their host key " +
  "changed and that they must confirm the new fingerprint out of band before the target is used " +
  "again.";

class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.available = limit;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    };
  }
}

export interface SSHTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string | (() => string);
  hostFingerprint: string | null;
  onFingerprint?: (fp: string) => void;
}

function fingerprintOf(key: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SSHSandbox implements Sandbox {
  readonly root: string;
  readonly mode: SandboxMode;
  private readonly unconfined: boolean;
  private readonly target: SSHTarget;
  private readonly onConnecting?: (connecting: boolean) => void;
  private clientPromise: Promise<Client> | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private readonly execSlots = new Semaphore(MAX_CONCURRENT_EXEC);
  private readonly retiring = new Set<Client>();
  private currentClient: Client | null = null;
  private readonly execCount = new Map<Client, number>();

  constructor(opts: { root: string; mode: SandboxMode; target: SSHTarget; unconfined?: boolean; onConnecting?: (connecting: boolean) => void }) {
    this.root = opts.root;
    this.mode = opts.mode;
    this.unconfined = Boolean(opts.unconfined);
    this.target = opts.target;
    this.onConnecting = opts.onConnecting;
  }

  canWrite(): boolean {
    return this.mode !== "read-only";
  }

  async metrics(): Promise<SandboxLoad | null> {
    return null;
  }

  resolve(relPath: string): string {
    if (this.unconfined) {
      const clean = relPath.trim();
      return path.posix.isAbsolute(clean) ? path.posix.normalize(clean) : clean;
    }
    const clean = relPath.replace(/^[/\\]+/, "");
    const abs = path.posix.normalize(path.posix.join(this.root, clean));
    if (abs !== this.root && !abs.startsWith(this.root + "/")) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  toRel(absPath: string): string {
    if (this.unconfined) return absPath;
    const rel = path.posix.relative(this.root, absPath);
    return rel === "" ? "." : rel;
  }

  private connect(): Promise<Client> {
    if (this.clientPromise) return this.clientPromise;
    this.onConnecting?.(true);
    const promise = (async () => {
      const pinnedIp = await resolveSafeSshHost(this.target.host);
      const privateKey = typeof this.target.privateKey === "function" ? this.target.privateKey() : this.target.privateKey;
      const client = new Client();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        client.on("ready", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        client.on("error", (err) => {
          if (settled) return;
          settled = true;
          this.clientPromise = null;
          reject(err);
        });
        client.on("close", () => {
          if (this.currentClient === client) this.currentClient = null;
          this.retiring.delete(client);
          this.execCount.delete(client);
          if (this.clientPromise === promise) {
            this.clientPromise = null;
            this.sftpPromise = null;
          }
        });
        client.connect({
          host: pinnedIp,
          port: this.target.port,
          username: this.target.username,
          privateKey,
          readyTimeout: READY_TIMEOUT_MS,
          hostVerifier: (key: Buffer): boolean => {
            const fp = fingerprintOf(key);
            if (this.target.hostFingerprint) return fp === this.target.hostFingerprint;
            this.target.hostFingerprint = fp;
            this.target.onFingerprint?.(fp);
            return true;
          },
        });
      }).catch((cause: unknown) => {
        if (isHostKeyRejection(cause)) throw new Error(HOST_KEY_CHANGED);
        throw new Error(
          "ENVIRONMENT FAILURE (not a problem with this command): could not reach the SSH host that " +
            `runs this session's commands (${this.target.host}:${this.target.port}). ` +
            "Check that the machine is up and reachable and that its SSH service is running; " +
            `re-running the command will not help until it is. Cause: ${errorMessage(cause)}`,
        );
      });
      this.currentClient = client;
      return client;
    })();
    this.clientPromise = promise;
    void promise.then(
      () => this.onConnecting?.(false),
      () => {
        if (this.clientPromise === promise) this.clientPromise = null;
        this.onConnecting?.(false);
      },
    );
    return promise;
  }

  private retireConnection(client: Client): void {
    if (this.retiring.has(client)) return;
    this.retiring.add(client);
    if (this.currentClient === client) {
      this.currentClient = null;
      this.clientPromise = null;
      this.sftpPromise = null;
    }
    this.endIfDrained(client);
  }

  private endIfDrained(client: Client): void {
    if (!this.retiring.has(client)) return;
    if ((this.execCount.get(client) ?? 0) > 0) return;
    this.retiring.delete(client);
    this.execCount.delete(client);
    try { client.end(); } catch {  }
  }

  private async openChannel<T>(open: (client: Client) => Promise<T>): Promise<{ client: Client; value: T }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.connect();
      try {
        return { client, value: await open(client) };
      } catch (e) {
        if (!isChannelOpenFailure(e)) throw e;
        logAudit("ssh_channel_exhausted", {
          level: attempt === 0 ? "warn" : "error",
          data: {
            host: this.target.host,
            port: this.target.port,
            recovered: attempt === 0,
            liveExecChannels: this.execCount.get(client) ?? 0,
          },
        });
        this.retireConnection(client);
        if (attempt === 1) throw new Error(CHANNEL_EXHAUSTED_HINT);
      }
    }
    throw new Error(CHANNEL_EXHAUSTED_HINT);
  }

  private async openExecChannel(command: string): Promise<{ client: Client; stream: ClientChannel }> {
    const { client, value: stream } = await this.openChannel((c) =>
      new Promise<ClientChannel>((resolve, reject) => {
        c.exec(command, { pty: false }, (err, s) => (err ? reject(err) : resolve(s)));
      }));
    this.execCount.set(client, (this.execCount.get(client) ?? 0) + 1);
    return { client, stream };
  }

  private releaseExecChannel(client: Client): void {
    const next = (this.execCount.get(client) ?? 1) - 1;
    if (next > 0) this.execCount.set(client, next);
    else this.execCount.delete(client);
    this.endIfDrained(client);
  }

  close(): void {
    for (const client of this.retiring) {
      try { client.end(); } catch {  }
    }
    this.retiring.clear();
    this.execCount.clear();
    this.currentClient = null;
    const promise = this.clientPromise;
    this.clientPromise = null;
    const sftp = this.sftpPromise;
    this.sftpPromise = null;
    if (sftp) sftp.then((channel) => channel.end()).catch(() => {});
    if (promise) {
      promise.then((c) => c.end()).catch(() => {});
    }
  }

  private async withExecChannel<T>(command: string, run: (stream: ClientChannel) => Promise<T>): Promise<T> {
    const release = await this.execSlots.acquire();
    let opened: { client: Client; stream: ClientChannel };
    try {
      opened = await this.openExecChannel(command);
    } catch (e) {
      release();
      throw e;
    }
    const { client, stream } = opened;

    let accounted = true;
    const giveBack = () => {
      if (!accounted) return;
      accounted = false;
      clearTimeout(graceTimer);
      this.releaseExecChannel(client);
      release();
    };
    const graceTimer = setTimeout(giveBack, CHANNEL_CLOSE_GRACE_MS);
    graceTimer.unref?.();
    stream.once("close", giveBack);

    try {
      return await run(stream);
    } catch (e) {
      giveBack();
      throw e;
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
    const wrapped = this.unconfined
      ? `cd "$HOME" 2>/dev/null; ( ${command}\n)`
      : (() => { const root = shellQuote(this.root); return `mkdir -p ${root}; cd ${root} && ( ${command}\n)`; })();

    return await this.withExecChannel(wrapped, (stream) => new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        resolve({ stdout: stdout.slice(0, MAX), stderr: stderr.slice(0, MAX), exitCode, timedOut });
      };

      const stop = () => {
        try {
          stream.close();
        } catch {
        }
      };

      const onAbort = () => { stop(); finish(130); };
      const timer = setTimeout(() => { timedOut = true; stop(); finish(124); }, timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort);
      }

      stream.on("data", (d: Buffer) => {
        if (stdout.length < MAX) stdout += d.toString();
      });
      stream.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX) stderr += d.toString();
      });
      stream.on("close", (code: number | null) => finish(code ?? 0));
      stream.on("error", () => finish(1));
    }));
  }

  async openPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      opts.onExit(code);
    };
    let client: Client;
    try {
      client = await this.connect();
    } catch (e) {
      opts.onData(new TextEncoder().encode(`\r\n[ssh] connection failed: ${errorMessage(e)}\r\n`));
      finish(1);
      return { write: () => {}, resize: () => {}, kill: () => {} };
    }
    return await new Promise<PtyHandle>((resolve) => {
      client.shell({ term: "xterm-256color", cols: opts.cols, rows: opts.rows }, (err, stream: ClientChannel) => {
        if (err) {
          opts.onData(new TextEncoder().encode(`\r\n[ssh] failed to open shell: ${err.message}\r\n`));
          finish(1);
          resolve({ write: () => {}, resize: () => {}, kill: () => {} });
          return;
        }
        if (!this.unconfined) {
          const root = shellQuote(this.root);
          stream.write(`cd ${root} 2>/dev/null || (mkdir -p ${root} && cd ${root})\n`);
        }
        stream.on("data", (chunk: Buffer) => opts.onData(new Uint8Array(chunk)));
        stream.stderr.on("data", (chunk: Buffer) => opts.onData(new Uint8Array(chunk)));
        stream.on("close", () => finish(0));
        resolve({
          write: async (data) => {
            await new Promise<void>((resolve, reject) => {
              stream.write(Buffer.from(data), (err?: Error | null) => {
                if (err) reject(err);
                else resolve();
              });
            });
          },
          resize: (cols, rows) => {
            try {
              stream.setWindow(rows, cols, 0, 0);
            } catch {
            }
          },
          kill: () => {
            try {
              stream.close();
            } catch {
            }
            finish(130);
          },
        });
      });
    });
  }

  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpPromise) return this.sftpPromise;
    const promise = (async () => {
      const { value } = await this.openChannel((client) =>
        new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
        }));
      return value;
    })();
    this.sftpPromise = promise;
    void promise.then(
      (channel) => {
        const clear = () => { if (this.sftpPromise === promise) this.sftpPromise = null; };
        channel.once("close", clear);
        channel.once("error", clear);
      },
      () => { if (this.sftpPromise === promise) this.sftpPromise = null; },
    );
    return promise;
  }

  private async readableSftpPath(sftp: SFTPWrapper, relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
    if (this.unconfined) return abs;
    const realpath = (value: string) => new Promise<string>((resolve, reject) => {
      sftp.realpath(value, (error, resolved) => error ? reject(error) : resolve(resolved));
    });
    const [rootReal, fileReal] = await Promise.all([realpath(this.root), realpath(abs)]);
    const prefix = rootReal.endsWith("/") ? rootReal : `${rootReal}/`;
    if (fileReal !== rootReal && !fileReal.startsWith(prefix)) {
      throw new Error(`path escapes workspace via symlink: ${relPath}`);
    }
    return fileReal;
  }

  private async sftpMkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
    if (dir === "/" || dir === "" || dir === ".") return;
    const exists = await new Promise<boolean>((resolve) => {
      sftp.stat(dir, (err) => resolve(!err));
    });
    if (exists) return;
    await this.sftpMkdirp(sftp, path.posix.dirname(dir));
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(dir, (err) => {
        if (err && !/exists|failure/i.test(String(err.message))) reject(err);
        else resolve();
      });
    });
  }

  async readFile(relPath: string): Promise<string> {
    const sftp = await this.sftp();
    const abs = await this.readableSftpPath(sftp, relPath);
    return await new Promise<string>((resolve, reject) => {
      sftp.readFile(abs, (err, data) => {
        if (err) reject(err);
        else resolve(data.toString("utf8"));
      });
    });
  }

  async statFile(relPath: string): Promise<FileEntry | null> {
    const sftp = await this.sftp();
    let abs: string;
    try {
      abs = await this.readableSftpPath(sftp, relPath);
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      if (code === 2 || code === "ENOENT" || /no such file|not found/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
    return await new Promise<FileEntry | null>((resolve, reject) => {
      sftp.stat(abs, (error, attrs) => {
        if (error) {
          const code = (error as unknown as { code?: string | number }).code;
          if (code === 2 || code === "ENOENT" || /no such file|not found/i.test(error.message)) resolve(null);
          else reject(error);
          return;
        }
        resolve({
          name: path.posix.basename(abs),
          path: this.toRel(abs),
          kind: attrs.isDirectory() ? "directory" : "file",
          size: attrs.size,
          modifiedAt: Math.floor(attrs.mtime * 1000),
        });
      });
    });
  }

  async readFileBytes(relPath: string): Promise<Uint8Array> {
    const sftp = await this.sftp();
    const abs = await this.readableSftpPath(sftp, relPath);
    return await new Promise<Uint8Array>((resolve, reject) => {
      sftp.readFile(abs, (err, data) => {
        if (err) reject(err);
        else resolve(new Uint8Array(data));
      });
    });
  }

  async *readFileChunks(relPath: string, opts: ReadFileChunksOptions = {}): AsyncGenerator<Uint8Array> {
    const start = Math.max(0, Math.floor(opts.start ?? 0));
    const endExclusive = opts.endExclusive == null ? null : Math.max(start, Math.floor(opts.endExclusive));
    if (endExclusive === start) return;
    const sftp = await waitForAbort(this.sftp(), opts.signal);
    const stream = sftp.createReadStream(await this.readableSftpPath(sftp, relPath), {
      start,
      ...(endExclusive == null ? {} : { end: endExclusive - 1 }),
    });
    stream.on("error", () => {});
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const abort = () => stream.destroy(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("file read aborted"));
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) {
        yield typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
      }
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      stream.destroy();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    if (!this.canWrite()) throw new Error("workspace is read-only");
    await this.sftpWrite(this.resolve(relPath), Buffer.from(content, "utf8"));
  }

  async writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void> {
    if (!opts?.allowReadOnly && !this.canWrite()) throw new Error("workspace is read-only");
    await this.sftpWrite(this.resolve(relPath), Buffer.from(data));
  }

  private async sftpWrite(abs: string, data: Buffer): Promise<void> {
    const sftp = await this.sftp();
    await this.sftpMkdirp(sftp, path.posix.dirname(abs));
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(abs, data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async listDir(relPath: string): Promise<FileEntry[]> {
    const sftp = await this.sftp();
    const abs = await this.readableSftpPath(sftp, relPath || ".");
    const list = await new Promise<import("ssh2").FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(abs, (err, l) => {
        if (err) reject(err);
        else resolve(l);
      });
    });
    const entries: FileEntry[] = [];
    for (const e of list) {
      if (e.filename === ".git") continue;
      const childAbs = path.posix.join(abs, e.filename);
      entries.push({
        name: e.filename,
        path: this.toRel(childAbs),
        kind: e.attrs.isDirectory() ? "directory" : "file",
        size: e.attrs.size,
        modifiedAt: e.attrs.mtime * 1000,
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }
}
