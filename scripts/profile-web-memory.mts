import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  summarizeCpuProfile,
  summarizeHeapSamplingProfile,
  writeCpuFlamegraph,
  writeHeapSamplingFlamegraph,
  type CpuProfile,
  type SamplingHeapProfile,
} from "./profile-utils.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const outputDir = path.resolve(process.env.PROFILE_OUTPUT_DIR ?? "docs/pr/278-performance/profiles");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-web-memory-"));
const sessionCount = Number(process.env.PROFILE_SESSION_COUNT ?? 8);
const timelineRows = Number(process.env.PROFILE_TIMELINE_ROWS ?? 160);
const timelineChars = Number(process.env.PROFILE_TIMELINE_CHARS ?? 1_024);
const fileCount = Number(process.env.PROFILE_FILE_COUNT ?? 24);
const fileChars = Number(process.env.PROFILE_FILE_CHARS ?? 64 * 1_024);
const warmSwitches = Number(process.env.PROFILE_WARM_SWITCHES ?? 100);
const coldSwitches = Number(process.env.PROFILE_COLD_SWITCHES ?? 300);
const sidebarCycles = Number(process.env.PROFILE_SIDEBAR_CYCLES ?? 80);
const terminalCycles = Number(process.env.PROFILE_TERMINAL_CYCLES ?? 30);
const streamingTurns = Number(process.env.PROFILE_STREAMING_TURNS ?? 40);
const reconnectCycles = Number(process.env.PROFILE_RECONNECT_CYCLES ?? 20);
const viewCycles = Number(process.env.PROFILE_VIEW_CYCLES ?? 60);
const panelCycles = Number(process.env.PROFILE_PANEL_CYCLES ?? 60);
const soakMinutes = Number(process.env.PROFILE_SOAK_MINUTES ?? 0);
const saveHeapSnapshots = process.env.PROFILE_SAVE_HEAP_SNAPSHOTS === "1";
const hostAtStart = {
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  logicalCpus: os.cpus().length,
  loadAverage: os.loadavg(),
};

process.env.AGENT_WEB_DATA_DIR = dataDir;
process.env.AGENT_WEB_SECRET = "web-memory-profile-secret";
process.env.AGENT_WEB_KEY_SECRET = "web-memory-profile-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";
process.env.AGENT_WEB_AUDIT_STDOUT = "0";
process.env.AGENT_WEB_ALLOWED_EMAIL_DOMAINS = "*";

interface FixtureSession {
  id: string;
  title: string;
  marker: string;
}

interface MemorySample {
  scenario: string;
  step: number;
  elapsedMs: number;
  timestamp: string;
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  embedderHeapUsedBytes: number;
  backingStorageBytes: number;
  documents: number;
  nodes: number;
  jsEventListeners: number;
  frames: number;
  resourceEntries: number;
  websocketCreated: number;
  websocketOpen: number;
  canvasElements: number;
  iframeElements: number;
  timelineTextChars: number;
  sessionCacheHit: boolean;
  rendererRssBytes: number;
  gpuRssBytes: number;
  browserRssBytes: number;
  processRssBytes: number;
}

interface ScenarioSummary {
  samples: number;
  heapDeltaMiB: number;
  heapSlopeKiBPerStep: number;
  tailHeapDeltaMiB: number;
  nodesDelta: number;
  listenersDelta: number;
  documentsDelta: number;
  plateauHint: "stable-tail" | "growing-tail" | "insufficient-samples";
}

const varied = (label: string, index: number, length: number): string => {
  const seed = `${label} row=${index} const result = await profile.run('/workspace/src/module-${index % 97}.ts'); `;
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
};

const PROFILE_LANGUAGES = ["typescript", "python", "bash", "json"] as const;

