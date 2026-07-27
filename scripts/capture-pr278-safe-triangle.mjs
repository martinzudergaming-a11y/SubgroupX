import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4323";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/278-ui");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
  reducedMotion: "reduce",
  colorScheme: "light",
});
const page = await context.newPage();
await page.goto(BASE_URL);

const token = await page.evaluate(async (email) => {
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email, password: "password123" });
  let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
  if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
  if (!response.ok) throw new Error(`auth failed: ${response.status}`);
  return (await response.json()).token;
}, `pr278-safe-triangle-${VARIANT}@test.dev`);

await page.evaluate((value) => {
  localStorage.setItem("agentweb.token", value);
  localStorage.setItem("oiia.locale", "zh");
}, token);

const session = await page.evaluate(async (value) => {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${value}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "安全三角区",
      provider: "mock",
      model: "mock-coder",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    }),
  });
  if (!response.ok) throw new Error(`create session failed: ${response.status}`);
  return (await response.json()).session;
}, token);

await page.goto(`${BASE_URL}/s/${session.id}`);
await page.getByTestId("composer").fill("hello");
await page.getByTestId("send").click();
await page.getByTestId("msg-assistant").last().waitFor();
await page.getByTestId("send").waitFor({ state: "visible" });
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}",
});
await page.evaluate(() => document.fonts.ready);

const trigger = page.getByTestId("approval-switch");
const menu = page.getByTestId("approval-menu");
await trigger.hover();
await menu.waitFor();
const triggerBox = await trigger.boundingBox();
const menuBox = await menu.boundingBox();
if (!triggerBox || !menuBox) throw new Error("composer popover geometry is unavailable");

const start = {
  x: triggerBox.x + triggerBox.width - 4,
  y: triggerBox.y + 4,
};
const destination = {
  x: menuBox.x + 18,
  y: menuBox.y + menuBox.height - 10,
};
const gapY = (triggerBox.y + menuBox.y + menuBox.height) / 2;
const progress = (start.y - gapY) / (start.y - destination.y);
const gapX = start.x + (destination.x - start.x) * progress;

await page.mouse.move(start.x, start.y);
await page.mouse.move(gapX, gapY, { steps: 6 });
await page.waitForTimeout(220);

const menuStayedOpen = await menu.isVisible().catch(() => false);
if (VARIANT === "before" && menuStayedOpen) throw new Error("before capture unexpectedly kept the menu open");
if (VARIANT === "after" && !menuStayedOpen) throw new Error("after capture lost the menu inside the safe triangle");

await page.evaluate(({ start, destination, gapX, gapY, menuStayedOpen }) => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(window.innerWidth));
  svg.setAttribute("height", String(window.innerHeight));
  Object.assign(svg.style, {
    position: "fixed",
    inset: "0",
    zIndex: "99999",
    pointerEvents: "none",
  });

  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", String(start.x));
  line.setAttribute("y1", String(start.y));
  line.setAttribute("x2", String(destination.x));
  line.setAttribute("y2", String(destination.y));
  line.setAttribute("stroke", "#C77D2E");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "5 5");
  line.setAttribute("opacity", "0.9");
  svg.append(line);

  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", String(gapX));
  dot.setAttribute("cy", String(gapY));
  dot.setAttribute("r", "6");
  dot.setAttribute("fill", "#C77D2E");
  dot.setAttribute("stroke", "white");
  dot.setAttribute("stroke-width", "2");
  svg.append(dot);
  document.body.append(svg);

  const label = document.createElement("div");
  label.textContent = `指针在按钮→菜单路径停留 220ms · 菜单${menuStayedOpen ? "保持打开" : "已经关闭"}`;
  Object.assign(label.style, {
    position: "fixed",
    left: `${Math.max(16, gapX - 78)}px`,
    top: `${Math.max(16, gapY - 46)}px`,
    zIndex: "100000",
    pointerEvents: "none",
    padding: "6px 9px",
    border: "1px solid #D8C7A8",
    borderRadius: "8px",
    background: "#FFFDF7",
    color: "#6D4B22",
    boxShadow: "0 4px 14px rgba(64, 45, 20, .12)",
    font: "600 12px/1.25 system-ui, sans-serif",
  });
  document.body.append(label);
}, { start, destination, gapX, gapY, menuStayedOpen });

const target = path.join(OUT_DIR, `20-composer-safe-triangle-${VARIANT}.png`);
await page.screenshot({ path: target });
console.log(target);
await browser.close();
