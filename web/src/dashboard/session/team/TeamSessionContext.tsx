import { ArrowUpRight, GitBranch, Network, RotateCcw } from "lucide-react";
import { useT } from "../../../i18n";
import { OrchestrationStatus } from "../../../orchestration/OrchestrationStatus";
import { useSessionRunReadModel } from "../../../orchestration/read-model";
import { Link } from "../../../platform/router";

export function TeamSessionContext({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { state, retry } = useSessionRunReadModel(sessionId);

  if (state.status === "loading") {
    return (
      <div
        data-testid="team-session-context-loading"
        className="mb-5 flex min-h-14 w-full items-center gap-2.5 border-y border-[#E8EBE3] px-2 py-3 text-[12.5px] text-[#777B75] dark:border-[#343632] dark:text-[#989C95]"
      >
        <Network className="size-[15px] shrink-0" strokeWidth={1.55} />
        <span>{t("chat.teamContextLoading")}</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-testid="team-session-context-error"
        className="mb-5 flex min-h-14 w-full items-center gap-2.5 border-y border-[#E8EBE3] px-2 py-3 text-[12.5px] text-[#777B75] dark:border-[#343632] dark:text-[#989C95]"
      >
        <Network className="size-[15px] shrink-0" strokeWidth={1.55} />
        <span className="min-w-0 flex-1">{t("chat.teamContextUnavailable")}</span>
        <button
          type="button"
          onClick={retry}
          className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[#555A53] transition-transform duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.97] dark:text-[#B7BBB3]"
        >
          <RotateCcw className="size-3" strokeWidth={1.7} />
          {t("chat.retry")}
        </button>
      </div>
    );
  }

  const latestTask = state.data.latestTeamTask ?? state.data.backgroundTasks.find((task) => {
    if (task.kind !== "team_turn") return false;
    if (task.teamId) return state.data.teams.some((membership) => membership.teamId === task.teamId);
    return state.data.teams.length === 1;
  });
  const membership = latestTask?.teamId
    ? state.data.teams.find((candidate) => candidate.teamId === latestTask.teamId)
    : state.data.teams[0];
  return (
    <section
      data-testid="team-session-context"
      className="mb-5 w-full border-y border-[#E8EBE3] text-[#343733] dark:border-[#343632] dark:text-[#E0E2DE]"
      aria-label={t("chat.teamContextLabel")}
    >
      <div className="flex min-h-12 items-center gap-2.5 px-2 py-2.5">
        <Network className="size-[15px] shrink-0 text-[#777B75] dark:text-[#989C95]" strokeWidth={1.55} />
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#777B75] dark:text-[#989C95]">
            {t("chat.teamContextLabel")}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] font-medium">
            {membership ? `${membership.name} · ${membership.role}` : t("chat.teamMembershipEnded")}
          </p>
        </div>
        {membership && (
          <Link
            to={`/agents/teams/${encodeURIComponent(membership.teamId)}`}
            aria-label={t("chat.openTeam")}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[#777B75] transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.035] hover:text-[#343733] active:scale-[.96] dark:text-[#989C95] dark:hover:bg-white/[0.05] dark:hover:text-[#E0E2DE]"
          >
            <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
          </Link>
        )}
      </div>

      {latestTask ? (
        <Link
          to={`/agents/activity/${encodeURIComponent(latestTask.id)}`}
          data-testid="team-session-latest-task"
          className="group flex min-h-11 items-center gap-2.5 border-t border-[#EEF0EB] px-2 py-2 text-left transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.022] active:scale-[.995] dark:border-[#30322F] dark:hover:bg-white/[0.025]"
        >
          <GitBranch className="size-[14px] shrink-0 text-[#777B75] dark:text-[#989C95]" strokeWidth={1.55} />
          <span className="min-w-0 flex-1">
            <span className="block text-[10.5px] text-[#777B75] dark:text-[#989C95]">{t("chat.teamLatestTask")}</span>
            <span className="block truncate text-[12.5px] font-medium">{latestTask.title}</span>
          </span>
          <OrchestrationStatus value={latestTask.status} compact />
          <ArrowUpRight className="size-3.5 shrink-0 text-[#8A8E87] transition-transform duration-150 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-reduce:transition-none dark:text-[#8F938C]" strokeWidth={1.55} />
        </Link>
      ) : (
        <p data-testid="team-session-no-task" className="border-t border-[#EEF0EB] px-2 py-2.5 text-[12px] text-[#777B75] dark:border-[#30322F] dark:text-[#989C95]">
          {t("chat.teamNoAssignment")}
        </p>
      )}
    </section>
  );
}
