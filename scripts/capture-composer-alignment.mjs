import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4323";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: "zh-CN",
  reducedMotion: "reduce",
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
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
}, `composer-alignment-${VARIANT}@test.dev`);

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

await api("PUT", "/providers/anthropic/key", { key: ["sk", "ant", "api03", "composer-alignment-only"].join("-") });
const models = (await api("GET", "/models")).models;
const model = models.find((candidate) => candidate.provider === "anthropic" && candidate.reasoning)
  ?? models.find((candidate) => !candidate.mock);
if (!model) throw new Error("no real model exposed for alignment capture");

const session = (await api("POST", "/sessions", {
  title: "Composer 对齐",
  provider: model.provider,
  model: model.id,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
})).session;

await page.goto(`${BASE_URL}/s/${session.id}`);
await page.getByTestId("composer").waitFor();
await page.getByTestId("context-ring").first().waitFor({ state: "attached" });
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}[data-testid=sandbox-load]{visibility:hidden!important}",
});
await page.evaluate(() => document.fonts.ready);
await page.getByTestId("composer-overflow").tap();
const menu = page.getByTestId("composer-overflow-menu");
await menu.waitFor();
await page.waitForTimeout(100);

const selector = VARIANT === "after"
  ? "[data-composer-overflow-row]"
  : ':scope [data-testid="model-switcher"], :scope [data-testid="thinking-switch"], :scope [data-testid="approval-switch"], :scope [data-testid="context-ring"], :scope [data-testid="cache-rate"]';
const geometry = await menu.locator(selector).evaluateAll((nodeList) => nodeList.map((node) => {
  const rect = node.getBoundingClientRect();
  const button = node.matches("button") ? node : node.querySelector("button");
  const measure = (element) => {
    const box = element?.getBoundingClientRect();
    return box ? { x: box.x, width: box.width, right: box.right } : null;
  };
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    icon: measure(button?.querySelector(":scope > svg")),
    category: measure(button?.querySelector("[data-composer-control-category]")),
    value: measure(button?.querySelector("[data-composer-control-value]")),
  };
}));
console.log(JSON.stringify({ variant: VARIANT, geometry }));

const target = path.join(OUT_DIR, `21-composer-overflow-${VARIANT}.png`);
await page.screenshot({ path: target });
console.log(target);
await browser.close();
