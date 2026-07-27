import { api, type FilePreviewSource } from "../platform/api";

export type MediaPreviewKind = "image" | "pdf";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);

export function mediaPreviewKind(path: string): MediaPreviewKind | null {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  return ext === "pdf" ? "pdf" : IMAGE_EXTENSIONS.has(ext) ? "image" : null;
}

interface SourceEntry {
  generation: number;
  promise: Promise<FilePreviewSource>;
  expiresAt: number;
  version: string;
  sessionId: string;
  path: string;
  url: string;
  refs: number;
  pendingRevoke: boolean;
}

export interface FilePreviewSourceLease {
  source: FilePreviewSource;
  generation: number;
  release(): void;
}

const SOURCE_CACHE_MAX = 12;
const EXPIRY_SAFETY_MS = 30_000;
const sourceCache = new Map<string, SourceEntry>();
let nextSourceGeneration = 0;

const normalizedVersion = (versionHint: string): string => versionHint === "unknown" ? "" : versionHint;
const sourceKey = (sessionId: string, path: string, versionHint = ""): string => JSON.stringify([sessionId, path, normalizedVersion(versionHint)]);

function promote(key: string, entry: SourceEntry): void {
  sourceCache.delete(key);
  sourceCache.set(key, entry);
}

function promoteEntryTo(key: string, entry: SourceEntry): void {
  for (const [currentKey, current] of sourceCache) {
    if (current === entry) sourceCache.delete(currentKey);
  }
  sourceCache.set(key, entry);
}

function revokeEntry(entry: SourceEntry): void {
  if (!entry.url) return;
  void fetch(entry.url, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
  }).catch(() => {});
  entry.url = "";
  entry.pendingRevoke = false;
}

function requestRevoke(entry: SourceEntry): void {
  entry.pendingRevoke = true;
  if (entry.refs === 0) revokeEntry(entry);
}

function trim(): void {
  while (sourceCache.size > SOURCE_CACHE_MAX) {
    const candidate = [...sourceCache].find(([, entry]) => entry.refs === 0 && entry.expiresAt !== 0);
    if (!candidate) return;
    const [oldest, entry] = candidate;
    sourceCache.delete(oldest);
    if (![...sourceCache.values()].some((current) => current === entry)) requestRevoke(entry);
  }
}

export function filePreviewSource(
  sessionId: string,
  path: string,
  versionHint = "",
  replaceGeneration?: number,
): Promise<FilePreviewSource> {
  versionHint = normalizedVersion(versionHint);
  const key = sourceKey(sessionId, path, versionHint);
  if (replaceGeneration !== undefined) {
    const stale = new Set<SourceEntry>();
    for (const [currentKey, entry] of sourceCache) {
      if (entry.sessionId === sessionId && entry.path === path && entry.generation === replaceGeneration) {
        sourceCache.delete(currentKey);
        stale.add(entry);
      }
    }
    for (const entry of stale) {
      if (![...sourceCache.values()].some((current) => current === entry)) requestRevoke(entry);
    }
  }
  const cached = sourceCache.get(key);
  if (cached && (cached.expiresAt === 0 || cached.expiresAt > Date.now() + EXPIRY_SAFETY_MS)) {
    promote(key, cached);
    return cached.promise;
  }
  if (versionHint) {
    for (const sibling of sourceCache.values()) {
      if (sibling.sessionId !== sessionId || sibling.path !== path) continue;
      if (sibling.expiresAt !== 0 && sibling.expiresAt <= Date.now() + EXPIRY_SAFETY_MS) continue;
      if (sibling.version === versionHint) {
        promoteEntryTo(key, sibling);
        return sibling.promise;
      }
    }
  }
  if (!versionHint) {
    const siblings = [...sourceCache.values()].reverse();
    for (const sibling of siblings) {
      if (sibling.sessionId !== sessionId || sibling.path !== path) continue;
      if (sibling.expiresAt !== 0 && sibling.expiresAt <= Date.now() + EXPIRY_SAFETY_MS) continue;
      promoteEntryTo(key, sibling);
      return sibling.promise;
    }
  }
  if (cached) {
    sourceCache.delete(key);
    if (![...sourceCache.values()].some((current) => current === cached)) requestRevoke(cached);
  }
  const entry: SourceEntry = {
    generation: ++nextSourceGeneration,
    expiresAt: 0,
    version: "",
    sessionId,
    path,
    url: "",
    refs: 0,
    pendingRevoke: false,
    promise: api.filePreviewSource(sessionId, path),
  };
  sourceCache.set(key, entry);
  trim();
  entry.promise.then(
    (source) => {
      if (![...sourceCache.values()].some((current) => current === entry)) {
        entry.url = source.url;
        requestRevoke(entry);
        trim();
        return;
      }
      const ttl = typeof source.expiresInMs === "number" && Number.isFinite(source.expiresInMs)
        ? Math.max(0, source.expiresInMs)
        : Math.max(0, source.expiresAt - Date.now());
      entry.expiresAt = Date.now() + ttl;
      entry.version = source.version;
      entry.url = source.url;
      trim();
    },
    () => {
      for (const [currentKey, current] of sourceCache) {
        if (current === entry) sourceCache.delete(currentKey);
      }
      trim();
    },
  );
  return entry.promise;
}

export async function acquireFilePreviewSource(
  sessionId: string,
  path: string,
  versionHint = "",
  replaceGeneration?: number,
): Promise<FilePreviewSourceLease> {
  versionHint = normalizedVersion(versionHint);
  const retain = async (entry: SourceEntry | undefined, promise: Promise<FilePreviewSource>): Promise<FilePreviewSourceLease> => {
    if (entry) entry.refs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0 && entry.pendingRevoke) revokeEntry(entry);
      trim();
    };
    try {
      const source = await promise;
      return { source, generation: entry?.generation ?? 0, release };
    } catch (error) {
      release();
      throw error;
    }
  };

  if (versionHint) {
    const pending = [...new Set(sourceCache.values())].reverse().find((entry) =>
      entry.sessionId === sessionId &&
      entry.path === path &&
      entry.expiresAt === 0 &&
      entry.generation !== replaceGeneration
    );
    if (pending) {
      const pendingLease = await retain(pending, pending.promise);
      if (pendingLease.source.version === versionHint) {
        if ([...sourceCache.values()].some((entry) => entry === pending)) {
          promoteEntryTo(sourceKey(sessionId, path, versionHint), pending);
        }
        return pendingLease;
      }
      pendingLease.release();
      return await acquireFilePreviewSource(sessionId, path, versionHint, replaceGeneration);
    }
  }

  const promise = filePreviewSource(sessionId, path, versionHint, replaceGeneration);
  const entry = [...new Set(sourceCache.values())].find((candidate) => candidate.promise === promise);
  return await retain(entry, promise);
}

export function warmFilePreviewSource(sessionId: string, path: string, versionHint = ""): void {
  void filePreviewSource(sessionId, path, versionHint).catch(() => {});
}

export function invalidateFilePreviewSource(sessionId: string, path: string): void {
  const removed = new Set<SourceEntry>();
  for (const [key, entry] of sourceCache) {
    if (entry.sessionId === sessionId && entry.path === path) {
      sourceCache.delete(key);
      removed.add(entry);
    }
  }
  for (const entry of removed) {
    if (![...sourceCache.values()].some((current) => current === entry)) requestRevoke(entry);
  }
}
