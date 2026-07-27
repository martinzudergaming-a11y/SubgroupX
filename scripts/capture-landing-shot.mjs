import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("web/public/landing");
const EMAIL = `landing-shot-${COLOR_SCHEME}@example.invalid`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_100, height: 900 },
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
  localStorage.setItem("oiia.firstRunDismissed", "1");
}, { email: EMAIL });
await page.goto(BASE_URL);

await page.getByTestId("new-session").waitFor({ timeout: 20_000 });
await page.getByTestId("new-session").click();
await page.getByTestId("new-session-modal").waitFor();
await page.getByTestId("ns-title").fill("Landing");
await page.getByTestId("ns-model").selectOption("mock::mock-coder");
await page.getByTestId("ns-sandbox").selectOption("workspace-write");
await page.getByTestId("ns-approval").selectOption("never");
await page.getByTestId("ns-create").click();
await page.getByTestId("composer").waitFor();

async function send(text) {
  await page.getByTestId("send").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

await send("/write greet.py\nprint('hello from the agent')");
await page.getByTestId("tool-write_file").getByTestId("tool-status").waitFor({ timeout: 30_000 });
await page.waitForTimeout(400);
await send("/bash python3 greet.py");
await page.getByTestId("tool-bash").last().getByTestId("tool-status").waitFor({ timeout: 30_000 });
await page.waitForTimeout(900);

const timeline = page.getByTestId("timeline");
const box = await timeline.boundingBox();
if (!box) throw new Error("timeline has no box");
await page.screenshot({
  path: path.join(OUT_DIR, `session-${COLOR_SCHEME}.png`),
  clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 560) },
});

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured session-${COLOR_SCHEME} → ${OUT_DIR}`);
