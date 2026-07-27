import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const SHOT = process.env.SHOT ?? "help";
const LABEL = process.env.LABEL ?? "after";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/onboarding-help-surface");
const EMAIL = process.env.EMAIL ?? `help-surface-${SHOT}-${COLOR_SCHEME}@example.invalid`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_180, height: 820 },
  deviceScaleFactor: 2,
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: COLOR_SCHEME,
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
  localStorage.setItem("oiia.locale", "en");
}, { email: EMAIL });
await page.goto(BASE_URL);

const suffix = COLOR_SCHEME === "dark" ? "-dark" : "";
if (SHOT === "about") {
  await page.goto(`${BASE_URL}/about`);
  await page.getByTestId("landing-enter-app").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-about${suffix}.png`), clip: { x: 0, y: 0, width: 1_180, height: 640 } });
} else {
  const trigger = page.getByTestId("help-menu-trigger");
  await trigger.waitFor({ timeout: 20_000 });
  await trigger.click();
  await page.getByTestId("help-menu").waitFor();
  await page.waitForTimeout(250);
  const menu = await page.getByTestId("help-menu").boundingBox();
  const box = await trigger.boundingBox();
  if (!menu || !box) throw new Error("help menu has no box");
  const pad = 16;
  const top = Math.min(menu.y, box.y) - pad;
  await page.screenshot({
    path: path.join(OUT_DIR, `${LABEL}-help${suffix}.png`),
    clip: { x: Math.max(0, menu.x - pad), y: Math.max(0, top), width: menu.width + pad * 2, height: box.y + box.height + pad - top },
  });
}

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured ${LABEL}-${SHOT}${suffix} → ${OUT_DIR}`);
