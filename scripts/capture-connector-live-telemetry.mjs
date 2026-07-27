import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4328";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/connector-live-telemetry");
fs.mkdirSync(OUT_DIR, { recursive: true });

const scenarios = [
  { label: "desktop", viewport: { width: 1_440, height: 900 }, colorScheme: "light" },
  { label: "mobile", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { label: "dark", viewport: { width: 1_440, height: 900 }, colorScheme: "dark" },
];
const cpuSeries = [17.2, 24.8, 38.1, 31.6, 46.4, 42.9, 55.2, 49.7, 35.4, 40.8];
const memSeries = [42.1, 42.8, 43.5, 44.1, 44.6, 45.3, 45.8, 46.2, 46.8, 47.1];
const browser = await chromium.launch();
const output = { variant: VARIANT, scenarios: {} };

for (const scenario of scenarios) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    colorScheme: scenario.colorScheme,
    reducedMotion: "reduce",
    locale: "en-US",
  });
  const page = await context.newPage();
  const errors = [];
  let telemetryCalls = 0;
  let hiddenNetworkCalls = null;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler, delay, ...args) => nativeTimeout(handler, delay === 3_000 ? 120 : delay, ...args));
  });
  const now = Date.now();
  await page.route("**/api/connectors/studio-node/telemetry", async (route) => {
    const index = Math.min(telemetryCalls, cpuSeries.length - 1);
    telemetryCalls += 1;
    const memTotal = 16 * 1024 ** 3;
    await route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        telemetry: {
          sampledAt: now + telemetryCalls * 3_000,
          cpuPct: cpuSeries[index],
          memUsed: memTotal * memSeries[index] / 100,
          memTotal,
          cpuCores: 12,
          loadAvg: [2.18, 1.94, 1.71],
          processCount: 146,
          cpuKind: "interval",
          processSource: "native",
          processes: [
            { pid: 4102, ppid: 1, name: "node", state: "R+", cpuPct: 24.6, memPct: 3.2, rssBytes: 534_773_760, elapsed: "12:48" },
            { pid: 982, ppid: 1, name: "WindowServer", state: "Ss", cpuPct: 8.1, memPct: 1.5, rssBytes: 251_658_240, elapsed: "04:21:09" },
            { pid: 731, ppid: 1, name: "Code Helper", state: "S", cpuPct: 5.7, memPct: 2.1, rssBytes: 346_030_080, elapsed: "01:14:32" },
            { pid: 5088, ppid: 4102, name: "typescript-language-server", state: "S", cpuPct: 3.4, memPct: 1.2, rssBytes: 198_180_864, elapsed: "08:16" },
            { pid: 221, ppid: 1, name: "coreaudiod", state: "Ss", cpuPct: 1.8, memPct: 0.2, rssBytes: 33_554_432, elapsed: "04:20:57" },
          ],
        },
      },
    });
  });
  await page.route("**/api/connectors", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        connectors: [{
          id: "studio-node",
          name: "Studio Mac",
          workspaceRoot: "~/work/studio",
          capabilities: ["exec", "files", "pty", "metrics"],
          online: true,
          lastSeenAt: now,
          createdAt: now,
          unconfined: false,
          daemonUnconfined: true,
        }],
      },
    });
  });

  await page.goto(BASE_URL);
  const token = await page.evaluate(async (email) => {
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ email, password: "password123" });
    let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!response.ok) throw new Error(`auth failed: ${response.status}`);
    return (await response.json()).token;
  }, `connector-telemetry-${VARIANT}-${scenario.label}@example.invalid`);
  await page.evaluate((value) => {
    localStorage.setItem("agentweb.token", value);
    localStorage.setItem("oiia.locale", "en");
  }, token);
  await page.goto(`${BASE_URL}/plugins`);
  if (scenario.label === "mobile") await page.getByTestId("connector-row-studio-node").click();
  await page.getByRole("heading", { name: "Studio Mac" }).waitFor();
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}",
  });
  if (VARIANT === "after") {
    await page.waitForFunction(() => document.querySelectorAll(".recharts-area-curve").length === 2);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="connector-process-row"]').length >= 5);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const beforeHidden = telemetryCalls;
    await page.waitForTimeout(500);
    hiddenNetworkCalls = telemetryCalls - beforeHidden;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    while (telemetryCalls < cpuSeries.length) await page.waitForTimeout(25);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const view = page.getByTestId("plugins-view");
  const box = await view.boundingBox();
  if (!box) throw new Error(`${scenario.label}: Connector view geometry missing`);
  const metrics = await page.evaluate(() => ({
    telemetry: document.querySelector('[data-testid^="connector-telemetry-"]')?.getBoundingClientRect().toJSON() ?? null,
    chartCurves: document.querySelectorAll(".recharts-area-curve").length,
    processRows: document.querySelectorAll('[data-testid="connector-process-row"]').length,
    lazyResources: performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("ConnectorTelemetry"))
      .map((entry) => ({
        name: entry.name.split("/").pop(),
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      })),
  }));
  await page.screenshot({
    path: path.join(OUT_DIR, `${VARIANT}-${scenario.label}.png`),
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(scenario.viewport.width - box.x, box.width),
      height: Math.min(scenario.viewport.height - box.y, box.height),
    },
  });
  output.scenarios[scenario.label] = { box, telemetryCalls, hiddenNetworkCalls, errors, ...metrics };
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT_DIR, `${VARIANT}-metrics.json`), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output));
