import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Sandbox as E2B, NotFoundError, SandboxNotFoundError, FileNotFoundError, TimeoutError, FileType } from "e2b";
import type { SandboxMode, FileEntry } from "../../../shared/src/protocol.ts";
import type { Sandbox, ExecResult, ExecOptions, ReadFileChunksOptions, SandboxLoad, PtyHandle, PtySpawnOpts } from "./sandbox.ts";
import {
  ExecutorUnavailableError,
  assertE2BNewEnvironmentAvailable,
  observeE2BCapacityError,
} from "./executor-availability.ts";
import { proxyEnv } from "./proxy-env.ts";

const IDLE_MS = Number(process.env.AGENT_WEB_E2B_IDLE_MS || 120_000);
const KEEPALIVE_MS = Math.max(IDLE_MS * 3, 300_000);
const MAX_PER_USER = Number(process.env.AGENT_WEB_E2B_MAX || 3);
const TEMPLATE = process.env.AGENT_WEB_E2B_TEMPLATE || "";
const EXEC_TIMEOUT_MS = 60_000;
const PTY_MAX_MS = Number(process.env.AGENT_WEB_PTY_MAX_MS || 3_600_000);
const ROOT = "/home/user";
const CONNECT_REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 2_500] as const;
const OP_RETRY_DELAYS_MS = [250, 750] as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function apiKey(): string {
  const k = process.env.AGENT_WEB_E2B_KEY;
  if (!k) throw new Error("E2B is not configured (missing AGENT_WEB_E2B_KEY).");
  return k;
}

async function enforceQuota(userId: string): Promise<void> {
  try {
    const paginator = E2B.list({
      query: { metadata: { userId, app: "oiia" }, state: ["running", "paused"] },
      apiKey: apiKey(),
    });
    const all: { sandboxId: string; startedAt: Date }[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const items = await paginator.nextItems();
      for (const it of items) all.push({ sandboxId: it.sandboxId, startedAt: it.startedAt });
      if (!paginator.hasNext) break;
    }
    if (all.length < MAX_PER_USER) return;
    all.sort((a, b) => +a.startedAt - +b.startedAt);
    const toEvict = all.length - MAX_PER_USER + 1;
    for (let i = 0; i < toEvict; i++) {
      await E2B.kill(all[i].sandboxId, { apiKey: apiKey() }).catch(() => {});
    }
  } catch (e) {
    if (observeE2BCapacityError(e)) {
      throw new ExecutorUnavailableError("e2b", "capacity_unavailable", { cause: e });
    }
    console.error("[e2b] quota check failed:", e instanceof Error ? e.message : e);
  }
}

export class E2BSandbox implements Sandbox {
  readonly root = ROOT;
  readonly mode: SandboxMode;
  private readonly userId: string;
  private sandboxId?: string;
  private readonly onSandboxId?: (id: string) => void;
  private readonly onConnecting?: (connecting: boolean) => void;
  private sbxPromise: Promise<E2B> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pausePromise: Promise<void> | null = null;
  private activeOps = 0;
  private readonly proxyUrl?: string | null;
  private snapshotId?: string;
  private readonly onSnapshotId?: (snapshotId: string) => void;
  private dirty = false;
  private readonly existingOnly: boolean;

  constructor(opts: {
    userId: string;
    mode: SandboxMode;
    sandboxId?: string;
    onSandboxId?: (id: string) => void;
    proxyUrl?: string | null;
    onConnecting?: (connecting: boolean) => void;
    snapshotId?: string;
    onSnapshotId?: (snapshotId: string) => void;
    existingOnly?: boolean;
  }) {
    this.userId = opts.userId;
    this.mode = opts.mode;
    this.sandboxId = opts.sandboxId || undefined;
    this.onSandboxId = opts.onSandboxId;
    this.proxyUrl = opts.proxyUrl;
    this.onConnecting = opts.onConnecting;
    this.snapshotId = opts.snapshotId || undefined;
    this.onSnapshotId = opts.onSnapshotId;
    this.existingOnly = opts.existingOnly ?? false;
  }

  private markDirty(): void {
    if (this.canWrite()) this.dirty = true;
  }

