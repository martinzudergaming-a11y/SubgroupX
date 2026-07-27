import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("web/public/landing");
const EMAIL = process.env.DEMO_EMAIL ?? "you@example.invalid";
const PASSWORD = process.env.DEMO_PASSWORD ?? "password123";

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();

const SCRIPT = [
  "export PS1='$ ' && clear",
  "cat > primes.py <<'PY'\nn = 50\nsieve = [True] * (n + 1)\nfor p in range(2, int(n ** 0.5) + 1):\n    if sieve[p]:\n        for m in range(p * p, n + 1, p):\n            sieve[m] = False\nprint([i for i in range(2, n + 1) if sieve[i]])\nPY",
  "python3 primes.py",
  "printf 'fermat: a^(p-1) mod p == 1\\n'; python3 -c \"print(pow(3, 6, 7))\"",
  "ls && wc -l primes.py",
];

async function capture(scheme) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 700 },
    deviceScaleFactor: 2,
    locale: "en-US",
    reducedMotion: "reduce",
    colorScheme: scheme,
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(BASE_URL);
  await page.evaluate(async ({ email, password }) => {
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ email, password });
    let res = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!res.ok) res = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
    localStorage.setItem("agentweb.token", (await res.json()).token);
  }, { email: EMAIL, password: PASSWORD });
  await page.goto(BASE_URL);

  await page.evaluate(async () => {
    const headers = { authorization: `Bearer ${localStorage.getItem("agentweb.token")}` };
    const { sessions } = await (await fetch("/api/sessions", { headers })).json();
    await Promise.all(sessions.map((s) => fetch(`/api/sessions/${s.id}`, { method: "DELETE", headers })));
  });
  await page.goto(BASE_URL);

  await page.getByTestId("new-session").click();
  await page.getByTestId("ns-title").fill("primes");
  await page.getByTestId("ns-create").click();
  await page.getByTestId("composer").waitFor({ timeout: 60_000 });

  await page.getByTestId("open-terminal").click();
  const term = page.getByTestId("shell-terminal");
  await term.waitFor({ timeout: 60_000 });
  if ((await term.getAttribute("data-state")) !== "open") await page.getByTestId("shell-new").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="shell-terminal"]')?.getAttribute("data-state") === "open",
    undefined,
    { timeout: 60_000 },
  );
  await page.getByTestId("shell-terminal").click();
  await page.waitForTimeout(1_500);

  for (const line of SCRIPT) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(/python3|printf|ls /.test(line) ? 2_500 : 1_200);
  }
  await page.waitForTimeout(1_500);

  const shellText = await page.locator("body").innerText();

  if (!shellText.includes("[2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47]")) {
    throw new Error("the terminal did not produce the expected output — refusing to publish an idle shell");
  }

  if (await page.getByTestId("msg-assistant").count() > 0) {
    throw new Error("an assistant message is visible — this hero is supposed to contain no generated prose");
  }

  const leak = shellText
    .split("\n")
    .find((l) => (l.includes("@") && !l.includes("@example")) || /[A-Za-z0-9_.-]+:[~/]/.test(l));
  if (leak) throw new Error(`identity visible in the frame: ${leak.trim()}`);
  if (pageErrors.length) throw new Error(`page errors during capture: ${pageErrors.join("; ")}`);

  const out = path.join(OUT_DIR, `session-${scheme}.png`);
  await page.screenshot({ path: out });
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  console.log(`[${scheme}] wrote ${path.relative(process.cwd(), out)} (${width * 2}x${height * 2})`);
  await page.close();
  return { width: width * 2, height: height * 2 };
}

const light = await capture("light");
const dark = await capture("dark");
await browser.close();
if (light.width !== dark.width || light.height !== dark.height) {
  throw new Error("light and dark captures differ in size; Landing.tsx declares one intrinsic size for both");
}
console.log(`\nSet SHOTS.session in web/src/auth/Landing.tsx to { w: ${light.width}, h: ${light.height} }`);
