import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-file-preview-"));
process.env.AGENT_WEB_DATA_DIR = path.join(tmp, "data");
process.env.AGENT_WEB_SECRET = "file-preview-check-secret";
process.env.AGENT_WEB_KEY_SECRET = "file-preview-check-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const { FILE_PREVIEW_MAX_RANGE_BYTES, parseByteRange } = await import("../server/src/http/routes/files.ts");
const { LocalSandbox, workspacePathFor } = await import("../server/src/runtime/sandbox.ts");
const { WarmLeasePool } = await import("../server/src/runtime/sandbox-lease-pool.ts");
const { accumulatePdfZoomFactor, clampPdfDisplayScale, clampPdfZoom, pdfFitScale, pdfLocationFromFragment, pdfPinchWheelScaleFactor } = await import("../web/src/files/pdf-preview-model.ts");
const { signup, issueFilePreviewToken, verifyFilePreviewToken, verifyToken } = await import("../server/src/identity/auth.ts");
const { sessionDao } = await import("../server/src/persistence/index.ts");
const { prepareFilePreview, openFileChunkStream, previewFileRevision } = await import("../server/src/workspace/file-explorer.ts");

assert.equal(FILE_PREVIEW_MAX_RANGE_BYTES, 4 * 1024 * 1024);

assert.deepEqual(parseByteRange(undefined, 100), { start: 0, endExclusive: 100, partial: false });
assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, endExclusive: 20, partial: true });
assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, endExclusive: 100, partial: true });
assert.deepEqual(parseByteRange("bytes=-8", 100), { start: 92, endExclusive: 100, partial: true });
assert.deepEqual(parseByteRange("bytes=95-999", 100), { start: 95, endExclusive: 100, partial: true });
assert.deepEqual(parseByteRange("Bytes=10-19", 100), { start: 10, endExclusive: 20, partial: true });
assert.deepEqual(parseByteRange("items=0-1", 100), { start: 0, endExclusive: 100, partial: false });
assert.deepEqual(parseByteRange("bytes=0-1,3-4", 100), { start: 0, endExclusive: 100, partial: false });
assert.deepEqual(parseByteRange("bytes=0-999999999999999999999999", 100), { start: 0, endExclusive: 100, partial: true });
assert.equal(parseByteRange("bytes=100-101", 100), null);
assert.deepEqual(parseByteRange("garbage", 100), { start: 0, endExclusive: 100, partial: false });

const root = path.join(tmp, "workspace");
fs.mkdirSync(root, { recursive: true });
const expected = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
fs.writeFileSync(path.join(root, "sample.bin"), expected);
const sandbox = new LocalSandbox(root, "workspace-write");
const stat = await sandbox.statFile("sample.bin");
assert.equal(stat?.size, expected.byteLength);
assert.equal(stat?.kind, "file");
const chunks: Uint8Array[] = [];
for await (const chunk of sandbox.readFileChunks("sample.bin", { start: 17, endExclusive: 203 })) chunks.push(chunk);
assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), expected.subarray(17, 203));

const user = await signup(`file-preview-${process.pid}@gmail.com`, "password123");
const claims = {
  userId: user.id,
  sessionId: "s_preview_check",
  path: "reports/sample.pdf",
  name: "sample.pdf",
  size: 12_345,
  modifiedAt: 1_700_000_000_123,
  version: "9ix-loyw3v5n",
  backendVersion: "a".repeat(43),
  mimeType: "application/pdf",
  nonce: "a".repeat(32),
  mode: "range" as const,
};
const capability = issueFilePreviewToken(claims);
assert.deepEqual(verifyFilePreviewToken(capability, claims.nonce), claims);
assert.equal(verifyFilePreviewToken(capability, "b".repeat(32)), null, "nonce is part of the capability boundary");
assert.equal(verifyToken(capability), null, "a file capability can never type-confuse into a login Bearer");
assert.equal(previewFileRevision({ size: 100, modifiedAt: 0 }), null, "missing mtime cannot become a size-only capability");
assert.deepEqual(previewFileRevision({ size: 100, modifiedAt: 0, version: "opaque" }), { modifiedAt: 0, version: "opaque" });
assert.deepEqual(previewFileRevision({ size: 100, modifiedAt: 1234 }), { modifiedAt: 1234, version: "2s-ya" });

