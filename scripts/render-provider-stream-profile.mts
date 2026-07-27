import fs from "node:fs";
import path from "node:path";

type Row = Record<string, unknown> & {
  kind: string;
  model: string;
  provider?: string;
  passed?: boolean;
  endToResultMs?: number | null;
  firstTextMs?: number | null;
  firstArgumentMs?: number | null;
};

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "docs/pr/responses-terminal-tail");
const readJsonl = (name: string): Row[] =>
  fs.readFileSync(path.join(outDir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const before = readJsonl("before.jsonl");
const after = readJsonl("after.jsonl");
const replay = JSON.parse(fs.readFileSync(path.join(outDir, "exact-capture-replay.json"), "utf8"));

const modelOrder = ["operator-model", "operator-model-a", "operator-model-b", "vendor-model-flash", "vendor-model-pro"];
const modelLabel: Record<string, string> = {
  "operator-model": "Operator Model",
  "operator-model-a": "Operator Model A",
  "operator-model-b": "Operator Model B",
  "vendor-model-flash": "DeepSeek V4 Flash",
  "vendor-model-pro": "DeepSeek V4 Pro",
};
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const successes = (rows: Row[], model: string, kind: string): Row[] =>
  rows.filter((row) => row.passed === true && row.model === model && row.kind === kind);
const attempts = (rows: Row[], model: string, kind: string): Row[] =>
  rows.filter((row) => row.model === model && row.kind === kind);

function aggregate(rows: Row[], models: string[]) {
  return models.flatMap((model) => ["text", "tool"].map((kind) => {
    const good = successes(rows, model, kind);
    const firstKey = kind === "text" ? "firstTextMs" : "firstArgumentMs";
    const first = good.map((row) => row[firstKey]).filter(finite);
    const tail = good.map((row) => row.endToResultMs).filter(finite);
    const all = attempts(rows, model, kind);
    return {
      provider: good[0]?.provider ?? all[0]?.provider ?? "0AI-jail",
      model,
      kind,
      attempts: all.length,
      successes: good.length,
      failures: all.length - good.length,
      firstOutputMs: { min: quantile(first, 0), p50: median(first), p90: quantile(first, 0.9), max: quantile(first, 1) },
      contentEndToResultMs: { min: quantile(tail, 0), p50: median(tail), p90: quantile(tail, 0.9), max: quantile(tail, 1) },
    };
  }));
}

const summary = {
  methodology: {
    reasoningEffort: "medium",
    successfulSamplesPerBeforeCell: "4–5",
    successfulSamplesPerAfterCell: 3,
    note: "Attempts that failed before a valid stream are counted separately and excluded from latency percentiles.",
  },
  before: aggregate(before, modelOrder),
  afterTerminalPatch: aggregate(after, modelOrder.slice(0, 3)),
  exactCapturedReplay: replay,
};
fs.writeFileSync(path.join(outDir, "benchmark.json"), `${JSON.stringify(summary, null, 2)}\n`);

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const fmt = (ms: number | null): string => ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s` : `${Math.round(ms)}ms`;
const shell = (w: number, h: number, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
  <rect width="${w}" height="${h}" fill="#F7F5EF"/>
  <style>
    text{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#292A27}
    .title{font-size:25px;font-weight:650;letter-spacing:-.35px}.sub{font-size:13px;fill:#77776F}
    .label{font-size:14px;font-weight:560}.tick{font-size:12px;fill:#8B8A82}.value{font-size:12px;font-weight:620}
  </style>
  ${body}
</svg>\n`;

{
  const width = 1280;
  const height = 660;
  const panels = [{ kind: "text", title: "Text response" }, { kind: "tool", title: "Function arguments" }];
  const maxMs = 11_000;
  let body = `<text class="title" x="48" y="48">First meaningful output latency</text>
  <text class="sub" x="48" y="73">Controlled medium-reasoning probes · dots are successful requests · bar is median</text>`;
  for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
    const panel = panels[panelIndex];
    const x0 = 180 + panelIndex * 625;
    const x1 = x0 + 385;
    body += `<text class="label" x="${x0 - 132}" y="112">${panel.title}</text>`;
    for (let tick = 0; tick <= 10_000; tick += 2_000) {
      const x = x0 + (tick / maxMs) * (x1 - x0);
      body += `<line x1="${x}" y1="126" x2="${x}" y2="586" stroke="#E1DED5" stroke-width="1"/>`;
      body += `<text class="tick" x="${x}" y="610" text-anchor="middle">${tick / 1000}s</text>`;
    }
    modelOrder.forEach((model, rowIndex) => {
      const y = 160 + rowIndex * 86;
      const rows = successes(before, model, panel.kind);
      const key = panel.kind === "text" ? "firstTextMs" : "firstArgumentMs";
      const values = rows.map((row) => row[key]).filter(finite);
      const med = median(values);
      const color = model.startsWith("deepseek") ? "#52766C" : "#B66E35";
      body += `<text class="label" x="${x0 - 132}" y="${y + 5}">${esc(modelLabel[model])}</text>`;
      body += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#E5E2D9"/>`;
      values.forEach((value, i) => {
        const x = x0 + Math.min(value, maxMs) / maxMs * (x1 - x0);
        const jitter = [-8, -4, 0, 4, 8][i % 5];
        body += `<circle cx="${x}" cy="${y + jitter}" r="4.5" fill="${color}" fill-opacity=".42"/>`;
      });
      if (med !== null) {
        const x = x0 + Math.min(med, maxMs) / maxMs * (x1 - x0);
        body += `<line x1="${x}" y1="${y - 14}" x2="${x}" y2="${y + 14}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
        const valueX = Math.min(x + 8, x1 - 2);
        const anchor = valueX >= x1 - 4 ? "end" : "start";
        body += `<text class="value" x="${valueX}" y="${y - 18}" text-anchor="${anchor}" fill="${color}">${fmt(med)}</text>`;
      }
    });
  }
  body += `<text class="sub" x="48" y="642">Sol commonly arrived as one buffered delta; latency is not equivalent to streaming smoothness.</text>`;
  fs.writeFileSync(path.join(outDir, "ttft-comparison.svg"), shell(width, height, body));
}

{
  const width = 1280;
  const height = 690;
  const x0 = 315;
  const x1 = 1110;
  const max = 100_000;
  const xFor = (ms: number): number => x0 + Math.log10(ms + 1) / Math.log10(max + 1) * (x1 - x0);
  let body = `<text class="title" x="48" y="48">Completed output → adapter result</text>
  <text class="sub" x="48" y="73">Log scale · orange before (waited for HTTP EOF) · green after (returns on response.completed)</text>`;
  [1, 10, 100, 1_000, 10_000, 100_000].forEach((tick) => {
    const x = xFor(tick);
    body += `<line x1="${x}" y1="112" x2="${x}" y2="604" stroke="#E1DED5"/>`;
    body += `<text class="tick" x="${x}" y="630" text-anchor="middle">${fmt(tick)}</text>`;
  });
  let rowIndex = 0;
  for (const model of modelOrder.slice(0, 3)) {
    for (const kind of ["text", "tool"]) {
      const y = 140 + rowIndex * 76;
      const beforeValues = successes(before, model, kind).map((row) => row.endToResultMs).filter(finite);
      const afterValues = successes(after, model, kind).map((row) => row.endToResultMs).filter(finite);
      const beforeMed = median(beforeValues);
      const afterMed = median(afterValues);
      body += `<text class="label" x="48" y="${y + 4}">${esc(modelLabel[model])}</text>`;
      body += `<text class="tick" x="202" y="${y + 4}">${kind === "text" ? "text" : "tool"}</text>`;
      body += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#E5E2D9"/>`;
      beforeValues.forEach((value, i) => body += `<circle cx="${xFor(value)}" cy="${y - 9 + (i % 3) * 3}" r="4.5" fill="#C36F3B" fill-opacity=".48"/>`);
      afterValues.forEach((value, i) => body += `<circle cx="${xFor(value)}" cy="${y + 9 - (i % 3) * 3}" r="4.5" fill="#3E8068" fill-opacity=".58"/>`);
      if (beforeMed !== null) body += `<line x1="${xFor(beforeMed)}" y1="${y - 17}" x2="${xFor(beforeMed)}" y2="${y - 2}" stroke="#A9532E" stroke-width="3"/>`;
      if (afterMed !== null) body += `<line x1="${xFor(afterMed)}" y1="${y + 2}" x2="${xFor(afterMed)}" y2="${y + 17}" stroke="#2D6D59" stroke-width="3"/>`;
      body += `<text class="value" x="${x1 + 14}" y="${y - 5}" fill="#A9532E">${fmt(beforeMed)}</text>`;
      body += `<text class="value" x="${x1 + 14}" y="${y + 13}" fill="#2D6D59">${fmt(afterMed)}</text>`;
      rowIndex++;
    }
  }
  body += `<text class="sub" x="48" y="670">Successful samples only. Before n=4–5/cell; after n=3/cell. Failed capacity attempts are reported in benchmark.json.</text>`;
  fs.writeFileSync(path.join(outDir, "terminal-tail-before-after.svg"), shell(width, height, body));
}

{
  const width = 1280;
  const height = 400;
  const timings = replay.timingsMs as Record<string, number>;
  const x0 = 72;
  const x1 = 1208;
  const max = 65_000;
  const xFor = (ms: number) => x0 + ms / max * (x1 - x0);
  const segments = [
    [0, timings.headers, "Request → headers", "#B9B8B0"],
    [timings.headers, timings.firstVisible, "Headers → first output", "#7E9CAA"],
    [timings.firstVisible, timings.responseCompleted, "Model output", "#55756C"],
    [timings.responseCompleted, timings.httpEof, "Completed, but adapter still waiting", "#C96A4A"],
  ] as const;
  let body = `<text class="title" x="48" y="48">Exact captured Luna request replay</text>
  <text class="sub" x="48" y="73">516 KiB request · 136,246 input tokens · installed pi-ai 0.80.10 before patch</text>`;
  for (let tick = 0; tick <= 60_000; tick += 10_000) {
    const x = xFor(tick);
    body += `<line x1="${x}" y1="118" x2="${x}" y2="248" stroke="#E1DED5"/>`;
    body += `<text class="tick" x="${x}" y="272" text-anchor="middle">${tick / 1000}s</text>`;
  }
  segments.forEach(([start, end, label, color], i) => {
    const x = xFor(start);
    const w = Math.max(2, xFor(end) - x);
    body += `<rect x="${x}" y="156" width="${w}" height="54" fill="${color}" rx="${i === 0 || i === segments.length - 1 ? 8 : 0}"/>`;
    if (w > 135) body += `<text x="${x + w / 2}" y="188" text-anchor="middle" font-size="13" font-weight="620" fill="#fff">${esc(label)}</text>`;
  });
  body += `<line x1="${xFor(timings.responseCompleted)}" y1="134" x2="${xFor(timings.responseCompleted)}" y2="226" stroke="#7F2F25" stroke-width="2"/>`;
  body += `<text class="value" x="${xFor(timings.responseCompleted) - 8}" y="126" text-anchor="end">response.completed · 38.846s</text>`;
  body += `<text x="48" y="326" font-size="22" font-weight="680" fill="#A44332">+21.839s false processing tail</text>`;
  body += `<text class="sub" x="48" y="352">The terminal event arrived 7ms after output_item.done; HTTP EOF and pi adapter return arrived together at 60.685s.</text>`;
  fs.writeFileSync(path.join(outDir, "exact-replay-waterfall.svg"), shell(width, height, body));
}

console.log(`rendered provider stream profile → ${path.relative(root, outDir)}`);
