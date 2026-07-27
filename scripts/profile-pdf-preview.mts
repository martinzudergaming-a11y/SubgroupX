import { chromium, type CDPSession, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  summarizeCpuProfile,
  summarizeHeapSamplingProfile,
  writeCpuFlamegraph,
  writeHeapSamplingFlamegraph,
  type CpuProfile,
  type SamplingHeapProfile,
} from "./profile-utils.mts";

const baseURL = process.env.PROFILE_BASE_URL ?? "http://127.0.0.1:4319";
let sessionId = process.env.PROFILE_SESSION_ID ?? "";
const fileName = process.env.PROFILE_FILE ?? "Claude_Sonnet_5_System_Card.pdf";
const outputDir = path.resolve(process.env.PROFILE_OUTPUT_DIR ?? "test-results/pdf-profile/current");
const bootstrap = process.env.PROFILE_BOOTSTRAP === "1";
const captureTrace = process.env.PROFILE_TRACE === "1";
const latencyMs = Math.max(0, Number(process.env.PROFILE_LATENCY_MS ?? 0) || 0);
const downloadMbps = Math.max(0, Number(process.env.PROFILE_DOWNLOAD_MBPS ?? 0) || 0);
const uploadMbps = Math.max(0, Number(process.env.PROFILE_UPLOAD_MBPS ?? process.env.PROFILE_DOWNLOAD_MBPS ?? 0) || 0);
const resizeStress = process.env.PROFILE_RESIZE_STRESS === "1";
const deviceScaleFactor = Math.max(1, Number(process.env.PROFILE_DPR ?? (resizeStress ? 2 : 1)) || 1);
const token = process.env.PROFILE_TOKEN
  ?? (process.env.PROFILE_TOKEN_FILE ? fs.readFileSync(process.env.PROFILE_TOKEN_FILE, "utf8").trim() : "");
if (!bootstrap && (!token || !sessionId)) {
  throw new Error("Set PROFILE_SESSION_ID + PROFILE_TOKEN_FILE/PROFILE_TOKEN, or PROFILE_BOOTSTRAP=1 for a local server");
}
fs.mkdirSync(outputDir, { recursive: true });

type NetRow = {
  id: string;
  kind: "mint" | "range" | "legacy-file" | "legacy-download" | "pdf-code" | "pdf-worker" | "pdf-support";
  url: string;
  range?: string;
  start: number;
  response?: number;
  finish?: number;
  status?: number;
  encodedBytes?: number;
  contentRange?: string;
  failed?: string;
};

class NestedCdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  private readonly onMessage: (event: { sessionId: string; message: string }) => void;

  constructor(private readonly parent: CDPSession, readonly sessionId: string) {
    this.onMessage = (event) => {
      if (event.sessionId !== this.sessionId) return;
      const message = JSON.parse(event.message) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id == null) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "nested CDP error"));
      else waiter.resolve(message.result);
    };
    parent.on("Target.receivedMessageFromTarget", this.onMessage);
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    await this.parent.send("Target.sendMessageToTarget", {
      sessionId: this.sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return result;
  }

  dispose(): void {
    this.parent.off("Target.receivedMessageFromTarget", this.onMessage);
    for (const waiter of this.pending.values()) waiter.reject(new Error("nested CDP session disposed"));
    this.pending.clear();
  }
}