const sessionId = "s_preview_check";
sessionDao.create({
  id: sessionId,
  user_id: user.id,
  title: "preview check",
  provider: "mock",
  model: "mock-coder",
  sandbox_mode: "workspace-write",
  sandbox_kind: "local",
  sandbox_id: null,
  sandbox_target_id: null,
  e2b_snapshot_id: null,
  mode: "coding",
  approval_policy: "never",
  status: "idle",
  thinking_level: "medium",
  cwd: ".",
  created_at: Date.now(),
  updated_at: Date.now(),
});
const sessionRoot = workspacePathFor(user.id, sessionId);
fs.mkdirSync(sessionRoot, { recursive: true });
fs.writeFileSync(path.join(sessionRoot, "versioned.pdf"), Buffer.from("%PDF-preview-v1"));
const prepared = await prepareFilePreview(user.id, sessionId, "versioned.pdf");
assert(prepared?.ok);
const opened = await openFileChunkStream(user.id, sessionId, "versioned.pdf", {
  start: 0,
  endExclusive: 5,
  expectedSize: prepared.size,
  expectedModifiedAt: prepared.modifiedAt,
  expectedVersion: prepared.version,
  expectedBackendVersion: prepared.backendVersion,
});
assert(opened?.ok);
const prefix: Uint8Array[] = [];
for await (const chunk of opened.stream.chunks) prefix.push(chunk);
opened.stream.close();
assert.equal(Buffer.concat(prefix.map((chunk) => Buffer.from(chunk))).toString("ascii"), "%PDF-");
fs.writeFileSync(path.join(sessionRoot, "versioned.pdf"), Buffer.from("%PDF-preview-v2-longer"));
const stale = await openFileChunkStream(user.id, sessionId, "versioned.pdf", {
  start: 0,
  endExclusive: 5,
  expectedSize: prepared.size,
  expectedModifiedAt: prepared.modifiedAt,
  expectedVersion: prepared.version,
  expectedBackendVersion: prepared.backendVersion,
});
assert.deepEqual(stale, { ok: false, reason: "changed" });

let creates = 0;
let closes = 0;
const pool = new WarmLeasePool<{ id: number; close(): void }>({ warmMs: 60_000, maxEntries: 2, maxEntriesPerOwner: 2 });
const first = pool.acquire({ key: "u/s", owner: "u", fingerprint: "a", create: () => ({ id: ++creates, close: () => { closes++; } }) });
const shared = pool.acquire({ key: "u/s", owner: "u", fingerprint: "a", create: () => ({ id: ++creates, close: () => { closes++; } }) });
assert.equal(first.value, shared.value);
assert.equal(creates, 1);
const replacement = pool.acquire({ key: "u/s", owner: "u", fingerprint: "b", create: () => ({ id: ++creates, close: () => { closes++; } }) });
assert.notEqual(first.value, replacement.value);
assert.equal(closes, 0, "an active stale adapter is never closed under its reader");
first.release();
assert.equal(closes, 0);
shared.release();
assert.equal(closes, 1);
replacement.release();
pool.closeAll();
assert.equal(closes, 2);

const ownerPool = new WarmLeasePool<{ close(): void }>({ warmMs: 60_000, maxEntries: 4, maxEntriesPerOwner: 4 });
let ownerCloses = 0;
const ownerActive = ownerPool.acquire({ key: "u/a", owner: "u", fingerprint: "1", create: () => ({ close: () => { ownerCloses++; } }) });
const ownerWarm = ownerPool.acquire({ key: "u/b", owner: "u", fingerprint: "1", create: () => ({ close: () => { ownerCloses++; } }) });
ownerWarm.release();
assert.equal(ownerPool.invalidateOwner("u"), 2);
assert.equal(ownerCloses, 1, "warm owner adapter closes at lifecycle invalidation");
ownerActive.release();
assert.equal(ownerCloses, 2, "active owner adapter closes only after its final reader releases");

