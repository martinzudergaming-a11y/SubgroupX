import inspector from "node:inspector";
import fs from "node:fs";
import path from "node:path";

interface CpuCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface CpuNode {
  id: number;
  callFrame: CpuCallFrame;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
}

export interface SamplingHeapProfileNode {
  callFrame: CpuCallFrame;
  selfSize: number;
  id: number;
  children: SamplingHeapProfileNode[];
}

export interface SamplingHeapProfile {
  head: SamplingHeapProfileNode;
  samples?: { size: number; nodeId: number; ordinal: number }[];
}

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function post(session: inspector.Session, method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result as Record<string, unknown>));
  });
}

export async function captureCpuProfile(outputPath: string, work: () => Promise<void> | void): Promise<CpuProfile> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const session = new inspector.Session();
  session.connect();
  try {
    await post(session, "Profiler.enable");
    await post(session, "Profiler.start");
    await work();
    const result = await post(session, "Profiler.stop");
    const profile = result.profile as CpuProfile;
    fs.writeFileSync(outputPath, JSON.stringify(profile));
    return profile;
  } finally {
    session.disconnect();
  }
}

interface FlameNode {
  name: string;
  detail: string;
  weight: number;
  self: number;
  children: Map<string, FlameNode>;
}

function frameInfo(frame: CpuCallFrame): { key: string; name: string; detail: string } {
  const name = frame.functionName || "(anonymous)";
  const file = frame.url ? frame.url.split("/").pop() : frame.scriptId === "0" ? "native" : "unknown";
  const detail = `${name} — ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
  return { key: `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${name}`, name, detail };
}

function colorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  const hue = 22 + (Math.abs(hash) % 38);
  const light = 62 + (Math.abs(hash >> 8) % 15);
  return `hsl(${hue} 78% ${light}%)`;
}

export function summarizeCpuProfile(profile: CpuProfile, limit = 24): {
  sampledMs: number;
  samples: number;
  topSelf: { name: string; detail: string; selfMs: number; pct: number }[];
} {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let total = 0;
  for (let index = 0; index < samples.length; index++) {
    const delta = deltas[index] ?? 0;
    total += delta;
    self.set(samples[index], (self.get(samples[index]) ?? 0) + delta);
  }
  const topSelf = [...self.entries()]
    .map(([id, micros]) => {
      const frame = byId.get(id)?.callFrame;
      const info = frame ? frameInfo(frame) : { name: `node ${id}`, detail: `node ${id}` };
      return { name: info.name, detail: info.detail, selfMs: micros / 1_000, pct: total ? (micros / total) * 100 : 0 };
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit);
  return { sampledMs: total / 1_000, samples: samples.length, topSelf };
}

export function writeCpuFlamegraph(profile: CpuProfile, outputPath: string, title: string): void {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

  const root: FlameNode = { name: title, detail: title, weight: 0, self: 0, children: new Map() };
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let maxDepth = 1;

  for (let index = 0; index < samples.length; index++) {
    const delta = deltas[index] ?? 0;
    if (delta <= 0) continue;
    const stack: CpuNode[] = [];
    let id: number | undefined = samples[index];
    while (id != null) {
      const node = byId.get(id);
      if (!node) break;
      stack.push(node);
      id = parent.get(id);
    }
    stack.reverse();
    root.weight += delta;
    let current = root;
    let depth = 0;
    for (const node of stack) {
      const info = frameInfo(node.callFrame);
      if (info.name === "(root)" || info.name === "(program)" || info.name === "(idle)") continue;
      let child = current.children.get(info.key);
      if (!child) {
        child = { name: info.name, detail: info.detail, weight: 0, self: 0, children: new Map() };
        current.children.set(info.key, child);
      }
      child.weight += delta;
      current = child;
      depth++;
    }
    current.self += delta;
    maxDepth = Math.max(maxDepth, depth);
  }

  const width = 1_600;
  const rowHeight = 22;
  const top = 46;
  const height = top + (maxDepth + 1) * rowHeight + 24;
  const elements: string[] = [];

  const layout = (node: FlameNode, x: number, y: number, w: number, depth: number): void => {
    const children = [...node.children.values()].sort((a, b) => b.weight - a.weight);
    let cursor = x;
    for (const child of children) {
      const childWidth = node.weight > 0 ? w * (child.weight / node.weight) : 0;
      if (childWidth < 0.35) { cursor += childWidth; continue; }
      const pct = root.weight ? (child.weight / root.weight) * 100 : 0;
      const tooltip = `${child.detail}\n${(child.weight / 1_000).toFixed(2)} ms total (${pct.toFixed(2)}%)\n${(child.self / 1_000).toFixed(2)} ms self`;
      elements.push(
        `<g><title>${escapeXml(tooltip)}</title><rect x="${cursor.toFixed(2)}" y="${(y + depth * rowHeight).toFixed(2)}" width="${Math.max(0, childWidth - 0.5).toFixed(2)}" height="${rowHeight - 1}" rx="2" fill="${colorFor(child.name)}"/>`
        + (childWidth > 38 ? `<text x="${(cursor + 4).toFixed(2)}" y="${(y + depth * rowHeight + 15).toFixed(2)}" font-size="11" fill="#2c2118">${escapeXml(child.name.slice(0, Math.max(3, Math.floor(childWidth / 7))))}</text>` : "")
        + `</g>`,
      );
      layout(child, cursor, y, childWidth, depth + 1);
      cursor += childWidth;
    }
  };
  layout(root, 0, top, width, 0);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fbfaf6"/>
  <text x="16" y="24" font-family="ui-sans-serif,system-ui" font-size="16" font-weight="700" fill="#28241e">${escapeXml(title)}</text>
  <text x="16" y="39" font-family="ui-monospace,monospace" font-size="10" fill="#82796c">aggregate sampled CPU · width = total time · hover for total/self</text>
  <g font-family="ui-monospace,SFMono-Regular,monospace">${elements.join("")}</g>
</svg>`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, svg);
}