  canWrite(): boolean {
    return this.mode !== "read-only";
  }

  async metrics(): Promise<SandboxLoad | null> {
    if (!this.sandboxId) return null;
    try {
      const series = await E2B.getMetrics(this.sandboxId, { apiKey: apiKey() });
      const last = series[series.length - 1];
      if (!last) return null;
      return { cpuPct: Math.round(last.cpuUsedPct), memUsed: last.memUsed, memTotal: last.memTotal };
    } catch {
      return null;
    }
  }

  resolve(relPath: string): string {
    const clean = relPath.replace(/^[/\\]+/, "");
    const abs = path.posix.normalize(path.posix.join(ROOT, clean));
    if (abs !== ROOT && !abs.startsWith(ROOT + "/")) throw new Error(`path escapes workspace: ${relPath}`);
    return abs;
  }

  toRel(absPath: string): string {
    const rel = path.posix.relative(ROOT, absPath);
    return rel === "" ? "." : rel;
  }

  private errorText(e: unknown): string {
    return e instanceof Error ? `${e.name}: ${e.message}`.toLowerCase() : String(e).toLowerCase();
  }

  private isSandboxNotFound(e: unknown): boolean {
    if (e instanceof FileNotFoundError) return false;
    if (e instanceof SandboxNotFoundError) return true;
    if (e instanceof NotFoundError) {
      const s = this.errorText(e);
      return s.includes("sandbox") || !s.includes("file");
    }
    const s = this.errorText(e);
    return s.includes("sandbox") && s.includes("not found");
  }

  private isTransientConnectError(e: unknown): boolean {
    if (this.isSandboxNotFound(e)) return false;
    if ((e as { name?: string })?.name === "AbortError") return false;
    const s = this.errorText(e);
    return (
      e instanceof TimeoutError ||
      s.includes("timeout") ||
      s.includes("timed out") ||
      s.includes("deadline_exceeded") ||
      s.includes("unavailable") ||
      s.includes("fetch failed") ||
      s.includes("econnreset") ||
      s.includes("socket") ||
      s.includes("network") ||
      s.includes("canceled") ||
      /\b5\d\d\b/.test(s)
    );
  }

  private isRecoverableSandboxError(e: unknown): boolean {
    if (this.isSandboxNotFound(e)) return true;
    if (e instanceof FileNotFoundError) return false;
    if ((e as { name?: string })?.name === "AbortError") return false;
    const s = this.errorText(e);
    if (s.includes("file not found") || s.includes("no such file") || s.includes("directory not found")) return false;
    return (
      (s.includes("sandbox") || s.includes("envd")) &&
      (s.includes("paused") ||
        s.includes("not running") ||
        s.includes("not ready") ||
        s.includes("unavailable") ||
        s.includes("resume") ||
        s.includes("expired") ||
        s.includes("killed") ||
        s.includes("connection") ||
        s.includes("fetch failed") ||
        s.includes("econnreset"))
    );
  }

  private beginOperation(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.activeOps++;
  }

  private endOperation(): void {
    this.activeOps = Math.max(0, this.activeOps - 1);
    if (this.activeOps === 0) this.armIdlePause();
  }

  private invalidateSandbox(promise?: Promise<E2B>, cause?: unknown): void {
    if (!promise || this.sbxPromise === promise) {
      this.sbxPromise = null;
      if (cause && this.isSandboxNotFound(cause)) this.sandboxId = undefined;
    }
  }

  private async ensureLease(): Promise<{ sbx: E2B; promise: Promise<E2B> }> {
    if (this.pausePromise) await this.pausePromise;
    if (!this.sbxPromise) this.sbxPromise = this.acquire();
    const promise = this.sbxPromise;
    try {
      return { sbx: await promise, promise };
    } catch (e) {
      if (this.sbxPromise === promise) this.sbxPromise = null;
      throw e;
    }
  }

