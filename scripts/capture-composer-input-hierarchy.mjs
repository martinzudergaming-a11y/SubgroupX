import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4327";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/composer-input-hierarchy");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1_600, height: 900 },
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: "light",
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
}, `composer-hierarchy-${VARIANT}@test.dev`);

await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "en");
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

const session = (await api("POST", "/sessions", {
  title: "Composer input hierarchy",
  provider: "mock",
  model: "mock-coder",
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "never",
})).session;

await page.goto(`${BASE_URL}/s/${session.id}`);
const composer = page.getByTestId("composer");
await composer.waitFor();
await page.addStyleTag({
  content: [
    "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}",
    "[data-testid=composer]{caret-color:transparent!important}",
    "[data-testid=sandbox-load]{visibility:hidden!important}",
  ].join(""),
});

await composer.fill("Explain the safest execution plan in three concise steps.");
await page.getByTestId("send").click();
await page.getByTestId("msg-assistant").last().waitFor();
await page.getByTestId("session-status").getByText("idle", { exact: true }).waitFor();

await composer.fill("/bash sleep 60");
await page.getByTestId("send").click();
await page.getByTestId("tool-bash").getByTestId("tool-status").getByText("running", { exact: true }).waitFor();
await composer.fill("Review the output, then continue with the safer path.");
await page.getByTestId("queue").waitFor();
await page.getByTestId("steer").waitFor();
await composer.focus();
await page.evaluate(() => document.fonts.ready);

function rounded(rect) {
  if (!rect) return null;
  return Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}

async function capture(label, viewport) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await composer.focus();
  const metrics = await page.evaluate(() => {
    const read = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      main: read('[data-testid="main-content"]'),
      shell: read('[data-testid="composer-shell"]'),
      row: read('[data-testid="composer-row"]'),
      input: read('[data-testid="composer"]'),
      attach: read('[data-testid="attach"]'),
      queue: read('[data-testid="queue"]'),
      steer: read('[data-testid="steer"]'),
      stop: read('[data-testid="interrupt"]'),
    };
  });
  const main = metrics.main;
  if (!main) throw new Error("main content geometry missing");
  const cropHeight = label === "wide" ? 310 : 360;
  const clip = {
    x: main.x,
    y: Math.max(main.y, main.bottom - cropHeight),
    width: main.width,
    height: Math.min(cropHeight, main.height),
  };
  await page.screenshot({
    path: path.join(OUT_DIR, `${VARIANT}-${label}.png`),
    clip,
  });
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, rounded(value)]));
}

async function captureOverflowShape(label, viewport) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const trigger = page.getByTestId("composer-overflow");
  await trigger.click();
  await page.getByTestId("composer-overflow-menu").waitFor();

  const clip = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="main-content"]')?.getBoundingClientRect();
    const button = document.querySelector('[data-testid="composer-overflow"]')?.getBoundingClientRect();
    if (!main || !button) throw new Error("overflow shape geometry missing");
    const roomy = window.innerWidth >= 1_024;
    const x = roomy ? Math.max(main.x, button.x - 260) : main.x;
    const right = roomy ? Math.min(main.right, button.right + 8) : main.right;
    const y = Math.max(main.y, button.y - 6);
    return {
      x,
      y,
      width: right - x,
      height: Math.min(44, main.bottom - y),
    };
  });

  const oldRadius = await page.addStyleTag({
    content: '[data-testid="composer-overflow"]{border-radius:.5rem!important}',
  });
  await page.screenshot({ path: path.join(OUT_DIR, `before-overflow-${label}.png`), clip });
  await oldRadius.evaluate((node) => node.remove());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await page.screenshot({ path: path.join(OUT_DIR, `after-overflow-${label}.png`), clip });

  const shape = await trigger.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const rawRadius = Number.parseFloat(getComputedStyle(node).borderTopLeftRadius);
    return {
      width: box.width,
      height: box.height,
      effectiveRadius: Math.min(rawRadius, box.width / 2, box.height / 2),
    };
  });
  await trigger.click();
  return rounded(shape);
}

const wide = await capture("wide", { width: 1_600, height: 900 });
const mobile = await capture("mobile", { width: 390, height: 844 });
const overflowShape = VARIANT === "after"
  ? {
      wide: await captureOverflowShape("wide", { width: 1_600, height: 900 }),
      mobile: await captureOverflowShape("mobile", { width: 390, height: 844 }),
    }
  : undefined;
const result = { variant: VARIANT, wide, mobile, ...(overflowShape ? { overflowShape } : {}) };
fs.writeFileSync(path.join(OUT_DIR, `${VARIANT}-metrics.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));

await browser.close();
