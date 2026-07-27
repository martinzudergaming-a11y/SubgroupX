export type StatusTone = "live" | "working" | "error" | "idle" | "muted" | "info";

const TONE_BG: Record<StatusTone, string> = {
  live: "bg-[var(--status-live)]",
  working: "bg-[var(--status-working)]",
  error: "bg-[var(--status-error)]",
  idle: "bg-[var(--status-idle)]",
  muted: "bg-[var(--status-muted)]",
  info: "bg-[var(--status-info)]",
};

export function StatusDot({
  tone,
  pulse = false,
  ping = false,
  className = "",
  title,
}: {
  tone: StatusTone;
  pulse?: boolean;
  ping?: boolean;
  className?: string;
  title?: string;
}) {
  if (ping) {
    return (
      <span className={`relative inline-flex size-1.5 shrink-0 ${className}`} aria-hidden="true" title={title}>
        <span className={`absolute inline-flex size-full rounded-full ${TONE_BG[tone]} opacity-60 animate-ping`} />
        <span className={`relative inline-flex size-1.5 rounded-full ${TONE_BG[tone]}`} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      title={title}
      className={`inline-block size-1.5 shrink-0 rounded-full ${TONE_BG[tone]} ${pulse ? "animate-pulse" : ""} ${className}`}
    />
  );
}
