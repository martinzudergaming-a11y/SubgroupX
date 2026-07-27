import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4326";
const LABEL = process.env.LABEL ?? "after";
const COLOR_SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("docs/pr/account-popover-unified");
const EMAIL = process.env.EMAIL ?? "account-menu@example.invalid";
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1_440, height: 900 },
  deviceScaleFactor: 1,
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
await page.reload();
await page.getByTestId("new-session").waitFor();
await page.evaluate(() => document.fonts.ready);
await page.getByTestId("account-menu-trigger").click();
const menu = page.getByRole("menu");
await menu.waitFor();

const metrics = await page.evaluate(() => {
  const rect = (element) => {
    const bounds = element?.getBoundingClientRect();
    return bounds
      ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(bounds[key] * 100) / 100]))
      : null;
  };
  const style = (element) => {
    const computed = element ? getComputedStyle(element) : null;
    return computed
      ? {
          background: computed.backgroundColor,
          border: computed.borderColor,
          radius: computed.borderRadius,
          padding: computed.padding,
          boxShadow: computed.boxShadow,
        }
      : null;
  };
  const trigger = document.querySelector('[data-testid="account-menu-trigger"]');
  const card = document.querySelector('[role="menu"]');
  return {
    trigger: {
      rect: rect(trigger),
      style: style(trigger),
      name: trigger?.querySelector("[data-account-name]")?.textContent ?? null,
      email: trigger?.querySelector("[data-account-email]")?.textContent ?? null,
    },
    menu: {
      rect: rect(card),
      style: style(card),
      items: [...(card?.querySelectorAll("[data-menu-item]") ?? [])].map((item) => ({
        id: item.getAttribute("data-testid"),
        text: item.textContent?.trim(),
        rect: rect(item),
        style: style(item),
      })),
      separators: card?.querySelectorAll('[role="separator"]').length ?? 0,
    },
    activeTestId: document.activeElement?.getAttribute("data-testid") ?? null,
  };
});

await page.screenshot({
  path: path.join(OUT_DIR, `${LABEL}.png`),
  clip: { x: 0, y: 570, width: 292, height: 330 },
});
fs.writeFileSync(
  path.join(OUT_DIR, `${LABEL}.json`),
  `${JSON.stringify({ ...metrics, errors }, null, 2)}\n`,
);
console.log(JSON.stringify({ ...metrics, errors }));
await browser.close();
