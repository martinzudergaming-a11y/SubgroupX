import crypto from "node:crypto";
import { once } from "node:events";
import zlib from "node:zlib";
import { Transform, pipeline } from "node:stream";
import type express from "express";
import { uploadDao } from "../../persistence/index.ts";
import { boundedRuntimeClient, runtimeUsesIpc } from "../../runtime/runtime-client.ts";
import {
  listFiles,
  readFile,
  writeFile,
  downloadFile,
  openFileChunkStream,
  type OpenFileChunkResult,
  type ReadFilePreviewChunkOptions,
  MAX_DOWNLOAD,
  downloadAllArchive,
  DOWNLOAD_ALL_MAX,
  workspaceDiff,
} from "../../workspace/file-explorer.ts";
import {
  FILE_PREVIEW_FULL_TOKEN_TTL_SECONDS,
  FILE_PREVIEW_TOKEN_TTL_SECONDS,
  authEpochIsCurrent,
  issueFilePreviewToken,
  verifyFilePreviewToken,
  type FilePreviewMode,
} from "../../identity/auth.ts";
import { bannedReason } from "../../identity/ban.ts";
import { getAuditRequestId, logAudit } from "../../observability/audit-log.ts";
import {
  type AuthedRequest,
  requireAuth,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_BYTES,
  MAX_USER_BYTES,
} from "../route-helpers.ts";

const DOWNLOAD_ALL_MAX_CONCURRENT = 2;
const DOWNLOAD_ALL_MAX_PER_USER = 1;
let activeDownloadAll = 0;
const activeDownloadAllByUser = new Map<string, number>();

export interface ParsedByteRange {
  start: number;
  endExclusive: number;
  partial: boolean;
}

export function parseByteRange(header: string | undefined, size: number): ParsedByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  if (!header) return { start: 0, endExclusive: size, partial: false };
  const equals = header.indexOf("=");
  if (equals < 0 || header.slice(0, equals).trim().toLowerCase() !== "bytes" || header.includes(",")) {
    return { start: 0, endExclusive: size, partial: false };
  }
  const match = /^(\d*)-(\d*)$/.exec(header.slice(equals + 1).trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start: number;
  let endInclusive: number;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix <= 0n) return null;
    start = suffix >= BigInt(size) ? 0 : size - Number(suffix);
    endInclusive = size - 1;
  } else {
    const rawStart = BigInt(match[1]);
    const rawEnd = match[2] ? BigInt(match[2]) : BigInt(size - 1);
    if (rawStart >= BigInt(size) || rawEnd < rawStart) return null;
    start = Number(rawStart);
    endInclusive = Number(rawEnd >= BigInt(size) ? BigInt(size - 1) : rawEnd);
  }
  return { start, endExclusive: endInclusive + 1, partial: true };
}

export const FILE_PREVIEW_MAX_RANGE_BYTES = 4 * 1024 * 1024;

type PreviewAdmission = {
  active: number;
  byUser: Map<string, number>;
  max: number;
  maxPerUser: number;
};

const rangeAdmission: PreviewAdmission = {
  active: 0,
  byUser: new Map(),
  max: Math.max(1, Number(process.env.AGENT_WEB_PREVIEW_MAX_ACTIVE ?? 32) || 32),
  maxPerUser: Math.max(1, Number(process.env.AGENT_WEB_PREVIEW_MAX_ACTIVE_PER_USER ?? 8) || 8),
};
const mediaAdmission: PreviewAdmission = { active: 0, byUser: new Map(), max: 8, maxPerUser: 2 };
const fullAdmission: PreviewAdmission = { active: 0, byUser: new Map(), max: 2, maxPerUser: 1 };

function reservePreview(userId: string, mode: FilePreviewMode): (() => void) | null {
  const pool = mode === "range" ? rangeAdmission : mode === "media" ? mediaAdmission : fullAdmission;
  const userActive = pool.byUser.get(userId) ?? 0;
  if (pool.active >= pool.max || userActive >= pool.maxPerUser) return null;
  pool.active++;
  pool.byUser.set(userId, userActive + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pool.active = Math.max(0, pool.active - 1);
    const next = (pool.byUser.get(userId) ?? 1) - 1;
    if (next <= 0) pool.byUser.delete(userId);
    else pool.byUser.set(userId, next);
  };
}

