import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveSshPrivateKey } from "../runtime/ssh-unlock.ts";
import { createSandbox, type CreateSandboxOptions, type Sandbox, type ExecStream } from "../runtime/sandbox.ts";
import { connectorDao, sessionDao, sshTargetDao, userDao } from "../persistence/index.ts";
import type { SSHTarget } from "../runtime/ssh-sandbox.ts";
import { WarmLeasePool, type WarmLease } from "../runtime/sandbox-lease-pool.ts";
import { connectorManager } from "../runtime/connector-manager.ts";
import { fallbackFileEntryVersion, type FileEntry, type WorkspaceDiff, type DiffFile, type DiffFileStatus } from "../../../shared/src/protocol.ts";

const MAX_PREVIEW = 2 * 1024 * 1024;

type SandboxSpec = {
  key: string;
  owner: string;
  fingerprint: string;
  create(): Sandbox;
};
type ResolvedSpec = SandboxSpec | "no-session" | "no-sandbox-yet";
type Resolved = { sb: Sandbox } | "no-session" | "no-sandbox-yet";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

const configuredPreviewWarmMs = Math.min(envInt("AGENT_WEB_PREVIEW_SANDBOX_WARM_MS", 30_000, 0), 5 * 60_000);
const configuredE2bIdleMs = Number(process.env.AGENT_WEB_E2B_IDLE_MS ?? 120_000);
const previewWarmMs = Number.isFinite(configuredE2bIdleMs) && configuredE2bIdleMs > 0
  ? Math.min(configuredPreviewWarmMs, Math.max(0, configuredE2bIdleMs - 1_000))
  : configuredPreviewWarmMs;
const previewSandboxPool = new WarmLeasePool<Sandbox>({
  warmMs: previewWarmMs,
  maxEntries: envInt("AGENT_WEB_PREVIEW_SANDBOX_WARM_MAX", 24, 1),
  maxEntriesPerOwner: envInt("AGENT_WEB_PREVIEW_SANDBOX_WARM_PER_USER", 3, 1),
});

function sandboxFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function sessionSandboxSpec(userId: string, sessionId: string): ResolvedSpec {
  const row = sessionDao.byId(sessionId);
  if (!row || row.user_id !== userId) return "no-session";
  if (row.sandbox_kind === "e2b" && !row.sandbox_id) return "no-sandbox-yet";
  const opts: CreateSandboxOptions = {
    kind: row.sandbox_kind,
    sandboxId: row.sandbox_id,
    e2bExistingOnly: row.sandbox_kind === "e2b",
    onSandboxId: (id) => sessionDao.setSandboxId(sessionId, id),
    snapshotId: row.e2b_snapshot_id,
    onSnapshotId: (id) => sessionDao.setSnapshotId(sessionId, id),
  };
  const owner = userDao.byId(userId);
  opts.proxyUrl = owner?.proxy_url || owner?.jump_server || null;
  let targetRevision: unknown = null;
  if (row.sandbox_kind === "ssh") {
    const t = row.sandbox_target_id
      ? sshTargetDao.byId(userId, row.sandbox_target_id)
      : sshTargetDao.listForUser(userId)[0];
    if (t) {
      opts.sshUnconfined = row.sandbox_mode === "danger-full-access" && Boolean(t.unconfined);
      const target: SSHTarget = {
        host: t.host,
        port: t.port,
        username: t.username,
        privateKey: () => resolveSshPrivateKey(userId, t),
        hostFingerprint: t.host_fp,
        onFingerprint: (fp) => sshTargetDao.setFingerprint(t.id, fp),
      };
      opts.sshTarget = target;
      targetRevision = {
        id: t.id,
        host: t.host,
        port: t.port,
        username: t.username,
        key: sandboxFingerprint(t.enc_key),
        keyProtected: t.key_protected,
        unconfined: opts.sshUnconfined,
      };
    }
  } else if (row.sandbox_kind === "connector" && row.sandbox_target_id) {
    const connector = connectorDao.byId(userId, row.sandbox_target_id);
    if (connector) {
      const connectionGeneration = connectorManager.connectionGeneration(connector.id);
      const override = row.connector_unconfined;
      const wantUnconfined = override == null ? Boolean(connector.unconfined) : override === 1;
      const unconfined = row.sandbox_mode === "danger-full-access" && wantUnconfined;
      opts.connectorTarget = { id: connector.id, workspaceRoot: connector.workspace_root, unconfined, expectedGeneration: connectionGeneration ?? undefined };
      targetRevision = { id: connector.id, workspaceRoot: connector.workspace_root, unconfined, connectionGeneration };
    }
  }
  if (row.sandbox_kind === "connector" && !opts.connectorTarget) {
    return "no-sandbox-yet";
  }
  const fingerprint = sandboxFingerprint({
    kind: row.sandbox_kind,
    mode: row.sandbox_mode,
    sandboxId: row.sandbox_id,
    targetId: row.sandbox_target_id,
    targetRevision,
    proxyUrl: opts.proxyUrl,
  });
  return {
    key: JSON.stringify([userId, sessionId]),
    owner: userId,
    fingerprint,
    create: () => createSandbox(userId, sessionId, row.sandbox_mode, opts),
  };
}

