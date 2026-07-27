import express from "express";
import { statusSampleDao, statusIncidentDao, type StatusIncidentRow } from "../persistence/index.ts";
import { COMPONENTS, type ComponentStatus, type Criticality } from "./prober.ts";
import { STATUS_PAGE_HTML } from "./status-page-html.ts";

const DAY_MS = 24 * 60 * 60_000;

const cache = new Map<string, { v: unknown; exp: number }>();
function cached<T>(key: string, ttlMs: number, build: () => T): T {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.v as T;
  const v = build();
  cache.set(key, { v, exp: now + ttlMs });
  return v;
}

function pct(ok: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((ok / total) * 10000) / 100;
}

function severityFor(crit: Criticality): ComponentStatus {
  return crit === "critical" ? "major_outage" : crit === "important" ? "partial_outage" : "degraded";
}

const RANK: Record<ComponentStatus, number> = {
  operational: 0,
  degraded: 1,
  partial_outage: 2,
  major_outage: 3,
};

function utcDays(days: number): string[] {
  const out: string[] = [];
  const today = Math.floor(Date.now() / DAY_MS);
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date((today - i) * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

function buildSummary() {
  return cached("summary", 15_000, () => {
    const latest = new Map(statusSampleDao.latestPerComponent().map((s) => [s.component, s]));
    const since90 = Date.now() - 90 * DAY_MS;
    const components = COMPONENTS.map((def) => {
      const last = latest.get(def.key);
      const status: ComponentStatus = !last ? "operational" : last.ok ? "operational" : severityFor(def.criticality);
      const buckets = new Map(statusSampleDao.dailyBuckets(def.key, since90).map((b) => [b.day, b]));
      const bars = utcDays(90).map((day) => {
        const b = buckets.get(day);
        return b && b.total > 0 ? { day, uptime: pct(b.ok, b.total) } : { day, uptime: null };
      });
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        criticality: def.criticality,
        status,
        latencyMs: def.key === "api" ? null : (last?.latency_ms ?? null),
        uptime: {
          d1: ratio(def.key, 1),
          d7: ratio(def.key, 7),
          d90: ratio(def.key, 90),
        },
        bars,
      };
    });
    const overall = components
      .filter((c) => c.criticality !== "informational")
      .reduce<ComponentStatus>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), "operational");
    return { updatedAt: Date.now(), overall, components };
  });
}

function ratio(component: string, days: number): number | null {
  const { ok, total } = statusSampleDao.uptimeSince(component, Date.now() - days * DAY_MS);
  return pct(ok, total);
}

function buildIncidents() {
  return cached("incidents", 15_000, () => {
    return statusIncidentDao.recent(50).map((i: StatusIncidentRow) => ({
      id: i.id,
      component: i.component,
      startedAt: i.started_at,
      resolvedAt: i.resolved_at,
      severity: i.severity,
      summary: i.summary,
    }));
  });
}

export function createStatusRouter(): express.Router {
  const r = express.Router();

  r.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /api/\nAllow: /$\n");
  });

  const sendJson = (res: express.Response, body: unknown) => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.json(body);
  };

  const safe = (res: express.Response, build: () => unknown, fallback: unknown) => {
    try {
      sendJson(res, build());
    } catch (e) {
      console.error("[status] endpoint failed:", e instanceof Error ? e.message : e);
      sendJson(res, fallback);
    }
  };

  r.get("/api/status/summary", (_req, res) =>
    safe(res, buildSummary, { updatedAt: Date.now(), overall: "unknown", components: [], error: true }));
  r.get("/api/status/incidents", (_req, res) => safe(res, buildIncidents, []));

  r.get(/.*/, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type("html").send(STATUS_PAGE_HTML);
  });

  return r;
}
