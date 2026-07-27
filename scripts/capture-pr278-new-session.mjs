import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4321";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
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
}, "pr278-new-session@test.dev");
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "zh");
}, token);
await page.reload();
await page.getByTestId("new-session").click();
await page.getByTestId("new-session-modal").waitFor();
await page.getByTestId("ns-model").locator("option").first().waitFor({ state: "attached" });
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}",
});
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(120);

const target = path.join(OUT_DIR, "19-new-session-after.png");
await page.screenshot({ path: target });
console.log(target);
await browser.close();