assert.deepEqual(pdfLocationFromFragment("page=7&zoom=200&view=FitV&nameddest=part.2"), {
  page: 7,
  namedDestination: "part.2",
  zoom: 2,
  scaleMode: "fit-height",
});
assert.equal(pdfFitScale({
  pageWidth: 800,
  pageHeight: 1_000,
  stageWidth: 700,
  stageHeight: 900,
  scaleMode: "fit-width",
  horizontalPadding: 40,
  verticalPadding: 32,
}), 0.825);
const extremeAspect = pdfFitScale({
  pageWidth: 1,
  pageHeight: Number.MAX_VALUE,
  stageWidth: 700,
  stageHeight: 900,
  scaleMode: "fit-page",
});
assert(Number.isFinite(extremeAspect) && extremeAspect > 0);
const boundedDisplayScale = clampPdfDisplayScale({
  pageWidth: 100_000,
  pageHeight: 80_000,
  requestedScale: 4,
  maxPixels: 16 * 1024 * 1024,
  maxDimension: 16_384,
});
assert(boundedDisplayScale * 100_000 <= 16_384);
assert(boundedDisplayScale * 80_000 <= 16_384);
assert(boundedDisplayScale * 100_000 <= (16 * 1024 * 1024) / (boundedDisplayScale * 80_000));
assert.equal(clampPdfZoom(99), 4);
assert.equal(clampPdfZoom(0.01), 0.25);
const pinchFactor = pdfPinchWheelScaleFactor({ ctrlKey: true, ctrlKeyDown: false, deltaMode: 0, deltaX: 0, deltaY: -1, deltaZ: 0 });
assert(pinchFactor && pinchFactor > 1);
assert.equal(
  pdfPinchWheelScaleFactor({ ctrlKey: false, ctrlKeyDown: false, deltaMode: 0, deltaX: 0, deltaY: -1, deltaZ: 0 }),
  null,
  "ordinary two-finger scroll is not captured as zoom",
);
const subCent = accumulatePdfZoomFactor(0.4, 1.001, 1);
assert.equal(subCent.factor, 1);
assert(subCent.unusedFactor > 1, "sub-cent pinch motion is retained for a later representable scale");

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const originalFetch = globalThis.fetch;
let sourceSequence = 0;
const revoked: string[] = [];
let mintGate: Promise<void> | null = null;
let mintFailures = 0;
let stableMintVersion: string | null = null;
globalThis.fetch = async (input, init) => {
  const target = String(input);
  if (init?.method === "DELETE") {
    revoked.push(target);
    return new Response(null, { status: 204 });
  }
  const mintedSequence = ++sourceSequence;
  await mintGate;
  if (mintFailures > 0) {
    mintFailures--;
    return Response.json({ error: "synthetic mint failure" }, { status: 500 });
  }
  return Response.json({
    url: `/api/file-preview/${mintedSequence.toString(16).padStart(32, "0")}`,
    size: 100,
    version: stableMintVersion ?? `v${mintedSequence}`,
    mimeType: "image/png",
    expiresAt: Date.now() + 60_000,
    expiresInMs: 60_000,
  });
};
const { acquireFilePreviewSource, filePreviewSource, invalidateFilePreviewSource } = await import("../web/src/files/media-preview-source.ts");
let releaseMint!: () => void;
mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
const racedPromise = acquireFilePreviewSource("cache-session", "raced.png");
invalidateFilePreviewSource("cache-session", "raced.png");
releaseMint();
const raced = await racedPromise;
assert(!revoked.includes(raced.source.url), "invalidate during mint cannot revoke a source before acquire returns");
raced.release();
await Promise.resolve();
assert(revoked.includes(raced.source.url), "raced source revokes only after its acquired lease releases");
mintGate = null;
const active = await acquireFilePreviewSource("cache-session", "active.png");
for (let index = 0; index < 14; index++) await filePreviewSource("cache-session", `inactive-${index}.png`);
assert(!revoked.includes(active.source.url), "LRU pressure never revokes a mounted source");
invalidateFilePreviewSource("cache-session", "active.png");
assert(!revoked.includes(active.source.url), "explicit invalidation defers active source revocation");
active.release();
await Promise.resolve();
assert(revoked.includes(active.source.url), "final release fulfills deferred cookie revocation");