function timelineText(marker: string, index: number): string {
  const text = varied(marker, index, timelineChars);
  if (index % 2 === 0) return text;
  const assistantIndex = Math.floor(index / 2);
  const languageIndex = assistantIndex - Math.max(0, Math.floor(timelineRows / 2) - PROFILE_LANGUAGES.length);
  if (languageIndex < 0 || languageIndex >= PROFILE_LANGUAGES.length) return text;
  const language = PROFILE_LANGUAGES[languageIndex];
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

function checkpointSet(total: number, desired: number[]): Set<number> {
  return new Set([0, ...desired.filter((value) => value > 0 && value < total), total]);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  if (!port) throw new Error("failed to allocate a profile port");
  return port;
}

async function waitForHealth(url: string, server: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`profile server exited (${server.exitCode})\n${logs.slice(-40).join("\n")}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
    }
    await delay(150);
  }
  throw new Error(`profile server did not become healthy\n${logs.slice(-40).join("\n")}`);
}

async function stopServer(server: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!server || server.exitCode != null) return;
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), delay(3_000)]);
  if (server.exitCode == null) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(1_000)]);
  }
}

async function seedFixture(): Promise<{ email: string; sessions: FixtureSession[] }> {
  const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
  const { sessionManager } = await import("../server/src/runtime/manager.ts");
  const { messageDao, timelineDao, runInTransaction, db } = await import("../server/src/persistence/index.ts");
  const { signup } = await import("../server/src/identity/auth.ts");
  registerMockProvider();

  const email = `web-memory-${process.pid}@gmail.com`;
  const user = await signup(email, "password123");
  const sessions: FixtureSession[] = [];

  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
    const title = `Profile Session ${String(sessionIndex + 1).padStart(2, "0")}`;
    const marker = `profile-session-${String(sessionIndex + 1).padStart(2, "0")}`;
    const id = sessionManager.createSession(user, {
      title,
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL_ID,
      sandboxMode: "workspace-write",
      sandboxKind: "local",
      approvalPolicy: "never",
    }).id;
    const messages = Array.from({ length: Math.min(timelineRows, 80) }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: varied(marker, index, timelineChars),
    }));
    runInTransaction(() => {
      messageDao.replaceAll(id, messages as never);
      for (let index = 0; index < timelineRows; index++) {
        const text = timelineText(marker, index);
        timelineDao.append(id, index % 2 === 0
          ? { kind: "user", id: `u_${sessionIndex}_${index}`, seq: index + 1, text, ts: 1_700_000_000_000 + index }
          : { kind: "assistant", id: `a_${sessionIndex}_${index}`, seq: index + 1, blocks: [{ type: "text", text }], streaming: false, ts: 1_700_000_000_000 + index });
      }
    });
    sessions.push({ id, title, marker });
  }

  sessionManager.disposeUserRuntimes(user.id);
  db.close();
  return { email, sessions };
}

function processRssByPid(pids: number[]): Map<number, number> {
  if (pids.length === 0) return new Map();
  try {
    const output = execFileSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8" });
    return new Map(output.trim().split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      return match ? [[Number(match[1]), Number(match[2]) * 1024] as const] : [];
    }));
  } catch {
    return new Map();
  }
}

async function processRss(browserCdp: CDPSession): Promise<{
  rendererRssBytes: number;
  gpuRssBytes: number;
  browserRssBytes: number;
  processRssBytes: number;
}> {
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo") as {
    processInfo: { id: number; type: string }[];
  };
  const rss = processRssByPid(processInfo.map((process) => process.id));
  let rendererRssBytes = 0;
  let gpuRssBytes = 0;
  let browserRssBytes = 0;
  let processRssBytes = 0;
  for (const process of processInfo) {
    const bytes = rss.get(process.id) ?? 0;
    processRssBytes += bytes;
    if (process.type === "renderer") rendererRssBytes += bytes;
    else if (process.type.toLowerCase().includes("gpu")) gpuRssBytes += bytes;
    else if (process.type === "browser") browserRssBytes += bytes;
  }
  return { rendererRssBytes, gpuRssBytes, browserRssBytes, processRssBytes };
}

async function login(baseURL: string, email: string): Promise<string> {
  const response = await fetch(`${baseURL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (!response.ok) throw new Error(`profile login failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error("profile login returned no token");
  return body.token;
}

async function seedFiles(baseURL: string, token: string, sessionId: string): Promise<string[]> {
  const names = Array.from({ length: fileCount }, (_, index) => `profile-file-${String(index).padStart(3, "0")}.txt`);
  for (let offset = 0; offset < names.length; offset += 4) {
    await Promise.all(names.slice(offset, offset + 4).map(async (name, batchIndex) => {
      const index = offset + batchIndex;
      const response = await fetch(`${baseURL}/api/sessions/${sessionId}/file`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: name, content: varied(`profile-file-${index}`, index, fileChars) }),
      });
      if (!response.ok) throw new Error(`failed to seed ${name}: ${response.status} ${await response.text()}`);
    }));
  }
  return names;
}

function metric(metrics: { name: string; value: number }[], name: string): number {
  return metrics.find((entry) => entry.name === name)?.value ?? 0;
}

async function takeHeapSnapshot(cdp: CDPSession, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stream = fs.createWriteStream(outputPath);
  const onChunk = (event: { chunk: string }) => stream.write(event.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    stream.end();
    await once(stream, "finish");
  }
}

function linearSlope(rows: MemorySample[]): number {
  if (rows.length < 2) return 0;
  const meanX = rows.reduce((sum, row) => sum + row.step, 0) / rows.length;
  const meanY = rows.reduce((sum, row) => sum + row.jsHeapUsedBytes, 0) / rows.length;
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    numerator += (row.step - meanX) * (row.jsHeapUsedBytes - meanY);
    denominator += (row.step - meanX) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function summarizeScenarios(samples: MemorySample[]): Record<string, ScenarioSummary> {
  const groups = new Map<string, MemorySample[]>();
  for (const sample of samples) {
    const rows = groups.get(sample.scenario) ?? [];
    rows.push(sample);
    groups.set(sample.scenario, rows);
  }
  const out: Record<string, ScenarioSummary> = {};
  for (const [scenario, rows] of groups) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const previous = rows[rows.length - 2];
    const tailDelta = previous ? last.jsHeapUsedBytes - previous.jsHeapUsedBytes : 0;
    const stableThreshold = Math.max(2 * 1024 * 1024, previous ? previous.jsHeapUsedBytes * 0.08 : 0);
    out[scenario] = {
      samples: rows.length,
      heapDeltaMiB: (last.jsHeapUsedBytes - first.jsHeapUsedBytes) / 1024 / 1024,
      heapSlopeKiBPerStep: linearSlope(rows) / 1024,
      tailHeapDeltaMiB: tailDelta / 1024 / 1024,
      nodesDelta: last.nodes - first.nodes,
      listenersDelta: last.jsEventListeners - first.jsEventListeners,
      documentsDelta: last.documents - first.documents,
      plateauHint: rows.length < 3 ? "insufficient-samples" : tailDelta <= stableThreshold ? "stable-tail" : "growing-tail",
    };
  }
  return out;
}

function writeCsv(samples: MemorySample[], outputPath: string): void {
  const columns = Object.keys(samples[0] ?? {}) as (keyof MemorySample)[];
  const cell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  fs.writeFileSync(outputPath, `${columns.join(",")}\n${samples.map((row) => columns.map((column) => cell(row[column])).join(",")).join("\n")}\n`);
}

function writeMemoryTrend(samples: MemorySample[], outputPath: string): void {
  const width = 1_600;
  const left = 82;
  const right = 28;
  const top = 58;
  const panelHeight = 132;
  const panelGap = 34;
  const plotWidth = width - left - right;
  const xs = samples.map((_, index) => left + (samples.length <= 1 ? 0 : index * plotWidth / (samples.length - 1)));
  const panels = [
    { label: "Post-GC JS heap (MiB)", value: (row: MemorySample) => row.jsHeapUsedBytes / 1024 / 1024, color: "#c56632" },
    { label: "Renderer RSS (MiB)", value: (row: MemorySample) => row.rendererRssBytes / 1024 / 1024, color: "#8b5f9b" },
    { label: "GPU RSS (MiB)", value: (row: MemorySample) => row.gpuRssBytes / 1024 / 1024, color: "#b68a2f" },
    { label: "All Chromium RSS (MiB)", value: (row: MemorySample) => row.processRssBytes / 1024 / 1024, color: "#4c6f91" },
    { label: "DOM nodes", value: (row: MemorySample) => row.nodes, color: "#397d6b" },
    { label: "JS event listeners", value: (row: MemorySample) => row.jsEventListeners, color: "#5967a8" },
  ];
  const height = top + panels.length * (panelHeight + panelGap) + 70;
  const svg: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fbfaf6"/>`,
    `<text x="24" y="30" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="700" fill="#28241e">Browser longevity profile</text>`,
    `<text x="24" y="47" font-family="ui-monospace,monospace" font-size="10" fill="#82796c">every point is measured after HeapProfiler.collectGarbage()</text>`,
  ];
  panels.forEach((panel, panelIndex) => {
    const yTop = top + panelIndex * (panelHeight + panelGap);
    const values = samples.map(panel.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * 0.12, max === min ? Math.max(1, max * 0.05) : 0);
    const lo = Math.max(0, min - pad);
    const hi = max + pad;
    const y = (value: number) => yTop + panelHeight - ((value - lo) / Math.max(1e-9, hi - lo)) * panelHeight;
    svg.push(`<rect x="${left}" y="${yTop}" width="${plotWidth}" height="${panelHeight}" rx="8" fill="#fff" stroke="#e8ebe3"/>`);
    svg.push(`<text x="24" y="${yTop + 14}" font-family="ui-sans-serif,system-ui" font-size="12" font-weight="600" fill="#514a41">${panel.label}</text>`);
    svg.push(`<text x="${left - 8}" y="${yTop + 5}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="#92877a">${hi.toFixed(panelIndex < 4 ? 1 : 0)}</text>`);
    svg.push(`<text x="${left - 8}" y="${yTop + panelHeight}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="#92877a">${lo.toFixed(panelIndex < 4 ? 1 : 0)}</text>`);
    for (let index = 1; index < samples.length; index++) {
      if (samples[index].scenario !== samples[index - 1].scenario) {
        svg.push(`<line x1="${xs[index]}" x2="${xs[index]}" y1="${yTop}" y2="${yTop + panelHeight}" stroke="#d9d2c8" stroke-dasharray="4 4"/>`);
      }
    }
    const points = samples.map((row, index) => `${xs[index].toFixed(1)},${y(panel.value(row)).toFixed(1)}`).join(" ");
    svg.push(`<polyline points="${points}" fill="none" stroke="${panel.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    samples.forEach((row, index) => svg.push(`<circle cx="${xs[index].toFixed(1)}" cy="${y(panel.value(row)).toFixed(1)}" r="3" fill="${panel.color}"><title>${row.scenario} · ${row.step}: ${panel.value(row).toFixed(2)}</title></circle>`));
  });
  samples.forEach((row, index) => {
    if (index === 0 || row.scenario !== samples[index - 1].scenario) {
      svg.push(`<text x="${xs[index].toFixed(1)}" y="${height - 22}" font-family="ui-monospace,monospace" font-size="9" fill="#6f665c" transform="rotate(-28 ${xs[index].toFixed(1)} ${height - 22})">${row.scenario}</text>`);
    }
  });
  svg.push(`</svg>`);
  fs.writeFileSync(outputPath, svg.join("\n"));
}

async function openSession(page: Page, session: FixtureSession): Promise<void> {
  const row = page.locator(`[data-session-item][aria-label="${session.title}"]`);
  await row.click();
  await page.waitForURL((url) => url.pathname === `/s/${session.id}`);
  await page.waitForFunction((marker) => document.querySelector('[data-testid="timeline"]')?.textContent?.includes(String(marker)), session.marker);
}

async function navigateView(page: Page, pathname: string, selector: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event("app:navigate"));
  }, pathname);
  await page.waitForURL((url) => url.pathname === pathname);
  await page.locator(selector).first().waitFor({ state: "visible" });
}

async function forceWsReconnect(page: Page): Promise<void> {
  const before = await page.evaluate(() => (window as Window & { __oiiaProfileSockets?: { created: number } }).__oiiaProfileSockets?.created ?? 0);
  const closed = await page.evaluate(() => {
    const registry = (window as Window & { __oiiaProfileSockets?: { active: Set<WebSocket> } }).__oiiaProfileSockets;
    const socket = [...(registry?.active ?? [])].find((candidate) => candidate.url.includes("/ws") && candidate.readyState === WebSocket.OPEN);
    if (!socket) return false;
    socket.close(4000, "profile reconnect");
    return true;
  });
  if (!closed) throw new Error("no open application WebSocket to reconnect");
  await page.waitForTimeout(30);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction((createdBefore) => {
    const registry = (window as Window & { __oiiaProfileSockets?: { active: Set<WebSocket>; created: number } }).__oiiaProfileSockets;
    return Boolean(registry && registry.created > Number(createdBefore)
      && [...registry.active].some((socket) => socket.url.includes("/ws") && socket.readyState === WebSocket.OPEN));
  }, before, { timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  const samplesPath = path.join(outputDir, "web-memory-samples.jsonl");
  fs.writeFileSync(samplesPath, "");

  if (process.env.PROFILE_SKIP_BUILD !== "1") {
    execFileSync("npm", ["run", "build:web"], { cwd: ROOT, stdio: "inherit" });
  }
  const fixture = await seedFixture();
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const server = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), ["server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), AGENT_WEB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collectLog = (prefix: string) => (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) logs.push(`${prefix}${line}`);
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  };
  server.stdout.on("data", collectLog("[server] "));
  server.stderr.on("data", collectLog("[server:err] "));

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let cdp: CDPSession | null = null;
  let browserCdp: CDPSession | null = null;
  const samples: MemorySample[] = [];
  const startedAt = Date.now();

  try {
    await waitForHealth(baseURL, server, logs);
    const token = await login(baseURL, fixture.email);
    const files = await seedFiles(baseURL, token, fixture.sessions[0].id);

    browser = await chromium.launch({ headless: true, args: ["--js-flags=--expose-gc"] });
    context = await browser.newContext({ viewport: { width: 1_440, height: 960 }, locale: "en-US" });
    await context.addInitScript((authToken) => {
      try {
        localStorage.setItem("agentweb.token", authToken);
        localStorage.setItem("oiia.locale", "en");
      } catch {  }
    }, token);
    await context.addInitScript(() => {
      const registry = { active: new Set<WebSocket>(), created: 0 };
      Object.defineProperty(window, "__oiiaProfileSockets", { value: registry, configurable: false });
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget) as WebSocket;
          registry.created++;
          registry.active.add(socket);
          socket.addEventListener("close", () => registry.active.delete(socket), { once: true });
          return socket;
        },
      });
    });
    const page = await context.newPage();
    browserCdp = await browser.newBrowserCDPSession();
    let initialRendererRssPeakBytes = 0;
    let initialProcessRssPeakBytes = 0;
    let monitorInitialLoad = true;
    const initialRssMonitor = (async () => {
      while (monitorInitialLoad) {
        try {
          const rss = await processRss(browserCdp!);
          initialRendererRssPeakBytes = Math.max(initialRendererRssPeakBytes, rss.rendererRssBytes);
          initialProcessRssPeakBytes = Math.max(initialProcessRssPeakBytes, rss.processRssBytes);
        } catch {
          break;
        }
        await delay(25);
      }
    })();
    const initialLoadStartedAt = performance.now();
    await page.goto(`${baseURL}/s/${fixture.sessions[0].id}`);
    await page.locator('[data-testid="main-content"]').waitFor();
    await page.waitForFunction((marker) => document.querySelector('[data-testid="timeline"]')?.textContent?.includes(String(marker)), fixture.sessions[0].marker);
    await page.waitForFunction((expected) => {
      const blocks = [...document.querySelectorAll<HTMLElement>(".codeblock-body")];
      return blocks.length >= Number(expected)
        && blocks.filter((block) => block.querySelector(".shiki .line")).length >= Number(expected);
    }, Math.min(Math.floor(timelineRows / 2), PROFILE_LANGUAGES.length));
    const initialHighlightReadyMs = performance.now() - initialLoadStartedAt;
    await page.waitForTimeout(300);
    monitorInitialLoad = false;
    await initialRssMonitor;
    const initialUi = await page.evaluate(() => ({
      codeBlocks: document.querySelectorAll(".codeblock-body").length,
      highlightedBlocks: [...document.querySelectorAll<HTMLElement>(".codeblock-body")]
        .filter((block) => block.querySelector(".shiki .line")).length,
      resourceEntries: performance.getEntriesByType("resource").length,
    }));

    cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1_000 });
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32_768 });

    const record = async (scenario: string, step: number): Promise<void> => {
      await page.waitForTimeout(160);
      await cdp!.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(80);
      const [performanceResult, heapResult, domResult, ui, processMemory] = await Promise.all([
        cdp!.send("Performance.getMetrics") as Promise<{ metrics: { name: string; value: number }[] }>,
        cdp!.send("Runtime.getHeapUsage") as Promise<{ usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number }>,
        cdp!.send("Memory.getDOMCounters") as Promise<{ documents: number; nodes: number; jsEventListeners: number }>,
        page.evaluate(() => {
          const registry = (window as Window & { __oiiaProfileSockets?: { active: Set<WebSocket>; created: number } }).__oiiaProfileSockets;
          const timeline = document.querySelector('[data-testid="timeline"]');
          return {
            resourceEntries: performance.getEntriesByType("resource").length,
            websocketCreated: registry?.created ?? 0,
            websocketOpen: [...(registry?.active ?? [])].filter((socket) => socket.readyState === WebSocket.OPEN).length,
            canvasElements: document.querySelectorAll("canvas").length,
            iframeElements: document.querySelectorAll("iframe").length,
            timelineTextChars: timeline?.textContent?.length ?? 0,
            sessionCacheHit: document.querySelector('[data-testid="main-content"]')?.getAttribute("data-session-cache-hit") === "true",
          };
        }),
        processRss(browserCdp!),
      ]);
      const sample: MemorySample = {
        scenario,
        step,
        elapsedMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        jsHeapUsedBytes: heapResult.usedSize || metric(performanceResult.metrics, "JSHeapUsedSize"),
        jsHeapTotalBytes: heapResult.totalSize || metric(performanceResult.metrics, "JSHeapTotalSize"),
        embedderHeapUsedBytes: heapResult.embedderHeapUsedSize ?? 0,
        backingStorageBytes: heapResult.backingStorageSize ?? 0,
        documents: domResult.documents,
        nodes: domResult.nodes,
        jsEventListeners: domResult.jsEventListeners,
        frames: metric(performanceResult.metrics, "Frames"),
        ...ui,
        ...processMemory,
      };
      samples.push(sample);
      fs.appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
      console.log(`[memory] ${scenario} ${step}: heap=${(sample.jsHeapUsedBytes / 1024 / 1024).toFixed(2)}MiB nodes=${sample.nodes} listeners=${sample.jsEventListeners}`);
    };

    if (saveHeapSnapshots) await takeHeapSnapshot(cdp, path.join(outputDir, "web-memory-baseline.heapsnapshot"));

    await cdp.send("Profiler.start");
    const runSwitches = async (scenario: string, total: number, pool: FixtureSession[], checkpoints: Set<number>) => {
      await record(scenario, 0);
      for (let index = 1; index <= total; index++) {
        await openSession(page, pool[index % pool.length]);
        if (checkpoints.has(index)) await record(scenario, index);
      }
    };
    await runSwitches("session-warm-ab", warmSwitches, fixture.sessions.slice(0, 2), checkpointSet(warmSwitches, [1, 10, 30]));
    await runSwitches("session-cold-lru", coldSwitches, fixture.sessions, checkpointSet(coldSwitches, [1, 10, 30, 100]));
    const cpuResult = await cdp.send("Profiler.stop") as { profile: CpuProfile };
    fs.writeFileSync(path.join(outputDir, "web-session-switch.cpuprofile"), JSON.stringify(cpuResult.profile));
    writeCpuFlamegraph(cpuResult.profile, path.join(outputDir, "web-session-switch-flame.svg"), "Browser Session-switch CPU");

    await openSession(page, fixture.sessions[0]);
    await record("route-view-cycle", 0);
    const viewCheckpoints = checkpointSet(viewCycles, [1, 10, 30]);
    for (let index = 1; index <= viewCycles; index++) {
      await navigateView(page, "/blog", '[data-testid="blog-view"]');
      await navigateView(page, "/settings", '[data-testid="settings-modal"]');
      await navigateView(page, "/plugins", '[data-testid="plugins-view"]');
      await openSession(page, fixture.sessions[index % fixture.sessions.length]);
      if (viewCheckpoints.has(index)) await record("route-view-cycle", index);
    }

    await openSession(page, fixture.sessions[0]);
    await record("panel-cycle", 0);
    const panelCheckpoints = checkpointSet(panelCycles, [1, 10, 30]);
    for (let index = 1; index <= panelCycles; index++) {
      const collapse = page.getByRole("button", { name: "Collapse sidebar" });
      if (await collapse.count()) await collapse.click();
      const open = page.getByRole("button", { name: "Open sidebar" });
      if (await open.count()) await open.click();
      const details = page.getByRole("button", { name: "Toggle details panel" });
      await details.click();
      await page.waitForTimeout(18);
      await details.click();
      if (panelCheckpoints.has(index)) await record("panel-cycle", index);
    }

    await openSession(page, fixture.sessions[0]);
    const detailsToggle = page.getByRole("button", { name: "Toggle details panel" });
    await record("right-sidebar-mount", 0);
    const sidebarCheckpoints = checkpointSet(sidebarCycles, [20]);
    for (let index = 1; index <= sidebarCycles; index++) {
      await detailsToggle.click();
      await page.waitForTimeout(18);
      await detailsToggle.click();
      if (sidebarCheckpoints.has(index)) await record("right-sidebar-mount", index);
    }

    await detailsToggle.click();
    await page.getByTestId(`file-${files[0]}`).waitFor();
    await record("file-preview-retention", 0);
    const fileCheckpoints = checkpointSet(files.length, [Math.min(8, files.length)]);
    for (let index = 0; index < files.length; index++) {
      await page.getByTestId(`file-${files[index]}`).click();
      await page.getByTestId("file-view").waitFor();
      if (index + 1 < files.length) await page.getByRole("button", { name: "File Tree", exact: true }).click();
      if (fileCheckpoints.has(index + 1)) await record("file-preview-retention", index + 1);
    }
    await detailsToggle.click();

    await record("terminal-mount", 0);
    const terminalCheckpoints = checkpointSet(terminalCycles, [10]);
    for (let index = 1; index <= terminalCycles; index++) {
      await page.getByTestId("open-terminal").click();
      await page.getByTestId("shell-tab-terminal").click();
      await page.getByTestId("shell-terminal").waitFor();
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="shell-terminal"]')?.getAttribute("data-state");
        return state === "idle" || state === "open" || state === "verification_required";
      });
      await openSession(page, fixture.sessions[0]);
      if (terminalCheckpoints.has(index)) await record("terminal-mount", index);
    }

    await record("mock-streaming", 0);
    const streamingCheckpoints = checkpointSet(streamingTurns, [10]);
    for (let index = 1; index <= streamingTurns; index++) {
      const composer = page.getByTestId("composer");
      await composer.fill(`profile streaming turn ${index}`);
      await composer.press("Enter");
      await page.getByTestId("send").waitFor({ timeout: 15_000 });
      if (streamingCheckpoints.has(index)) await record("mock-streaming", index);
    }

    await record("ws-reconnect", 0);
    const reconnectCheckpoints = checkpointSet(reconnectCycles, [5, 10]);
    for (let index = 1; index <= reconnectCycles; index++) {
      await forceWsReconnect(page);
      if (reconnectCheckpoints.has(index)) await record("ws-reconnect", index);
    }

    if (soakMinutes > 0) {
      const soakDeadline = Date.now() + soakMinutes * 60_000;
      let iteration = 0;
      let nextSample = Date.now();
      await record("soak", 0);
      while (Date.now() < soakDeadline) {
        iteration++;
        await openSession(page, fixture.sessions[iteration % fixture.sessions.length]);
        if (iteration % 5 === 0) { await detailsToggle.click(); await page.waitForTimeout(25); await detailsToggle.click(); }
        if (iteration % 20 === 0) await forceWsReconnect(page);
        if (Date.now() >= nextSample) {
          await record("soak", iteration);
          nextSample = Date.now() + 60_000;
        }
      }
      await record("soak", iteration);
    }

    if (saveHeapSnapshots) await takeHeapSnapshot(cdp, path.join(outputDir, "web-memory-final.heapsnapshot"));
    const heapSamplingResult = await cdp.send("HeapProfiler.stopSampling") as { profile: SamplingHeapProfile };
    fs.writeFileSync(path.join(outputDir, "web-memory-allocations.heapsampling"), JSON.stringify(heapSamplingResult.profile));
    writeHeapSamplingFlamegraph(heapSamplingResult.profile, path.join(outputDir, "web-memory-allocation-flame.svg"), "Browser sampled allocations across longevity scenarios");

    const scenarioSummary = summarizeScenarios(samples);
    const summary = {
      host: { ...hostAtStart, chromium: browser.version(), loadAverageAtEnd: os.loadavg() },
      fixture: { sessionCount, timelineRows, timelineChars, fileCount, fileChars },
      workload: { warmSwitches, coldSwitches, viewCycles, panelCycles, sidebarCycles, terminalCycles, streamingTurns, reconnectCycles, soakMinutes },
      initialLoad: {
        highlightReadyMs: initialHighlightReadyMs,
        codeBlocks: initialUi.codeBlocks,
        highlightedBlocks: initialUi.highlightedBlocks,
        resourceEntries: initialUi.resourceEntries,
        rendererRssPeakBytes: initialRendererRssPeakBytes,
        processRssPeakBytes: initialProcessRssPeakBytes,
      },
      scenarioSummary,
      cpu: summarizeCpuProfile(cpuResult.profile),
      allocations: summarizeHeapSamplingProfile(heapSamplingResult.profile),
    };
    fs.writeFileSync(path.join(outputDir, "web-memory-summary.json"), JSON.stringify(summary, null, 2));
    writeCsv(samples, path.join(outputDir, "web-memory-samples.csv"));
    writeMemoryTrend(samples, path.join(outputDir, "web-memory-trend.svg"));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (browserCdp) await browserCdp.detach().catch(() => {});
    if (cdp) await cdp.detach().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