function sessionSandbox(userId: string, sessionId: string): Resolved {
  const spec = sessionSandboxSpec(userId, sessionId);
  if (typeof spec === "string") return spec;
  return { sb: spec.create() };
}

type PreviewSandboxLease = WarmLease<Sandbox> & { fingerprint: string };

function previewSandbox(userId: string, sessionId: string): PreviewSandboxLease | "no-session" | "no-sandbox-yet" {
  const spec = sessionSandboxSpec(userId, sessionId);
  if (typeof spec === "string") return spec;
  const lease = previewSandboxPool.acquire({
    key: spec.key,
    owner: spec.owner,
    fingerprint: spec.fingerprint,
    create: spec.create,
  });
  return { ...lease, fingerprint: spec.fingerprint };
}

export function invalidateFilePreviewSandboxes(userId: string, sessionId?: string): number {
  return sessionId === undefined
    ? previewSandboxPool.invalidateOwner(userId)
    : Number(previewSandboxPool.invalidate(JSON.stringify([userId, sessionId])));
}

export function closeFilePreviewSandboxes(): void {
  previewSandboxPool.closeAll();
}

export async function listFiles(userId: string, sessionId: string, path: string): Promise<FileEntry[] | null> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session") return null;
  if (r === "no-sandbox-yet") return [];
  try {
    return await r.sb.listDir(path || ".");
  } catch {
    return [];
  } finally {
    r.sb.close?.();
  }
}

const MAX_DIFF_BYTES = 400 * 1024;

function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const blocks = diff.split(/(?=^diff --git )/m).filter((b) => b.startsWith("diff --git"));
  for (const block of blocks) {
    const lines = block.split("\n");
    let status: DiffFileStatus = "modified";
    let binary = false;
    let newPath = "";
    let oldPath = "";
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) { status = "renamed"; oldPath = line.slice("rename from ".length).trim(); }
      else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length).trim();
      else if (line.startsWith("Binary files ")) binary = true;
      else if (line.startsWith("--- ")) { const p = line.slice(4).trim(); if (p !== "/dev/null") oldPath = p.replace(/^a\//, ""); }
      else if (line.startsWith("+++ ")) { const p = line.slice(4).trim(); if (p !== "/dev/null") newPath = p.replace(/^b\//, ""); }
      else if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    if (status === "modified" && !oldPath && newPath && added > 0 && removed === 0) status = "untracked";
    const path = newPath || oldPath || block.match(/^diff --git a\/(.+?) b\//m)?.[1] || "(unknown)";
    files.push({ path, oldPath: oldPath && oldPath !== path ? oldPath : undefined, status, added, removed, patch: block.trimEnd(), binary });
  }
  return files;
}

const DIFF_SCRIPT = [
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo __NOREPO__; exit 0; }",
  'printf "__HEAD__%s\\n" "$(git rev-parse --short HEAD 2>/dev/null || echo none)"',
  'printf "__BRANCH__%s\\n" "$(git branch --show-current 2>/dev/null)"',
  'printf "__DIFF__\\n"',
  "git -c core.pager=cat -c color.ui=false diff HEAD 2>/dev/null",
  'for f in $(git ls-files -o --exclude-standard 2>/dev/null); do git -c core.pager=cat -c color.ui=false diff --no-index -- /dev/null "$f" 2>/dev/null; done',
].join("\n");

export async function workspaceDiff(userId: string, sessionId: string): Promise<WorkspaceDiff | null> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session") return null;
  if (r === "no-sandbox-yet") return { isRepo: false, files: [] };
  try {
    const res = await r.sb.exec(DIFF_SCRIPT, { timeoutMs: 30_000 });
    const out = res.stdout;
    if (out.includes("__NOREPO__") || !out.includes("__DIFF__")) return { isRepo: false, files: [] };
    const head = out.match(/__HEAD__(.*)/)?.[1]?.trim();
    const branch = out.match(/__BRANCH__(.*)/)?.[1]?.trim() || undefined;
    let diff = out.slice(out.indexOf("__DIFF__") + "__DIFF__".length).replace(/^\n/, "");
    const truncated = Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES;
    if (truncated) diff = diff.slice(0, MAX_DIFF_BYTES);
    return {
      isRepo: true,
      head: head && head !== "none" ? head : undefined,
      branch,
      files: parseUnifiedDiff(diff),
      truncated,
    };
  } catch {
    return { isRepo: false, files: [] };
  } finally {
    r.sb.close?.();
  }
}

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  binary: boolean;
}

