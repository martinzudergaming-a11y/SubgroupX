import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { captureVisibleElement } from "./view-preserving-screenshot.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4322";
const LABEL = process.env.LABEL ?? "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/account-trigger-hover");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_440, height: 900 },
  deviceScaleFactor: 1,
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: "light",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(BASE_URL);
await page.evaluate(async ({ email }) => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email, password: "password123" });
  let response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  const data = await response.json();
  localStorage.setItem("agentweb.token", data.token);
  localStorage.setItem("oiia.locale", "zh");
}, { email: `account-hover-${LABEL}@example.invalid` });
await page.reload();
await page.getByTestId("new-session").waitFor();

const trigger = page.getByTestId("account-menu-trigger");
const navigation = page.getByTestId("help-menu-trigger");
await navigation.waitFor();
await trigger.hover();
await page.waitForTimeout(180);
await page.evaluate(() => document.fonts.ready);

const presentation = () => page.evaluate(() => ({
  href: location.href,
  innerWidth,
  innerHeight,
  windowX: scrollX,
  windowY: scrollY,
  visualWidth: visualViewport?.width ?? null,
  visualHeight: visualViewport?.height ?? null,
  visualScale: visualViewport?.scale ?? null,
}));
const before = await presentation();
await captureVisibleElement(page, trigger);
await page.screenshot({
  path: path.join(OUT_DIR, `${LABEL}-crop.png`),
  clip: { x: 0, y: 748, width: 260, height: 152 },
});
const after = await presentation();

const readMetrics = (testId) => page.evaluate((id) => {
  const bounds = (node) => {
    const rect = node?.getBoundingClientRect();
    return rect
      ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(rect[key] * 10) / 10]))
      : null;
  };
  const node = document.querySelector(`[data-testid="${id}"]`);
  const style = node ? getComputedStyle(node) : null;
  return {
    row: bounds(node),
    icon: bounds(node?.querySelector("svg")),
    text: bounds(node?.querySelector("[data-account-email]") ?? node?.querySelector("span:last-child")),
    background: style?.backgroundColor ?? null,
    borderRadius: style?.borderRadius ?? null,
  };
}, testId);
const accountMetrics = await readMetrics("account-menu-trigger");
await navigation.hover();
await page.waitForTimeout(180);
const navigationMetrics = await readMetrics("help-menu-trigger");
const metrics = { account: accountMetrics, navigation: navigationMetrics };

fs.writeFileSync(
  path.join(OUT_DIR, `${LABEL}.json`),
  `${JSON.stringify({ metrics, presentation: { before, after }, errors }, null, 2)}\n`,
);
console.log(JSON.stringify({ metrics, presentation: { before, after }, errors }));
await browser.close();