  private async acquire(): Promise<E2B> {
    this.onConnecting?.(true);
    try {
      const key = apiKey();
      if (this.sandboxId) {
        const id = this.sandboxId;
        for (let attempt = 0; ; attempt++) {
          try {
            return await E2B.connect(id, { apiKey: key, timeoutMs: KEEPALIVE_MS, requestTimeoutMs: CONNECT_REQUEST_TIMEOUT_MS });
          } catch (e) {
            if (observeE2BCapacityError(e)) {
              throw new ExecutorUnavailableError("e2b", "capacity_unavailable", { cause: e });
            }
            if (this.isSandboxNotFound(e)) {
              if (this.existingOnly) throw new Error("the existing E2B sandbox is no longer available", { cause: e });
              if (this.sandboxId === id) this.sandboxId = undefined;
              break;
            }
            const delay = CONNECT_RETRY_DELAYS_MS[attempt];
            if (delay === undefined || !this.isTransientConnectError(e)) throw e;
            await sleep(delay);
          }
        }
      }
      if (this.existingOnly) throw new Error("an existing E2B sandbox is required for file access");
      assertE2BNewEnvironmentAvailable();
      await enforceQuota(this.userId);
      const opts = {
        apiKey: key,
        metadata: { userId: this.userId, app: "oiia" },
        timeoutMs: KEEPALIVE_MS,
        requestTimeoutMs: CONNECT_REQUEST_TIMEOUT_MS,
        autoPause: true,
      };
      if (this.snapshotId) {
        try {
          const restored = await E2B.create(this.snapshotId, opts);
          this.sandboxId = restored.sandboxId;
          this.onSandboxId?.(restored.sandboxId);
          return restored;
        } catch (e) {
          if (e instanceof ExecutorUnavailableError) throw e;
          if (observeE2BCapacityError(e)) {
            throw new ExecutorUnavailableError("e2b", "capacity_unavailable", { cause: e });
          }
          console.error("[e2b] #67 restore from snapshot failed, creating blank:", e instanceof Error ? e.message : e);
        }
      }
      let sbx: E2B;
      try {
        sbx = TEMPLATE ? await E2B.create(TEMPLATE, opts) : await E2B.create(opts);
      } catch (e) {
        if (observeE2BCapacityError(e)) {
          throw new ExecutorUnavailableError("e2b", "capacity_unavailable", { cause: e });
        }
        throw e;
      }
      this.sandboxId = sbx.sandboxId;
      this.onSandboxId?.(sbx.sandboxId);
      return sbx;
    } finally {
      this.onConnecting?.(false);
    }
  }

  private async keepAlive(sbx: E2B): Promise<void> {
    try {
      await sbx.setTimeout(KEEPALIVE_MS);
    } catch (e) {
      if (this.isRecoverableSandboxError(e)) throw e;
    }
  }

