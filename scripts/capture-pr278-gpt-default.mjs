import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL;
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
if (!BASE_URL) throw new Error("BASE_URL is required");
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
  const response = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (!response.ok) throw new Error(`signup failed: ${response.status}`);
  return (await response.json()).token;
}, `pr278-gpt-${VARIANT}@test.dev`);
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "zh");
}, token);
await page.reload();
await page.getByTestId("new-session").waitFor();
await page.getByTestId("new-session").click();
const picker = page.getByTestId("ns-model");
await picker.waitFor();
await page.waitForFunction(() => {
  const select = document.querySelector('[data-testid="ns-model"]');
  return select instanceof HTMLSelectElement && select.options.length > 1;
});
await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(120);
const selected = await picker.locator("option:checked").textContent();
const target = path.join(OUT_DIR, `16-gpt-default-${VARIANT}.png`);
await page.screenshot({ path: target });
console.log(JSON.stringify({ variant: VARIANT, selected: selected?.trim(), target }));

await page.getByTestId("ns-mode-option-pentest").click();
await page.waitForFunction(() => {
  const select = document.querySelector('[data-testid="ns-model"]');
  return select instanceof HTMLSelectElement && select.value.startsWith("0AI-jail::");
});
await page.waitForTimeout(80);
const jailSelected = await picker.locator("option:checked").textContent();
const jailTarget = path.join(OUT_DIR, `17-jail-default-${VARIANT}.png`);
await page.screenshot({ path: jailTarget });
console.log(JSON.stringify({ variant: VARIANT, selected: jailSelected?.trim(), target: jailTarget }));
await browser.close();
