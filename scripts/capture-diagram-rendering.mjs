import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4326";
const LABEL = process.env.LABEL ?? "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/d2-diagram-compiler");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_280, height: 900 },
  deviceScaleFactor: 1,
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: "light",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(BASE_URL);

const token = await page.evaluate(async () => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email: "diagram-review@example.invalid", password: "password123" });
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
});
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "en");
}, token);

const session = await page.evaluate(async (authToken) => {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Compiler-checked diagrams",
      provider: "mock",
      model: "mock-coder",
      sandboxMode: "workspace-write",
      sandboxKind: "local",
      approvalPolicy: "never",
    }),
  });
  if (!response.ok) throw new Error(`create session failed: ${response.status}`);
  return (await response.json()).session;
}, token);

await page.goto(`${BASE_URL}/s/${session.id}`);
const composer = page.getByTestId("composer");
await composer.waitFor();
await page.addStyleTag({
  content: [
    "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}",
    "[data-testid=composer]{caret-color:transparent!important}",
    "[data-testid=sandbox-load]{visibility:hidden!important}",
  ].join(""),
});

async function send(command) {
  await composer.fill(command);
  await page.getByTestId("send").click();
  const message = page.getByTestId("msg-assistant").last();
  await message.waitFor();
  await expectIdle();
  return message;
}

async function expectIdle() {
  await page.getByTestId("send").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="stop"]'), null, { timeout: 20_000 });
}

const d2Start = Date.now();
const d2 = await send("/d2");
if (LABEL === "after") await d2.getByTestId("d2-diagram").locator("svg").first().waitFor({ timeout: 20_000 });
else await d2.locator(".codeblock-shell").waitFor({ timeout: 10_000 });
const firstD2RenderMs = Date.now() - d2Start;
await page.evaluate(() => document.fonts.ready);
await d2.screenshot({ path: path.join(OUT_DIR, `${LABEL}.png`) });

let bounded = null;
if (LABEL === "after") {
  bounded = {};
  for (const [command, language] of [["/talld2", "d2"], ["/tallmermaid", "mermaid"]]) {
    const tall = await send(command);
    const viewport = tall.getByTestId(`${language}-diagram`);
    await viewport.locator("svg").first().waitFor({ timeout: 20_000 });
    bounded[language] = await viewport.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      maxHeight: getComputedStyle(node).maxHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    await tall.screenshot({ path: path.join(OUT_DIR, `after-bounded-${language}.png`) });
  }

  const invalid = await send("/badlintd2");
  await invalid.getByText("missing destination").waitFor({ timeout: 20_000 });
  const previousTool = page.getByTestId("tool-diagram_lint").last();
  await previousTool.scrollIntoViewIfNeeded();
  await invalid.screenshot({ path: path.join(OUT_DIR, "after-lint-feedback.png") });
}

const d2Resource = LABEL === "after" ? await page.evaluate(() => {
  const entry = performance.getEntriesByType("resource").find((item) => item.name.includes("/assets/browser-"));
  if (!(entry instanceof PerformanceResourceTiming)) return null;
  return {
    durationMs: Math.round(entry.duration),
    transferBytes: entry.transferSize,
    encodedBytes: entry.encodedBodySize,
    decodedBytes: entry.decodedBodySize,
  };
}) : null;
const result = { label: LABEL, errors, firstD2RenderMs, d2Resource, bounded };
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
await browser.close();
