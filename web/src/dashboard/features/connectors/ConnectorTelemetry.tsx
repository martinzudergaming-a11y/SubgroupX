import { useEffect, useState } from "react";
import type { ConnectorTelemetry } from "@shared/protocol";
import { api, type ConnectorInfo } from "../../../platform/api.ts";
import { useI18n } from "../../../i18n";
import { TelemetryPanelView, type TelemetryPoint } from "../../../telemetry/TelemetryPanel.tsx";

const POLL_MS = 3_000;
const MAX_SAMPLES = 60;

export function ConnectorTelemetryPanel({ connector }: { connector: ConnectorInfo }) {
  const { t } = useI18n();
  const [telemetry, setTelemetry] = useState<ConnectorTelemetry | null>(null);
  const [history, setHistory] = useState<TelemetryPoint[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!connector.online) {
      setTelemetry(null);
      setHistory([]);
      setFailed(false);
      return;
    }
    let stopped = false;
    let running = false;
    let sampleOnSettle = false;
    let activeRequest: AbortController | null = null;
    let timer: number | undefined;

    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (!stopped && !document.hidden) {
        timer = window.setTimeout(() => {
          timer = undefined;
          void sample();
        }, POLL_MS);
      }
    };
    const sample = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      const controller = new AbortController();
      activeRequest = controller;
      try {
        const next = (await api.connectorTelemetry(connector.id, controller.signal)).telemetry;
        if (stopped) return;
        setTelemetry(next);
        setFailed(false);
        const point = {
          sampledAt: next.sampledAt,
          cpuPct: next.cpuPct,
          memPct: next.memTotal > 0 ? Math.min(100, (next.memUsed / next.memTotal) * 100) : 0,
        };
        setHistory((current) => {
          if (current.at(-1)?.sampledAt === point.sampledAt) return current;
          return [...current, point].slice(-MAX_SAMPLES);
        });
      } catch {
        if (!stopped && !controller.signal.aborted) setFailed(true);
      } finally {
        if (activeRequest === controller) activeRequest = null;
        running = false;
        if (sampleOnSettle && !stopped && !document.hidden) {
          sampleOnSettle = false;
          void sample();
        } else {
          schedule();
        }
      }
    };
    const onVisibility = () => {
      clearTimer();
      if (document.hidden) {
        sampleOnSettle = false;
        activeRequest?.abort();
        return;
      }
      if (stopped) return;
      if (running) sampleOnSettle = true;
      else {
        sampleOnSettle = false;
        void sample();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void sample();
    return () => {
      stopped = true;
      clearTimer();
      activeRequest?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connector.id, connector.online]);

  const status = !connector.online
    ? t("plugins.telemetryOffline")
    : failed && !telemetry
      ? t("plugins.telemetryUnavailable")
      : !telemetry
        ? t("plugins.telemetryWaiting")
        : null;

  return (
    <TelemetryPanelView
      telemetry={telemetry}
      history={history}
      status={status}
      testId={`connector-telemetry-${connector.id}`}
    />
  );
}
