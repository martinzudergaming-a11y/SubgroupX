import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4327";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/inline-workspace-images");
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
  const body = JSON.stringify({ email: "inline-image-evidence@test.dev", password: "password123" });
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
});
await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "en");
}, token);

async function api(method, route, body) {
  return page.evaluate(async ({ token, method, route, body }) => {
    const response = await fetch(`/api${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status}`);
    return json;
  }, { token, method, route, body });
}

const session = (await api("POST", "/sessions", {
  title: "Inline workspace image",
  provider: "mock",
  model: "mock-coder",
  sandboxMode: "workspace-write",
  sandboxKind: "local",
  approvalPolicy: "never",
})).session;

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

const png = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 750;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const gradient = ctx.createLinearGradient(0, 0, 1200, 750);
  gradient.addColorStop(0, "#E8EEE3");
  gradient.addColorStop(0.55, "#C9DAC3");
  gradient.addColorStop(1, "#9FB7A2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1200, 750);
  ctx.fillStyle = "rgba(255,255,255,.45)";
  ctx.beginPath(); ctx.arc(960, 100, 270, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(50,65,52,.10)";
  ctx.beginPath(); ctx.arc(1060, 700, 360, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(50,65,52,.24)";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(100, 545); ctx.lineTo(1100, 545); ctx.stroke();
  ctx.fillStyle = "#334238";
  ctx.font = "600 70px system-ui, sans-serif";
  ctx.fillText("WORKSPACE IMAGE", 100, 300);
  ctx.font = "400 31px system-ui, sans-serif";
  ctx.fillStyle = "rgba(51,66,56,.78)";
  ctx.fillText("lazy  •  bounded  •  reusable", 104, 365);
  return canvas.toDataURL("image/png").split(",", 2)[1];
});
await api("POST", `/sessions/${session.id}/upload`, { files: [{ name: "preview.png", dataBase64: png }] });

let mintRequests = 0;
let mediaGets = 0;
page.on("request", (request) => {
  const url = new URL(request.url());
  if (request.method() === "POST" && url.pathname === `/api/sessions/${session.id}/file-preview`) mintRequests++;
  if (request.method() === "GET" && url.pathname.startsWith("/api/file-preview/")) mediaGets++;
});

await composer.fill("/link uploads/preview.png");
await page.getByTestId("send").click();
const message = page.getByTestId("msg-assistant").last();
const preview = message.getByTestId("workspace-image-preview");
await preview.waitFor();
await preview.locator("img").waitFor();
await preview.evaluate((node) => new Promise((resolve) => {
  const image = node.querySelector("img");
  if (image?.complete) resolve(undefined);
  else image?.addEventListener("load", () => resolve(undefined), { once: true });
}));
await page.evaluate(() => document.fonts.ready);

const readMetrics = () => preview.evaluate((node) => {
  const card = node.getBoundingClientRect();
  const viewport = node.querySelector('[data-testid="workspace-image-viewport"]')?.getBoundingClientRect();
  const image = node.querySelector("img");
  return {
    card: { width: card.width, height: card.height },
    viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
    image: image ? {
      loading: image.loading,
      decoding: image.decoding,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    } : null,
  };
});

const desktop = await readMetrics();
await message.screenshot({ path: path.join(OUT_DIR, "after-desktop.png") });
await page.setViewportSize({ width: 390, height: 844 });
await message.screenshot({ path: path.join(OUT_DIR, "after-mobile.png") });
const mobile = await readMetrics();

await page.setViewportSize({ width: 1_100, height: 760 });
await page.evaluate(() => {
  const root = document.querySelector("[data-workspace-image-root]");
  const wrapper = root?.parentElement;
  if (!root || !wrapper) throw new Error("workspace image root missing");
  const paragraph = document.createElement("p");
  const anchor = document.createElement("a");
  anchor.href = "uploads/preview.png";
  anchor.dataset.file = "uploads/preview.png";
  anchor.className = "cursor-pointer underline decoration-[#C8C8C8] underline-offset-2 hover:decoration-current";
  anchor.textContent = "uploads/preview.png";
  paragraph.appendChild(anchor);
  wrapper.replaceWith(paragraph);
});
await message.screenshot({ path: path.join(OUT_DIR, "before-desktop.png") });

const result = { desktop, mobile, requests: { mint: mintRequests, mediaGet: mediaGets } };
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
await browser.close();