function previewCookie(req: express.Request, nonce: string, value: string, maxAge: number): string {
  const routePath = `/api/file-preview/${nonce}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = req.secure || forwardedProto === "https" || process.env.NODE_ENV === "production";
  return [
    `oiia_preview_${nonce}=${value ? encodeURIComponent(value) : ""}`,
    `Path=${routePath}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function cookieValue(raw: string | undefined, name: string): string {
  for (const part of (raw ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}

function previewError(reason: "not-found" | "too-large" | "is-dir" | "unsupported" | "invalid" | "path-too-long"): { status: number; error: string } {
  switch (reason) {
    case "too-large": return { status: 413, error: `file exceeds the ${MAX_DOWNLOAD / 1024 / 1024}MB preview limit` };
    case "is-dir": return { status: 400, error: "cannot preview a directory" };
    case "unsupported": return { status: 415, error: "this file type is not previewable" };
    case "invalid": return { status: 415, error: "the file does not contain a valid PDF header" };
    case "path-too-long": return { status: 414, error: "preview path is too long" };
    default: return { status: 404, error: "not found" };
  }
}

const PREVIEW_IPC_CHUNK_BYTES = 256 * 1024;

export async function openPreviewStream(
  userId: string,
  sessionId: string,
  filePath: string,
  opts: ReadFilePreviewChunkOptions & { signal?: AbortSignal },
): Promise<OpenFileChunkResult> {
  if (!runtimeUsesIpc) return await openFileChunkStream(userId, sessionId, filePath, opts);

  const read = async (start: number, endExclusive: number) => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("preview client disconnected");
    const result = await boundedRuntimeClient.readFilePreviewChunk(userId, sessionId, filePath, {
      start,
      endExclusive,
      expectedSize: opts.expectedSize,
      expectedModifiedAt: opts.expectedModifiedAt,
      expectedVersion: opts.expectedVersion,
      expectedBackendVersion: opts.expectedBackendVersion,
    });
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("preview client disconnected");
    return result;
  };
  const firstEnd = Math.min(opts.endExclusive, opts.start + PREVIEW_IPC_CHUNK_BYTES);
  const first = await read(opts.start, firstEnd);
  if (!first?.ok) return first;
  const firstBytes = new Uint8Array(Buffer.from(first.dataBase64, "base64"));
  let closed = false;
  return {
    ok: true,
    stream: {
      chunks: (async function* () {
        if (firstBytes.byteLength > 0) yield firstBytes;
        let offset = opts.start + firstBytes.byteLength;
        while (!closed && offset < opts.endExclusive) {
          const end = Math.min(opts.endExclusive, offset + PREVIEW_IPC_CHUNK_BYTES);
          const next = await read(offset, end);
          if (!next?.ok) throw new Error(next?.reason === "changed" ? "preview file changed" : "preview file disappeared");
          const bytes = new Uint8Array(Buffer.from(next.dataBase64, "base64"));
          if (bytes.byteLength === 0) break;
          const requested = end - offset;
          yield bytes;
          offset += bytes.byteLength;
          if (bytes.byteLength < requested) break;
        }
      })(),
      close: () => { closed = true; },
    },
  };
}

export function registerFileRoutes(r: express.Router): void {
  r.get("/sessions/:id/files", requireAuth, async (req: AuthedRequest, res) => {
    const entries = await listFiles(req.user!.id, req.params.id, String(req.query.path ?? "."));
    if (entries === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ entries });
  });

  r.get("/sessions/:id/diff", requireAuth, async (req: AuthedRequest, res) => {
    const diff = await workspaceDiff(req.user!.id, req.params.id);
    if (diff === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(diff);
  });

  r.get("/sessions/:id/file", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const result = await readFile(req.user!.id, req.params.id, String(req.query.path ?? ""));
      if (result === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "read failed" });
    }
  });

  r.post("/sessions/:id/file-preview", requireAuth, async (req: AuthedRequest, res) => {
    const filePath = String(req.body?.path ?? "");
    const purpose = req.body?.purpose;
    if (purpose !== undefined && purpose !== "full-viewer") {
      res.status(400).json({ error: "invalid preview purpose" });
      return;
    }
    try {
      const prepared = await boundedRuntimeClient.prepareFilePreview(req.user!.id, req.params.id, filePath);
      if (prepared === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!prepared.ok) {
        const failure = previewError(prepared.reason);
        res.status(failure.status).json({ error: failure.error });
        return;
      }
      if (!authEpochIsCurrent(req.user!)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const nonce = crypto.randomBytes(16).toString("hex");
      const mode: FilePreviewMode = purpose === "full-viewer"
        ? "full"
        : prepared.mimeType === "application/pdf" ? "range" : "media";
      const ttlSeconds = mode === "full" ? FILE_PREVIEW_FULL_TOKEN_TTL_SECONDS : FILE_PREVIEW_TOKEN_TTL_SECONDS;
      const token = issueFilePreviewToken({
        userId: req.user!.id,
        sessionId: req.params.id,
        path: prepared.path,
        name: prepared.name,
        size: prepared.size,
        modifiedAt: prepared.modifiedAt,
        version: prepared.version,
        backendVersion: prepared.backendVersion,
        mimeType: prepared.mimeType,
        nonce,
        mode,
      });
      const routePath = `/api/file-preview/${nonce}`;
      res.setHeader("Set-Cookie", previewCookie(req, nonce, token, ttlSeconds));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        url: routePath,
        size: prepared.size,
        version: prepared.version,
        mimeType: prepared.mimeType,
        expiresAt: Date.now() + ttlSeconds * 1_000,
        expiresInMs: ttlSeconds * 1_000,
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "preview failed" });
    }
  });

  r.delete("/file-preview/:nonce", (req, res) => {
    const nonce = String(req.params.nonce ?? "");
    if (!/^[a-f0-9]{32}$/.test(nonce)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Set-Cookie", previewCookie(req, nonce, "", 0));
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  });

  r.get("/file-preview/:nonce", async (req, res) => {
    const nonce = String(req.params.nonce ?? "");
    if (!/^[a-f0-9]{32}$/.test(nonce)) {
      res.status(404).end();
      return;
    }
    const token = cookieValue(req.headers.cookie, `oiia_preview_${nonce}`);
    const claims = token ? verifyFilePreviewToken(token, nonce) : null;
    if (!claims || bannedReason(claims.userId)) {
      res.status(401).end();
      return;
    }
    const rangeHeader = req.headers["if-range"] === undefined && typeof req.headers.range === "string"
      ? req.headers.range
      : undefined;
    const range = claims.mode === "range"
      ? parseByteRange(req.method === "HEAD" ? undefined : rangeHeader, claims.size)
      : { start: 0, endExclusive: claims.size, partial: false };
    const rangeLength = range ? range.endExclusive - range.start : 0;
    const invalidQuickRange = claims.mode === "range" && req.method !== "HEAD" && (
      !rangeHeader || !range?.partial || rangeLength > FILE_PREVIEW_MAX_RANGE_BYTES
    );
    if (!range || invalidQuickRange) {
      res.status(416).setHeader("Content-Range", `bytes */${claims.size}`).end();
      return;
    }
    const releaseAdmission = reservePreview(claims.userId, claims.mode);
    if (!releaseAdmission) {
      res.setHeader("Retry-After", "1");
      res.status(429).end();
      return;
    }

    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error("preview client disconnected"));
    req.once("aborted", onAbort);
    res.once("close", onAbort);
    let opened: Awaited<ReturnType<typeof openFileChunkStream>> = null;
    try {
      if (abort.signal.aborted) return;
      const readEndExclusive = req.method === "HEAD" ? range.start : range.endExclusive;
      opened = await openPreviewStream(claims.userId, claims.sessionId, claims.path, {
        start: range.start,
        endExclusive: readEndExclusive,
        expectedSize: claims.size,
        expectedModifiedAt: claims.modifiedAt,
        expectedVersion: claims.version,
        expectedBackendVersion: claims.backendVersion,
        signal: abort.signal,
      });
      if (!opened) {
        res.status(404).end();
        return;
      }
      if (!opened.ok) {
        res.setHeader("Cache-Control", "no-store");
        res.status(opened.reason === "changed" ? 412 : 404).end();
        return;
      }

      const safeName = claims.name.replace(/[^\w.\-]+/g, "_") || "file";
      const length = range.endExclusive - range.start;
      if (claims.mode === "full" && req.method === "GET") {
        res.setHeader("Set-Cookie", previewCookie(req, nonce, "", 0));
      }
      res.status(range.partial ? 206 : 200);
      res.setHeader("Content-Type", claims.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
      if (claims.mode === "range") res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(length));
      if (range.partial) res.setHeader("Content-Range", `bytes ${range.start}-${range.endExclusive - 1}/${claims.size}`);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Cookie");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method === "HEAD" || length === 0) {
        res.end();
        return;
      }
      res.flushHeaders();

      let sent = 0;
      for await (const chunk of opened.stream.chunks) {
        if (abort.signal.aborted) break;
        const remaining = length - sent;
        if (remaining <= 0) break;
        if (chunk.byteLength > remaining) throw new Error(`preview backend returned too many bytes (${chunk.byteLength}/${remaining})`);
        sent += chunk.byteLength;
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (!res.write(buffer)) await once(res, "drain", { signal: abort.signal });
      }
      if (!abort.signal.aborted && sent !== length) {
        throw new Error(`preview range ended early (${sent}/${length} bytes)`);
      }
      if (!abort.signal.aborted) res.end();
    } catch (error) {
      if (!abort.signal.aborted) {
        logAudit("file_preview_stream_failed", {
          level: "warn",
          requestId: getAuditRequestId(req),
          userId: claims.userId,
          sessionId: claims.sessionId,
          data: { path: claims.path, reason: error instanceof Error ? error.message : String(error) },
        });
        if (!res.headersSent) {
          for (const header of ["Content-Length", "Content-Range", "Content-Type", "Content-Disposition", "Accept-Ranges", "ETag", "Last-Modified"]) {
            res.removeHeader(header);
          }
          res.setHeader("Cache-Control", "no-store");
          res.status(500).end();
        }
        else res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      if (opened?.ok) opened.stream.close();
      req.off("aborted", onAbort);
      res.off("close", onAbort);
      releaseAdmission();
    }
  });

  r.get("/sessions/:id/download", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const result = await downloadFile(req.user!.id, req.params.id, String(req.query.path ?? ""));
      if (result === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!result.ok) {
        const status = result.reason === "too-large" ? 413 : result.reason === "is-dir" ? 400 : 404;
        const error =
          result.reason === "too-large"
            ? `file exceeds the ${MAX_DOWNLOAD / 1024 / 1024}MB download limit`
            : result.reason === "is-dir"
              ? "cannot download a directory"
              : "not found";
        res.status(status).json({ error });
        return;
      }
      const safeName = result.name.replace(/[^\w.\-]+/g, "_") || "file";
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.setHeader("Content-Length", String(result.bytes.byteLength));
      res.end(Buffer.from(result.bytes));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "download failed" });
    }
  });

  r.get("/sessions/:id/download-all", requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const userActive = activeDownloadAllByUser.get(userId) ?? 0;
    if (activeDownloadAll >= DOWNLOAD_ALL_MAX_CONCURRENT || userActive >= DOWNLOAD_ALL_MAX_PER_USER) {
      res.status(429).json({ error: "too many concurrent workspace downloads — try again shortly" });
      return;
    }
    activeDownloadAll++;
    activeDownloadAllByUser.set(userId, userActive + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeDownloadAll--;
      const n = (activeDownloadAllByUser.get(userId) ?? 1) - 1;
      if (n <= 0) activeDownloadAllByUser.delete(userId);
      else activeDownloadAllByUser.set(userId, n);
    };

    const ac = new AbortController();
    res.on("close", () => ac.abort());
    let result: Awaited<ReturnType<typeof downloadAllArchive>>;
    try {
      result = await downloadAllArchive(userId, req.params.id, ac.signal);
    } catch {
      release();
      if (!res.headersSent) res.status(500).json({ error: "archive failed" });
      return;
    }
    if (!result.ok) {
      release();
      const status =
        result.reason === "no-session" ? 404
          : result.reason === "no-sandbox-yet" ? 409
            : result.reason === "unsupported" ? 501
              : result.reason === "too-large" ? 413
                : 500;
      const error =
        result.reason === "no-session" ? "not found"
          : result.reason === "no-sandbox-yet" ? "the workspace isn't ready yet"
            : result.reason === "unsupported" ? "download-all isn't available for this runtime"
              : result.reason === "too-large" ? `workspace exceeds the ${DOWNLOAD_ALL_MAX / 1024 / 1024}MB archive limit`
                : "archive failed";
      res.status(status).json({ error });
      return;
    }
    logAudit("session_download_all", { requestId: getAuditRequestId(req), userId, data: { sessionId: req.params.id } });

    const safeName = result.name.replace(/[^\w.\-]+/g, "_") || "workspace.tar.gz";
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    let sent = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        sent += chunk.length;
        if (sent > DOWNLOAD_ALL_MAX) {
          cb(new Error("workspace archive exceeded the size cap mid-stream"));
          return;
        }
        cb(null, chunk);
      },
    });

    pipeline(result.stream.stdout, cap, zlib.createGzip(), res, (err) => {
      if (err) {
        logAudit("session_download_all_aborted", {
          level: "warn",
          requestId: getAuditRequestId(req),
          userId,
          data: { sessionId: req.params.id, reason: err.message, sentBytes: sent },
        });
        ac.abort();
      }
      result.cleanup();
      release();
    });
  });

  r.post("/sessions/:id/upload", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (files.length === 0) {
        res.status(400).json({ error: "no files" });
        return;
      }
      if (files.length > MAX_UPLOAD_FILES) {
        res.status(400).json({ error: `at most ${MAX_UPLOAD_FILES} files per upload` });
        return;
      }
      const decoded = files.map((f: { name?: unknown; dataBase64?: unknown }) => ({
        name: String(f?.name ?? "file"),
        data: Buffer.from(String(f?.dataBase64 ?? ""), "base64"),
      }));
      const thisBytes = decoded.reduce((n: number, f: { data: Buffer }) => n + f.data.length, 0);
      if (thisBytes > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `this upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB` });
        return;
      }
      const userTotal = uploadDao.totalBytesForUser(req.user!.id);
      if (userTotal + thisBytes > MAX_USER_BYTES) {
        res.status(413).json({ error: `would exceed your ${MAX_USER_BYTES / 1024 / 1024}MB storage quota` });
        return;
      }
      const saved: { name: string; path: string; bytes: number }[] = [];
      for (const f of decoded) {
        const r2 = await boundedRuntimeClient.writeUpload(req.user!.id, req.params.id, f.name, f.data.toString("base64"));
        if (!r2.ok) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        uploadDao.add({ id: "up_" + crypto.randomUUID(), user_id: req.user!.id, session_id: req.params.id, rel_path: r2.path, bytes: f.data.length });
        saved.push({ name: f.name, path: r2.path, bytes: f.data.length });
      }
      logAudit("upload_created", {
        requestId: getAuditRequestId(req),
        userId: req.user!.id,
        sessionId: req.params.id,
        data: {
          files: saved.length,
          bytes: thisBytes,
          userTotalBytes: userTotal + thisBytes,
          quotaBytes: MAX_USER_BYTES,
          ext: saved.map((file) => {
            const dot = file.name.lastIndexOf(".");
            return dot >= 0 ? file.name.slice(dot + 1).toLowerCase().slice(0, 16) : "";
          }),
        },
      });
      await boundedRuntimeClient.releaseIfIdle(req.user!.id, req.params.id);
      res.json({ files: saved, userTotalBytes: userTotal + thisBytes, quotaBytes: MAX_USER_BYTES });
    } catch (e) {
      logAudit("upload_failed", { level: "warn", requestId: getAuditRequestId(req), userId: req.user!.id, sessionId: req.params.id, data: { reason: e instanceof Error ? e.message : "upload failed" } });
      res.status(400).json({ error: e instanceof Error ? e.message : "upload failed" });
    }
  });

  r.put("/sessions/:id/file", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const { path, content } = req.body ?? {};
      const ok = await writeFile(req.user!.id, req.params.id, String(path ?? ""), String(content ?? ""));
      res.status(ok ? 200 : 404).json({ ok });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "write failed" });
    }
  });
}
