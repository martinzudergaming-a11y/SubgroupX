import crypto from "node:crypto";
import { errorMessage } from "../foundation/errors.ts";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { PORT } from "../config.ts";
import { db, statusSampleDao, statusIncidentDao, type StatusSampleRow } from "../persistence/index.ts";
import { boundedRuntimeClient } from "../runtime/runtime-client.ts";
import { aggregatePerf } from "./perf.ts";

const TICK_MS = 60_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_SAMPLE_ROWS = 200_000;
const API_ERROR_THRESHOLD = 0.2;
const API_WINDOW_MS = 15 * 60_000;
const API_MIN_SAMPLES = 5;
const OPEN_AFTER = 3;
const RESOLVE_AFTER = 2;

export type Criticality = "critical" | "important" | "informational";
export type ComponentStatus = "operational" | "degraded" | "partial_outage" | "major_outage";

export interface ComponentDef {
  key: string;
  label: string;
  description: string;
  criticality: Criticality;
}

const GRAFANA_HEALTH_URL = process.env.AGENT_WEB_GRAFANA_HEALTH_URL || "";

const SEARCH_PROBE_EVERY_TICKS = Number(process.env.AGENT_WEB_SEARCH_PROBE_EVERY_TICKS) || 30;

export const COMPONENTS: ComponentDef[] = [
  { key: "web", label: "Web App", description: "HTTP app & UI serving", criticality: "critical" },
  { key: "api", label: "Model API", description: "AI response availability", criticality: "important" },
  { key: "sandbox", label: "Sandbox", description: "Code execution environment", criticality: "important" },
  { key: "database", label: "Database", description: "Session & state storage", criticality: "critical" },
  ...(GRAFANA_HEALTH_URL
    ? [{ key: "grafana", label: "Monitoring", description: "Metrics & dashboards", criticality: "informational" as Criticality }]
    : []),
  ...(process.env.EXA_API_KEY
    ? [{ key: "search", label: "Search API", description: "Web search availability", criticality: "informational" as Criticality }]
    : []),
];

interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  detail: Record<string, unknown>;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

function now(): number {
  return Date.now();
}

async function probeWeb(): Promise<ProbeResult> {
  const t0 = now();
  return new Promise<ProbeResult>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 4000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const ok = res.statusCode === 200 && body.includes('"ok":true');
        resolve({ ok, latencyMs: now() - t0, detail: { status: res.statusCode } });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, latencyMs: now() - t0, detail: { error: "timeout" } });
    });
    req.on("error", (e) => resolve({ ok: false, latencyMs: now() - t0, detail: { error: e.message } }));
  });
}

function probeDatabase(): ProbeResult {
  const t0 = now();
  try {
    db.prepare("SELECT 1 AS ok").get();
    return { ok: true, latencyMs: now() - t0, detail: {} };
  } catch (e) {
    return { ok: false, latencyMs: now() - t0, detail: { error: errorMessage(e) } };
  }
}

async function probeSandbox(): Promise<ProbeResult> {
  const t0 = now();
  const { e2b } = await boundedRuntimeClient.getExecutorAvailability();
  const detail: Record<string, unknown> = { e2bAdmissionAvailable: e2b.available, e2bReason: e2b.reason };
  const ok = await new Promise<boolean>((resolve) => {
    let done = false;
    const child = spawn("/bin/sh", ["-c", ":"], { stdio: "ignore" });
    const kill = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGKILL");
        resolve(false);
      }
    }, 4000);
    child.on("error", () => {
      if (!done) {
        done = true;
        clearTimeout(kill);
        resolve(false);
      }
    });
    child.on("exit", (code) => {
      if (!done) {
        done = true;
        clearTimeout(kill);
        resolve(code === 0);
      }
    });
  });
  return { ok, latencyMs: now() - t0, detail };
}

export function probeApi(): ProbeResult {
  const report = aggregatePerf(API_WINDOW_MS);
  const top = report.models[0];
  const detail: Record<string, unknown> = {
    turns: report.totalTurns,
    errorRate: Number(report.errorRate.toFixed(3)),
    ttftP50: top?.ttftP50 ?? null,
    ttftP95: top?.ttftP95 ?? null,
  };
  const ok = report.totalTurns < API_MIN_SAMPLES || report.errorRate <= API_ERROR_THRESHOLD;
  return { ok, latencyMs: top?.totalP50 ?? null, detail };
}