function profilePdfFixture(targetBytes = 12_583_590): string {
  const build = (paddingBytes: number): Buffer => {
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
    const offsets: number[] = [0];
    let length = chunks[0].length;
    const object = (id: number, body: Buffer | string) => {
      offsets[id] = length;
      const head = Buffer.from(`${id} 0 obj\n`, "ascii");
      const data = typeof body === "string" ? Buffer.from(body, "ascii") : body;
      const tail = Buffer.from("\nendobj\n", "ascii");
      chunks.push(head, data, tail);
      length += head.length + data.length + tail.length;
    };
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
    const content = Buffer.from("BT /F1 24 Tf 72 720 Td (PDF PROFILE FIXTURE) Tj ET", "ascii");
    object(4, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"), content, Buffer.from("\nendstream", "ascii")]));
    object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const padding = Buffer.alloc(Math.max(0, paddingBytes), 0x20);
    object(6, Buffer.concat([Buffer.from(`<< /Length ${padding.length} >>\nstream\n`, "ascii"), padding, Buffer.from("\nendstream", "ascii")]));
    const xref = length;
    const rows = ["xref", "0 7", "0000000000 65535 f ", ...Array.from({ length: 6 }, (_, index) => `${String(offsets[index + 1]).padStart(10, "0")} 00000 n `)];
    chunks.push(Buffer.from(`${rows.join("\n")}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
    return Buffer.concat(chunks);
  };
  const empty = build(0);
  let paddingBytes = Math.max(0, targetBytes - empty.byteLength);
  let pdf = build(paddingBytes);
  for (let attempt = 0; attempt < 4 && pdf.byteLength !== targetBytes; attempt++) {
    paddingBytes += targetBytes - pdf.byteLength;
    pdf = build(paddingBytes);
  }
  if (pdf.byteLength !== targetBytes) throw new Error(`fixture sizing failed (${pdf.byteLength} != ${targetBytes})`);
  return pdf.toString("ascii");
}

async function bootstrapLocal(page: Page): Promise<{ token: string; sessionId: string }> {
  const content = profilePdfFixture();
  return page.evaluate(async ({ fileName: name, content: pdf }) => {
    const email = `pdf-profile-${Date.now()}-${Math.random().toString(36).slice(2)}@test.dev`;
    const authResponse = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    if (!authResponse.ok) throw new Error(`signup failed (${authResponse.status})`);
    const auth = await authResponse.json() as { token: string };
    const headers = { "content-type": "application/json", authorization: `Bearer ${auth.token}` };
    const sessionResponse = await fetch("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "PDF performance profile",
        provider: "mock",
        model: "mock-coder",
        sandboxKind: "local",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      }),
    });
    if (!sessionResponse.ok) throw new Error(`session create failed (${sessionResponse.status})`);
    const created = await sessionResponse.json() as { session: { id: string } };
    const writeResponse = await fetch(`/api/sessions/${created.session.id}/file`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ path: name, content: pdf }),
    });
    if (!writeResponse.ok) throw new Error(`fixture write failed (${writeResponse.status})`);
    localStorage.setItem("agentweb.token", auth.token);
    return { token: auth.token, sessionId: created.session.id };
  }, { fileName, content });
}

async function startTrace(cdp: CDPSession): Promise<{ done: Promise<string> }> {
  let resolveDone!: (value: string) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<string>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  cdp.once("Tracing.tracingComplete", async ({ stream }: { stream: string }) => {
    try {
      const chunks: string[] = [];
      while (true) {
        const part = await cdp.send("IO.read", { handle: stream }) as { data: string; eof?: boolean };
        chunks.push(part.data);
        if (part.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      const output = path.join(outputDir, "cold-load.trace.json");
      fs.writeFileSync(output, chunks.join(""));
      resolveDone(output);
    } catch (error) {
      rejectDone(error);
    }
  });
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordUntilFull",
      includedCategories: [
        "-*", "blink.user_timing", "devtools.timeline", "loading", "renderer.scheduler", "v8",
        "v8.execute", "disabled-by-default-devtools.timeline", "disabled-by-default-v8.cpu_profiler",
        "disabled-by-default-v8.cpu_profiler.hires",
      ],
    },
  });
  return { done };
}

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const state = {
      click: 0,
      pdfMounted: 0,
      canvasFirstReady: 0,
      canvasReady: 0,
      iframeSeen: 0,
      iframeLoaded: 0,
      renderReadyCount: 0,
      longTasks: [],
    };
    window.__pdfProfile = state;
    const seenReadyCanvases = new WeakSet();
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch { /* unsupported */ }
    const scan = () => {
      const preview = document.querySelector('[data-testid="pdf-preview"]');
      if (preview && !state.pdfMounted) state.pdfMounted = performance.now();
      for (const canvas of document.querySelectorAll('[data-testid="pdf-canvas"][data-ready="true"]')) {
        if (seenReadyCanvases.has(canvas)) continue;
        seenReadyCanvases.add(canvas);
        state.renderReadyCount++;
        state.canvasReady = performance.now();
        if (!state.canvasFirstReady) state.canvasFirstReady = state.canvasReady;
      }
      const iframe = document.querySelector('iframe[title$=".pdf"]');
      if (iframe && !state.iframeSeen) {
        state.iframeSeen = performance.now();
        iframe.addEventListener("load", () => { state.iframeLoaded = performance.now(); }, { once: true });
      }
    };
    scan();
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-ready"],
    });
  })()`);
}

function netKind(url: string): NetRow["kind"] | null {
  if (/\/api\/sessions\/[^/]+\/file-preview$/.test(url)) return "mint";
  if (/\/api\/file-preview\//.test(url)) return "range";
  if (/\/api\/sessions\/.*\/file\?/.test(url)) return "legacy-file";
  if (/\/api\/sessions\/.*\/download\?/.test(url)) return "legacy-download";
  if (/\/assets\/PdfPreview-/.test(url)) return "pdf-code";
  if (/\/assets\/pdf\.worker/.test(url)) return "pdf-worker";
  if (/\/pdfjs-assets\//.test(url)) return "pdf-support";
  return null;
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-quic", "--js-flags=--expose-gc"] });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor,
    locale: "en-US",
    serviceWorkers: "block",
  });
  if (token) await context.addInitScript((value) => localStorage.setItem("agentweb.token", value), token);
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (bootstrap) {
    const setup = await bootstrapLocal(page);
    sessionId = setup.sessionId;
  }
  if (resizeStress) {
    await page.evaluate(() => localStorage.setItem("oiia.workspacePaneWidth", "860"));
  }
  await page.goto(`${baseURL}/s/${sessionId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("composer").waitFor({ state: "visible", timeout: 60_000 });
  const fileTreeTab = page.getByRole("button", { name: "File Tree", exact: true });
  if (!(await fileTreeTab.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Toggle details panel/ }).click();
    await fileTreeTab.waitFor({ state: "visible", timeout: 30_000 });
  }
  await fileTreeTab.click();
  await page.getByTestId("file-skeleton").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => undefined);
  const file = page.getByTestId(`file-${path.basename(fileName)}`).first();
  await file.waitFor({ state: "visible", timeout: 60_000 });

  const pageCdp = await context.newCDPSession(page);
  const browserCdp = await browser.newBrowserCDPSession();
  const net = new Map<string, NetRow>();
  await pageCdp.send("Network.enable");
  if (latencyMs > 0 || downloadMbps > 0 || uploadMbps > 0) {
    await pageCdp.send("Network.emulateNetworkConditionsByRule", {
      matchedNetworkConditions: [{
        urlPattern: "",
        latency: latencyMs,
        downloadThroughput: downloadMbps > 0 ? downloadMbps * 125_000 : -1,
        uploadThroughput: uploadMbps > 0 ? uploadMbps * 125_000 : -1,
        connectionType: "wifi",
        offline: false,
      }],
    });
  }
  pageCdp.on("Network.requestWillBeSent", (event: { requestId: string; timestamp: number; request: { url: string; headers: Record<string, string> } }) => {
    const kind = netKind(event.request.url);
    if (!kind) return;
    net.set(event.requestId, {
      id: event.requestId,
      kind,
      url: event.request.url.replace(/\/api\/file-preview\/[a-f0-9]+/, "/api/file-preview/<nonce>"),
      range: event.request.headers.Range ?? event.request.headers.range,
      start: event.timestamp,
    });
  });
  pageCdp.on("Network.responseReceived", (event: { requestId: string; timestamp: number; response: { status: number; headers: Record<string, string> } }) => {
    const row = net.get(event.requestId);
    if (!row) return;
    row.response = event.timestamp;
    row.status = event.response.status;
    row.contentRange = event.response.headers["content-range"] ?? event.response.headers["Content-Range"];
  });
  pageCdp.on("Network.loadingFinished", (event: { requestId: string; timestamp: number; encodedDataLength: number }) => {
    const row = net.get(event.requestId);
    if (!row) return;
    row.finish = event.timestamp;
    row.encodedBytes = event.encodedDataLength;
  });
  pageCdp.on("Network.loadingFailed", (event: { requestId: string; errorText: string }) => {
    const row = net.get(event.requestId);
    if (row) row.failed = event.errorText;
  });

  let pdfWorker: NestedCdpSession | null = null;
  let workerProfiling = false;
  let workerProfileError: string | null = null;
  const nestedSessions: NestedCdpSession[] = [];
  pageCdp.on("Target.attachedToTarget", (event: { sessionId: string; targetInfo: { type: string; url: string } }) => {
    const nested = new NestedCdpSession(pageCdp, event.sessionId);
    nestedSessions.push(nested);
    void (async () => {
      try {
        await nested.send("Network.enable");
        if (latencyMs > 0 || downloadMbps > 0 || uploadMbps > 0) {
          await nested.send("Network.emulateNetworkConditionsByRule", {
            matchedNetworkConditions: [{
              urlPattern: "",
              latency: latencyMs,
              downloadThroughput: downloadMbps > 0 ? downloadMbps * 125_000 : -1,
              uploadThroughput: uploadMbps > 0 ? uploadMbps * 125_000 : -1,
              connectionType: "wifi",
              offline: false,
            }],
          });
        }
        if (event.targetInfo.type === "worker" && /pdf\.worker/.test(event.targetInfo.url)) {
          pdfWorker = nested;
          await nested.send("Profiler.enable");
          await nested.send("Profiler.setSamplingInterval", { interval: 500 });
          await nested.send("Profiler.start");
          workerProfiling = true;
        }
      } catch (error) {
        workerProfileError = error instanceof Error ? error.message : String(error);
      } finally {
        await nested.send("Runtime.runIfWaitingForDebugger").catch(() => {});
      }
    })();
  });
  await pageCdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });

  await installProbe(page);
  await pageCdp.send("Profiler.enable");
  await pageCdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await pageCdp.send("HeapProfiler.enable");
  await pageCdp.send("HeapProfiler.startSampling", { samplingInterval: 16 * 1024 });
  const trace = captureTrace ? await startTrace(browserCdp) : null;
  await pageCdp.send("Profiler.start");

  const clickWall = Date.now();
  await page.evaluate(() => { (window as unknown as { __pdfProfile: { click: number } }).__pdfProfile.click = performance.now(); });
  await file.click();
  const canvas = page.getByTestId("pdf-canvas").first();
  const iframe = page.locator('iframe[title$=".pdf"]');
  const renderer = await Promise.race([
    canvas.waitFor({ state: "visible", timeout: 60_000 }).then(() => "pdfjs" as const),
    iframe.waitFor({ state: "visible", timeout: 60_000 }).then(() => "native" as const),
  ]);
  if (renderer === "pdfjs") await canvas.waitFor({ state: "visible", timeout: 60_000 }).then(() => page.waitForFunction(() => document.querySelector('[data-testid="pdf-canvas"]')?.getAttribute("data-ready") === "true", { timeout: 60_000 }));
  else await page.waitForFunction(() => Boolean((window as unknown as { __pdfProfile: { iframeLoaded: number } }).__pdfProfile.iframeLoaded), { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(750);

  const coldCpu = (await pageCdp.send("Profiler.stop") as { profile: CpuProfile }).profile;
  const coldWorkerCpu = pdfWorker && workerProfiling
    ? ((await pdfWorker.send<{ profile: CpuProfile }>("Profiler.stop")).profile)
    : null;
  workerProfiling = false;
  const heap = (await pageCdp.send("HeapProfiler.stopSampling") as { profile: SamplingHeapProfile }).profile;
  if (captureTrace) await browserCdp.send("Tracing.end");
  const tracePath = trace ? await trace.done : null;
  await pageCdp.send("HeapProfiler.collectGarbage");
  const postGcHeap = await pageCdp.send("Runtime.getHeapUsage") as { usedSize: number; totalSize: number; embedderHeapUsedSize?: number };

  const coldCpuPath = path.join(outputDir, "cold-load.main.cpuprofile");
  const heapPath = path.join(outputDir, "cold-load.main.heapprofile");
  fs.writeFileSync(coldCpuPath, JSON.stringify(coldCpu));
  fs.writeFileSync(heapPath, JSON.stringify(heap));
  writeCpuFlamegraph(coldCpu, path.join(outputDir, "cold-load.main.cpu-flame.svg"), "PDF cold load · browser main thread");
  if (coldWorkerCpu) {
    fs.writeFileSync(path.join(outputDir, "cold-load.worker.cpuprofile"), JSON.stringify(coldWorkerCpu));
    writeCpuFlamegraph(coldWorkerCpu, path.join(outputDir, "cold-load.worker.cpu-flame.svg"), "PDF cold load · PDF.js worker");
  }
  writeHeapSamplingFlamegraph(heap, path.join(outputDir, "cold-load.main.heap-flame.svg"), "PDF cold load · browser allocations");

  await page.screenshot({ path: path.join(outputDir, "reader.png") });

  let warm: null | { elapsedMs: number; cpu: ReturnType<typeof summarizeCpuProfile>; workerCpu: ReturnType<typeof summarizeCpuProfile> | null; rangeRequests: number } = null;
  if (renderer === "pdfjs") {
    const beforeCount = await page.evaluate(() => (window as unknown as { __pdfProfile: { renderReadyCount: number } }).__pdfProfile.renderReadyCount);
    const rangesBefore = [...net.values()].filter((row) => row.kind === "range").length;
    await pageCdp.send("Profiler.start");
    if (pdfWorker) {
      await pdfWorker.send("Profiler.start");
      workerProfiling = true;
    }
    const warmStart = Date.now();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForFunction((count) => (window as unknown as { __pdfProfile: { renderReadyCount: number } }).__pdfProfile.renderReadyCount > count, beforeCount, { timeout: 30_000 });
    const warmReadyMs = Date.now() - warmStart;
    await page.waitForTimeout(250);
    const warmCpu = (await pageCdp.send("Profiler.stop") as { profile: CpuProfile }).profile;
    const warmWorkerCpu = pdfWorker && workerProfiling
      ? ((await pdfWorker.send<{ profile: CpuProfile }>("Profiler.stop")).profile)
      : null;
    workerProfiling = false;
    fs.writeFileSync(path.join(outputDir, "warm-render.main.cpuprofile"), JSON.stringify(warmCpu));
    writeCpuFlamegraph(warmCpu, path.join(outputDir, "warm-render.main.cpu-flame.svg"), "PDF warm zoom · browser main thread");
    if (warmWorkerCpu) {
      fs.writeFileSync(path.join(outputDir, "warm-render.worker.cpuprofile"), JSON.stringify(warmWorkerCpu));
      writeCpuFlamegraph(warmWorkerCpu, path.join(outputDir, "warm-render.worker.cpu-flame.svg"), "PDF warm zoom · PDF.js worker");
    }
    warm = {
      elapsedMs: warmReadyMs,
      cpu: summarizeCpuProfile(warmCpu),
      workerCpu: warmWorkerCpu ? summarizeCpuProfile(warmWorkerCpu) : null,
      rangeRequests: [...net.values()].filter((row) => row.kind === "range").length - rangesBefore,
    };
  }

  let stress: null | {
    elapsedMs: number;
    cpu: ReturnType<typeof summarizeCpuProfile>;
    workerCpu: ReturnType<typeof summarizeCpuProfile> | null;
    zoom: string;
    alerts: number;
    usableCanvases: number;
    detailCanvases: number;
    maxCanvasArea: number;
    totalCanvasArea: number;
    longTasks: { start: number; duration: number }[];
  } = null;
  if (renderer === "pdfjs" && resizeStress) {
    const stage = page.getByTestId("pdf-stage");
    const longTaskStart = await page.evaluate(() => {
      const profile = (window as unknown as { __pdfProfile: { longTasks: unknown[] } }).__pdfProfile;
      return profile.longTasks.length;
    });
    await pageCdp.send("Profiler.start");
    if (pdfWorker) {
      await pdfWorker.send("Profiler.start");
      workerProfiling = true;
    }
    const stressStart = Date.now();
    await stage.evaluate(async (node) => {
      const rect = node.getBoundingClientRect();
      for (let index = 0; index < 40; index++) {
        node.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaX: 0,
          deltaY: -4,
          deltaZ: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.getByTestId("pdf-zoom").waitFor({ state: "visible" });
    for (const viewport of [
      { width: 1180, height: 820 },
      { width: 1700, height: 960 },
      { width: 1260, height: 860 },
      { width: 1600, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(35);
    }
    const separator = page.getByRole("separator", { name: "Resize panel" });
    for (const delta of [-220, 180, -160, 120]) {
      const box = await separator.boundingBox();
      if (!box) break;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + delta, y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(650);
    const snapshot = await page.evaluate((from) => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[data-testid="pdf-stage"] canvas')];
      const profile = (window as unknown as {
        __pdfProfile: { longTasks: { start: number; duration: number }[] };
      }).__pdfProfile;
      return {
        zoom: document.querySelector('[data-testid="pdf-zoom"]')?.textContent?.trim() ?? "",
        alerts: document.querySelectorAll('[role="alert"]').length,
        usableCanvases: canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
        detailCanvases: canvases.filter((canvas) => canvas.getAttribute("aria-hidden") === "true").length,
        maxCanvasArea: Math.max(0, ...canvases.map((canvas) => canvas.width * canvas.height)),
        totalCanvasArea: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        longTasks: profile.longTasks.slice(from),
      };
    }, longTaskStart);
    const stressCpu = (await pageCdp.send("Profiler.stop") as { profile: CpuProfile }).profile;
    const stressWorkerCpu = pdfWorker && workerProfiling
      ? ((await pdfWorker.send<{ profile: CpuProfile }>("Profiler.stop")).profile)
      : null;
    workerProfiling = false;
    fs.writeFileSync(path.join(outputDir, "resize-stress.main.cpuprofile"), JSON.stringify(stressCpu));
    writeCpuFlamegraph(stressCpu, path.join(outputDir, "resize-stress.main.cpu-flame.svg"), "PDF pinch + resize stress · browser main thread");
    if (stressWorkerCpu) {
      fs.writeFileSync(path.join(outputDir, "resize-stress.worker.cpuprofile"), JSON.stringify(stressWorkerCpu));
      writeCpuFlamegraph(stressWorkerCpu, path.join(outputDir, "resize-stress.worker.cpu-flame.svg"), "PDF pinch + resize stress · PDF.js worker");
    }
    stress = {
      elapsedMs: Date.now() - stressStart,
      cpu: summarizeCpuProfile(stressCpu),
      workerCpu: stressWorkerCpu ? summarizeCpuProfile(stressWorkerCpu) : null,
      ...snapshot,
    };
    await stage.evaluate((node) => node.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputDir, "resize-stress.png") });
  }

  const probe = await page.evaluate(() => (window as unknown as { __pdfProfile: {
    click: number;
    pdfMounted: number;
    canvasFirstReady: number;
    canvasReady: number;
    iframeSeen: number;
    iframeLoaded: number;
    renderReadyCount: number;
    longTasks: { start: number; duration: number }[];
  } }).__pdfProfile);
  const rows = [...net.values()].map((row) => ({
    ...row,
    ttfbMs: row.response == null ? null : (row.response - row.start) * 1_000,
    totalMs: row.finish == null ? null : (row.finish - row.start) * 1_000,
  }));
  const ranges = rows.filter((row) => row.kind === "range");
  const result = {
    target: {
      baseURL,
      sessionId,
      fileName,
      networkProfile: { latencyMs, downloadMbps, uploadMbps },
      deviceScaleFactor,
    },
    renderer,
    elapsedWallMs: Date.now() - clickWall,
    coldTtfpMs: renderer === "pdfjs"
      ? probe.canvasFirstReady - probe.click
      : probe.iframeLoaded > 0 ? probe.iframeLoaded - probe.click : null,
    probe,
    network: {
      rows,
      rangeRequests: ranges.length,
      nonRangePreviewRequests: ranges.filter((row) => !row.range).length,
      encodedRangeBytes: ranges.reduce((sum, row) => sum + (row.encodedBytes ?? 0), 0),
    },
    cold: {
      cpu: summarizeCpuProfile(coldCpu),
      workerCpu: coldWorkerCpu ? summarizeCpuProfile(coldWorkerCpu) : null,
      workerProfileError,
      heap: summarizeHeapSamplingProfile(heap),
      postGcHeap,
    },
    warm,
    stress,
    artifacts: { tracePath, coldCpuPath, heapPath },
  };
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await pageCdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }).catch(() => {});
  for (const nested of nestedSessions) nested.dispose();
  await context.close();
} finally {
  await browser.close();
}
process.exit(0);
