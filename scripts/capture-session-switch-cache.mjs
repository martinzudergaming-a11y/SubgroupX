import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4326";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  reducedMotion: "reduce",
  colorScheme: "light",
});

await context.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  class DelayedReplayWebSocket extends NativeWebSocket {
    redispatching = false;
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        if (this.redispatching || !window.__oiiaDelayTimelineReplay) return;
        if (typeof event.data !== "string" || !event.data.includes('"type":"timeline_replay"')) return;
        event.stopImmediatePropagation();
        window.__oiiaDelayTimelineReplay = false;
        window.setTimeout(() => {
          this.redispatching = true;
          this.dispatchEvent(new MessageEvent("message", { data: event.data, origin: event.origin }));
          this.redispatching = false;
        }, 1_200);
      }, { capture: true });
    }
  }
  window.WebSocket = DelayedReplayWebSocket;
});

const page = await context.newPage();
await page.goto(BASE_URL);
const token = await page.evaluate(async (email) => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email, password: "password123" });
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
}, `session-cache-${VARIANT}-${Date.now()}@gmail.com`);

await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "zh");
}, token);

async function api(method, route, body) {
  return page.evaluate(async ({ token, method, route, body }) => {
    const response = await fetch(`/api${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }, { token, method, route, body });
}

const createSession = async (title) => (await api("POST", "/sessions", {
  title,
  provider: "mock",
  model: "mock-coder",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
})).session;

const titleA = "性能会话 A";
const titleB = "性能会话 B";
const marker = "切回 A 时，这段历史应立即保留。";
const sessionA = await createSession(titleA);
await createSession(titleB);

await page.goto(`${BASE_URL}/s/${sessionA.id}`);
await page.getByTestId("composer").waitFor();
await page.getByTestId("composer").fill(marker);
await page.getByTestId("send").click();
await page.getByTestId("msg-assistant").last().waitFor();
await page.waitForTimeout(100);

await page.locator("[data-session-item]").filter({ hasText: titleB }).click();
await page.waitForFunction((title) => document.body.textContent?.includes(title), titleB);
await page.waitForTimeout(100);

await page.addStyleTag({
  content: "*,*::before,*::after{transition-duration:0s!important;scroll-behavior:auto!important}[data-testid=sandbox-load]{visibility:hidden!important}",
});
await page.evaluate(() => { window.__oiiaDelayTimelineReplay = true; });

const start = performance.now();
const markerVisible = page.getByTestId("msg-user").filter({ hasText: marker }).waitFor();
await page.locator("[data-session-item]").filter({ hasText: titleA }).click();
await page.waitForTimeout(350);

const stateAtCapture = await page.evaluate((expected) => ({
  cacheHit: document.querySelector('[data-testid="main-content"]')?.getAttribute("data-session-cache-hit") ?? "unsupported",
  markerVisible: [...document.querySelectorAll('[data-testid="msg-user"]')].some((node) => node.textContent?.includes(expected)),
  loaderVisible: Boolean(document.querySelector(".oiia-overlay")),
}), marker);

const target = path.join(OUT_DIR, `23-session-switch-cache-${VARIANT}.png`);
await page.screenshot({ path: target });
await markerVisible;
const contentReadyMs = performance.now() - start;
console.log(JSON.stringify({ variant: VARIANT, contentReadyMs: Math.round(contentReadyMs), stateAtCapture }));
console.log(target);
await browser.close();
