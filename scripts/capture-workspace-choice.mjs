import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const LABEL = process.env.LABEL ?? "after";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/onboarding-workspace-choice");
const EMAIL = process.env.EMAIL ?? `workspace-choice-${LABEL}-${COLOR_SCHEME}@example.invalid`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_100, height: 760 },
  deviceScaleFactor: 2,
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: COLOR_SCHEME,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.route("**/api/models", async (route) => {
  const upstream = await route.fetch();
  const body = await upstream.json();
  await route.fulfill({
    response: upstream,
    json: {
      ...body,
      e2b: false,
      executors: {
        local: { available: false, reason: "policy_disabled" },
        e2b: { available: false, reason: "capacity_unavailable" },
      },
    },
  });
});

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
const state = page.getByTestId("executor-empty-state");
await state.waitFor({ timeout: 20_000 });
const panel = (await state.getByTestId("executor-choice").count()) > 0
  ? state.getByTestId("executor-choice")
  : state.locator("section").first();
await page.waitForTimeout(400);

const suffix = COLOR_SCHEME === "dark" ? "-dark" : "";
const box = await panel.boundingBox();
if (!box) throw new Error("panel has no box");
const pad = 24;
await page.screenshot({
  path: path.join(OUT_DIR, `${LABEL}${suffix}.png`),
  clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
});

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured ${LABEL}${suffix} → ${OUT_DIR}`);
