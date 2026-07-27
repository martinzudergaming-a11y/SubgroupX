import type { Readable } from "node:stream";
import type { SandboxMode, FileEntry } from "../../../shared/src/protocol.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReadFileChunksOptions {
  start?: number;
  endExclusive?: number;
  signal?: AbortSignal;
  expectedVersion?: string;
}

export interface ExecStream {
  stdout: Readable;
  abort(): void;
  done: Promise<number>;
}

export interface SandboxLoad {
  cpuPct: number;
  memUsed: number;
  memTotal: number;
}

export interface PtySpawnOpts {
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

export interface PtyHandle {
  write(data: Uint8Array): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  kill(): void | Promise<void>;
}

export interface Sandbox {
  readonly root: string;
  readonly mode: SandboxMode;
  resolve(relPath: string): string;
  toRel(absPath: string): string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  execStream?(command: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): ExecStream;
  readFile(relPath: string): Promise<string>;
  statFile(relPath: string): Promise<FileEntry | null>;
  readFileBytes(relPath: string): Promise<Uint8Array>;
  readFileChunks(relPath: string, opts?: ReadFileChunksOptions): AsyncIterable<Uint8Array>;
  writeFile(relPath: string, content: string): Promise<void>;
  writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void>;
  listDir(relPath: string): Promise<FileEntry[]>;
  canWrite(): boolean;
  metrics?(): Promise<SandboxLoad | null>;
  openPty(opts: PtySpawnOpts): Promise<PtyHandle>;
  close?(): void;
}
