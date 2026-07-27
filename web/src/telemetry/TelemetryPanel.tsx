import { lazy, Suspense } from "react";
import { Activity, Cpu, ListTree, MemoryStick } from "lucide-react";
import type { ConnectorProcessInfo, ConnectorTelemetry } from "@shared/protocol";
import { useI18n } from "../i18n";

const TelemetryCharts = lazy(() => import("./TelemetryCharts.tsx"));
const MAX_VISIBLE_PROCESSES = 8;

export interface TelemetryPoint {
  sampledAt: number;
  cpuPct: number;
  memPct: number;
}

export function formatBytes(bytes: number): string {
  if (!(bytes >= 0) || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index >= 3 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function MetricHeader({
  icon,
  label,
  value,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex min-h-9 items-start gap-2">
      <span className="mt-0.5 text-[#73776E] dark:text-[#A2A69C]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-[.07em] text-[#686C63] dark:text-[#A0A39B]">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-[#777B72] dark:text-[#999D94]" title={title}>{title}</div>
      </div>
      <span className="font-mono text-[19px] font-medium tabular-nums tracking-[-.035em] text-[#343831] dark:text-[#E0E2DB]">{value}</span>
    </div>
  );
}

function ProcessRow({ process }: { process: ConnectorProcessInfo }) {
  return (
    <tr className="h-9 text-[11px]" data-testid="connector-process-row">
      <td className="min-w-0 truncate border-t border-[#ECEEE8] pr-3 font-medium text-[#454941] dark:border-[#30322D] dark:text-[#CFD1CA]" title={process.name}>{process.name}</td>
      <td className="border-t border-[#ECEEE8] text-right font-mono tabular-nums text-[#4E765F] dark:border-[#30322D] dark:text-[#82B497]">{process.cpuPct.toFixed(1)}%</td>
      <td className="border-t border-[#ECEEE8] text-right font-mono tabular-nums text-[#626B83] dark:border-[#30322D] dark:text-[#9DA8C2]">{formatBytes(process.rssBytes)}</td>
      <td className="hidden border-t border-[#ECEEE8] text-right font-mono tabular-nums text-[#777B72] dark:border-[#30322D] dark:text-[#92968D] @2xl/detail:table-cell">{process.pid}</td>
      <td className="hidden truncate border-t border-[#ECEEE8] text-right font-mono tabular-nums text-[#777B72] dark:border-[#30322D] dark:text-[#92968D] @2xl/detail:table-cell">{process.elapsed || "—"}</td>
    </tr>
  );
}

function ProcessTable({ telemetry }: { telemetry: ConnectorTelemetry }) {
  const { t } = useI18n();
  const processes = telemetry.processes.slice(0, MAX_VISIBLE_PROCESSES);
  return (
    <div className="mt-5" data-testid="connector-processes">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-[#3A3E36] dark:text-[#D7D9D2]">
            <ListTree className="size-3.5" strokeWidth={1.6} />
            {t("plugins.telemetryProcesses")}
          </h4>
          <p className="mt-1 text-[10.5px] leading-[1.5] text-[#777B72] dark:text-[#92968D]">{t("plugins.telemetryProcessesHint")}</p>
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] tabular-nums text-[#777B72] dark:text-[#92968D]">
          {t("plugins.telemetryProcessCount", { count: telemetry.processCount })}
          {telemetry.processSource === "compat" && <span className="ml-2 text-[#9A6C2C] dark:text-[#D1A057]">{t("plugins.telemetryCompat")}</span>}
        </div>
      </div>
      <table className="mt-3 w-full table-fixed border-y border-[#DFE3DA] dark:border-[#383A35]">
        <caption className="sr-only">{t("plugins.telemetryProcesses")}</caption>
        <colgroup>
          <col />
          <col className="w-[58px] @2xl/detail:w-16" />
          <col className="w-[68px] @2xl/detail:w-[76px]" />
          <col className="hidden w-[62px] @2xl/detail:table-column" />
          <col className="hidden w-[82px] @2xl/detail:table-column" />
        </colgroup>
        <thead>
          <tr className="h-7 text-[9.5px] font-semibold uppercase tracking-[.06em] text-[#777B72] dark:text-[#92968D]">
            <th scope="col" className="text-left">{t("plugins.telemetryProcess")}</th>
            <th scope="col" className="text-right">CPU</th>
            <th scope="col" className="text-right">RAM</th>
            <th scope="col" className="hidden text-right @2xl/detail:table-cell">{t("plugins.telemetryPid")}</th>
            <th scope="col" className="hidden text-right @2xl/detail:table-cell">{t("plugins.telemetryElapsed")}</th>
          </tr>
        </thead>
        <tbody>
          {processes.length > 0
            ? processes.map((process) => <ProcessRow key={process.pid} process={process} />)
            : <tr><td colSpan={5} className="border-t border-[#ECEEE8] py-5 text-center text-[11px] text-[#777B72] dark:border-[#30322D] dark:text-[#92968D]">{t("plugins.telemetryNoProcesses")}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function TelemetryPanelView({
  telemetry,
  history,
  status,
  testId,
}: {
  telemetry: ConnectorTelemetry | null;
  history: TelemetryPoint[];
  status: string | null;
  testId?: string;
}) {
  const { t, locale } = useI18n();
  const intlLocale = locale === "zh" ? "zh-CN" : "en-US";
  const memPct = telemetry && telemetry.memTotal > 0 ? Math.min(100, (telemetry.memUsed / telemetry.memTotal) * 100) : 0;

  return (
    <section className="border-b border-[#E3E6DE] py-6 dark:border-[#30322D]" data-testid={testId}>
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 size-4 shrink-0 text-[#5E7467] dark:text-[#8FA99A]" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-[#383B34] dark:text-[#D5D7CF]">{t("plugins.telemetryTitle")}</h3>
          <p className="mt-1 text-[10.5px] leading-[1.5] text-[#777B72] dark:text-[#92968D]">{t("plugins.telemetryHint")}</p>
        </div>
        {telemetry && (
          <time
            className="shrink-0 font-mono text-[10px] tabular-nums text-[#777B72] dark:text-[#92968D]"
            dateTime={new Date(telemetry.sampledAt).toISOString()}
          >
            {new Intl.DateTimeFormat(intlLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(telemetry.sampledAt)}
          </time>
        )}
      </div>

      {status ? (
        <div className="mt-5 border-y border-[#E3E6DE] py-9 text-center text-[11px] text-[#777B72] dark:border-[#30322D] dark:text-[#92968D]">{status}</div>
      ) : telemetry ? (
        <>
          <div className="mt-5 grid border-y border-[#DFE3DA] [--telemetry-cpu:#4E765F] [--telemetry-memory:#68748F] dark:border-[#383A35] dark:[--telemetry-cpu:#82B497] dark:[--telemetry-memory:#9DA8C2] @2xl/detail:grid-cols-2">
            <div className="min-w-0 border-b border-[#E3E6DE] px-1 py-4 dark:border-[#30322D] @2xl/detail:border-b-0 @2xl/detail:border-r @2xl/detail:pr-5">
              <MetricHeader
                icon={<Cpu className="size-3.5" strokeWidth={1.6} />}
                label={t("plugins.telemetryCpu")}
                value={`${telemetry.cpuPct.toFixed(1)}%`}
                title={telemetry.cpuKind === "load"
                  ? t("plugins.telemetryLegacyCpu")
                  : t("plugins.telemetryCores", { count: telemetry.cpuCores || "—" })}
              />
              {history.length > 1 ? (
                <Suspense fallback={<div className="h-[126px]" />}>
                  <TelemetryCharts
                    data={history}
                    dataKey="cpuPct"
                    color="var(--telemetry-cpu)"
                    locale={intlLocale}
                    label={t("plugins.telemetryHistory", { label: t("plugins.telemetryCpu") })}
                  />
                </Suspense>
              ) : <div className="flex h-[126px] items-center justify-center text-[10.5px] text-[#8A8E84] dark:text-[#858980]">{t("plugins.telemetryWaiting")}</div>}
            </div>
            <div className="min-w-0 px-1 py-4 @2xl/detail:pl-5">
              <MetricHeader
                icon={<MemoryStick className="size-3.5" strokeWidth={1.6} />}
                label={t("plugins.telemetryMemory")}
                value={`${memPct.toFixed(1)}%`}
                title={`${formatBytes(telemetry.memUsed)} / ${formatBytes(telemetry.memTotal)}`}
              />
              {history.length > 1 ? (
                <Suspense fallback={<div className="h-[126px]" />}>
                  <TelemetryCharts
                    data={history}
                    dataKey="memPct"
                    color="var(--telemetry-memory)"
                    locale={intlLocale}
                    label={t("plugins.telemetryHistory", { label: t("plugins.telemetryMemory") })}
                  />
                </Suspense>
              ) : <div className="flex h-[126px] items-center justify-center text-[10.5px] text-[#8A8E84] dark:text-[#858980]">{t("plugins.telemetryWaiting")}</div>}
            </div>
          </div>
          <ProcessTable telemetry={telemetry} />
        </>
      ) : null}
    </section>
  );
}
