import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../i18n";

export function AgentsMasterDetail({
  list,
  detail,
  detailOpen,
  onBack,
  listLabel,
}: {
  list: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  onBack: () => void;
  listLabel: string;
}) {
  const t = useT();
  return (
    <div className="@container/agents-body flex min-h-0 flex-1 overflow-hidden">
      <section
        aria-label={listLabel}
        className={`${detailOpen ? "hidden" : "flex"} min-h-0 w-full flex-col border-r border-[#DDE1D8] bg-[var(--app-frame)] dark:border-[#383B37] dark:bg-[#1E1E1E] @3xl/agents-body:flex @3xl/agents-body:w-[19rem] @5xl/agents-body:w-[22rem]`}
      >
        {list}
      </section>
      <section
        className={`${detailOpen ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A] @3xl/agents-body:flex`}
      >
        {detailOpen && (
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[#E8EBE3] px-3 text-[12px] font-medium text-[#656A63] hover:bg-black/[0.025] active:bg-black/[0.045] dark:border-[#343632] dark:text-[#A5A9A1] dark:hover:bg-white/[0.035] @3xl/agents-body:hidden"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.7} />
            {t("agents.back")}
          </button>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">{detail}</div>
      </section>
    </div>
  );
}

export function MasterListHeader({ title, count }: { title: string; count: number | string }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#E8EBE3] px-3 dark:border-[#343632]">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.075em] text-[#7D817A] dark:text-[#7D8279]">{title}</h2>
      <span className="font-mono text-[10.5px] tabular-nums text-[#9A9E97] dark:text-[#696D66]">{count}</span>
    </div>
  );
}

export function MasterListLoadMore({ label, busy, onClick }: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="h-10 w-full border-b border-[#E8EBE3] text-[11.5px] font-medium text-[#656A63] transition-[background-color,transform] duration-150 hover:bg-black/[0.025] active:scale-[.995] disabled:opacity-55 dark:border-[#343632] dark:text-[#A5A9A1] dark:hover:bg-white/[0.035] motion-reduce:transition-none"
    >
      {busy ? "…" : label}
    </button>
  );
}

export const masterRowClass = (active: boolean) => `w-full border-b border-[#E8EBE3] px-3 py-3 text-left transition-[background-color,transform] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.995] dark:border-[#343632] motion-reduce:transition-none ${
  active
    ? "bg-[var(--app-surface)] text-[#2E312D] dark:bg-[#1A1A1A] dark:text-[#E5E7E2]"
    : "text-[#41453F] hover:bg-black/[0.025] dark:text-[#D1D4CE] dark:hover:bg-white/[0.03]"
}`;

export function DetailHeader({ eyebrow, title, trailing, detail }: {
  eyebrow: string;
  title: string;
  trailing?: ReactNode;
  detail?: string;
}) {
  return (
    <header className="border-b border-[#DDE1D8] px-5 py-5 dark:border-[#383B37] @2xl/agents-body:px-7 @2xl/agents-body:py-6">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#8A8E87] dark:text-[#777C74]">{eyebrow}</p>
      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-4">
        <h2 className="min-w-0 truncate text-[19px] font-semibold tracking-[-0.015em] text-[#2D302C] dark:text-[#E6E8E3]">{title}</h2>
        {trailing}
      </div>
      {detail && <p className="mt-2 max-w-2xl text-[12.5px] leading-[1.55] text-[#70746D] dark:text-[#949890]">{detail}</p>}
    </header>
  );
}

export function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-10 grid-cols-[8rem_minmax(0,1fr)] items-center border-b border-[#EEF0EB] px-5 py-2 text-[12px] last:border-b-0 dark:border-[#30322F] @2xl/agents-body:px-7">
      <dt className="text-[#898D86] dark:text-[#777C74]">{label}</dt>
      <dd className="min-w-0 text-[#41453F] dark:text-[#C9CCC6]">{children}</dd>
    </div>
  );
}
