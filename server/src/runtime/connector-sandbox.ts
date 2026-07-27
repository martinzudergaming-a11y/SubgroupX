import path from "node:path";
import { connectorManager } from "./connector-manager.ts";
import type { FileEntry, SandboxMode } from "../../../shared/src/protocol.ts";
import type { ExecOptions, ExecResult, PtyHandle, PtySpawnOpts, ReadFileChunksOptions, Sandbox, SandboxLoad } from "./sandbox.ts";

const CONNECTOR_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

function connectorRangeUpgradeRequired(): Error {
  const error = new Error("connector daemon update required for bounded file previews");
  error.name = "ConnectorDaemonUpgradeRequiredError";
  return error;
}

export interface ConnectorSandboxOptions {
  connectorId: string;
  sessionId: string;
  mode: SandboxMode;
  workspaceRoot: string;
  unconfined?: boolean;
  expectedGeneration?: string;
}

export class ConnectorSandbox implements Sandbox {
  readonly root: string;
  readonly mode: SandboxMode;
  private readonly connectorId: string;
  private readonly sessionId: string;
  private readonly unconfined: boolean;
  private readonly expectedGeneration?: string;
  private statCapabilityMissing = false;
  private rangeCapabilityMissing = false;

  constructor(opts: ConnectorSandboxOptions) {
    this.connectorId = opts.connectorId;
    this.sessionId = opts.sessionId;
    this.mode = opts.mode;
    this.unconfined = opts.unconfined ?? false;
    this.expectedGeneration = opts.expectedGeneration;
    this.root = this.unconfined
      ? opts.workspaceRoot.replace(/\\/g, "/") || "~"
      : path.posix.join(opts.workspaceRoot.replace(/\\/g, "/"), opts.sessionId);
  }

  canWrite(): boolean {
    return this.mode !== "read-only";
  }

  resolve(relPath: string): string {
    const rel = this.cleanRel(relPath);
    if (rel === ".") return this.root;
    if (this.unconfined && path.posix.isAbsolute(rel)) return rel;
    return path.posix.join(this.root, rel);
  }

  toRel(absPath: string): string {
    const root = this.root.endsWith("/") ? this.root : this.root + "/";
    if (absPath === this.root) return ".";
    if (absPath.startsWith(root)) return absPath.slice(root.length) || ".";
    return absPath;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return await connectorManager.exec(
      this.connectorId,
      { sessionId: this.sessionId, command, timeoutMs: opts.timeoutMs, unconfined: this.unconfined },
      opts.signal,
    );
  }

  async readFile(relPath: string): Promise<string> {
    return await connectorManager.readFile(this.connectorId, this.sessionId, this.cleanRel(relPath), this.unconfined);
  }

  async readFileBytes(relPath: string): Promise<Uint8Array> {
    return await connectorManager.readFileBytes(this.connectorId, this.sessionId, this.cleanRel(relPath), this.unconfined, undefined, this.expectedGeneration);
  }

