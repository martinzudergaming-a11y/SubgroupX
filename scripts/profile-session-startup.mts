import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { captureCpuProfile, summarizeCpuProfile, writeCpuFlamegraph } from "./profile-utils.mts";

const outputDir = path.resolve(process.env.PROFILE_OUTPUT_DIR ?? "docs/pr/278-performance/profiles");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-session-profile-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "session-profile-secret";
process.env.AGENT_WEB_KEY_SECRET = "session-profile-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";

const runtimeIterations = Number(process.env.PROFILE_RUNTIME_ITERATIONS ?? 180);
const replayIterations = Number(process.env.PROFILE_REPLAY_ITERATIONS ?? 36);
const runtimeProfileIterations = Number(process.env.PROFILE_RUNTIME_CPU_ITERATIONS ?? 36);
const replayProfileIterations = Number(process.env.PROFILE_REPLAY_CPU_ITERATIONS ?? 8);
const messageRows = Number(process.env.PROFILE_MESSAGE_ROWS ?? 600);
const timelineRows = Number(process.env.PROFILE_TIMELINE_ROWS ?? 2_400);
const charsPerMessage = Number(process.env.PROFILE_MESSAGE_CHARS ?? 2_048);
const charsPerTimelineRow = Number(process.env.PROFILE_TIMELINE_CHARS ?? 4_096);
const hostAtStart = {
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  logicalCpus: os.cpus().length,
  loadAverage: os.loadavg(),
};

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { messageDao, timelineDao, runInTransaction, db } = await import("../server/src/persistence/index.ts");
const { signup } = await import("../server/src/identity/auth.ts");
registerMockProvider();

const user = await signup(`profile-${process.pid}@gmail.com`, "password123");
const sessionId = sessionManager.createSession(user, {
  title: "cold startup profile",
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "never",
}).id;

const varied = (index: number, length: number): string => {
  const seed = `row=${index} const result = await tool.run('/workspace/src/module-${index % 97}.ts'); `;
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
};

const messages = Array.from({ length: messageRows }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: varied(index, charsPerMessage),
}));
runInTransaction(() => {
  messageDao.replaceAll(sessionId, messages as never);
  for (let index = 0; index < timelineRows; index++) {
    const text = varied(index, charsPerTimelineRow);
    timelineDao.append(sessionId, index % 2 === 0
      ? { kind: "user", id: `u_${index}`, seq: index + 1, text, ts: 1_700_000_000_000 + index }
      : { kind: "assistant", id: `a_${index}`, seq: index + 1, blocks: [{ type: "text", text }], streaming: false, ts: 1_700_000_000_000 + index });
  }
});

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const stats = (values: number[]) => ({
  n: values.length,
  meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
  p50Ms: percentile(values, 0.50),
  p95Ms: percentile(values, 0.95),
  maxMs: Math.max(...values),
});

{
  const runtime = sessionManager.getRuntime(user.id, sessionId)!;
  JSON.stringify(runtime.getTimeline());
  sessionManager.disposeUserRuntimes(user.id);
}

fs.mkdirSync(outputDir, { recursive: true });
const runtimeTimes: number[] = [];
for (let index = 0; index < runtimeIterations; index++) {
  const start = performance.now();
  sessionManager.getRuntime(user.id, sessionId)!;
  runtimeTimes.push(performance.now() - start);
  sessionManager.disposeUserRuntimes(user.id);
}
const runtimeProfilePath = path.join(outputDir, "session-runtime-cold.cpuprofile");
const runtimeProfile = await captureCpuProfile(runtimeProfilePath, () => {
  for (let index = 0; index < runtimeProfileIterations; index++) {
    sessionManager.getRuntime(user.id, sessionId)!;
    sessionManager.disposeUserRuntimes(user.id);
  }
});
writeCpuFlamegraph(runtimeProfile, path.join(outputDir, "session-runtime-cold-flame.svg"), "Cold AgentSessionRuntime construction");

const constructTimes: number[] = [];
const timelineTimes: number[] = [];
const stringifyTimes: number[] = [];
const fullTimes: number[] = [];
let replayBytes = 0;
for (let index = 0; index < replayIterations; index++) {
  const fullStart = performance.now();
  const constructStart = performance.now();
  const runtime = sessionManager.getRuntime(user.id, sessionId)!;
  constructTimes.push(performance.now() - constructStart);
  const timelineStart = performance.now();
  const items = runtime.getTimeline();
  timelineTimes.push(performance.now() - timelineStart);
  const stringifyStart = performance.now();
  const payload = JSON.stringify({ type: "timeline_replay", sessionId, epoch: runtime.getEpoch(), items, pending: runtime.getPendingQueue() });
  stringifyTimes.push(performance.now() - stringifyStart);
  replayBytes = Buffer.byteLength(payload);
  fullTimes.push(performance.now() - fullStart);
  sessionManager.disposeUserRuntimes(user.id);
}
const replayProfilePath = path.join(outputDir, "session-replay-cold.cpuprofile");
const replayProfile = await captureCpuProfile(replayProfilePath, () => {
  for (let index = 0; index < replayProfileIterations; index++) {
    const runtime = sessionManager.getRuntime(user.id, sessionId)!;
    const items = runtime.getTimeline();
    JSON.stringify({ type: "timeline_replay", sessionId, epoch: runtime.getEpoch(), items, pending: runtime.getPendingQueue() });
    sessionManager.disposeUserRuntimes(user.id);
  }
});
writeCpuFlamegraph(replayProfile, path.join(outputDir, "session-replay-cold-flame.svg"), "Cold runtime + Timeline replay serialization");

const summary = {
  host: { ...hostAtStart, loadAverageAtEnd: os.loadavg() },
  fixture: {
    messageRows,
    timelineRows,
    charsPerMessage,
    charsPerTimelineRow,
    replayBytes,
    timingIterations: { runtime: runtimeIterations, replay: replayIterations },
    cpuProfileIterations: { runtime: runtimeProfileIterations, replay: replayProfileIterations },
  },
  runtimeConstruction: stats(runtimeTimes),
  coldSubscribe: {
    total: stats(fullTimes),
    runtimeConstruction: stats(constructTimes),
    timelineLoadParse: stats(timelineTimes),
    replayStringify: stats(stringifyTimes),
  },
  cpu: {
    runtimeConstruction: summarizeCpuProfile(runtimeProfile),
    coldSubscribe: summarizeCpuProfile(replayProfile),
  },
};
fs.writeFileSync(path.join(outputDir, "session-startup-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

sessionManager.disposeUserRuntimes(user.id);
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