function pathParts(filePath: string): { dir: string; name: string } {
  const slash = filePath.lastIndexOf("/");
  return {
    dir: slash >= 0 ? filePath.slice(0, slash) || "." : ".",
    name: (slash >= 0 ? filePath.slice(slash + 1) : filePath) || "file",
  };
}

async function fileEntry(sb: Sandbox, filePath: string): Promise<FileEntry | null> {
  return sb.statFile(filePath);
}

async function readBoundedBytes(sb: Sandbox, filePath: string, start: number, endExclusive: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of sb.readFileChunks(filePath, { start, endExclusive })) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const joined = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readFile(userId: string, sessionId: string, path: string): Promise<ReadFileResult | null> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session" || r === "no-sandbox-yet") return null;
  try {
    const entry = await fileEntry(r.sb, path);
    if (!entry || entry.kind === "directory") throw new Error("file not found");
    const size = entry.size;
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBytes(r.sb, path, 0, Math.min(size, MAX_PREVIEW + 1));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConnectorDaemonUpgradeRequiredError") throw error;
      const legacy = await r.sb.readFile(path);
      const legacyBytes = Buffer.from(legacy, "utf8");
      bytes = legacyBytes.subarray(0, Math.min(legacyBytes.byteLength, MAX_PREVIEW + 1));
    }
    const binary = bytes.includes(0);
    if (binary) return { path, content: "[binary file]", size, binary: true };
    const content = Buffer.from(bytes).toString("utf8");
    if (size > MAX_PREVIEW || bytes.byteLength > MAX_PREVIEW) return { path, content: content.slice(0, MAX_PREVIEW) + "\n…[truncated]", size, binary: false };
    return { path, content, size, binary: false };
  } finally {
    r.sb.close?.();
  }
}

export const MAX_DOWNLOAD = Math.max(1, Math.floor(Number(process.env.AGENT_WEB_MAX_DOWNLOAD_MB) || 50)) * 1024 * 1024;

const PREVIEW_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

export type PreparedFilePreview =
  | { ok: true; path: string; name: string; size: number; modifiedAt: number; version: string; backendVersion: string; mimeType: string }
  | { ok: false; reason: "not-found" | "too-large" | "is-dir" | "unsupported" | "invalid" | "path-too-long" };

export function previewFileRevision(
  entry: Pick<FileEntry, "size" | "modifiedAt" | "version">,
): { modifiedAt: number; version: string } | null {
  const modifiedAt = Math.max(0, Math.floor(entry.modifiedAt));
  if (!entry.version && modifiedAt === 0) return null;
  return { modifiedAt, version: entry.version ?? fallbackFileEntryVersion(entry) };
}

