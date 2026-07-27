import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ServerEvent, TimelineReplayCursor } from "../shared/src/protocol.ts";

const outputDir = path.resolve(process.env.PROFILE_OUTPUT_DIR ?? "docs/pr/278-performance/replay-resume");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-replay-resume-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "replay-resume-secret";
process.env.AGENT_WEB_KEY_SECRET = "replay-resume-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "60000";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const iterations = Number(process.env.PROFILE_REPLAY_RESUME_ITERATIONS ?? 24);
const timelineRows = Number(process.env.PROFILE_TIMELINE_ROWS ?? 2_400);
const charsPerTimelineRow = Number(process.env.PROFILE_TIMELINE_CHARS ?? 4_096);
const hostAtStart = {
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  logicalCpus: os.cpus().length,
  loadAverage: os.loadavg(),
};

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { timelineDao, runInTransaction, db } = await import("../server/src/persistence/index.ts");
const { signup } = await import("../server/src/identity/auth.ts");
const { LocalSessionGateway } = await import("../server/src/runtime/session-gateway.ts");
registerMockProvider();

const user = await signup(`replay-resume-${process.pid}@gmail.com`, "password123");
const create = (title: string) => sessionManager.createSession(user, {
  title,
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "never",
}).id;
const sessionA = create("large replay A");
const sessionB = create("switch target B");

const varied = (index: number, length: number): string => {
  const seed = `row=${index} const result = await tool.run('/workspace/src/module-${index % 97}.ts'); `;
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
};
runInTransaction(() => {
  for (let index = 0; index < timelineRows; index++) {
    const text = varied(index, charsPerTimelineRow);
    timelineDao.append(sessionA, index % 2 === 0
      ? { kind: "user", id: `u_${index}`, seq: index + 1, text, ts: 1_700_000_000_000 + index }
      : { kind: "assistant", id: `a_${index}`, seq: index + 1, blocks: [{ type: "text", text }], streaming: false, ts: 1_700_000_000_000 + index });
  }
});

interface Capture {
  bytes: number;
  serializeCpuMs: number;
  types: string[];
  replay?: Extract<ServerEvent, { type: "timeline_replay" }>;
}
let capture: Capture | null = null;
const gateway = new LocalSessionGateway(user.id, (event) => {
  if (!capture) return;
  if (event.type === "sandbox_load") return;
  const cpuStart = process.cpuUsage();
  const payload = JSON.stringify(event);
  const cpu = process.cpuUsage(cpuStart);
  capture.serializeCpuMs += (cpu.user + cpu.system) / 1_000;
  capture.bytes += Buffer.byteLength(payload);
  capture.types.push(event.type);
  if (event.type === "timeline_replay") capture.replay = event;
});

const run = async (cursor?: TimelineReplayCursor): Promise<{ durationMs: number; cpuMs: number; capture: Capture }> => {
  const current: Capture = { bytes: 0, serializeCpuMs: 0, types: [] };
  capture = current;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const ensured = gateway.ensureSubscribed(sessionA);
  const replayed = gateway.replaySubscribed(sessionA, cursor);
  const durationMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  assert.equal(await ensured, true);
  await replayed;
  capture = null;
  return { durationMs, cpuMs: (cpu.user + cpu.system) / 1_000, capture: current };
};

