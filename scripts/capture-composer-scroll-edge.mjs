import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4328";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/composer-scroll-edge");
fs.mkdirSync(OUT_DIR, { recursive: true });

const scenarios = [
  { label: "desktop", viewport: { width: 1_440, height: 900 }, colorScheme: "light" },
  { label: "mobile", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { label: "dark", viewport: { width: 1_440, height: 900 }, colorScheme: "dark" },
];

const browser = await chromium.launch();
const result = { variant: VARIANT, scenarios: {} };

for (const scenario of scenarios) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    locale: "en-US",
    reducedMotion: "reduce",
    colorScheme: scenario.colorScheme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(BASE_URL);

  const token = await page.evaluate(async ({ email }) => {
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ email, password: "password123" });
    let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!response.ok) throw new Error(`auth failed: ${response.status}`);
    return (await response.json()).token;
  }, { email: `composer-edge-${VARIANT}-${scenario.label}@example.invalid` });

  await page.evaluate((value) => {
    localStorage.setItem("agentweb.token", value);
    localStorage.setItem("oiia.locale", "en");
  }, token);

  const session = await page.evaluate(async (auth) => {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Composer edge study",
        provider: "mock",
        model: "mock-coder",
        sandboxMode: "workspace-write",
        sandboxKind: "local",
        approvalPolicy: "never",
      }),
    });
    if (!response.ok) throw new Error(`session create failed: ${response.status}`);
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

  for (let index = 0; index < 3; index += 1) {
    await composer.fill(`Edge study ${index + 1}: keep the final answer compact.`);
    await page.getByTestId("send").click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-testid="msg-assistant"]').length >= count,
      index + 1,
    );
    await page.getByTestId("session-status").getByText("idle", { exact: true }).waitFor();
  }
  await composer.fill("Describe the next step without hiding the preceding line.");
  await composer.focus();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const metrics = await page.evaluate(() => {
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box
        ? Object.fromEntries(Object.entries({ x: box.x, y: box.y, width: box.width, height: box.height })
          .map(([key, value]) => [key, Math.round(value * 100) / 100]))
        : null;
    };
    const wrap = document.querySelector(".oiia-composer-wrap");
    const input = document.querySelector('[data-testid="composer"]');
    const edge = document.querySelector('[data-testid="composer-scroll-edge"]') ?? wrap?.firstElementChild;
    const wrapStyle = wrap ? getComputedStyle(wrap) : null;
    const inputStyle = input ? getComputedStyle(input) : null;
    const edgeStyle = edge ? getComputedStyle(edge) : null;
    return {
      main: rect(document.querySelector('[data-testid="main-content"]')),
      shell: rect(document.querySelector('[data-testid="composer-shell"]')),
      input: rect(input),
      edge: rect(edge),
      surface: wrapStyle?.backgroundColor ?? null,
      inputShadow: inputStyle?.boxShadow ?? null,
      inputRadius: inputStyle?.borderRadius ?? null,
      edgeBackground: edgeStyle?.backgroundImage ?? null,
    };
  });
  metrics.errors = errors;

  if (!metrics.main) throw new Error(`${scenario.label}: main content geometry missing`);
  if (errors.length > 0) throw new Error(`${scenario.label}: page errors: ${errors.join("; ")}`);
  if (VARIANT === "after") {
    if (metrics.edge?.height !== 20) throw new Error(`${scenario.label}: expected a 20px edge veil`);
    if (metrics.edgeBackground?.includes("/ 0.6)")) {
      throw new Error(`${scenario.label}: old 60% veil midpoint is still active`);
    }
    if (scenario.label !== "mobile" && metrics.inputShadow?.includes("rgba(42, 47, 38")) {
      throw new Error(`${scenario.label}: old fixed-hue Composer shadow is still active`);
    }
  }
  const cropHeight = scenario.label === "mobile" ? 350 : 300;
  await page.screenshot({
    path: path.join(OUT_DIR, `${VARIANT}-${scenario.label}.png`),
    clip: {
      x: metrics.main.x,
      y: Math.max(metrics.main.y, metrics.main.y + metrics.main.height - cropHeight),
      width: metrics.main.width,
      height: Math.min(cropHeight, metrics.main.height),
    },
  });
  result.scenarios[scenario.label] = metrics;
  await context.close();
}

fs.writeFileSync(path.join(OUT_DIR, `${VARIANT}-metrics.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
await browser.close();