  private armIdlePause(): void {
    if (this.activeOps > 0 || !this.sbxPromise) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.pauseNow(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  private async pauseNow(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.activeOps > 0) return;
    if (this.pausePromise) return await this.pausePromise;
    const pending = this.sbxPromise;
    if (!pending) return;
    const pause = this.pauseSandbox(pending);
    this.pausePromise = pause;
    try {
      await pause;
    } finally {
      if (this.pausePromise === pause) this.pausePromise = null;
    }
  }

  private async pauseSandbox(pending: Promise<E2B>): Promise<void> {
    try {
      const sbx = await pending;
      if (this.activeOps > 0 || this.sbxPromise !== pending) return;
      if (this.dirty) {
        try {
          const prev = this.snapshotId;
          const info = await sbx.createSnapshot();
          this.snapshotId = info.snapshotId;
          this.onSnapshotId?.(info.snapshotId);
          this.dirty = false;
          if (prev && prev !== info.snapshotId) {
            void E2B.deleteSnapshot(prev, { apiKey: apiKey() }).catch(() => {});
          }
        } catch (e) {
          if (this.isSandboxNotFound(e)) throw e;
          console.error("[e2b] #67 snapshot-on-pause failed, plain pause:", e instanceof Error ? e.message : e);
          await sbx.betaPause();
        }
      } else {
        await sbx.betaPause();
      }
      if (this.sbxPromise === pending) this.sbxPromise = null;
    } catch (e) {
      this.invalidateSandbox(pending, e);
      console.error("[e2b] idle pause failed:", e instanceof Error ? e.message : e);
    }
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async withSandbox<T>(fn: (sbx: E2B) => Promise<T>): Promise<T> {
    this.beginOperation();
    try {
      for (let attempt = 0; ; attempt++) {
        let lease: { sbx: E2B; promise: Promise<E2B> } | undefined;
        try {
          lease = await this.ensureLease();
          await this.keepAlive(lease.sbx);
          return await fn(lease.sbx);
        } catch (e) {
          const delay = OP_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !this.isRecoverableSandboxError(e)) throw e;
          this.invalidateSandbox(lease?.promise, e);
          await sleep(delay);
        }
      }
    } finally {
      this.endOperation();
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
    try {
      return await this.withSandbox(async (sbx) => {
        this.markDirty();
        const handle = await sbx.commands.run(command, { cwd: ROOT, background: true, envs: proxyEnv(this.proxyUrl) });
        let timedOut = false;
        let aborted = false;
        const kill = () => void handle.kill().catch(() => {});
        const onAbort = () => {
          aborted = true;
          kill();
        };
        const signal = opts.signal;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        try {
          const res = await handle.wait();
          return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exitCode ?? 0, timedOut: false };
        } catch (e) {
          const ce = e as { exitCode?: number; stdout?: string; stderr?: string };
          if (timedOut) return { stdout: ce?.stdout ?? "", stderr: ce?.stderr ?? "command timed out", exitCode: 124, timedOut: true };
          if (aborted) return { stdout: ce?.stdout ?? "", stderr: ce?.stderr ?? "interrupted", exitCode: 130, timedOut: false };
          if (ce && typeof ce.exitCode === "number") return { stdout: ce.stdout ?? "", stderr: ce.stderr ?? "", exitCode: ce.exitCode, timedOut: false };
          throw e;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      });
    } catch (e) {
      const ce = e as { exitCode?: number; stdout?: string; stderr?: string };
      if (ce && typeof ce.exitCode === "number") {
        return { stdout: ce.stdout ?? "", stderr: ce.stderr ?? "", exitCode: ce.exitCode, timedOut: false };
      }
      throw e;
    }
  }

  async openPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    this.beginOperation();
    let finished = false;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      this.endOperation();
      opts.onExit(code);
    };
    try {
      const { sbx } = await this.ensureLease();
      this.markDirty();
      await this.keepAlive(sbx);
      const handle = await sbx.pty.create({
        cols: opts.cols,
        rows: opts.rows,
        timeoutMs: PTY_MAX_MS,
        onData: (d) => opts.onData(d),
      });
      const pid = handle.pid;
      keepalive = setInterval(() => void sbx.setTimeout(KEEPALIVE_MS).catch(() => {}), IDLE_MS / 2);
      keepalive.unref?.();
      void handle
        .wait()
        .then((r) => finish(r.exitCode ?? 0))
        .catch(() => finish(null));
      return {
        write: async (data) => {
          await sbx.pty.sendInput(pid, data);
        },
        resize: async (cols, rows) => {
          await sbx.pty.resize(pid, { cols, rows });
        },
        kill: async () => {
          await handle.kill().catch(() => {});
          finish(130);
        },
      };
    } catch (e) {
      finish(null);
      throw e;
    }
  }

  async readFile(relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
    return await this.withSandbox((sbx) => sbx.files.read(abs));
  }

