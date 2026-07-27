import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAPER = "#FBFCF8";
const FRAME = "#F1F4ED";
const INK = "#2A2C27";
const MUTED = "#8A8D83";
const HAIRLINE = "#E2E5DD";
const LIVE = "#22A06B";
const WORKING = "#C77D2E";
const INFO = "#6E87B0";

function plume() {
  return [
    { x: 76, y: 106, r: 28, c: WORKING, a: 1.00 },
    { x: 71, y: 89, r: 21, c: WORKING, a: 0.85 },
    { x: 79, y: 85,  r: 18, c: LIVE,    a: 0.90 },
    { x: 74, y: 72,  r: 15, c: LIVE,    a: 0.88 },
    { x: 80, y: 67,  r: 12, c: INFO,    a: 0.80 },
    { x: 75, y: 56,  r: 9,  c: INFO,    a: 0.78 },
    { x: 77, y: 46,  r: 5,  c: INFO,    a: 0.85 },
    { x: 76, y: 51,  r: 4,  c: LIVE,    a: 0.70 },
    { x: 88, y: 83,  r: 14, c: INFO,    a: 0.50 },
    { x: 66, y: 96, r: 14, c: WORKING, a: 0.68 },
  ]
    .map((b) => `<span style="--x:${b.x}%; --y:${b.y}%; --r:${b.r}%; --c:${b.c}; --a:${b.a}"></span>`)
    .join("");
}

function card({ kicker, title, subtitle, footL }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  body {
    background:${PAPER};
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { position:relative; width:1200px; height:630px; overflow:hidden; background:${PAPER}; }
  /* A whisper of the deeper frame tone at the edges, so the card has a boundary in a chat client
     that renders it on white without drawing an actual border. */
  .vignette { position:absolute; inset:0; background:
      linear-gradient(to bottom, ${FRAME} 0%, transparent 6%),
      linear-gradient(to top, ${FRAME} 0%, transparent 8%),
      linear-gradient(to right, ${FRAME} 0%, transparent 4%),
      linear-gradient(to left, ${FRAME} 0%, transparent 4%);
    opacity:.85; }

  .plume { position:absolute; inset:0; filter: blur(34px) saturate(1.8); }
  /* width in % of 1200 and height matched in px keeps every blob circular; a %/% pair would
     stretch them into the card's 1.9:1 and flatten the plume back into a smear. */
  .plume span { position:absolute; left:var(--x); top:var(--y);
    width:var(--r); aspect-ratio:1;
    transform: translate(-50%,-50%);
    background: radial-gradient(circle at 50% 50%, var(--c) 0%, color-mix(in oklab, var(--c) 55%, transparent) 42%, transparent 70%);
    opacity: var(--a); }

  .rule { position:absolute; left:64px; right:64px; height:1px; background:${HAIRLINE}; }
  .rule.top { top:96px; }

  .lab { position:absolute; font-size:12.5px; letter-spacing:.20em; text-transform:uppercase;
         font-weight:600; color:${MUTED}; }
  .lab.tl { left:64px; top:58px; }
  .lab.tr { right:64px; top:58px; }
  .lab.bl { left:64px; bottom:52px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
            letter-spacing:.14em; font-weight:500; }

  .stack { position:absolute; left:64px; top:168px; }
  .wordmark { font-size:104px; line-height:.92; letter-spacing:-.045em; font-weight:640; color:${INK}; }
  .sub { margin-top:20px; font-size:23px; line-height:1.35; letter-spacing:-.012em;
         color:#5D6058; max-width:620px; font-weight:420; }
</style></head><body>
  <div class="card">
    <div class="plume">${plume()}</div>
    <div class="vignette"></div>
    <div class="rule top"></div>
    <div class="lab tl">${kicker}</div>
    <div class="lab tr">${title}</div>
    <div class="stack">
      <div class="wordmark">oiia</div>
      <div class="sub">${subtitle}</div>
    </div>
    <div class="lab bl">${footL}</div>
  </div>
</body></html>`;
}

const CARDS = [
  {
    file: "og-home.png",
    kicker: "oiia",
    title: "Agents on your machines",
    subtitle: "Hosted agent sessions that execute wherever you point them — a cloud sandbox, a host over SSH, or a machine with no public IP.",
    footL: "CONNECTOR · SSH · E2B · LOCAL",
  },
  {
    file: "og-card.png",
    kicker: "oiia",
    title: "Shared conversation",
    subtitle: "A read-only snapshot of an agent session — the whole transcript, exactly as it ran.",
    footL: "READ-ONLY · SNAPSHOT",
  },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
for (const spec of CARDS) {
  await page.setContent(card(spec), { waitUntil: "load" });
  await page.waitForTimeout(120);
  const out = path.join(ROOT, "web/public", spec.file);
  await page.screenshot({ path: out });
  console.log(`wrote ${path.relative(ROOT, out)}`);
}
await browser.close();
