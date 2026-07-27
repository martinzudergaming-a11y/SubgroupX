import crypto from "node:crypto";
import { statusSampleDao, perfSampleDao, type StatusSampleRow } from "../persistence/index.ts";
import { jailAvailable, JAIL_API, JAIL_BASE_URL, JAIL_MODEL_ID } from "../runtime/providers.ts";
import { COMPONENTS, evaluateIncident } from "./prober.ts";

const REAL_TURN_CONFIRM_MS = 12 * 60_000;

const PROBE_INTERVAL_MS = Number(process.env.AGENT_WEB_STATUS_PROBE_MS) || 290_000;
const PROBE_MODEL = process.env.AGENT_WEB_STATUS_PROBE_MODEL || JAIL_MODEL_ID;
const PROBE_TIMEOUT_MS = 30_000;

export interface ApiProbeResult {
  ok: boolean;
  ttftMs: number | null;
  totalMs: number;
  detail: Record<string, unknown>;
}

export async function probeModelApi(): Promise<ApiProbeResult | null> {
  if (!jailAvailable() || JAIL_API !== "openai-responses") return null;
  const key = process.env.AGENT_WEB_JAIL_KEY;
  if (!key) return null;
  const t0 = Date.now();
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(`${JAIL_BASE_URL}/responses`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "oiia/1.0",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: ok" }] }],
        stream: true,
        max_output_tokens: 64,
        reasoning: { effort: "low" },
        prompt_cache_key: "oiia-status-probe",
        include: ["reasoning.encrypted_content"],
      }),
    });
    if (!res.ok || !res.body) {
      try {
        await res.body?.cancel();
      } catch {
      }
      return { ok: false, ttftMs: null, totalMs: Date.now() - t0, detail: { model: PROBE_MODEL, status: res.status } };
    }
    let ttftMs: number | null = null;
    let completed = false;
    let sawText = false;
    let errored = false;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.trim()) buf += "\n";
      } else {
        buf += decoder.decode(value, { stream: true });
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: { type?: string; delta?: unknown };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.type === "response.output_text.delta") {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          if (typeof evt.delta === "string" && evt.delta.length > 0) sawText = true;
        } else if (evt.type === "response.completed") {
          completed = true;
        } else if (
          evt.type === "response.failed" ||
          evt.type === "response.incomplete" ||
          evt.type === "error" ||
          evt.type === "response.error"
        ) {
          errored = true;
        }
      }
      if (completed || errored) {
        void reader.cancel().catch(() => {  });
        const ok = completed && sawText && !errored;
        return { ok, ttftMs, totalMs: Date.now() - t0, detail: { model: PROBE_MODEL, ttftMs, completed, sawText } };
      }
      if (done) break;
    }
    const ok = completed && sawText && !errored;
    return { ok, ttftMs, totalMs: Date.now() - t0, detail: { model: PROBE_MODEL, ttftMs, completed, sawText } };
  } catch {
    return {
      ok: false,
      ttftMs: null,
      totalMs: Date.now() - t0,
      detail: { model: PROBE_MODEL, error: signal.aborted ? "timeout" : "fetch_error" },
    };
  }
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  const apiDef = COMPONENTS.find((c) => c.key === "api");
  if (!apiDef) return;
  const result = await probeModelApi();
  if (!result) return;
  const ts = Date.now();

  let ok = result.ok;
  let secondary: Record<string, unknown> | undefined;
  if (!ok) {
    const realTurnOk = perfSampleDao.since(ts - REAL_TURN_CONFIRM_MS, 100).find((s) => s.ok === 1);
    if (realTurnOk) {
      ok = true;
      secondary = { secondaryPass: "real-turn-ok", realTurnAgeMs: ts - realTurnOk.ts };
    }
  }

  const row: StatusSampleRow = {
    id: "ss_" + crypto.randomUUID(),
    ts,
    component: "api",
    ok: ok ? 1 : 0,
    latency_ms: result.ttftMs != null ? result.ttftMs : Math.round(result.totalMs),
    detail_json: JSON.stringify({ ...result.detail, ...secondary, syntheticOk: result.ok, totalMs: result.totalMs, synthetic: true }),
  };
  try {
    statusSampleDao.add(row);
    evaluateIncident(apiDef, ts);
  } catch (e) {
    console.error("[status] api-probe write failed:", e instanceof Error ? e.message : e);
  }
}

export function startApiProbe(): void {
  if (started) return;
  started = true;
  setTimeout(() => void runOnce().catch((e) => console.error("[status] api-probe failed:", e)), 5000);
  timer = setInterval(() => void runOnce().catch((e) => console.error("[status] api-probe failed:", e)), PROBE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
