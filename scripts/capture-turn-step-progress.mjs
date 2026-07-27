import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4327";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/turn-step-progress");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1_100, height: 760 },
  locale: "en-US",
  reducedMotion: "reduce",
  colorScheme: "light",
});
const page = await context.newPage();
await page.goto(BASE_URL);

const token = await page.evaluate(async () => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email: "turn-step-evidence@example.invalid", password: "password123" });
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
});
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "en");
}, token);

const session = await page.evaluate(async (auth) => {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Turn and Step progress",
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
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}[data-testid=composer]{caret-color:transparent!important}",
});

const waitForStatus = (status) => page.waitForFunction(
  (expected) => document.querySelector('[data-testid="session-status"]')?.textContent === expected,
  status,
  { timeout: 15_000 },
);

const sendIdle = async (text) => {
  await composer.fill(text);
  await page.getByTestId("send").click();
  await waitForStatus("running");
  await waitForStatus("idle");
};

const sentAt = performance.now();
await composer.fill("/bash printf 'TOOL_STEP_OK\\n'");
await page.getByTestId("send").click();
await waitForStatus("running");
const activity = page.getByTestId("agent-activity-orb");
await page.waitForFunction(() => document.querySelector('[data-testid="agent-activity-orb"]')
  ?.getAttribute('title')?.includes('Command ready · waiting for model response to finish'), undefined, { timeout: 10_000 });
const readyAt = performance.now();

await page.getByTestId("main-content").screenshot({ path: path.join(OUT_DIR, "after-tool-ready.png") });
const afterLabels = await page.evaluate(() => ({
  activity: document.querySelector('[data-testid="agent-activity-orb"]')?.getAttribute('title') ?? "",
  tool: document.querySelector('[data-testid="tool-bash"] [data-testid="tool-open"]')?.textContent?.trim() ?? "",
}));

await page.evaluate(() => {
  const activityOrb = document.querySelector('[data-testid="agent-activity-orb"]');
  activityOrb?.setAttribute('title', 'Composing a command…');
  activityOrb?.querySelector('canvas')?.setAttribute('aria-label', 'Composing a command…');
  const spans = document.querySelectorAll('[data-testid="tool-bash"] [data-testid="tool-open"] > span');
  if (spans[1]) spans[1].textContent = "Composing bash command";
});
await page.getByTestId("main-content").screenshot({ path: path.join(OUT_DIR, "before-tool-ready.png") });

await composer.fill("Keep the final reply concise.");
await composer.press("Enter");
await waitForStatus("idle");

await sendIdle("Second top-level request.");

const timeline = await page.evaluate(async ({ auth, id }) => {
  const response = await fetch(`/api/sessions/${id}/timeline`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  if (!response.ok) throw new Error(`timeline failed: ${response.status}`);
  return (await response.json()).items;
}, { auth: token, id: session.id });
const userRows = timeline.filter((item) => item.kind === "user");
const exactTurnIds = [...new Set(timeline.map((item) => item.turnId).filter(Boolean))];

await page.getByTestId("chat-share").first().click();
await page.getByTestId("share-scope-choose").click();
const pickerRows = await page.getByTestId("share-turn-row").count();
await page.getByRole("dialog").screenshot({ path: path.join(OUT_DIR, "after-turn-picker.png") });

const metrics = {
  readyVisibleAfterMs: Math.round(readyAt - sentAt),
  afterLabels,
  timeline: {
    userMessages: userRows.length,
    exactAgentTurns: exactTurnIds.length,
    pickerRows,
    firstTurnUserMessages: userRows.filter((item) => item.turnId === userRows[0]?.turnId).length,
  },
};
fs.writeFileSync(path.join(OUT_DIR, "capture-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify(metrics));
await browser.close();
