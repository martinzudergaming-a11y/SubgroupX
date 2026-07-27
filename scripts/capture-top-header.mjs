import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const LABEL = process.env.LABEL ?? "after";
const STATE = process.env.STATE === "no-session" ? "no-session" : "session";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/onboarding-header-cleanup");
const EMAIL = process.env.EMAIL ?? `top-header-${LABEL}-${STATE}-${COLOR_SCHEME}@example.invalid`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_200, height: 800 },
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

await page.evaluate(async () => {
  const token = localStorage.getItem("agentweb.token");
  const headers = { authorization: `Bearer ${token}` };
  const listed = await fetch("/api/sessions", { headers }).then((r) => r.json());
  await Promise.all(listed.sessions.map((s) => fetch(`/api/sessions/${s.id}`, { method: "DELETE", headers })));
});
await page.goto(BASE_URL);

if (STATE === "session") {
  await page.getByTestId("new-session").waitFor({ timeout: 20_000 });
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-modal").waitFor();
  await page.getByTestId("ns-title").fill("Header");
  await page.getByTestId("ns-model").selectOption("mock::mock-coder");
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
  await page.getByTestId("sandbox-load").waitFor({ timeout: 30_000 });
}

const header = page.getByTestId("top-header");
await header.waitFor({ timeout: 20_000 });
await page.waitForTimeout(800);

const box = await header.boundingBox();
if (!box) throw new Error("header has no box");
const width = Math.min(box.width, 420);
await page.screenshot({
  path: path.join(OUT_DIR, `${LABEL}-${STATE}${COLOR_SCHEME === "dark" ? "-dark" : ""}.png`),
  clip: { x: box.x + box.width - width, y: box.y, width, height: box.height },
});

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured ${LABEL}-${STATE} → ${OUT_DIR}`);
