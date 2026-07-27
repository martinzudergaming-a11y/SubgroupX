import { Spinner } from "./Spinner";

export interface ByteProgress {
  loaded: number;
  total: number | null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ByteProgressRing({ progress, className }: { progress: ByteProgress | null; className?: string }) {
  const determinate = progress != null && progress.total != null && progress.total > 0;
  if (!determinate) {
    return <Spinner className={`size-5 ${className ?? ""}`} strokeWidth={2} />;
  }
  const frac = Math.min(1, progress.loaded / progress.total!);
  const r = 7;
  const C = 2 * Math.PI * r;
  return (
    <span
      data-testid="byte-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(frac * 100)}
      className={`flex flex-col items-center gap-1.5 ${className ?? ""}`}
    >
      <svg width={22} height={22} viewBox="0 0 18 18" className="-rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" className="stroke-black/[.08] dark:stroke-white/[.10]" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${frac * C} ${C}`}
          className="stroke-current transition-[stroke-dasharray] duration-150 ease-out"
        />
      </svg>
      <span className="text-[10.5px] leading-none tabular-nums">
        {formatBytes(progress.loaded)} / {formatBytes(progress.total!)}
      </span>
    </span>
  );
}
