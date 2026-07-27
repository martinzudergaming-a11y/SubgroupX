import { ArrowRight, Cable, ChevronRight, FileUp, Terminal } from "lucide-react";
import type { ExecutorUnavailableReason } from "@shared/protocol";
import { useT } from "../../i18n";
import { Link } from "../../platform/router";

export function SessionHydrationState({ visible }: { visible: boolean }) {
  const t = useT();

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden"
      data-testid="session-hydration-state"
      data-visible={visible ? "true" : "false"}
      aria-busy="true"
      role="status"
    >
      <span className="sr-only">{t("chat.loadingSession")}</span>
      <div
        className={`mx-auto flex w-full max-w-[46rem] flex-1 flex-col px-6 pb-6 pt-[clamp(3rem,10vh,6.5rem)] transition-opacity duration-200 [transition-timing-function:cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none ${visible ? "opacity-100" : "opacity-0"}`}
        aria-hidden="true"
      >
        <div className="space-y-8">
          <div className="space-y-3">
            <div className="h-2 w-[18%] rounded-full bg-black/[0.055] dark:bg-white/[0.075]" />
            <div className="h-2 w-[72%] rounded-full bg-black/[0.045] dark:bg-white/[0.065]" />
            <div className="h-2 w-[54%] rounded-full bg-black/[0.04] dark:bg-white/[0.055]" />
          </div>
          <div className="ml-auto w-[64%] space-y-3">
            <div className="ml-auto h-2 w-[82%] rounded-full bg-black/[0.045] dark:bg-white/[0.065]" />
            <div className="ml-auto h-2 w-[58%] rounded-full bg-black/[0.04] dark:bg-white/[0.055]" />
          </div>
        </div>
        <div className="mt-auto h-[78px] rounded-[24px] border border-[#E8EBE3] bg-black/[0.012] dark:border-[#32332F] dark:bg-white/[0.015]" />
      </div>
    </div>
  );
}

export function NoSessionState({
  executorReason,
  onConnectComputer,
}: {
  executorReason?: ExecutorUnavailableReason;
  onConnectComputer: () => void;
}) {
  const t = useT();
  if (!executorReason) {
    return (
      <div className="flex flex-1 items-center justify-center text-[14px] text-[#777] dark:text-[#999]">
        {t("chat.noSession")}
      </div>
    );
  }

  const cloudIsTemporary = executorReason === "capacity_unavailable";

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-5 pb-10 pt-[clamp(2rem,10vh,5rem)]" data-testid="executor-empty-state">

      <section data-testid="executor-choice" className="w-full max-w-[440px]">
        <span className="flex size-9 items-center justify-center rounded-[11px] border border-[#DECDB2] bg-[#F6F0E4] text-[#8C6233] dark:border-[#5C513D] dark:bg-[#29271F] dark:text-[#D29A5B]">
          <Cable className="size-[17px]" strokeWidth={1.7} />
        </span>
        <h2 className="mt-3.5 text-[17px] font-semibold tracking-[-0.02em] text-[#302F2A] dark:text-[#E8E5DC]">
          {t("chat.workspaceChoiceTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.65] text-[#77766E] dark:text-[#A6A299]">
          {t("chat.workspaceChoiceBody")}
        </p>

        <div className="mt-5 space-y-2">

          <div className="rounded-[14px] border border-[#E1E4DC] bg-[#FDFEFA] p-4 dark:border-[#373733] dark:bg-[#20201E]">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[13.5px] font-semibold text-[#302F2A] dark:text-[#E8E5DC]">
                {t("chat.optionOwnComputerTitle")}
              </h3>
              <span className="shrink-0 text-[11px] text-[#99978F] dark:text-[#79776F]">
                {t("chat.optionOwnComputerCost")}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#77766E] dark:text-[#A6A299]">
              {t("chat.optionOwnComputerBody")}
            </p>
            <button
              type="button"
              className="primary mt-3 !min-h-9 !rounded-[10px] !px-4 !py-1.5 !text-[12.5px]"
              data-testid="executor-connect-cta"
              onClick={onConnectComputer}
            >
              {t("chat.connectComputer")}
            </button>
          </div>

          <div className="rounded-[14px] border border-dashed border-[#E1E4DC] px-4 py-3.5 dark:border-[#373733]" data-testid="executor-cloud-option">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[13.5px] font-medium text-[#77766E] dark:text-[#A6A299]">
                {t("chat.optionCloudTitle")}
              </h3>
              <span className="shrink-0 text-[11px] text-[#99978F] dark:text-[#79776F]">
                {t(cloudIsTemporary ? "chat.optionCloudFull" : "chat.optionCloudOff")}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#99978F] dark:text-[#79776F]">
              {t("chat.optionCloudBody")}
            </p>
          </div>
        </div>

        <Link
          to="/about"
          data-testid="executor-see-what-it-does"
          className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-[#6E6C64] underline decoration-[#D7D4CA] underline-offset-[3px] transition-colors hover:text-[#302F2A] dark:text-[#A6A299] dark:decoration-[#4A4841] dark:hover:text-[#E8E5DC]"
        >
          {t("chat.seeWhatItDoes")}
          <ArrowRight className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        </Link>

        <details className="group mt-4" data-testid="executor-limits">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] text-[#8A8880] transition-colors hover:text-[#5F5E57] dark:text-[#8B897F] dark:hover:text-[#B3B0A6] [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" strokeWidth={1.8} aria-hidden="true" />
            {t("chat.limitsSummary")}
          </summary>
          <ul data-testid="executor-limits-list" className="mt-2 space-y-1.5 pl-[18px] text-[11.5px] leading-[1.55] text-[#8A8880] dark:text-[#8B897F]">
            <li className="flex items-center gap-2"><FileUp className="size-3.5 shrink-0" aria-hidden="true" />{t("chat.executorUploads")}</li>
            <li className="flex items-center gap-2"><Terminal className="size-3.5 shrink-0" aria-hidden="true" />{t("chat.executorTools")}</li>
          </ul>
        </details>
      </section>
    </div>
  );
}
