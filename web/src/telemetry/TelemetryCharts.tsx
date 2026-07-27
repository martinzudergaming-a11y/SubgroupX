import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import type { TelemetryPoint } from "./TelemetryPanel.tsx";

function SampleTooltip({
  active,
  payload,
  label,
  locale,
  suffix,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ value?: number | string }>;
  label?: number | string;
  locale: string;
  suffix: string;
}) {
  if (!active || !payload?.length || typeof payload[0]?.value !== "number") return null;
  const timestamp = typeof label === "number" ? label : Number(label);
  return (
    <div className="border border-[#DDE1D8] bg-[var(--app-surface)] px-2 py-1.5 shadow-[0_4px_12px_-9px_rgba(0,0,0,.35)] dark:border-[#41433E] dark:bg-[#252622]">
      <div className="font-mono text-[10px] tabular-nums text-[#777B72] dark:text-[#999D94]">
        {Number.isFinite(timestamp)
          ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp)
          : ""}
      </div>
      <div className="mt-0.5 font-mono text-[11px] font-medium tabular-nums text-[#343831] dark:text-[#E0E2DB]">
        {payload[0].value.toFixed(1)}{suffix}
      </div>
    </div>
  );
}

function TelemetryArea({
  data,
  dataKey,
  color,
  locale,
  label,
}: {
  data: TelemetryPoint[];
  dataKey: "cpuPct" | "memPct";
  color: string;
  locale: string;
  label: string;
}) {
  return (
    <div className="h-[126px] min-w-0 [--telemetry-grid:#E7EAE2] [--telemetry-muted:#8A8E84] dark:[--telemetry-grid:#343631] dark:[--telemetry-muted:#858980]">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={96}>
        <AreaChart
          accessibilityLayer
          data={data}
          margin={{ top: 8, right: 4, bottom: 2, left: -4 }}
          title={label}
        >
          <CartesianGrid vertical={false} stroke="var(--telemetry-grid)" strokeDasharray="2 3" />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            axisLine={false}
            tickLine={false}
            width={32}
            tick={{ fill: "var(--telemetry-muted)", fontFamily: "ui-monospace, monospace", fontSize: 9 }}
            tickFormatter={(value) => `${value}%`}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: "var(--telemetry-muted)", strokeWidth: 1, strokeDasharray: "2 3" }}
            content={<SampleTooltip locale={locale} suffix="%" />}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={color}
            fillOpacity={0.09}
            dot={false}
            activeDot={{ r: 2.5, strokeWidth: 1.5, fill: "var(--app-surface)" }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ConnectorTelemetryChart({
  data,
  locale,
  dataKey,
  color,
  label,
}: {
  data: TelemetryPoint[];
  locale: string;
  dataKey: "cpuPct" | "memPct";
  color: string;
  label: string;
}) {
  return <TelemetryArea data={data} dataKey={dataKey} color={color} locale={locale} label={label} />;
}
