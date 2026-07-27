export type CanvasValue = string | number | boolean | string[];

export interface CanvasField {
  key: string;
  label: string;
  kind: string;
  value: CanvasValue;
}

interface Entry {
  title: string;
  baseline: Map<string, CanvasField>;
  latest: Map<string, CanvasField>;
  hasBaseline: boolean;
}

const store = new Map<string, Entry>();

const MAX_FIELDS = 200;
const MAX_LABEL = 80;
const MAX_VALUE = 200;

function clampStr(s: string, n: number): string {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) : s;
}
function clampValue(v: CanvasValue): CanvasValue {
  if (typeof v === "string") return clampStr(v, MAX_VALUE);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => (typeof x === "string" ? clampStr(x, MAX_VALUE) : x));
  return v;
}

function toMap(fields: CanvasField[]): Map<string, CanvasField> {
  const m = new Map<string, CanvasField>();
  for (const f of fields) {
    if (!f || typeof f.key !== "string") continue;
    if (m.size >= MAX_FIELDS) break;
    m.set(f.key, {
      key: clampStr(f.key, MAX_LABEL * 2),
      label: clampStr(f.label ?? "", MAX_LABEL),
      kind: clampStr(f.kind ?? "", 16),
      value: clampValue(f.value),
    });
  }
  return m;
}

export function reportCanvasSnapshot(id: string, title: string, phase: "init" | "update", fields: CanvasField[]): void {
  const snap = toMap(fields);
  let e = store.get(id);
  if (!e) {
    e = { title, baseline: new Map(), latest: new Map(), hasBaseline: false };
    store.set(id, e);
  }
  if (title) e.title = title;
  if (phase === "init" && e.hasBaseline) return;
  e.latest = snap;
  if (!e.hasBaseline) {
    e.baseline = snap;
    e.hasBaseline = true;
  }
}

export function forgetCanvas(id: string): void {
  store.delete(id);
}

export function clearCanvasStates(): void {
  store.clear();
}

function sameValue(a: CanvasValue, b: CanvasValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function phrase(kind: string, v: CanvasValue): string {
  if (typeof v === "boolean") return v ? (kind === "toggle" ? "on" : "true") : kind === "toggle" ? "off" : "false";
  if (Array.isArray(v)) return v.length ? v.map((x) => JSON.stringify(x)).join(", ") : "(none)";
  if (v === "") return '""';
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function cleanTitle(s: string): string {
  return clampStr((s || "").replace(/\s+/g, " ").trim(), MAX_LABEL);
}

export function collectCanvasDiffs(): string {
  const blocks: string[] = [];
  for (const e of store.values()) {
    if (!e.hasBaseline) continue;
    const changes: string[] = [];
    for (const [key, cur] of e.latest) {
      const prev = e.baseline.get(key);
      if (!prev) {
        changes.push(`- ${cur.label || key} (${cur.kind}): ${phrase(cur.kind, cur.value)} (new)`);
      } else if (!sameValue(prev.value, cur.value)) {
        changes.push(`- ${cur.label || key} (${cur.kind}): ${phrase(prev.kind, prev.value)} → ${phrase(cur.kind, cur.value)}`);
      }
    }
    if (changes.length) {
      const title = e.title ? ` "${cleanTitle(e.title)}"` : "";
      blocks.push(`User changes in canvas${title} (${changes.length} of ${e.latest.size} controls changed):\n${changes.join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}
