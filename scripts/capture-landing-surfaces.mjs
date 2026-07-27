import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("web/public/landing");
const EMAIL = `landing-surfaces-${COLOR_SCHEME}@example.invalid`;
const SUFFIX = COLOR_SCHEME === "dark" ? "-dark" : "-light";
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
  localStorage.removeItem("oiia.firstRunDismissed");
}, { email: EMAIL });

await page.evaluate(async () => {
  const token = localStorage.getItem("agentweb.token");
  const headers = { authorization: `Bearer ${token}` };
  const listed = await fetch("/api/sessions", { headers }).then((r) => r.json());
  await Promise.all(listed.sessions.map((s) => fetch(`/api/sessions/${s.id}`, { method: "DELETE", headers })));
});
await page.goto(BASE_URL);

async function newSession(title, approval = "never") {
  await page.getByTestId("new-session").waitFor({ timeout: 20_000 });
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-modal").waitFor();
  await page.getByTestId("ns-title").fill(title);
  await page.getByTestId("ns-model").selectOption("mock::mock-coder");
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption(approval);
  await page.getByTestId("ns-create").click();
  await page.getByTestId("composer").waitFor({ timeout: 20_000 });
}

async function send(text) {
  await page.getByTestId("send").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

async function shoot(locator, name, { pad = 0, maxH, maxW } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${name}: no box — the surface was never reached`);
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}${SUFFIX}.png`),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(box.width + pad * 2, maxW ?? box.width + pad * 2),
      height: Math.min(box.height + pad * 2, maxH ?? box.height + pad * 2),
    },
  });
  console.log(`  ${name}${SUFFIX}`);
}

await newSession("Landing");
await send("/write greet.py\nprint('hello from the agent')");
await page.getByTestId("tool-write_file").getByTestId("tool-status").waitFor({ timeout: 30_000 });
await send("/bash python3 greet.py");
await page.getByTestId("tool-bash").last().getByTestId("tool-status").waitFor({ timeout: 30_000 });
await page.waitForTimeout(900);
await shoot(page.getByTestId("timeline"), "session", { maxH: 560 });

await page.getByTestId("toggle-details").click().catch(() => {});
await page.getByRole("button", { name: "Toggle details panel" }).click().catch(() => {});
await page.getByTestId("workspace-rail").waitFor({ timeout: 20_000 });
await page.getByTestId("file-browser").waitFor({ timeout: 20_000 });
await page.getByTestId("file-browser").getByText("greet.py").first().click();
await page.getByTestId("file-view").waitFor({ timeout: 20_000 });
await page.waitForTimeout(600);
await shoot(page.getByTestId("file-workbench"), "rail-files", { maxH: 150 });

await page.getByTestId("open-terminal").click();
const term = page.getByTestId("shell-terminal");
await term.waitFor({ timeout: 20_000 });
if ((await term.getAttribute("data-state")) !== "open") {
  await page.getByTestId("shell-new").click();
}
await page.waitForFunction(
  () => document.querySelector('[data-testid="shell-terminal"]')?.getAttribute("data-state") === "open",
  undefined,
  { timeout: 30_000 },
);
await term.click();
await page.keyboard.type("export PS1='$ ' && clear");
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
await page.keyboard.type("ls && python3 greet.py");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => document.querySelector('[data-testid="shell-terminal"]')?.textContent?.includes("hello from the agent"),
  undefined,
  { timeout: 30_000 },
);
await page.waitForTimeout(700);
const shellText = (await term.textContent()) ?? "";
if (/@|\$ *$|[A-Za-z0-9_.-]+:[~/]/.test(shellText.replace(/\$ /g, ""))) {
  const leak = shellText.split("\n").find((line) => /@|[A-Za-z0-9_.-]+:[~/]/.test(line));
  if (leak) throw new Error(`terminal capture still shows an identity: ${leak.trim()}`);
}
await shoot(term, "rail-terminal", { maxH: 108, maxW: 470 });

await page.evaluate(async ({ email }) => {
  localStorage.clear();
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email, password: "password123" });
  let response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  const data = await response.json();
  localStorage.setItem("agentweb.token", data.token);
  localStorage.setItem("oiia.locale", "en");
}, { email: `landing-approval-${COLOR_SCHEME}@example.invalid` });
await page.goto(BASE_URL);
await newSession("Approval", "on-request");
await send("/bash echo release > RELEASE.txt");
const perm = page.getByTestId("permission");
await perm.waitFor({ timeout: 30_000 });
await page.getByTestId("perm-summary").waitFor({ timeout: 10_000 });
await page.waitForTimeout(700);
await shoot(perm, "rail-approval", { pad: 10 });

if (errors.length > 0) {
  console.error("page errors:", errors);
  await browser.close();
  process.exit(1);
}
await browser.close();
console.log(`captured ${COLOR_SCHEME} surfaces → ${OUT_DIR}`);