async function probeGrafana(): Promise<ProbeResult> {
  const t0 = now();
  let url: URL;
  try {
    url = new URL(GRAFANA_HEALTH_URL);
  } catch {
    return { ok: false, latencyMs: null, detail: { error: "bad GRAFANA_HEALTH_URL" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, latencyMs: null, detail: { error: "unsupported protocol" } };
  }
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;
  return new Promise<ProbeResult>((resolve) => {
    const req = client.get(
      { host: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, timeout: 4000 },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          if (body.length < 4096) body += c;
        });
        res.on("end", () => {
          const ok = res.statusCode === 200 && /"database":\s*"ok"/.test(body);
          resolve({ ok, latencyMs: now() - t0, detail: { status: res.statusCode } });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, latencyMs: now() - t0, detail: { error: "timeout" } });
    });
    req.on("error", (e) => resolve({ ok: false, latencyMs: now() - t0, detail: { error: e.message } }));
  });
}

async function probeSearch(): Promise<ProbeResult> {
  const key = process.env.EXA_API_KEY;
  if (!key) return { ok: false, latencyMs: null, detail: { error: "no key" } };
  const t0 = now();
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ query: "status probe", numResults: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.text().catch(() => "");
    return { ok: res.status === 200, latencyMs: now() - t0, detail: { status: res.status } };
  } catch (e) {
    return { ok: false, latencyMs: now() - t0, detail: { error: errorMessage(e) } };
  }
}

async function probeComponent(key: string): Promise<ProbeResult> {
  switch (key) {
    case "web":
      return probeWeb();
    case "database":
      return probeDatabase();
    case "sandbox":
      return probeSandbox();
    case "api":
      return probeApi();
    case "grafana":
      return probeGrafana();
    case "search":
      return probeSearch();
    default:
      return { ok: false, latencyMs: null, detail: { error: "unknown component" } };
  }
}

function trailingFailures(component: string, window: number): number {
  const rows = db
    .prepare("SELECT ok FROM status_samples WHERE component = ? ORDER BY ts DESC LIMIT ?")
    .all(component, window) as unknown as { ok: number }[];
  let n = 0;
  for (const r of rows) {
    if (r.ok === 0) n++;
    else break;
  }
  return n;
}

function trailingSuccesses(component: string, window: number): number {
  const rows = db
    .prepare("SELECT ok FROM status_samples WHERE component = ? ORDER BY ts DESC LIMIT ?")
    .all(component, window) as unknown as { ok: number }[];
  let n = 0;
  for (const r of rows) {
    if (r.ok === 1) n++;
    else break;
  }
  return n;
}

export function evaluateIncident(def: ComponentDef, ts: number): void {
  const open = statusIncidentDao.openFor(def.key);
  if (!open && trailingFailures(def.key, OPEN_AFTER) >= OPEN_AFTER) {
    const severity = def.criticality === "critical" ? "major" : def.criticality === "important" ? "partial" : "minor";
    statusIncidentDao.open({
      id: "inc_" + crypto.randomUUID(),
      component: def.key,
      started_at: ts,
      resolved_at: null,
      severity,
      summary: `${def.label} health checks failing`,
    });
  } else if (open && trailingSuccesses(def.key, RESOLVE_AFTER) >= RESOLVE_AFTER) {
    statusIncidentDao.resolve(open.id, ts);
  }
}

let lastPruneAt = 0;
function maybePrune(ts: number): void {
  if (ts - lastPruneAt < 60 * 60_000) return;
  lastPruneAt = ts;
  try {
    statusSampleDao.prune(ts - RETENTION_MS, MAX_SAMPLE_ROWS);
    statusIncidentDao.prune(ts - RETENTION_MS);
  } catch (e) {
    console.error("[status] prune failed:", e instanceof Error ? e.message : e);
  }
}

let tickCount = 0;
async function tick(): Promise<void> {
  const ts = now();
  const thisTick = tickCount++;
  for (const def of COMPONENTS) {
    if (def.key === "api") continue;
    if (def.key === "search" && thisTick % SEARCH_PROBE_EVERY_TICKS !== 0) continue;
    let result: ProbeResult;
    try {
      result = await probeComponent(def.key);
    } catch (e) {
      result = { ok: false, latencyMs: null, detail: { error: errorMessage(e) } };
    }
    const row: StatusSampleRow = {
      id: "ss_" + crypto.randomUUID(),
      ts,
      component: def.key,
      ok: result.ok ? 1 : 0,
      latency_ms: result.latencyMs != null ? Math.round(result.latencyMs) : null,
      detail_json: safeJson(result.detail),
    };
    try {
      statusSampleDao.add(row);
      evaluateIncident(def, ts);
    } catch (e) {
      console.error(`[status] sample write failed (${def.key}):`, e instanceof Error ? e.message : e);
    }
  }
  maybePrune(ts);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export function startStatusProber(): void {
  if (started) return;
  started = true;
  setTimeout(() => void tick().catch((e) => console.error("[status] tick failed:", e)), 3000);
  timer = setInterval(() => void tick().catch((e) => console.error("[status] tick failed:", e)), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
