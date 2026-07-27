import { ArrowUpRight, CircleDotDashed } from "lucide-react";
import { useT } from "../../../i18n";
import { Link, navigate } from "../../../platform/router";
import { activityLabel, OrchestrationStatus, useRelativeTime } from "../../../orchestration/OrchestrationStatus";
import { OrchestrationEmpty, ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import { AgentActivityGlyph } from "../../../orchestration/AgentActivityGlyph";
import { taskActivityMotion } from "../../../orchestration/agent-activity-motion";
import { useTaskDetailReadModel, type ActivityRow } from "../../../orchestration/read-model";
import {
  AgentsMasterDetail,
  DefinitionRow,
  DetailHeader,
  MasterListHeader,
  MasterListLoadMore,
  masterRowClass,
} from "./AgentsMasterDetail";

export function ActivitySection({
  items,
  selectedId,
  partial,
  loadingMore,
  onLoadMore,
}: {
  items: ActivityRow[];
  selectedId?: string;
  partial: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const selectedSummary = selectedId ? items.find((item) => item.id === selectedId) : undefined;

  if (items.length === 0 && !selectedId) {
    return <OrchestrationEmpty title={t("agents.activity.emptyTitle")} detail={t("agents.activity.emptyDetail")} />;
  }

  return (
    <AgentsMasterDetail
      listLabel={t("agents.activity.title")}
      detailOpen={Boolean(selectedId)}
      onBack={() => navigate("/agents/activity")}
      list={(
        <>
          <MasterListHeader title={t("agents.activity.title")} count={partial ? `${items.length}+` : items.length} />
          <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`activity-row-${item.id}`}
                onClick={() => navigate(`/agents/activity/${encodeURIComponent(item.id)}`)}
                className={masterRowClass(item.id === selectedId)}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{item.title}</span>
                    <span className="mt-1 block truncate text-[11.5px] text-[#7F837C] dark:text-[#858A82]">{item.agentLabel} · {item.sessionTitle}</span>
                  </span>
                  <OrchestrationStatus value={item.status} compact />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10.5px] text-[#777C74] dark:text-[#92968F]">
                  <span>{t(activityLabel(item.activity))}</span>
                  <span className="tabular-nums">{relativeTime(item.updatedAt)}</span>
                </div>
              </button>
            ))}
            {partial && <MasterListLoadMore label={t("agents.more")} busy={loadingMore} onClick={onLoadMore} />}
          </div>
        </>
      )}
      detail={selectedId
        ? <ActivityDetail id={selectedId} summary={selectedSummary} />
        : <OrchestrationEmpty title={t("agents.selectTitle")} detail={t("agents.selectDetail")} />}
    />
  );
}

function ActivityDetail({ id, summary }: { id: string; summary?: ActivityRow }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useTaskDetailReadModel(id, summary?.updatedAt ?? 0);
  if (state.status === "loading") return <ReadModelLoading rows={5} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  const task = state.data;
  const motion = taskActivityMotion(task.status, task.activity);
  const activityText = t(activityLabel(task.activity));
  return (
    <article data-testid="activity-detail">
      <DetailHeader
        eyebrow={t("agents.activity.task")}
        title={task.title}
        detail={summary?.summary}
        trailing={<OrchestrationStatus value={task.status} />}
      />
      <dl className="border-b border-[#DDE1D8] dark:border-[#383B37]">
        <DefinitionRow label={t("agents.activity.agent")}>{summary?.agentLabel ?? task.agentId}</DefinitionRow>
        <DefinitionRow label={t("agents.activity.session")}>{summary?.sessionTitle ?? task.sessionId}</DefinitionRow>
        <DefinitionRow label={t("agents.activity.mode")}>{task.awaitPolicy === "background" ? t("agents.background") : t("agents.joined")}</DefinitionRow>
        <DefinitionRow label={t("agents.activity.updated")}>{relativeTime(task.updatedAt)}</DefinitionRow>
      </dl>
      <section className="px-5 py-5 @2xl/agents-body:px-7 @2xl/agents-body:py-6">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#777C74]">{t("agents.activity.current")}</h3>
        <div className="mt-3 flex items-start gap-3 border-l border-[#CFD4CA] pl-3 dark:border-[#444841]">
          {motion
            ? <AgentActivityGlyph state={motion.state} paused={motion.paused} />
            : <span className="inline-flex size-5 shrink-0 items-center justify-center">
                <CircleDotDashed className="size-4 text-[#777B75] dark:text-[#969A93]" strokeWidth={1.5} />
              </span>}
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[#3A3E38] dark:text-[#D7DAD4]">{activityText}</p>
            {task.waitReason && <p className="mt-1 text-[12px] leading-[1.5] text-[#7D817A] dark:text-[#888D85]">{task.waitReason}</p>}
          </div>
        </div>
        <Link
          to={`/s/${task.sessionId}`}
          className="mt-6 inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[#DDE1D8] px-2.5 text-[12px] font-medium text-[#464A44] transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.04] active:scale-[.97] dark:border-[#3A3D39] dark:text-[#D4D6D1] dark:hover:bg-white/[0.05] motion-reduce:transition-none"
        >
          {t("agents.openSession")}
          <ArrowUpRight className="size-3.5" strokeWidth={1.7} />
        </Link>
      </section>
    </article>
  );
}