  async statFile(relPath: string): Promise<FileEntry | null> {
    const clean = this.cleanRel(relPath);
    const statCapability = this.statCapabilityMissing
      ? false
      : connectorManager.connectionCapability(this.connectorId, "file.stat.v1", this.expectedGeneration);
    if (statCapability === false) return await this.statFileFromParentList(clean);
    try {
      return await connectorManager.statFile(this.connectorId, this.sessionId, clean, this.unconfined, undefined, this.expectedGeneration);
    } catch (error) {
      if (statCapability === true || !/unknown connector method|method not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
      this.statCapabilityMissing = true;
      return await this.statFileFromParentList(clean);
    }
  }

  async *readFileChunks(relPath: string, opts: ReadFileChunksOptions = {}): AsyncGenerator<Uint8Array> {
    const start = Math.max(0, Math.floor(opts.start ?? 0));
    const endExclusive = opts.endExclusive == null ? null : Math.max(start, Math.floor(opts.endExclusive));
    const clean = this.cleanRel(relPath);
    if (endExclusive === start) return;
    const rangeCapability = this.rangeCapabilityMissing
      ? false
      : connectorManager.connectionCapability(this.connectorId, "file.range.v1", this.expectedGeneration);
    if (endExclusive != null) {
      if (rangeCapability === false) throw connectorRangeUpgradeRequired();
      let offset = start;
      try {
        for (; offset < endExclusive; ) {
          if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("file read aborted");
          const next = Math.min(endExclusive, offset + CONNECTOR_RANGE_CHUNK_BYTES);
          const requested = next - offset;
          const chunk = await connectorManager.readFileRange(
            this.connectorId,
            this.sessionId,
            clean,
            offset,
            next,
            this.unconfined,
            opts.signal,
            this.expectedGeneration,
            opts.expectedVersion,
          );
          if (chunk.byteLength === 0) break;
          if (chunk.byteLength > requested) throw new Error("connector range returned too many bytes");
          yield chunk;
          offset += chunk.byteLength;
          if (chunk.byteLength < requested) break;
        }
        return;
      } catch (error) {
        if (
          rangeCapability === true || offset !== start ||
          !/unknown connector method|method not found/i.test(error instanceof Error ? error.message : String(error))
        ) throw error;
        this.rangeCapabilityMissing = true;
        throw connectorRangeUpgradeRequired();
      }
    }
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("file read aborted");
    let bytes: Uint8Array;
    try {
      bytes = await connectorManager.readFileBytes(this.connectorId, this.sessionId, clean, this.unconfined, opts.signal, this.expectedGeneration);
    } catch (error) {
      if (/file too large/i.test(error instanceof Error ? error.message : String(error))) {
        throw connectorRangeUpgradeRequired();
      }
      throw error;
    }
    yield bytes.subarray(start, endExclusive ?? bytes.byteLength);
  }

  private async statFileFromParentList(clean: string): Promise<FileEntry | null> {
    const slash = clean.lastIndexOf("/");
    const dir = slash >= 0 ? clean.slice(0, slash) || "." : ".";
    const name = slash >= 0 ? clean.slice(slash + 1) : clean;
    const entries = await connectorManager.listDir(this.connectorId, this.sessionId, dir, this.unconfined, this.expectedGeneration);
    return entries.find((entry) => entry.path === clean || entry.name === name) ?? null;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    if (!this.canWrite()) throw new Error("workspace is read-only");
    await connectorManager.writeFile(this.connectorId, this.sessionId, this.cleanRel(relPath), content, this.unconfined);
  }

  async writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void> {
    if (!opts?.allowReadOnly && !this.canWrite()) throw new Error("workspace is read-only");
    await connectorManager.writeFileBytes(this.connectorId, this.sessionId, this.cleanRel(relPath), data, this.unconfined);
  }

  async listDir(relPath: string): Promise<FileEntry[]> {
    return await connectorManager.listDir(this.connectorId, this.sessionId, this.cleanRel(relPath || "."), this.unconfined, this.expectedGeneration);
  }

  async metrics(): Promise<SandboxLoad | null> {
    return await connectorManager.metrics(this.connectorId);
  }

  async openPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    return await connectorManager.openPty(this.connectorId, {
      sessionId: this.sessionId,
      cols: opts.cols,
      rows: opts.rows,
      onData: opts.onData,
      onExit: opts.onExit,
      unconfined: this.unconfined,
    });
  }

  private cleanRel(relPath: string): string {
    if (this.unconfined) {
      const raw = String(relPath || ".").replace(/\\/g, "/");
      return path.posix.normalize(raw) || ".";
    }
    const raw = String(relPath || ".").replace(/\\/g, "/").replace(/^\/+/, "");
    const rel = path.posix.normalize(raw || ".");
    if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return rel === "." ? "." : rel;
  }
}
