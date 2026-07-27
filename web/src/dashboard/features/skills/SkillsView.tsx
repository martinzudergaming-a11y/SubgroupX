import { Blocks, Code2, Zap, ShieldHalf, Bug, ArrowRight } from "lucide-react";
import { useT } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/en";
import type { SessionMode } from "@shared/protocol";
import { ViewHeader } from "../../ui/ViewHeader.tsx";

interface SkillRow {
  id: "coding" | "bold" | "pentest" | "exploit";
  icon: typeof Code2;
  mode: SessionMode;
  caps: [TranslationKey, TranslationKey, TranslationKey];
}

const SKILLS: SkillRow[] = [
  { id: "coding", icon: Code2, mode: "coding", caps: ["skills.cap.edit", "skills.cap.shell", "skills.cap.subagent"] },
  { id: "bold", icon: Zap, mode: "bold", caps: ["skills.cap.proactive", "skills.cap.allTools", "skills.cap.terse"] },
  { id: "pentest", icon: ShieldHalf, mode: "pentest", caps: ["skills.cap.recon", "skills.cap.e2b", "skills.cap.authorized"] },
  { id: "exploit", icon: Bug, mode: "exploit", caps: ["skills.cap.reversing", "skills.cap.wasm", "skills.cap.reason"] },
];

export function SkillsView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  onLaunch,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  onLaunch: (mode: SessionMode) => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="skills-view"
      className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]"
    >
      <ViewHeader
        icon={Blocks}
        title={t("skills.title")}
        subtitle={t("skills.headerSubtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--app-surface)] px-5 py-6 hide-scrollbar dark:bg-[#1D1E1B] md:px-8 md:py-8">
        <div className="mx-auto max-w-[760px]">
          <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-[#30322D] dark:text-[#E3E4DE]">
            {t("skills.heading")}
          </h2>
          <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">
            {t("skills.subtitle")}
          </p>

          <div className="mt-6 border-t border-[#DDE1D8] dark:border-[#393B35]">
            {SKILLS.map((skill) => {
              const Icon = skill.icon;
              const name = t(`skills.${skill.id}.name` as TranslationKey);
              return (
                <button
                  key={skill.id}
                  type="button"
                  data-testid={`skill-${skill.id}`}
                  onClick={() => onLaunch(skill.mode)}
                  aria-labelledby={`skill-name-${skill.id} skill-action-${skill.id}`}
                  aria-describedby={`skill-desc-${skill.id}`}
                  className="group flex min-h-[88px] w-full items-center border-b border-[#DDE1D8] px-1 py-4 text-left outline-none transition-colors duration-150 hover:bg-[#F3F4EF] active:bg-[#ECEEE8] focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.5)] dark:border-[#393B35] dark:hover:bg-[#292A26] dark:active:bg-[#2E302B]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center text-[#676B61] dark:text-[#A9ACA2]">
                    <Icon className="size-[18px]" strokeWidth={1.6} />
                  </span>

                  <span className="min-w-0 flex-1 px-2.5">
                    <span id={`skill-name-${skill.id}`} className="block text-[13.5px] font-semibold text-[#353730] dark:text-[#E0E1DB]">{name}</span>
                    <span id={`skill-desc-${skill.id}`} className="mt-1 block max-w-[560px] text-[11.5px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">
                      {t(`skills.${skill.id}.desc` as TranslationKey)}
                    </span>

                    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-[#7E8279] dark:text-[#8D9088]">
                      {skill.caps.map((cap, index) => (
                        <span key={cap} className="flex items-center gap-x-2">
                          {index > 0 && (
                            <span aria-hidden="true" className="size-[2px] rounded-full bg-[#C3C7BD] dark:bg-[#4A4C46]" />
                          )}
                          {t(cap)}
                        </span>
                      ))}
                    </span>
                  </span>

                  <span
                    id={`skill-action-${skill.id}`}
                    data-testid={`skill-launch-${skill.id}`}
                    className="mr-2 flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[#70746B] dark:text-[#A0A39B]"
                  >
                    <span className="sr-only sm:not-sr-only">{t("skills.start")}</span>
                    <ArrowRight
                      className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                      strokeWidth={1.7}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