function heapNodeWeight(node: SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + heapNodeWeight(child), 0);
}

export function summarizeHeapSamplingProfile(profile: SamplingHeapProfile, limit = 24): {
  sampledBytes: number;
  topSelf: { name: string; detail: string; selfBytes: number; pct: number }[];
} {
  const rows: { name: string; detail: string; selfBytes: number }[] = [];
  const walk = (node: SamplingHeapProfileNode): void => {
    const info = frameInfo(node.callFrame);
    if (node.selfSize > 0) rows.push({ name: info.name, detail: info.detail, selfBytes: node.selfSize });
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  const sampledBytes = rows.reduce((sum, row) => sum + row.selfBytes, 0);
  return {
    sampledBytes,
    topSelf: rows
      .sort((a, b) => b.selfBytes - a.selfBytes)
      .slice(0, limit)
      .map((row) => ({ ...row, pct: sampledBytes ? (row.selfBytes / sampledBytes) * 100 : 0 })),
  };
}

export function writeHeapSamplingFlamegraph(
  profile: SamplingHeapProfile,
  outputPath: string,
  title: string,
): void {
  const total = heapNodeWeight(profile.head);
  let maxDepth = 1;
  const depthOf = (node: SamplingHeapProfileNode, depth: number): void => {
    if (heapNodeWeight(node) > 0) maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) depthOf(child, depth + 1);
  };
  depthOf(profile.head, 0);

  const width = 1_600;
  const rowHeight = 22;
  const top = 46;
  const height = top + (maxDepth + 1) * rowHeight + 24;
  const elements: string[] = [];

  const layout = (node: SamplingHeapProfileNode, x: number, w: number, depth: number): void => {
    const nodeWeight = heapNodeWeight(node);
    const children = [...node.children]
      .map((child) => ({ child, weight: heapNodeWeight(child) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    let cursor = x;
    for (const { child, weight } of children) {
      const childWidth = nodeWeight > 0 ? w * (weight / nodeWeight) : 0;
      if (childWidth < 0.35) { cursor += childWidth; continue; }
      const info = frameInfo(child.callFrame);
      const pct = total ? (weight / total) * 100 : 0;
      const tooltip = `${info.detail}\n${(weight / 1024 / 1024).toFixed(2)} MiB retained/sample subtree (${pct.toFixed(2)}%)\n${(child.selfSize / 1024 / 1024).toFixed(2)} MiB self`;
      elements.push(
        `<g><title>${escapeXml(tooltip)}</title><rect x="${cursor.toFixed(2)}" y="${(top + depth * rowHeight).toFixed(2)}" width="${Math.max(0, childWidth - 0.5).toFixed(2)}" height="${rowHeight - 1}" rx="2" fill="${colorFor(info.name)}"/>`
        + (childWidth > 38 ? `<text x="${(cursor + 4).toFixed(2)}" y="${(top + depth * rowHeight + 15).toFixed(2)}" font-size="11" fill="#2c2118">${escapeXml(info.name.slice(0, Math.max(3, Math.floor(childWidth / 7))))}</text>` : "")
        + `</g>`,
      );
      layout(child, cursor, childWidth, depth + 1);
      cursor += childWidth;
    }
  };
  layout(profile.head, 0, width, 0);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fbfaf6"/>
  <text x="16" y="24" font-family="ui-sans-serif,system-ui" font-size="16" font-weight="700" fill="#28241e">${escapeXml(title)}</text>
  <text x="16" y="39" font-family="ui-monospace,monospace" font-size="10" fill="#82796c">sampled browser allocations · width = sampled bytes · hover for subtree/self</text>
  <g font-family="ui-monospace,SFMono-Regular,monospace">${elements.join("")}</g>
</svg>`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, svg);
}