export async function prepareFilePreview(
  userId: string,
  sessionId: string,
  filePath: string,
): Promise<PreparedFilePreview | null> {
  const r = previewSandbox(userId, sessionId);
  if (r === "no-session" || r === "no-sandbox-yet") return null;
  try {
    const canonicalPath = r.value.toRel(r.value.resolve(filePath));
    if (Buffer.byteLength(canonicalPath, "utf8") > 1024) return { ok: false, reason: "path-too-long" };
    const entry = await fileEntry(r.value, canonicalPath);
    if (!entry) return { ok: false, reason: "not-found" };
    if (entry.kind === "directory") return { ok: false, reason: "is-dir" };
    if (entry.size > MAX_DOWNLOAD) return { ok: false, reason: "too-large" };
    const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase() : "";
    const mimeType = PREVIEW_MIME[ext];
    if (!mimeType) return { ok: false, reason: "unsupported" };
    if (mimeType === "application/pdf") {
      const magic = await readBoundedBytes(r.value, canonicalPath, 0, 5);
      if (magic.byteLength !== 5 || Buffer.from(magic).toString("ascii") !== "%PDF-") return { ok: false, reason: "invalid" };
    }
    const revision = previewFileRevision(entry);
    if (!revision) return { ok: false, reason: "unsupported" };
    const currentSpec = sessionSandboxSpec(userId, sessionId);
    if (typeof currentSpec === "string") return null;
    return {
      ok: true,
      path: canonicalPath,
      name: entry.name,
      size: entry.size,
      modifiedAt: revision.modifiedAt,
      version: revision.version,
      backendVersion: currentSpec.fingerprint,
      mimeType,
    };
  } finally {
    r.release();
  }
}

export interface OpenFileChunkStream {
  chunks: AsyncIterable<Uint8Array>;
  close(): void;
}

export type OpenFileChunkResult =
  | { ok: true; stream: OpenFileChunkStream }
  | { ok: false; reason: "not-found" | "changed" }
  | null;

export interface ReadFilePreviewChunkOptions {
  start: number;
  endExclusive: number;
  expectedSize: number;
  expectedModifiedAt: number;
  expectedVersion: string;
  expectedBackendVersion: string;
}

export type ReadFilePreviewChunkResult =
  | { ok: true; dataBase64: string }
  | { ok: false; reason: "not-found" | "changed" }
  | null;

export async function openFileChunkStream(
  userId: string,
  sessionId: string,
  filePath: string,
  opts: ReadFilePreviewChunkOptions & { signal?: AbortSignal },
): Promise<OpenFileChunkResult> {
  const r = previewSandbox(userId, sessionId);
  if (r === "no-session" || r === "no-sandbox-yet") return null;
  try {
    if (r.fingerprint !== opts.expectedBackendVersion) {
      r.release();
      return { ok: false, reason: "changed" };
    }
    const entry = await r.value.statFile(filePath);
    if (!entry || entry.kind === "directory") {
      r.release();
      return { ok: false, reason: "not-found" };
    }
    const currentRevision = previewFileRevision(entry);
    if (
      !currentRevision ||
      entry.size !== opts.expectedSize ||
      currentRevision.modifiedAt !== opts.expectedModifiedAt ||
      currentRevision.version !== opts.expectedVersion
    ) {
      r.release();
      return { ok: false, reason: "changed" };
    }
    let closed = false;
    return {
      ok: true,
      stream: {
        chunks: r.value.readFileChunks(filePath, {
          start: opts.start,
          endExclusive: opts.endExclusive,
          signal: opts.signal,
          expectedVersion: opts.expectedVersion,
        }),
        close: () => {
          if (closed) return;
          closed = true;
          r.release();
        },
      },
    };
  } catch (error) {
    r.release();
    throw error;
  }
}

export async function readFilePreviewChunk(
  userId: string,
  sessionId: string,
  filePath: string,
  opts: ReadFilePreviewChunkOptions,
): Promise<ReadFilePreviewChunkResult> {
  const length = opts.endExclusive - opts.start;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) {
    throw new Error("preview IPC chunk exceeds 1 MiB");
  }
  const opened = await openFileChunkStream(userId, sessionId, filePath, opts);
  if (!opened?.ok) return opened;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of opened.stream.chunks) {
      total += chunk.byteLength;
      if (total > length) throw new Error("preview backend returned too many bytes");
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    return { ok: true, dataBase64: Buffer.concat(chunks, total).toString("base64") };
  } finally {
    opened.stream.close();
  }
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; name: string }
  | { ok: false; reason: "not-found" | "too-large" | "is-dir" };

