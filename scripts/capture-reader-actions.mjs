import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/reader-action-chrome");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1_280, height: 720 },
  locale: "en-US",
  colorScheme: "light",
  reducedMotion: "reduce",
});
const page = await context.newPage();
await page.goto(BASE_URL);

const token = await page.evaluate(async (email) => {
  const body = JSON.stringify({ email, password: "password123" });
  const headers = { "content-type": "application/json" };
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
}, `reader-actions-${VARIANT}-${Date.now()}@test.dev`);

await page.evaluate((value) => localStorage.setItem("agentweb.token", value), token);
await page.reload();
await page.getByTestId("new-session").waitFor();
await page.getByTestId("new-session").click();
await page.getByTestId("ns-title").fill("Reader actions");
await page.getByTestId("ns-model").selectOption("mock::mock-coder");
await page.getByTestId("ns-sandbox").selectOption("workspace-write");
await page.getByTestId("ns-approval").selectOption("never");
await page.getByTestId("ns-create").click();
await page.getByTestId("composer").waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="session-status"]')?.textContent === "idle");

for (const [index, prompt] of ["Map the execution path", "Compare the two traces", "Summarize the decisive evidence"].entries()) {
  await page.getByTestId("composer").fill(prompt);
  await page.getByTestId("send").click();
  await page.getByTestId("msg-assistant").nth(index).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-status"]')?.textContent === "idle");
}

await page.getByRole("button", { name: "Collapse sidebar" }).click();
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}[data-testid=sandbox-load]{visibility:hidden!important}",
});
await page.evaluate(() => document.fonts.ready);
await page.getByTestId("timeline").evaluate((node) => {
  node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -600 }));
  node.scrollTop = 0;
  node.dispatchEvent(new Event("scroll", { bubbles: true }));
});
await page.mouse.move(640, 360);
await page.getByTestId("jump-to-latest").waitFor({ state: "visible" });
await page.waitForFunction(() => {
  const jump = document.querySelector('[data-testid="jump-to-latest"]');
  return jump && getComputedStyle(jump).opacity === "1";
});
await page.waitForTimeout(80);

const metrics = await page.evaluate((variant) => {
  const rect = (node) => {
    const box = node?.getBoundingClientRect();
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null;
  };
  const composer = document.querySelector('[data-testid="composer"]');
  const jump = document.querySelector('[data-testid="jump-to-latest"]');
  const toc = document.querySelector('[data-testid="conversation-toc"]');
  const share = document.querySelector('[data-testid="chat-share"]');
  const floating = document.querySelector('[data-testid="floating-actions-anchor"]');
  const floatingSurface = floating?.querySelector('.oiia-shadow-pop');
  const composerRect = rect(composer);
  const jumpRect = rect(jump);
  return {
    variant,
    composer: composerRect,
    jump: jumpRect,
    toc: rect(toc),
    share: rect(share),
    floatingAnchor: rect(floating),
    floatingSurface: rect(floatingSurface),
    jumpCenterOffsetPx: composerRect && jumpRect
      ? Number(((jumpRect.x + jumpRect.width / 2) - (composerRect.x + composerRect.width / 2)).toFixed(2))
      : null,
    triggerShadows: {
      toc: toc ? getComputedStyle(toc).boxShadow : null,
      share: share ? getComputedStyle(share).boxShadow : null,
      jump: jump ? getComputedStyle(jump).boxShadow : null,
    },
    floatingSurfaceShadow: floatingSurface ? getComputedStyle(floatingSurface).boxShadow : null,
  };
}, VARIANT);

const target = path.join(OUT_DIR, `${VARIANT}-desktop.png`);
await page.screenshot({ path: target });
fs.writeFileSync(path.join(OUT_DIR, `${VARIANT}-metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);
let mobileTarget = null;
if (VARIANT === "after") {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-share"]').length === 0);
  await page.getByTestId("overflow-menu").click();
  await page.getByTestId("overflow-menu-panel").waitFor();
  await page.waitForTimeout(180);
  mobileTarget = path.join(OUT_DIR, "after-mobile.png");
  await page.screenshot({ path: mobileTarget });
}
console.log(JSON.stringify({ target, mobileTarget, metrics }));
await browser.close();
