import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4324";
const LABEL = process.env.LABEL ?? "after";
const RUN_ID = process.env.RUN_ID ?? LABEL;
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/reader-action-dock");
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
  localStorage.setItem("oiia.locale", "en");
}, { email: `reader-layout-${RUN_ID}@example.invalid` });
await page.reload();
await page.getByTestId("new-session").waitFor();

await page.getByTestId("new-session").click();
await page.getByTestId("ns-title").fill("Reader layout study");
await page.getByTestId("ns-model").selectOption("mock::mock-coder");
await page.getByTestId("ns-sandbox").selectOption("workspace-write");
await page.getByTestId("ns-approval").selectOption("never");
await page.getByTestId("ns-create").click();
await page.getByTestId("composer").waitFor();

for (let index = 1; index <= 7; index += 1) {
  const before = await page.getByTestId("msg-assistant").count();
  await page.getByTestId("composer").fill(`Reader layout note ${index}: keep the workbench calm and stable.`);
  await page.getByTestId("send").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-status"]')?.textContent?.trim() === "running");
  await page.getByTestId("msg-assistant").nth(before).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-status"]')?.textContent?.trim() === "idle");
  await page.waitForTimeout(350);
}

await page.getByRole("button", { name: "Collapse sidebar" }).click();
await page.getByRole("button", { name: "Open sidebar" }).waitFor();
await page.getByTestId("account-menu-trigger").waitFor({ state: "detached" });
await page.evaluate(() => document.fonts.ready);

const roundedRect = (rect) => rect
  ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(rect[key] * 10) / 10]))
  : null;
const geometry = () => page.evaluate(() => {
  const read = (testId) => {
    const node = document.querySelector(`[data-testid="${testId}"]`);
    return node ? node.getBoundingClientRect().toJSON() : null;
  };
  const title = document.querySelector('[data-testid="session-title"]');
  const header = document.querySelector('[data-testid="top-header"]') ?? title?.parentElement?.parentElement;
  const headerRect = header?.getBoundingClientRect().toJSON() ?? null;
  const toc = document.querySelector('[data-testid="conversation-toc"]');
  return {
    header: headerRect,
    composer: read("composer"),
    readerAnchor: read("reader-actions-anchor"),
    readerDock: read("reader-actions-dock"),
    workspaceRail: read("workspace-rail"),
    tocOwner: toc && header?.contains(toc)
      ? "header"
      : toc?.closest('[data-testid="reader-actions-dock"]')
        ? "reader-dock"
        : "other",
  };
});

const closed = await geometry();
await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-closed.png`) });

await page.getByRole("button", { name: "Toggle details panel" }).click();
await page.getByTestId("workspace-rail").waitFor();
await page.waitForTimeout(260);
const open = await geometry();
await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-open.png`) });

await page.getByRole("button", { name: "Toggle details panel" }).click();
await page.getByTestId("workspace-rail").waitFor({ state: "hidden" });
await page.getByTestId("conversation-toc").click();
await page.getByTestId("conversation-toc-panel").waitFor();
await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-outline.png`) });
await page.keyboard.press("Escape");
await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(80);
const mobile = await geometry();
await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-mobile.png`) });

const clean = (sample) => Object.fromEntries(Object.entries(sample).map(([key, value]) => [
  key,
  value && typeof value === "object" && "width" in value ? roundedRect(value) : value,
]));
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), `${JSON.stringify({
  closed: clean(closed),
  open: clean(open),
  mobile: clean(mobile),
  headerWidthDelta: Math.round(((open.header?.width ?? 0) - (closed.header?.width ?? 0)) * 10) / 10,
  errors,
}, null, 2)}\n`);

console.log(JSON.stringify({
  tocOwner: closed.tocOwner,
  headerWidthDelta: Math.round(((open.header?.width ?? 0) - (closed.header?.width ?? 0)) * 10) / 10,
  errors,
}));
await browser.close();