  async statFile(relPath: string): Promise<FileEntry | null> {
    const abs = this.resolve(relPath);
    try {
      const entry = await this.withSandbox((sbx) => sbx.files.getInfo(abs));
      return {
        name: entry.name,
        path: this.toRel(entry.path),
        kind: entry.type === FileType.DIR ? "directory" : "file",
        size: entry.size ?? 0,
        modifiedAt: entry.modifiedTime ? Math.floor(+new Date(entry.modifiedTime)) : 0,
      };
    } catch (error) {
      if (error instanceof FileNotFoundError || /file not found|no such file/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
  }

  async readFileBytes(relPath: string): Promise<Uint8Array> {
    const abs = this.resolve(relPath);
    return await this.withSandbox((sbx) => sbx.files.read(abs, { format: "bytes" }));
  }

  async *readFileChunks(relPath: string, opts: ReadFileChunksOptions = {}): AsyncGenerator<Uint8Array> {
    const abs = this.resolve(relPath);
    const start = Math.max(0, Math.floor(opts.start ?? 0));
    const endExclusive = opts.endExclusive == null ? null : Math.max(start, Math.floor(opts.endExclusive));
    const boundedBytes = endExclusive == null ? null : endExclusive - start;

    if (boundedBytes !== null && start > 0) {
      if (boundedBytes === 0) return;
      this.beginOperation();
      try {
        let offset = start;
        while (offset < endExclusive!) {
          const requested = Math.min(4 * 1024 * 1024, endExclusive! - offset);
          const encoded = await this.withSandbox(async (sbx) => {
            const command =
              `set -o pipefail; dd if=${shellQuote(abs)} iflag=skip_bytes,count_bytes skip=${offset} count=${requested} status=none | base64 -w0`;
            const result = await sbx.commands.run(command, { signal: opts.signal, timeoutMs: EXEC_TIMEOUT_MS });
            if (result.exitCode !== 0) throw new Error(result.stderr || `range read failed (${result.exitCode})`);
            return result.stdout;
          });
          const bytes = Buffer.from(encoded.trim(), "base64");
          if (bytes.byteLength > requested) throw new Error("range read returned more bytes than requested");
          if (bytes.byteLength === 0) break;
          yield bytes;
          offset += bytes.byteLength;
          if (bytes.byteLength < requested) break;
        }
        return;
      } finally {
        this.endOperation();
      }
    }

    this.beginOperation();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      let stream: ReadableStream<Uint8Array> | null = null;
      for (let attempt = 0; ; attempt++) {
        let lease: { sbx: E2B; promise: Promise<E2B> } | undefined;
        try {
          lease = await this.ensureLease();
          await this.keepAlive(lease.sbx);
          stream = await lease.sbx.files.read(abs, {
            format: "stream",
            signal: opts.signal,
            streamIdleTimeoutMs: EXEC_TIMEOUT_MS,
          });
          break;
        } catch (error) {
          const delay = OP_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !this.isRecoverableSandboxError(error)) throw error;
          this.invalidateSandbox(lease?.promise, error);
          await sleep(delay);
        }
      }
      reader = stream!.getReader();
      let sourceOffset = 0;
      while (true) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("file read aborted");
        const { value, done } = await reader.read();
        if (done) break;
        const chunkStart = sourceOffset;
        const chunkEnd = sourceOffset + value.byteLength;
        sourceOffset = chunkEnd;
        if (chunkEnd <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = endExclusive == null ? value.byteLength : Math.min(value.byteLength, endExclusive - chunkStart);
        if (to > from) yield value.subarray(from, to);
        if (endExclusive != null && chunkEnd >= endExclusive) break;
      }
    } finally {
      await reader?.cancel().catch(() => {});
      this.endOperation();
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    if (!this.canWrite()) throw new Error("workspace is read-only");
    const abs = this.resolve(relPath);
    await this.withSandbox(async (sbx) => {
      this.dirty = true;
      await sbx.files.write(abs, content);
    });
  }

  async writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void> {
    if (!opts?.allowReadOnly && !this.canWrite()) throw new Error("workspace is read-only");
    const abs = this.resolve(relPath);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.withSandbox(async (sbx) => {
      this.dirty = true;
      await sbx.files.write(abs, ab);
    });
  }

  async listDir(relPath: string): Promise<FileEntry[]> {
    const abs = this.resolve(relPath || ".");
    const entries = await this.withSandbox((sbx) => sbx.files.list(abs));
    const mapped: FileEntry[] = entries
      .filter((e) => e.name !== ".git")
      .map((e) => ({
        name: e.name,
        path: this.toRel(e.path),
        kind: e.type === FileType.DIR ? "directory" : "file",
        size: e.size ?? 0,
        modifiedAt: e.modifiedTime ? +new Date(e.modifiedTime) : 0,
      }));
    mapped.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return mapped;
  }
}
