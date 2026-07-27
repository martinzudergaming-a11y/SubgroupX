import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { captureVisibleElement } from "./view-preserving-screenshot.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4322";
const LABEL = process.env.LABEL ?? "proposed";
const STATE = process.env.STATE ?? "done";
const DENSITY = process.env.DENSITY === "long" || process.env.DENSITY === "limit"
  ? process.env.DENSITY
  : "short";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const MOBILE = process.env.MOBILE === "1";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/tool-detail-pane");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
  deviceScaleFactor: 1,
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: COLOR_SCHEME,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(BASE_URL);

const token = await page.evaluate(async ({ email }) => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email, password: "password123" });
  let response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
}, { email: `tool-detail-${LABEL}@example.invalid` });
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "en");
}, token);

const session = await page.evaluate(async ({ auth, state }) => {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Tool detail evidence",
      provider: "mock",
      model: "mock-coder",
      sandboxMode: "workspace-write",
      sandboxKind: "local",
      approvalPolicy: state === "waiting" ? "on-request" : "never",
    }),
  });
  if (!response.ok) throw new Error(`session create failed: ${response.status}`);
  return (await response.json()).session;
}, { auth: token, state: STATE });

await page.goto(`${BASE_URL}/s/${session.id}`);
await page.getByTestId("composer").waitFor();
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}[data-testid=composer]{caret-color:transparent!important}",
});
const longCommand = Array.from(
  { length: 72 },
  (_, index) => `printf 'adaptive-${String(index).padStart(2, "0")}\\n'`,
).join("\n");
const command = DENSITY === "long"
  ? `/bash ${longCommand}`
  : DENSITY === "limit"
    ? "/bash printf '%40000s' '' | tr ' ' x"
    : STATE === "running"
      ? "/bash sleep 2; printf 'SYSTEM CHECK\\nnode=22\\npython=3.13\\nstatus=ready\\n'"
      : "/bash printf 'SYSTEM CHECK\\nnode=22\\npython=3.13\\nstatus=ready\\n'";
await page.getByTestId("composer").fill(command);
await page.getByTestId("send").click();
const tool = page.getByTestId("tool-bash");
const expectedStatus = STATE === "running" ? "running" : STATE === "waiting" ? "pending" : "success";
await tool.getByTestId("tool-status").filter({ hasText: expectedStatus }).waitFor();
if (STATE === "waiting") await page.getByTestId("permission").waitFor();
const openStartedAt = performance.now();
await tool.getByTestId("tool-open").click();
await page.getByTestId("tool-detail").waitFor();
if (!MOBILE) await page.getByTestId("workspace-rail").waitFor();
if (STATE === "running") {
  await page.getByTestId("tool-output-pane").waitFor();
  await page.getByTestId("tool-elapsed").waitFor();
  await page.waitForTimeout(280);
}
if (DENSITY === "long") {
  await page.waitForFunction(
    () => document.querySelector("[data-testid=shell-tool-inspector]")?.getAttribute("data-layout") === "split",
    undefined,
    { timeout: 10_000 },
  );
}
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const openToStableMs = performance.now() - openStartedAt;

const panel = MOBILE ? page.locator("body") : page.getByTestId("workspace-rail").locator("xpath=../..");
const capture = await captureVisibleElement(page, panel, {
  path: path.join(OUT_DIR, `${LABEL}.png`),
});
const metrics = await page.getByTestId("tool-detail").evaluate((root) => {
  const rect = (node) => {
    const box = node?.getBoundingClientRect();
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  };
  const direct = Array.from(root.children);
  const commandPane = root.querySelector("[data-testid=tool-command-pane]");
  const output = root.querySelector("[data-testid=tool-output-pane]");
  return {
    detail: rect(root),
    header: rect(direct[0]),
    body: rect(direct[1]),
    layout: root.querySelector("[data-testid=shell-tool-inspector]")?.getAttribute("data-layout") ?? null,
    command: rect(root.querySelector("[data-testid=tool-command-pane]")),
    commandOverflowX: commandPane instanceof HTMLElement
      ? commandPane.scrollWidth - commandPane.clientWidth
      : null,
    commandOverflowNodes: commandPane instanceof HTMLElement
      ? Array.from(commandPane.querySelectorAll("*")).flatMap((node) => {
          const paneBox = commandPane.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          const right = box.right - paneBox.right;
          const left = paneBox.left - box.left;
          const style = getComputedStyle(node);
          return right > 0.5 || left > 0.5
            ? [{
                tag: node.tagName.toLowerCase(),
                className: String(node.className).slice(0, 120),
                right,
                left,
                display: style.display,
                whiteSpace: style.whiteSpace,
                overflowWrap: style.overflowWrap,
                wordBreak: style.wordBreak,
              }]
            : [];
        }).slice(0, 10)
      : [],
    commandCode: rect(root.querySelector("[data-testid=shell-command] pre")),
    output: rect(root.querySelector("[data-testid=tool-output-pane]")),
    splitter: rect(root.querySelector("[data-testid=tool-shell-splitter]")),
    resultCharacters: root.querySelector("[data-testid=tool-result]")?.textContent?.length ?? 0,
    resultElements: root.querySelector("[data-testid=tool-result]")?.querySelectorAll("*").length ?? 0,
    outputTailGap: output instanceof HTMLElement
      ? output.scrollHeight - output.scrollTop - output.clientHeight
      : null,
    roundedCards: root.querySelectorAll(".rounded-xl").length,
    borderedSurfaces: Array.from(root.querySelectorAll("div")).filter((node) => {
      const style = getComputedStyle(node);
      return style.borderTopWidth !== "0px" && style.borderTopStyle !== "none";
    }).length,
  };
});
fs.writeFileSync(
  path.join(OUT_DIR, `${LABEL}.json`),
  `${JSON.stringify({
    metrics,
    clip: capture.clip,
    viewport: { width: MOBILE ? 390 : 1_440, height: MOBILE ? 844 : 900, deviceScaleFactor: 1, colorScheme: COLOR_SCHEME },
    state: STATE,
    density: DENSITY,
    openToStableMs: Math.round(openToStableMs * 100) / 100,
    errors,
  }, null, 2)}\n`,
);
console.log(JSON.stringify({ metrics, clip: capture.clip, errors }));
if (DENSITY === "limit") {
  if (metrics.layout !== "natural") throw new Error(`one-sided overflow must stay natural, got ${metrics.layout}`);
  if (metrics.resultCharacters < 29_000 || metrics.resultCharacters > 64_200) {
    throw new Error(`near-limit result was not bounded: ${metrics.resultCharacters}`);
  }
}
if (STATE === "running") await tool.getByTestId("tool-status").filter({ hasText: "success" }).waitFor();
if (STATE === "waiting") await page.getByTestId("perm-deny").click();
await browser.close();
