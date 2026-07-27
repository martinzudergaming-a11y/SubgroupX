import { perfSampleDao } from "../persistence/index.ts";

export interface TurnPerf {
  provider: string;
  model: string;
  ttftMs: number | null;
  totalMs: number | null;
  ok: boolean;
}

export function recordTurnPerf(p: TurnPerf): void {
  try {
    perfSampleDao.add({
      ts: Date.now(),
      provider: p.provider || "unknown",
      model: p.model || "unknown",
      ttft_ms: p.ttftMs != null && Number.isFinite(p.ttftMs) && p.ttftMs >= 0 ? Math.round(p.ttftMs) : null,
      total_ms: p.totalMs != null && Number.isFinite(p.totalMs) && p.totalMs >= 0 ? Math.round(p.totalMs) : null,
      ok: p.ok ? 1 : 0,
    });
  } catch (err) {
    console.error("[status] recordTurnPerf failed:", err instanceof Error ? err.message : err);
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
}

export interface ModelPerf {
  provider: string;
  model: string;
  turns: number;
  errorRate: number;
  ttftP50: number | null;
  ttftP95: number | null;
  totalP50: number | null;
  totalP95: number | null;
}

export interface PerfReport {
  windowMs: number;
  totalTurns: number;
  errorRate: number;
  models: ModelPerf[];
}

export function aggregatePerf(windowMs: number, limit = 20_000): PerfReport {
  const since = Date.now() - windowMs;
  const rows = perfSampleDao.since(since, limit);
  const byModel = new Map<string, { provider: string; model: string; ttft: number[]; total: number[]; errors: number; turns: number }>();
  let totalTurns = 0;
  let totalErrors = 0;
  for (const r of rows) {
    totalTurns++;
    if (!r.ok) totalErrors++;
    const key = `${r.provider} ${r.model}`;
    let m = byModel.get(key);
    if (!m) {
      m = { provider: r.provider, model: r.model, ttft: [], total: [], errors: 0, turns: 0 };
      byModel.set(key, m);
    }
    m.turns++;
    if (!r.ok) m.errors++;
    if (r.ok && r.ttft_ms != null) m.ttft.push(r.ttft_ms);
    if (r.ok && r.total_ms != null) m.total.push(r.total_ms);
  }
  const models: ModelPerf[] = [...byModel.values()]
    .map((m) => {
      const ttft = m.ttft.sort((a, b) => a - b);
      const total = m.total.sort((a, b) => a - b);
      return {
        provider: m.provider,
        model: m.model,
        turns: m.turns,
        errorRate: m.turns ? m.errors / m.turns : 0,
        ttftP50: percentile(ttft, 50),
        ttftP95: percentile(ttft, 95),
        totalP50: percentile(total, 50),
        totalP95: percentile(total, 95),
      };
    })
    .sort((a, b) => b.turns - a.turns);
  return {
    windowMs,
    totalTurns,
    errorRate: totalTurns ? totalErrors / totalTurns : 0,
    models,
  };
}
