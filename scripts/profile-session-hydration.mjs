#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseURL = process.env.AGENT_WEB_PROFILE_URL ?? "http://127.0.0.1:4319";
const variant = process.argv[2] ?? "profile";
const outputDir = path.resolve(process.argv[3] ?? "docs/pr/session-hydration-stability");
const sessionDelayMs = Number(process.env.AGENT_WEB_PROFILE_SESSION_DELAY_MS ?? 1_800);
const modelDelayMs = Number(process.env.AGENT_WEB_PROFILE_MODEL_DELAY_MS ?? 250);
const cpuSlowdown = Number(process.env.AGENT_WEB_PROFILE_CPU_SLOWDOWN ?? 4);
const networkLatencyMs = Number(process.env.AGENT_WEB_PROFILE_NETWORK_LATENCY_MS ?? 350);
const downloadKbps = Number(process.env.AGENT_WEB_PROFILE_DOWNLOAD_KBPS ?? 750);
const uploadKbps = Number(process.env.AGENT_WEB_PROFILE_UPLOAD_KBPS ?? 250);
const captureTrace = process.env.AGENT_WEB_PROFILE_TRACE === "1";
const roundMs = (value) => Math.round(value * 10) / 10;
const profileHost = new URL(baseURL).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(profileHost)) {
  throw new Error(`session hydration profiling requires a loopback URL, received ${profileHost}`);
}

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const tracePath = path.resolve(process.env.AGENT_WEB_PROFILE_TRACE_PATH ?? path.join(os.tmpdir(), `oiia-session-hydration-${variant}-trace.zip`));
const requestEvents = [];
const pageErrors = [];
let fixture = null;