export async function downloadFile(
  userId: string,
  sessionId: string,
  path: string,
): Promise<DownloadResult | null> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session" || r === "no-sandbox-yet") return null;
  try {
    const { name } = pathParts(path);
    const entry = await fileEntry(r.sb, path);
    if (!entry) return { ok: false, reason: "not-found" };
    if (entry.kind === "directory") return { ok: false, reason: "is-dir" };
    if (entry.size > MAX_DOWNLOAD) return { ok: false, reason: "too-large" };
    const bytes = await r.sb.readFileBytes(path);
    if (bytes.byteLength > MAX_DOWNLOAD) return { ok: false, reason: "too-large" };
    return { ok: true, bytes, name };
  } finally {
    r.sb.close?.();
  }
}

export const DOWNLOAD_ALL_MAX = 100 * 1024 * 1024;
const ARCHIVE_EXCLUDES = [
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", "out", "target", ".output",
  "venv", ".venv", "env", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".tox",
  ".gradle", ".idea", ".vscode", ".DS_Store", ".terraform", "vendor",
  "*.pyc", "*.log", ".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519",
];

export async function copyWorkspaceBestEffort(srcRoot: string, dstRoot: string): Promise<void> {
  if (!fs.existsSync(srcRoot)) return;
  const excludeArgs = ARCHIVE_EXCLUDES.map((p) => `--exclude='${p}'`).join(" ");
  const run = (cmd: string, capture: boolean): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve, reject) => {
      const p = spawn("bash", ["-lc", cmd], { stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore" });
      let out = "";
      if (capture) p.stdout!.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
      p.on("error", reject);
    });
  const sized = await run(`du -sb ${excludeArgs} '${srcRoot}' 2>/dev/null | head -1 | cut -f1`, true);
  const bytes = parseInt(sized.out.trim(), 10);
  if (Number.isFinite(bytes) && bytes > DOWNLOAD_ALL_MAX) {
    throw new Error(`workspace too large to fork (${bytes} > ${DOWNLOAD_ALL_MAX} bytes)`);
  }
  fs.mkdirSync(dstRoot, { recursive: true });
  const res = await run(`tar -cf - ${excludeArgs} -C '${srcRoot}' . 2>/dev/null | tar -xf - -C '${dstRoot}'`, false);
  if (res.code !== 0) throw new Error(`workspace copy failed (tar exit ${res.code})`);
}

export type ArchiveResult =
  | { ok: true; stream: ExecStream; cleanup: () => void; name: string }
  | { ok: false; reason: "no-session" | "no-sandbox-yet" | "unsupported" | "too-large" | "error" };

export async function downloadAllArchive(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ArchiveResult> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session") return { ok: false, reason: "no-session" };
  if (r === "no-sandbox-yet") return { ok: false, reason: "no-sandbox-yet" };
  const sb = r.sb;
  if (typeof sb.execStream !== "function") {
    sb.close?.();
    return { ok: false, reason: "unsupported" };
  }
  const excludeArgs = ARCHIVE_EXCLUDES.map((p) => `--exclude='${p}'`).join(" ");
  const tarCmd = `tar -cf - ${excludeArgs} . 2>/dev/null`;
  try {
    const sized = await sb.exec(`${tarCmd} | wc -c`, { timeoutMs: 60_000 });
    const bytes = parseInt(sized.stdout.trim(), 10);
    if (Number.isFinite(bytes) && bytes > DOWNLOAD_ALL_MAX) {
      sb.close?.();
      return { ok: false, reason: "too-large" };
    }
    const stream = sb.execStream(tarCmd, { signal, timeoutMs: 180_000 });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        stream.abort();
      } catch {
      }
      sb.close?.();
    };
    return { ok: true, stream, cleanup, name: `workspace-${sessionId}.tar.gz` };
  } catch {
    sb.close?.();
    return { ok: false, reason: "error" };
  }
}

export async function writeFile(
  userId: string,
  sessionId: string,
  path: string,
  content: string,
): Promise<boolean> {
  const r = sessionSandbox(userId, sessionId);
  if (r === "no-session" || r === "no-sandbox-yet") return false;
  try {
    await r.sb.writeFile(path, content);
    return true;
  } finally {
    r.sb.close?.();
  }
}
