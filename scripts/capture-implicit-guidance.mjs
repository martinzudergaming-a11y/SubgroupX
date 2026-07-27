import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/onboarding-implicit");
const LABEL = process.env.LABEL ?? "after";
const EMAIL = `implicit-${COLOR_SCHEME}@example.invalid`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_100, height: 820 },
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

await page.getByTestId("new-session").waitFor({ timeout: 20_000 });
await page.getByTestId("new-session").click();
await page.getByTestId("new-session-modal").waitFor();
await page.getByTestId("ns-title").fill("Implicit");
await page.getByTestId("ns-model").selectOption("mock::mock-coder");
await page.getByTestId("ns-sandbox").selectOption("workspace-write");
await page.getByTestId("ns-approval").selectOption("never");
await page.getByTestId("ns-create").click();

const composer = page.getByTestId("composer");
await composer.waitFor({ timeout: 20_000 });
await page.getByTestId("accept-suggestion").waitFor({ timeout: 10_000 });
await page.waitForTimeout(500);

const suffix = COLOR_SCHEME === "dark" ? "-dark" : "";
const shell = page.getByTestId("composer-shell");
async function shoot(name) {
  const box = await shell.boundingBox();
  if (!box) throw new Error("composer has no box");
  const pad = 20;
  await page.screenshot({
    path: path.join(OUT_DIR, `${LABEL}-${name}${suffix}.png`),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
}

await shoot("suggestion");
await composer.press("Tab");
await page.waitForTimeout(350);
await shoot("accepted");

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured ${LABEL}${suffix} → ${OUT_DIR}`);
