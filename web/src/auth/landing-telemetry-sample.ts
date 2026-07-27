import type { ConnectorProcessInfo, ConnectorTelemetry } from "@shared/protocol";
import type { TelemetryPoint } from "../telemetry/TelemetryPanel.tsx";

const GIB = 1024 ** 3;

const CREW: readonly ConnectorProcessInfo[] = [
  { pid: 1337, ppid: 1, name: "neo", state: "R", cpuPct: 23.9, memPct: 5.5, rssBytes: 448 * 1024 * 1024, elapsed: "13:37" },
  { pid: 31337, ppid: 1, name: "trinity", state: "S", cpuPct: 12.1, memPct: 0.7, rssBytes: 55 * 1024 * 1024, elapsed: "02:41:08" },
  { pid: 4004, ppid: 1, name: "morpheus", state: "S", cpuPct: 11.9, memPct: 2.6, rssBytes: 213 * 1024 * 1024, elapsed: "18:57" },
  { pid: 6502, ppid: 4004, name: "oracle", state: "S", cpuPct: 10.9, memPct: 4.5, rssBytes: 370 * 1024 * 1024, elapsed: "18:47" },
  { pid: 8086, ppid: 1, name: "tank", state: "S", cpuPct: 6.4, memPct: 1.1, rssBytes: 92 * 1024 * 1024, elapsed: "01:12:03" },
  { pid: 68000, ppid: 1, name: "dozer", state: "S", cpuPct: 3.2, memPct: 0.9, rssBytes: 74 * 1024 * 1024, elapsed: "44:19" },
  { pid: 65536, ppid: 8086, name: "apoc", state: "S", cpuPct: 1.8, memPct: 0.4, rssBytes: 31 * 1024 * 1024, elapsed: "09:55" },
  { pid: 2600, ppid: 1, name: "switch", state: "S", cpuPct: 0.7, memPct: 0.2, rssBytes: 18 * 1024 * 1024, elapsed: "03:07" },
];

export function seededWalk(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function nextIn(random: () => number, current: number, min: number, max: number, step: number): number {
  const drift = (random() - 0.5) * step * 2;
  const pulled = current + drift + (min + max) / 2 > current ? drift : drift * 0.6;
  return Math.min(max, Math.max(min, current + pulled));
}

export const SAMPLE_WINDOW = 60;
export const SAMPLE_INTERVAL_MS = 3_000;

export function sampleTelemetry(cpuPct: number, memPct: number, at: number): ConnectorTelemetry {
  const memTotal = 16 * GIB;
  return {
    sampledAt: at,
    cpuPct,
    memUsed: Math.round((memPct / 100) * memTotal),
    memTotal,
    cpuCores: 8,
    loadAvg: [1.37, 1.13, 0.99],
    processCount: 1337,
    processes: [...CREW],
    cpuKind: "interval",
    processSource: "native",
  } satisfies ConnectorTelemetry;
}

export function seedHistory(endingAt: number): TelemetryPoint[] {
  const random = seededWalk(0x1337);
  const points: TelemetryPoint[] = [];
  let cpu = 21;
  let mem = 63;
  for (let i = SAMPLE_WINDOW - 1; i >= 0; i--) {
    cpu = nextIn(random, cpu, 8, 48, 4);
    mem = nextIn(random, mem, 58, 72, 1.2);
    points.push({ sampledAt: endingAt - i * SAMPLE_INTERVAL_MS, cpuPct: cpu, memPct: mem });
  }
  return points;
}