try {
  const first = await run();
  assert.ok(first.capture.replay, "initial subscribe emits a Timeline replay");
  const cursor = { epoch: first.capture.replay.epoch, version: first.capture.replay.version };
  capture = { bytes: 0, serializeCpuMs: 0, types: [] };
  assert.equal(await gateway.ensureSubscribed(sessionB), true);
  await gateway.replaySubscribed(sessionB);
  capture = null;

  const fullMs: number[] = [];
  const resumeMs: number[] = [];
  const fullCpuMs: number[] = [];
  const resumeCpuMs: number[] = [];
  const fullSerializeCpuMs: number[] = [];
  const resumeSerializeCpuMs: number[] = [];
  let fullBytes = 0;
  let resumeBytes = 0;
  for (let index = 0; index < iterations; index++) {
    const order = index % 2 === 0 ? ["full", "resume"] as const : ["resume", "full"] as const;
    for (const kind of order) {
      const sample = await run(kind === "resume" ? cursor : undefined);
      if (kind === "full") {
        assert.ok(sample.capture.types.includes("timeline_replay"));
        fullMs.push(sample.durationMs);
        fullCpuMs.push(sample.cpuMs);
        fullSerializeCpuMs.push(sample.capture.serializeCpuMs);
        fullBytes = sample.capture.bytes;
      } else {
        assert.ok(!sample.capture.types.includes("timeline_replay"));
        assert.ok(sample.capture.types.includes("session_status") && sample.capture.types.includes("context_usage"));
        resumeMs.push(sample.durationMs);
        resumeCpuMs.push(sample.cpuMs);
        resumeSerializeCpuMs.push(sample.capture.serializeCpuMs);
        resumeBytes = sample.capture.bytes;
      }
    }
  }

  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  const stats = (values: number[]) => ({
    n: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  });
  const full = stats(fullMs);
  const resumed = stats(resumeMs);
  const fullCpu = stats(fullCpuMs);
  const resumedCpu = stats(resumeCpuMs);
  const fullSerializeCpu = stats(fullSerializeCpuMs);
  const resumedSerializeCpu = stats(resumeSerializeCpuMs);
  const summary = {
    host: { ...hostAtStart, loadAverageAtEnd: os.loadavg() },
    fixture: { timelineRows, charsPerTimelineRow, iterations },
    fullReplay: { gatewaySync: full, cpu: fullCpu, frameSerializationCpu: fullSerializeCpu, emittedBytes: fullBytes },
    matchedResume: { gatewaySync: resumed, cpu: resumedCpu, frameSerializationCpu: resumedSerializeCpu, emittedBytes: resumeBytes },
    improvement: {
      emittedBytesSaved: fullBytes - resumeBytes,
      emittedBytesReductionPct: fullBytes ? (1 - resumeBytes / fullBytes) * 100 : 0,
      gatewaySyncP50Speedup: resumed.p50Ms ? full.p50Ms / resumed.p50Ms : 0,
      cpuP50Speedup: resumedCpu.p50Ms ? fullCpu.p50Ms / resumedCpu.p50Ms : 0,
      frameSerializationP50Speedup: resumedSerializeCpu.p50Ms ? fullSerializeCpu.p50Ms / resumedSerializeCpu.p50Ms : 0,
    },
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  const metrics = [
    { label: "Emitted JSON", unit: "MiB", before: fullBytes / 1024 / 1024, after: resumeBytes / 1024 / 1024, digits: 3 },
    { label: "Gateway sync p50", unit: "ms", before: full.p50Ms, after: resumed.p50Ms, digits: 3 },
    { label: "Frame serialization CPU p50", unit: "ms", before: fullSerializeCpu.p50Ms, after: resumedSerializeCpu.p50Ms, digits: 3 },
  ];
  const rows = metrics.map((metric, index) => {
    const y = 92 + index * 118;
    const max = Math.max(metric.before, metric.after);
    const width = (value: number) => Math.max(1, 680 * (value / max));
    const fmt = (value: number) => `${value.toFixed(metric.digits)} ${metric.unit}`;
    return `<g>
      <text x="28" y="${y}" font-size="15" font-weight="700" fill="#302c26">${metric.label}</text>
      <text x="28" y="${y + 31}" font-size="12" fill="#7a7268">Full replay</text>
      <rect x="150" y="${y + 15}" width="${width(metric.before).toFixed(2)}" height="22" rx="6" fill="#d97757"/>
      <text x="160" y="${y + 31}" font-size="12" font-weight="700" font-family="ui-monospace,monospace" fill="#fffaf4">${fmt(metric.before)}</text>
      <text x="28" y="${y + 65}" font-size="12" fill="#7a7268">Matched cursor</text>
      <rect x="150" y="${y + 49}" width="${width(metric.after).toFixed(2)}" height="22" rx="6" fill="#3d9368"/>
      <text x="160" y="${y + 65}" font-size="12" font-weight="700" font-family="ui-monospace,monospace" fill="#276b4a">${fmt(metric.after)}</text>
    </g>`;
  }).join("\n");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1020" height="455" viewBox="0 0 1020 455">
  <rect width="100%" height="100%" rx="18" fill="#fbfaf6"/>
  <text x="28" y="34" font-family="ui-sans-serif,system-ui" font-size="20" font-weight="800" fill="#28241e">Warm Session replay: full snapshot vs matching cursor</text>
  <text x="28" y="57" font-family="ui-sans-serif,system-ui" font-size="12" fill="#82796c">2,400 rows · 10.06 MB decompressed replay · 24 alternating samples · bars normalized per metric</text>
  <g font-family="ui-sans-serif,system-ui">${rows}</g>
  <text x="28" y="434" font-family="ui-monospace,monospace" font-size="11" fill="#82796c">Host load was ${hostAtStart.loadAverage[0].toFixed(1)} on ${hostAtStart.logicalCpus} logical CPUs; bytes and serialization CPU are the decisive signals.</text>
</svg>`;
  fs.writeFileSync(path.join(outputDir, "before-after.svg"), svg);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  gateway.close();
  sessionManager.disposeUserRuntimes(user.id);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
