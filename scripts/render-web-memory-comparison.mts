import fs from "node:fs";
import path from "node:path";

interface Sample {
  scenario: string;
  step: number;
  jsHeapUsedBytes: number;
  rendererRssBytes: number;
  gpuRssBytes: number;
  processRssBytes: number;
  nodes: number;
  jsEventListeners: number;
  resourceEntries: number;
}

interface ProfileSummary {
  fixture: Record<string, number>;
  workload: Record<string, number>;
  initialLoad: {
    highlightReadyMs: number;
    codeBlocks: number;
    highlightedBlocks: number;
    resourceEntries: number;
    rendererRssPeakBytes: number;
    processRssPeakBytes: number;
  };
}

const [beforeDir, afterDir, outputDir] = process.argv.slice(2);
if (!beforeDir || !afterDir || !outputDir) {
  throw new Error("usage: tsx scripts/render-web-memory-comparison.mts <before-dir> <after-dir> <output-dir>");
}

function readSamples(directory: string): Sample[] {
  return fs.readFileSync(path.join(directory, "web-memory-samples.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sample);
}

function readSummary(directory: string): ProfileSummary {
  return JSON.parse(fs.readFileSync(path.join(directory, "web-memory-summary.json"), "utf8")) as ProfileSummary;
}

const checkpoints = [
  { scenario: "session-warm-ab", step: 0, label: "cold" },
  { scenario: "session-warm-ab", step: 60, label: "A↔B 60" },
  { scenario: "session-cold-lru", step: 60, label: "LRU 60" },
  { scenario: "route-view-cycle", step: 60, label: "views 60" },
  { scenario: "panel-cycle", step: 60, label: "panels 60" },
] as const;

const beforeSamples = readSamples(beforeDir);
const afterSamples = readSamples(afterDir);
const beforeSummary = readSummary(beforeDir);
const afterSummary = readSummary(afterDir);
if (JSON.stringify(beforeSummary.fixture) !== JSON.stringify(afterSummary.fixture)) {
  throw new Error("before and after fixtures differ");
}
if (JSON.stringify(beforeSummary.workload) !== JSON.stringify(afterSummary.workload)) {
  throw new Error("before and after workloads differ");
}

function select(samples: Sample[]): Sample[] {
  return checkpoints.map(({ scenario, step }) => {
    const sample = samples.find((candidate) => candidate.scenario === scenario && candidate.step === step);
    if (!sample) throw new Error(`missing ${scenario}:${step}`);
    return sample;
  });
}

function mib(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

const before = select(beforeSamples);
const after = select(afterSamples);
const aggregate = {
  fixture: beforeSummary.fixture,
  workload: beforeSummary.workload,
  checkpoints: checkpoints.map((checkpoint, index) => ({
    label: checkpoint.label,
    before: {
      postGcHeapMiB: mib(before[index].jsHeapUsedBytes),
      rendererRssMiB: mib(before[index].rendererRssBytes),
      gpuRssMiB: mib(before[index].gpuRssBytes),
      chromiumRssMiB: mib(before[index].processRssBytes),
      domNodes: before[index].nodes,
      listeners: before[index].jsEventListeners,
    },
    after: {
      postGcHeapMiB: mib(after[index].jsHeapUsedBytes),
      rendererRssMiB: mib(after[index].rendererRssBytes),
      gpuRssMiB: mib(after[index].gpuRssBytes),
      chromiumRssMiB: mib(after[index].processRssBytes),
      domNodes: after[index].nodes,
      listeners: after[index].jsEventListeners,
    },
  })),
  initialLoad: {
    before: {
      highlightReadyMs: Number(beforeSummary.initialLoad.highlightReadyMs.toFixed(1)),
      resourceEntries: beforeSummary.initialLoad.resourceEntries,
      rendererRssPeakMiB: mib(beforeSummary.initialLoad.rendererRssPeakBytes),
      chromiumRssPeakMiB: mib(beforeSummary.initialLoad.processRssPeakBytes),
    },
    after: {
      highlightReadyMs: Number(afterSummary.initialLoad.highlightReadyMs.toFixed(1)),
      resourceEntries: afterSummary.initialLoad.resourceEntries,
      rendererRssPeakMiB: mib(afterSummary.initialLoad.rendererRssPeakBytes),
      chromiumRssPeakMiB: mib(afterSummary.initialLoad.processRssPeakBytes),
    },
  },
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "before-after.json"), `${JSON.stringify(aggregate, null, 2)}\n`);

const width = 1_440;
const left = 96;
const right = 34;
const top = 76;
const panelHeight = 124;
const gap = 34;
const panels = [
  { label: "Post-GC JS heap (MiB)", value: (sample: Sample) => sample.jsHeapUsedBytes / 1024 / 1024 },
  { label: "Renderer RSS (MiB)", value: (sample: Sample) => sample.rendererRssBytes / 1024 / 1024 },
  { label: "GPU RSS (MiB)", value: (sample: Sample) => sample.gpuRssBytes / 1024 / 1024 },
  { label: "All Chromium RSS (MiB)", value: (sample: Sample) => sample.processRssBytes / 1024 / 1024 },
  { label: "DOM nodes", value: (sample: Sample) => sample.nodes },
  { label: "JS event listeners", value: (sample: Sample) => sample.jsEventListeners },
] as const;
const height = top + panels.length * (panelHeight + gap) + 60;
const plotWidth = width - left - right;
const x = (index: number) => left + index * plotWidth / (checkpoints.length - 1);
const colors = { before: "#b15b42", after: "#367a62" };
const svg: string[] = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  `<rect x="0" y="0" width="${width}" height="${height}" fill="#fbfaf6"/>`,
  `<text x="24" y="30" font-family="ui-sans-serif,system-ui" font-size="20" font-weight="700" fill="#28241e">Browser memory: before / after</text>`,
  `<text x="24" y="50" font-family="ui-monospace,monospace" font-size="10" fill="#82796c">Major GC precedes every checkpoint. RSS is process memory, not JS heap.</text>`,
  `<circle cx="1120" cy="29" r="5" fill="${colors.before}"/><text x="1132" y="33" font-family="ui-sans-serif,system-ui" font-size="12" fill="#514a41">before</text>`,
  `<circle cx="1220" cy="29" r="5" fill="${colors.after}"/><text x="1232" y="33" font-family="ui-sans-serif,system-ui" font-size="12" fill="#514a41">after</text>`,
];

panels.forEach((panel, panelIndex) => {
  const panelTop = top + panelIndex * (panelHeight + gap);
  const values = [...before.map(panel.value), ...after.map(panel.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.14, max === min ? Math.max(1, max * 0.04) : 0);
  const low = Math.max(0, min - padding);
  const high = max + padding;
  const y = (value: number) => panelTop + panelHeight - (value - low) / Math.max(1e-9, high - low) * panelHeight;
  svg.push(`<rect x="${left}" y="${panelTop}" width="${plotWidth}" height="${panelHeight}" fill="#fff" stroke="#e8ebe3"/>`);
  svg.push(`<text x="24" y="${panelTop + 14}" font-family="ui-sans-serif,system-ui" font-size="11" font-weight="600" fill="#514a41">${panel.label}</text>`);
  svg.push(`<text x="${left - 8}" y="${panelTop + 4}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="#92877a">${high.toFixed(panelIndex < 4 ? 1 : 0)}</text>`);
  svg.push(`<text x="${left - 8}" y="${panelTop + panelHeight}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="#92877a">${low.toFixed(panelIndex < 4 ? 1 : 0)}</text>`);
  for (const [name, samples] of [["before", before], ["after", after]] as const) {
    const points = samples.map((sample, index) => `${x(index).toFixed(1)},${y(panel.value(sample)).toFixed(1)}`).join(" ");
    svg.push(`<polyline points="${points}" fill="none" stroke="${colors[name]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
    samples.forEach((sample, index) => svg.push(`<circle cx="${x(index).toFixed(1)}" cy="${y(panel.value(sample)).toFixed(1)}" r="3.5" fill="${colors[name]}"/>`));
  }
});

checkpoints.forEach((checkpoint, index) => {
  svg.push(`<text x="${x(index).toFixed(1)}" y="${height - 24}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="10" fill="#756b60">${checkpoint.label}</text>`);
});
svg.push(`</svg>`);
fs.writeFileSync(path.join(outputDir, "before-after.svg"), `${svg.join("\n")}\n`);

console.log(`wrote ${outputDir}`);