try {
  if (captureTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  fixture = await page.evaluate(async () => {
    const email = "session-hydration@example.invalid";
    const password = "profile-password";
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ email, password });
    let auth = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!auth.ok) auth = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!auth.ok) throw new Error(`profile auth failed: ${auth.status}`);
    const { token } = await auth.json();
    localStorage.setItem("agentweb.token", token);
    const authorizedHeaders = { ...headers, authorization: `Bearer ${token}` };
    const connectorResponse = await fetch("/api/connectors", {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({ name: "Example workstation", workspaceRoot: "./workspaces/example" }),
    });
    if (!connectorResponse.ok) throw new Error(`profile connector failed: ${connectorResponse.status}`);
    const { connector } = await connectorResponse.json();
    const sessionResponse = await fetch("/api/sessions", {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({
        title: "Connector session",
        provider: "mock",
        model: "mock-coder",
        sandboxMode: "workspace-write",
        sandboxKind: "connector",
        sandboxTargetId: connector.id,
        mode: "coding",
        approvalPolicy: "never",
      }),
    });
    if (!sessionResponse.ok) {
      await fetch(`/api/connectors/${connector.id}`, { method: "DELETE", headers: authorizedHeaders }).catch(() => {});
      throw new Error(`profile session failed: ${sessionResponse.status}`);
    }
    return { sessionId: (await sessionResponse.json()).session.id, connectorId: connector.id };
  });

  await page.goto(`${baseURL}/s/${fixture.sessionId}`);
  await page.getByTestId("composer").waitFor();

  await page.addInitScript(() => {
    window.__sessionHydrationProbe = { events: [], last: null, layoutShiftScore: 0, longTasks: [] };
    const start = () => {
      const record = () => {
        const state = document.querySelector('[data-testid="executor-empty-state"]')
          ? "executor-empty"
          : document.querySelector('[data-testid="session-hydration-state"]')
            ? "hydrating"
            : document.querySelector('[data-testid="composer"]')
              ? "composer"
              : "shell";
        const probe = window.__sessionHydrationProbe;
        if (probe.last === state) return;
        probe.last = state;
        probe.events.push({ state, atMs: performance.now() });
      };
      new MutationObserver(record).observe(document.documentElement, { childList: true, subtree: true });
      record();
    };
    if (document.documentElement) start();
    else window.addEventListener("DOMContentLoaded", start, { once: true });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__sessionHydrationProbe.layoutShiftScore += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {  }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__sessionHydrationProbe.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {  }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: networkLatencyMs,
    downloadThroughput: (downloadKbps * 1024) / 8,
    uploadThroughput: (uploadKbps * 1024) / 8,
    connectionType: "cellular3g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const requestStart = new Map();
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname !== "/api/models" && pathname !== "/api/sessions") return;
    requestStart.set(request, performance.now());
    requestEvents.push({ path: pathname, phase: "start", atMs: performance.now() });
  });
  page.on("response", (response) => {
    const request = response.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname !== "/api/models" && pathname !== "/api/sessions") return;
    const startedAt = requestStart.get(request);
    requestEvents.push({
      path: pathname,
      phase: "response",
      atMs: performance.now(),
      durationMs: startedAt === undefined ? null : performance.now() - startedAt,
      status: response.status(),
    });
  });

  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.json();
    await new Promise((resolve) => setTimeout(resolve, modelDelayMs));
    await route.fulfill({
      response: upstream,
      json: {
        ...body,
        e2b: false,
        executors: {
          local: { available: false, reason: "policy_disabled" },
          e2b: { available: false, reason: "capacity_unavailable" },
        },
      },
    });
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
    await route.continue();
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  const transient = page.getByTestId("executor-empty-state");
  const hydration = page.getByTestId("session-hydration-state");
  const firstState = await Promise.race([
    transient.waitFor({ state: "visible", timeout: 8_000 }).then(() => "executor-empty"),
    hydration.waitFor({ state: "visible", timeout: 8_000 }).then(() => "hydrating"),
  ]).catch(() => "neither");
  if (firstState === "hydrating") {
    await page.waitForFunction(() => document.querySelector('[data-testid="session-hydration-state"]')?.getAttribute("data-visible") === "true");
    await page.waitForTimeout(220);
  }
  await page.screenshot({ path: path.join(outputDir, `${variant}-throttled.png`) });
  await page.getByTestId("composer").waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: path.join(outputDir, `${variant}-settled.png`) });

  const browserProbe = await page.evaluate(() => window.__sessionHydrationProbe);
  const resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/api/models") || entry.name.includes("/api/sessions"))
    .map((entry) => ({
      path: new URL(entry.name).pathname,
      startTime: entry.startTime,
      responseStart: entry.responseStart,
      duration: entry.duration,
      transferSize: entry.transferSize,
    })));
  const falseGuidanceSeen = browserProbe.events.some((event) => event.state === "executor-empty");
  const normalizedBrowserEvents = browserProbe.events.map((event) => ({ ...event, atMs: roundMs(event.atMs) }));
  const requestOrigin = requestEvents[0]?.atMs ?? 0;
  const normalizedRequestEvents = requestEvents.map((event) => ({
    ...event,
    atMs: roundMs(event.atMs - requestOrigin),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs === null ? null : roundMs(event.durationMs) }),
  }));
  const normalizedResources = resources.map((entry) => ({
    ...entry,
    startTime: roundMs(entry.startTime),
    responseStart: roundMs(entry.responseStart),
    duration: roundMs(entry.duration),
  }));
  const incorrect = normalizedBrowserEvents.find((event) => event.state === "executor-empty");
  const hydrating = normalizedBrowserEvents.find((event) => event.state === "hydrating");
  const settled = normalizedBrowserEvents.find((event) => event.state === "composer");
  const profile = {
    variant,
    throttle: {
      latencyMs: networkLatencyMs,
      downloadKbps,
      uploadKbps,
      cpuSlowdown,
      sessionDelayMs,
      modelDelayMs,
    },
    firstState,
    falseGuidanceSeen,
    misleadingStateDurationMs: incorrect && settled ? roundMs(settled.atMs - incorrect.atMs) : 0,
    hydrationStateDurationMs: hydrating && settled ? roundMs(settled.atMs - hydrating.atMs) : 0,
    layoutShiftScore: Math.round(browserProbe.layoutShiftScore * 10_000) / 10_000,
    longTasks: browserProbe.longTasks.map((entry) => ({ startTime: roundMs(entry.startTime), duration: roundMs(entry.duration) })),
    pageErrors,
    browserEvents: normalizedBrowserEvents,
    requestEvents: normalizedRequestEvents,
    resources: normalizedResources,
  };
  await fs.writeFile(path.join(outputDir, `${variant}-profile.json`), JSON.stringify(profile, null, 2) + "\n");
  process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
} finally {
  if (captureTrace) await context.tracing.stop({ path: tracePath }).catch(() => {});
  if (fixture) {
    await page.evaluate(async ({ sessionId, connectorId }) => {
      const token = localStorage.getItem("agentweb.token");
      if (!token) return;
      const headers = { authorization: `Bearer ${token}` };
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE", headers }).catch(() => {});
      await fetch(`/api/connectors/${connectorId}`, { method: "DELETE", headers }).catch(() => {});
    }, fixture).catch(() => {});
  }
  await context.close();
  await browser.close();
}
