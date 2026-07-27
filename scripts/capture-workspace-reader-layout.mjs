import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4319";
const VARIANT = process.env.VARIANT === "before" ? "before" : "after";
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? "docs/pr/workspace-reader-layout");
const VIEWPORTS = [
  { name: "wide", width: 1600, height: 1000 },
  { name: "compact", width: 1280, height: 800 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

function pdfText(lines) {
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  return Buffer.from([
    "BT",
    "/F1 22 Tf",
    "72 738 Td",
    `(${escaped[0]}) Tj`,
    "/F1 11 Tf",
    ...escaped.slice(1).flatMap((line) => ["0 -25 Td", `(${line}) Tj`]),
    "ET",
  ].join("\n"), "ascii");
}

function readerPdfFixture() {
  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let length = chunks[0].length;
  const object = (id, body) => {
    offsets[id] = length;
    const head = Buffer.from(`${id} 0 obj\n`, "ascii");
    const data = typeof body === "string" ? Buffer.from(body, "ascii") : body;
    const tail = Buffer.from("\nendobj\n", "ascii");
    chunks.push(head, data, tail);
    length += head.length + data.length + tail.length;
  };
  const pageLines = [
    [
      "Workspace Reader Layout",
      "A calm document surface should begin near the top of the window.",
      "Navigation belongs beside the document, not in stacked toolbars above it.",
      "A wider canvas improves diagrams, tables, code, and side-by-side review.",
      "The conversation remains readable while the artifact receives real working space.",
      "Controls stay close to what they affect and yield before content does.",
      "This synthetic document contains no user or production data.",
    ],
    ["Responsive Workbench", "The second page verifies continuous document scrolling.", "Reader state survives resizing and page navigation."],
    ["Quiet Chrome", "The final page keeps the same bounded rendering path.", "Only the information needed for the current task remains visible."],
  ];
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R 6 0 R 8 0 R] /Count 3 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  const first = pdfText(pageLines[0]);
  object(4, Buffer.concat([Buffer.from(`<< /Length ${first.length} >>\nstream\n`, "ascii"), first, Buffer.from("\nendstream", "ascii")]));
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  object(6, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>");
  const second = pdfText(pageLines[1]);
  object(7, Buffer.concat([Buffer.from(`<< /Length ${second.length} >>\nstream\n`, "ascii"), second, Buffer.from("\nendstream", "ascii")]));
  object(8, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>");
  const third = pdfText(pageLines[2]);
  object(9, Buffer.concat([Buffer.from(`<< /Length ${third.length} >>\nstream\n`, "ascii"), third, Buffer.from("\nendstream", "ascii")]));
  const padding = Buffer.alloc(700 * 1024, 0x20);
  object(10, Buffer.concat([Buffer.from(`<< /Length ${padding.length} >>\nstream\n`, "ascii"), padding, Buffer.from("\nendstream", "ascii")]));
  const xref = length;
  const rows = ["xref", "0 11", "0000000000 65535 f ", ...Array.from({ length: 10 }, (_, index) => `${String(offsets[index + 1]).padStart(10, "0")} 00000 n `)];
  chunks.push(Buffer.from(`${rows.join("\n")}\ntrailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}

async function auth(page) {
  await page.goto(BASE_URL);
  const token = await page.evaluate(async (email) => {
    const body = JSON.stringify({ email, password: "password123" });
    const headers = { "content-type": "application/json" };
    let response = await fetch("/api/auth/signup", { method: "POST", headers, body });
    if (!response.ok) response = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!response.ok) throw new Error(`auth failed: ${response.status}`);
    return (await response.json()).token;
  }, `workspace-reader-${VARIANT}@test.dev`);
  await page.evaluate((value) => {
    localStorage.setItem("agentweb.token", value);
    localStorage.setItem("oiia.locale", "en");
  }, token);
  return token;
}

async function api(page, token, method, route, body) {
  return page.evaluate(async ({ token, method, route, body }) => {
    const response = await fetch(`/api${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }, { token, method, route, body });
}

async function settle(page) {
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}" }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORTS[0], locale: "en-US", colorScheme: "light", reducedMotion: "reduce" });
const page = await context.newPage();
const token = await auth(page);
const { session } = await api(page, token, "POST", "/sessions", {
  title: "Reader layout study",
  provider: "mock",
  model: "mock-coder",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
});
await page.goto(`${BASE_URL}/s/${session.id}`);
await page.getByTestId("composer").waitFor();
await page.locator('input[type="file"]').setInputFiles({
  name: "workspace-reader-layout.pdf",
  mimeType: "application/pdf",
  buffer: readerPdfFixture(),
});
await page.getByTestId("composer").fill("Review the document layout and keep the reader open beside this conversation.");
await page.getByTestId("send").click();
await page.getByTestId("send").waitFor({ state: "visible" });
await page.getByTestId("msg-attachment").first().click();
await page.getByTestId("pdf-preview").waitFor();
await page.locator('[data-testid="pdf-canvas"][data-page-number="1"][data-ready="true"]').waitFor({ timeout: 20_000 });

const geometry = {};
for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await settle(page);
  geometry[viewport.name] = await page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    };
    const composer = document.querySelector('[data-testid="composer"]');
    return {
      main: rect('[data-testid="main-content"]'),
      fileView: rect('[data-testid="file-view"]'),
      pdf: rect('[data-testid="pdf-preview"]'),
      pdfToolbar: rect('[data-testid="pdf-toolbar"]'),
      pdfStage: rect('[data-testid="pdf-stage"]'),
      composerField: rect('[data-testid="composer"]'),
      composerSurface: composer?.parentElement ? (() => {
        const box = composer.parentElement.getBoundingClientRect();
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      })() : null,
    };
  });
  await page.screenshot({ path: path.join(OUT_DIR, `${VARIANT}-${viewport.name}.png`) });
}

fs.writeFileSync(path.join(OUT_DIR, `${VARIANT}-geometry.json`), `${JSON.stringify(geometry, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({ variant: VARIANT, geometry }, null, 2));