mintFailures = 1;
const failedA = acquireFilePreviewSource("cache-session", "shared-failure.png");
const failedB = acquireFilePreviewSource("cache-session", "shared-failure.png");
const failedResults = await Promise.allSettled([failedA, failedB]);
assert.ok(failedResults.every((result) => result.status === "rejected"), "shared failed mint rejects every lease");
const beforeSharedRetry = sourceSequence;
const [retriedA, retriedB] = await Promise.all([
  acquireFilePreviewSource("cache-session", "shared-failure.png"),
  acquireFilePreviewSource("cache-session", "shared-failure.png"),
]);
assert.equal(sourceSequence, beforeSharedRetry + 1, "N retrying consumers mint one replacement source");
assert.equal(retriedA.generation, retriedB.generation);
assert.equal(retriedA.source.url, retriedB.source.url);
retriedA.release();
retriedB.release();

stableMintVersion = "shared-render-revision";
const staleInlineLease = await acquireFilePreviewSource("cache-session", "shared-render-failure.png");
const staleFileTabLease = await acquireFilePreviewSource(
  "cache-session",
  "shared-render-failure.png",
  stableMintVersion,
);
assert.equal(staleInlineLease.generation, staleFileTabLease.generation);
let releaseRefresh!: () => void;
mintGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
const beforeRefresh = sourceSequence;
const refreshedInlinePromise = acquireFilePreviewSource(
  "cache-session",
  "shared-render-failure.png",
  "",
  staleInlineLease.generation,
);
const refreshedFileTabPromise = acquireFilePreviewSource(
  "cache-session",
  "shared-render-failure.png",
  stableMintVersion,
  staleFileTabLease.generation,
);
assert.equal(sourceSequence, beforeRefresh + 1, "versioned retry waits on the in-flight unversioned replacement");
releaseRefresh();
const [freshInline, freshFileTab] = await Promise.all([refreshedInlinePromise, refreshedFileTabPromise]);
mintGate = null;
assert.equal(sourceSequence, beforeRefresh + 1, "cross-consumer compare-and-replace coalesces to one replacement");
assert.equal(freshInline.generation, freshFileTab.generation);
assert.equal(freshInline.source.url, freshFileTab.source.url);
assert(!revoked.includes(staleInlineLease.source.url), "stale source remains valid while either old-generation view is mounted");
staleInlineLease.release();
await Promise.resolve();
assert(!revoked.includes(staleFileTabLease.source.url), "one surviving old-generation lease defers revocation");
staleFileTabLease.release();
await Promise.resolve();
assert(revoked.includes(staleFileTabLease.source.url), "stale source revokes after final old-generation release");
freshInline.release();
freshFileTab.release();
stableMintVersion = null;

let releaseOverflow!: () => void;
mintGate = new Promise<void>((resolve) => { releaseOverflow = resolve; });
const overflowBefore = sourceSequence;
const protectedOverflowPromise = acquireFilePreviewSource("cache-session", "overflow-protected.png");
const overflowPromises = Array.from({ length: 19 }, (_, index) =>
  filePreviewSource("cache-session", `overflow-${index}.png`)
);
assert.equal(sourceSequence, overflowBefore + 20);
releaseOverflow();
const [protectedOverflow, overflowSources] = await Promise.all([
  protectedOverflowPromise,
  Promise.all(overflowPromises),
]);
mintGate = null;
await Promise.resolve();
const overflowUrls = new Set([protectedOverflow.source.url, ...overflowSources.map((source) => source.url)]);
const overflowRevoked = revoked.filter((url) => overflowUrls.has(url));
assert.equal(overflowRevoked.length, 8, "20 settled entries trim to the 12-source/cookie bound");
assert(!revoked.includes(protectedOverflow.source.url), "settlement trim never revokes an active lease");
protectedOverflow.release();
await filePreviewSource("cache-session", "overflow-pressure-after-release.png");
await Promise.resolve();
assert(revoked.includes(protectedOverflow.source.url), "released oldest lease becomes evictable under later pressure");
globalThis.fetch = originalFetch;

fs.rmSync(tmp, { recursive: true, force: true });
console.log("file preview checks passed");
