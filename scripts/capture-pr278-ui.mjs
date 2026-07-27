import { chromium } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const CAPTURE_DB = process.env.CAPTURE_DB;
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };
const LONG_COMMAND = `for meta in "script-src-elem 'unsafe-inline'" "script-src 'unsafe-inline'"; do echo "== $meta =="; printf 'ok\\n'; done`;

if (!CAPTURE_DB) throw new Error("CAPTURE_DB is required");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const desktop = await browser.newContext({
  viewport: DESKTOP,
  locale: "zh-CN",
  reducedMotion: "reduce",
  colorScheme: "light",
});

const email = () => `pr278-${VARIANT}@test.dev`;

async function settle(page) {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}`,
  }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
}

async function shot(page, stem) {
  await settle(page);
  const target = path.join(OUT_DIR, `${stem}-${VARIANT}.png`);
  await page.screenshot({ path: target });
  console.log(`shot ${path.basename(target)}`);
}

async function signup(page) {
  await page.goto(BASE_URL);
  const result = await page.evaluate(async (address) => {
    const body = JSON.stringify({ email: address, password: "password123" });
    const headers = { "content-type": "application/json" };
    let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!response.ok) throw new Error(`auth failed: ${response.status}`);
    return response.json();
  }, email());
  await page.evaluate((token) => {
    localStorage.setItem("agentweb.token", token);
    localStorage.setItem("oiia.locale", "zh");
  }, result.token);
  return result.token;
}

async function api(page, token, method, route, body) {
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

async function createSession(page, token, title, approvalPolicy = "never", provider = "mock", model = "mock-coder") {
  const result = await api(page, token, "POST", "/sessions", {
    title,
    provider,
    model,
    sandboxMode: "workspace-write",
    approvalPolicy,
  });
  return result.session;
}

async function openSession(page, sessionId) {
  await page.goto(`${BASE_URL}/s/${sessionId}`);
  await page.getByTestId("composer").waitFor();
  await settle(page);
}

async function send(page, text) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send").click();
}

async function waitForTurnEnd(page) {
  await page.getByTestId("msg-assistant").last().waitFor();
  await page.getByTestId("send").waitFor({ state: "visible" });
}

function seedCacheTimeline(sessionId) {
  const db = new DatabaseSync(CAPTURE_DB);
  const ts = Date.now();
  const rows = [
    { kind: "user", id: "u-cache-1", seq: 1, text: "Review the release plan", ts: ts - 3000 },
    {
      kind: "assistant", id: "a-cache-1", seq: 2, ts: ts - 2000,
      blocks: [{ type: "text", text: "I reviewed the release plan and kept the stable context." }],
      usage: { input: 1200, output: 180, total: 8380, costUsd: 0, cacheRead: 7000, cacheWrite: 0 },
    },
    { kind: "user", id: "u-cache-2", seq: 3, text: "Now check the final diff", ts: ts - 1000 },
    {
      kind: "assistant", id: "a-cache-2", seq: 4, ts,
      blocks: [{ type: "text", text: "The final diff is consistent with the cached project context." }],
      usage: { input: 1600, output: 160, total: 8160, costUsd: 0, cacheRead: 6400, cacheWrite: 0 },
    },
  ];
  const insert = db.prepare("INSERT OR REPLACE INTO timeline (session_id, seq, item_json, msg_cut) VALUES (?, ?, ?, NULL)");
  for (const row of rows) insert.run(sessionId, row.seq, JSON.stringify(row));
  db.close();
}

const page = await desktop.newPage();
const token = await signup(page);

await api(page, token, "PUT", "/providers/anthropic/key", { key: ["sk", "ant", "api03", "pr278-capture-only"].join("-") });
const modelList = await api(page, token, "GET", "/models");
const realModel = modelList.models.find((model) => model.provider === "anthropic" && model.reasoning)
  ?? modelList.models.find((model) => !model.mock);
if (!realModel) throw new Error("no real model exposed for composer capture");
const controlsSession = await createSession(page, token, "Composer controls", "on-request", realModel.provider, realModel.id);
await openSession(page, controlsSession.id);

await page.getByTestId("model-switcher").click();
await page.locator('[role="menu"]').waitFor();
await shot(page, "09-model-switcher");
await page.keyboard.press("Escape");

await page.getByTestId("thinking-switch").hover();
await page.getByTestId("thinking-menu").waitFor();
await shot(page, "10-thinking-level");
await page.keyboard.press("Escape");

await page.getByTestId("approval-switch").hover();
await page.getByTestId("approval-menu").waitFor();
await shot(page, "11-approval-policy");
await page.keyboard.press("Escape");

const cacheSession = await createSession(page, token, "Cache evidence");
seedCacheTimeline(cacheSession.id);
await openSession(page, cacheSession.id);
await page.getByTestId("cache-rate").click();
await page.getByTestId("cache-breakdown").waitFor();
await shot(page, "12-cache-rate");

const contextSession = await createSession(page, token, "Context evidence");
await openSession(page, contextSession.id);
await send(page, "hello");
await waitForTurnEnd(page);
await page.getByTestId("context-ring").click();
await page.getByTestId("context-breakdown").waitFor();
await shot(page, "03-context-ring");

const historySession = await createSession(page, token, "Shell history evidence");
await openSession(page, historySession.id);
await send(page, `/bash ${LONG_COMMAND}`);
await waitForTurnEnd(page);
await page.getByTestId("open-terminal").click();
await page.getByTestId("shell-history").waitFor();
await shot(page, "13-shell-history");

const toolSession = await createSession(page, token, "Tool inspector evidence", "on-request");
await openSession(page, toolSession.id);
await send(page, `/bash ${LONG_COMMAND}`);
await page.getByTestId("permission").waitFor();
await shot(page, "04-shell-approval");
await page.getByTestId("tool-bash").getByTestId("tool-open").click();
await page.getByTestId("tool-detail").waitFor();
await shot(page, "14-tool-waiting");
await page.getByTestId("perm-approve").click();
await waitForTurnEnd(page);
await shot(page, "15-tool-result");
await shot(page, "05-shell-result");

const canvasSession = await createSession(page, token, "Canvas evidence");
await openSession(page, canvasSession.id);
await send(page, "/canvas");
await waitForTurnEnd(page);
await page.waitForTimeout(250);
await shot(page, "06-canvas");

const actionsSession = await createSession(page, token, "Composer actions");
await openSession(page, actionsSession.id);
await send(page, "/bash sleep 30");
await page.getByTestId("interrupt").waitFor();
await page.getByTestId("composer").fill("先检查测试，再继续修改");
await page.getByTestId("queue").waitFor();
await shot(page, "18-composer-actions");
await page.getByTestId("interrupt").click();

const mobileSession = await createSession(page, token, "Mobile controls");
const mobile = await browser.newContext({
  viewport: MOBILE,
  locale: "zh-CN",
  reducedMotion: "reduce",
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
});
await mobile.addInitScript(({ token }) => {
  localStorage.setItem("agentweb.token", token);
  localStorage.setItem("oiia.locale", "zh");
}, { token });
const mobilePage = await mobile.newPage();
await openSession(mobilePage, mobileSession.id);
await send(mobilePage, "hello");
await waitForTurnEnd(mobilePage);
await mobilePage.getByTestId("composer-overflow").tap();
await mobilePage.waitForTimeout(180);
if (!(await mobilePage.getByTestId("composer-overflow-menu").isVisible().catch(() => false))) {
  await mobilePage.getByTestId("composer-overflow").tap();
}
await mobilePage.getByTestId("composer-overflow-menu").waitFor();
await shot(mobilePage, "07-mobile-overflow");

await mobile.close();
await desktop.close();
await browser.close();
