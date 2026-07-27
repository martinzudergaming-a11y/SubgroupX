import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n";

export function ReadModelLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div data-testid="orchestration-loading" aria-hidden="true" className="divide-y divide-[#E8EBE3] dark:divide-[#343632]">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="px-4 py-4">
          <div className="h-2 w-[38%] rounded-full bg-black/[0.065] dark:bg-white/[0.08]" />
          <div className="mt-3 h-2 w-[68%] rounded-full bg-black/[0.04] dark:bg-white/[0.055]" />
        </div>
      ))}
    </div>
  );
}

export function ReadModelError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div data-testid="orchestration-error" className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
      <p className="text-[13px] text-[#676B65] dark:text-[#A5A8A2]">{t("agents.loadError")}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[#DDE1D8] px-2.5 text-[12px] font-medium text-[#464A44] transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.04] active:scale-[.97] dark:border-[#3A3D39] dark:text-[#D4D6D1] dark:hover:bg-white/[0.05] motion-reduce:transition-none"
      >
        <RotateCw className="size-3.5" strokeWidth={1.7} />
        {t("agents.retry")}
      </button>
    </div>
  );
}

export function OrchestrationEmpty({ title, detail, action }: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div data-testid="orchestration-empty" className="flex min-h-48 flex-col items-center justify-center px-7 text-center">
      <div className="h-px w-9 bg-[#D9DDD5] dark:bg-[#3B3E3A]" aria-hidden />
      <h3 className="mt-4 text-[13.5px] font-medium text-[#343733] dark:text-[#E0E2DE]">{title}</h3>
      <p className="mt-1.5 max-w-64 text-[12px] leading-[1.55] text-[#81857E] dark:text-[#888D85]">{detail}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
