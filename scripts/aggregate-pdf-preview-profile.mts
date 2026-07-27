import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

type Summary = {
  coldTtfpMs: number | null;
  network: {
    rows: { kind: string; encodedBytes?: number }[];
    encodedRangeBytes: number;
  };
  warm: { elapsedMs: number; rangeRequests: number } | null;
};

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value) throw new Error(`missing ${name}`);
  return path.resolve(value);
}

function summaries(root: string, prefix: string): Summary[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(root, entry.name, "summary.json"), "utf8")) as Summary);
}

function values(rows: Summary[]): number[] {
  return rows.map((row) => row.coldTtfpMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function median(input: number[]): number {
  if (input.length === 0) throw new Error("cannot aggregate an empty sample");
  const sorted = [...input].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sample(input: number[]): { values: number[]; median: number; min: number; max: number } {
  const rounded = input.map((value) => Math.round(value * 10) / 10);
  return {
    values: rounded,
    median: Math.round(median(input) * 10) / 10,
    min: Math.round(Math.min(...input) * 10) / 10,
    max: Math.round(Math.max(...input) * 10) / 10,
  };
}

function medianEncoded(rows: Summary[], kinds: Set<string>): number {
  return Math.round(median(rows.map((row) => row.network.rows.reduce(
    (total, request) => total + (kinds.has(request.kind) ? request.encodedBytes ?? 0 : 0),
    0,
  ))));
}

function bundleAsset(assetDir: string, prefix: string): { rawBytes: number; gzipBytes: number } {
  const name = fs.readdirSync(assetDir).find((entry) => entry.startsWith(prefix));
  if (!name) throw new Error(`missing ${prefix} bundle in ${assetDir}`);
  const bytes = fs.readFileSync(path.join(assetDir, name));
  return { rawBytes: bytes.byteLength, gzipBytes: zlib.gzipSync(bytes, { level: 9 }).byteLength };
}

const beforeDir = argument("--before-dir");
const afterDir = argument("--after-dir");
const output = argument("--output");
const assetDir = path.resolve(process.env.PROFILE_ASSET_DIR ?? "web/dist/assets");
const fixtureBytes = Number(process.env.PROFILE_FIXTURE_BYTES ?? 12_583_590);
const beforeLoop = summaries(beforeDir, "loop-");
const afterLoop = summaries(afterDir, "loop-");
const beforeShaped = summaries(beforeDir, "shaped-v2-");
const afterShaped = summaries(afterDir, "shaped-v2-");
const beforeEncoded = medianEncoded(beforeShaped, new Set(["legacy-file", "legacy-download"]));
const afterEncoded = medianEncoded(afterShaped, new Set(["range"]));
const beforeShapedValues = values(beforeShaped);
const afterShapedValues = values(afterShaped);
const beforeShapedMedian = median(beforeShapedValues);
const afterShapedMedian = median(afterShapedValues);

const result = {
  generatedAt: new Date().toISOString(),
  fixture: {
    bytes: fixtureBytes,
    pages: 1,
    description: "synthetic valid PDF with a large unreferenced stream",
  },
  environment: {
    browser: "Chrome headless via Playwright/CDP",
    viewport: "1600x1000",
    beforeCommit: "dc66c09",
    afterBranch: "codex/pdf-performance",
  },
  methodology: {
    loopbackColdRuns: beforeLoop.length,
    shapedColdRuns: beforeShaped.length,
    statistic: "median with observed min/max; fresh browser/session per run",
    serviceWorkers: "blocked",
    dedicatedWorkerNetworkRule: true,
    shapedNetwork: { latencyMs: 80, downloadMbps: 20, uploadMbps: 20, enabledAfterBootstrap: true },
  },
  results: {
    coldTtfpLoopbackMs: { before: sample(values(beforeLoop)), after: sample(values(afterLoop)) },
    coldTtfpShapedMs: {
      before: sample(beforeShapedValues),
      after: sample(afterShapedValues),
      reductionPct: Math.round((1 - afterShapedMedian / beforeShapedMedian) * 1_000) / 10,
    },
    documentDataPathEncodedBytes: {
      before: beforeEncoded,
      after: afterEncoded,
      reductionPct: Math.round((1 - afterEncoded / beforeEncoded) * 1_000) / 10,
    },
    afterWarmZoomMs: {
      ...sample(afterLoop.map((row) => row.warm?.elapsedMs).filter((value): value is number => typeof value === "number")),
      newRangeRequests: afterLoop.map((row) => row.warm?.rangeRequests ?? null),
    },
    lazyBundleCost: {
      pdfUi: bundleAsset(assetDir, "PdfPreview-"),
      pdfWorker: bundleAsset(assetDir, "pdf.worker"),
    },
  },
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(`wrote ${output}`);
