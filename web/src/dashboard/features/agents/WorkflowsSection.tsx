import { ArrowUpRight, GitMerge } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../../../i18n";
import { Link, navigate } from "../../../platform/router";
import { OrchestrationStatus, useRelativeTime } from "../../../orchestration/OrchestrationStatus";
import { OrchestrationEmpty, ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import { useWorkflowDetailReadModel, type WorkflowSummaryRow } from "../../../orchestration/read-model";
import {
  AgentsMasterDetail,
  DefinitionRow,
  DetailHeader,
  MasterListHeader,
  masterRowClass,
} from "./AgentsMasterDetail";

export function WorkflowsSection({ items, selectedId, partial }: {
  items: WorkflowSummaryRow[];
  selectedId?: string;
  partial: boolean;
}) {
  const t = useT();
  const selectedSummary = selectedId ? items.find((item) => item.id === selectedId) : undefined;

  if (items.length === 0 && !selectedId) {
    return <OrchestrationEmpty title={t("agents.workflows.emptyTitle")} detail={t("agents.workflows.emptyDetail")} />;
  }

  return (
    <AgentsMasterDetail
      listLabel={t("agents.workflows.title")}
      detailOpen={Boolean(selectedId)}
      onBack={() => navigate("/agents/workflows")}
      list={(
        <>
          <MasterListHeader title={t("agents.workflows.title")} count={partial ? `${items.length}+` : items.length} />
          <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`workflow-row-${item.id}`}
                onClick={() => navigate(`/agents/workflows/${encodeURIComponent(item.id)}`)}
                className={masterRowClass(item.id === selectedId)}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{item.name}</span>
                    <span className="mt-1 block truncate text-[11.5px] text-[#7F837C] dark:text-[#858A82]">{item.ownerSessionTitle}</span>
                  </span>
                  <OrchestrationStatus value={item.status} compact />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="h-1 flex-1 overflow-hidden bg-[#DDE1D8] dark:bg-[#383B37]">
                    <span
                      className="block h-full bg-[#777D73] dark:bg-[#9A9F96]"
                      style={{ width: `${item.nodeCount ? item.completedNodeCount / item.nodeCount * 100 : 0}%` }}
                    />
                  </span>
                  <span className="font-mono text-[10px] text-[#777C74] dark:text-[#92968F]">{item.completedNodeCount}/{item.nodeCount}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      detail={selectedId
        ? <WorkflowDetail id={selectedId} summary={selectedSummary} />
        : <OrchestrationEmpty title={t("agents.selectTitle")} detail={t("agents.selectDetail")} />}
    />
  );
}

function WorkflowDetail({ id, summary }: { id: string; summary?: WorkflowSummaryRow }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useWorkflowDetailReadModel(id);
  const dependencies = useMemo(() => {
    if (state.status !== "ready") return new Map<string, string[]>();
    const result = new Map<string, string[]>();
    for (const edge of state.data.edges) {
      const current = result.get(edge.to) ?? [];
      current.push(edge.from);
      result.set(edge.to, current);
    }
    return result;
  }, [state]);

  if (state.status === "loading") return <ReadModelLoading rows={6} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  const workflow = state.data;
  return (
    <article data-testid="workflow-detail">
      <DetailHeader
        eyebrow={t("agents.workflows.workflow")}
        title={workflow.name}
        trailing={<OrchestrationStatus value={workflow.status} />}
      />
      <dl className="border-b border-[#DDE1D8] dark:border-[#383B37]">
        <DefinitionRow label={t("agents.workflows.owner")}>{summary?.ownerSessionTitle ?? workflow.ownerSessionId}</DefinitionRow>
        <DefinitionRow label={t("agents.workflows.progress")}>{t("agents.workflows.nodesDone", { done: workflow.completedNodeCount, total: workflow.nodeCount })}</DefinitionRow>
        <DefinitionRow label={t("agents.workflows.revision")}>{workflow.graphRevision}</DefinitionRow>
        <DefinitionRow label={t("agents.activity.updated")}>{relativeTime(workflow.updatedAt)}</DefinitionRow>
      </dl>
      <section className="px-5 py-5 @2xl/agents-body:px-7 @2xl/agents-body:py-6">
        <div className="flex items-center justify-between">
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#777C74]">{t("agents.workflows.graph")}</h3>
          <GitMerge className="size-3.5 text-[#9A9E97] dark:text-[#686D65]" strokeWidth={1.5} />
        </div>
        <ol className="mt-3 border-t border-[#DDE1D8] dark:border-[#383B37]">
          {workflow.nodes.map((node, index) => {
            const parents = dependencies.get(node.id) ?? [];
            return (
              <li key={node.id} className="grid min-h-[58px] grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#E8EBE3] dark:border-[#343632]">
                <span className="font-mono text-[10.5px] text-[#A0A49D] dark:text-[#686D65]">{String(index + 1).padStart(2, "0")}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[#3A3E38] dark:text-[#D7DAD4]">{node.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[#858981] dark:text-[#777C74]">
                    {node.kind} · {node.effect}{parents.length ? ` · ${t("agents.workflows.after", { count: parents.length })}` : ""}
                  </span>
                </span>
                <OrchestrationStatus value={node.status} />
              </li>
            );
          })}
        </ol>
        {(workflow.nodesPartial || workflow.edgesPartial) && (
          <p className="mt-2 text-[10.5px] text-[#777C74] dark:text-[#92968F]">{t("agents.workflows.partialGraph")}</p>
        )}
        <Link
          to={`/s/${workflow.ownerSessionId}`}
          className="mt-6 inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[#DDE1D8] px-2.5 text-[12px] font-medium text-[#464A44] transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.04] active:scale-[.97] dark:border-[#3A3D39] dark:text-[#D4D6D1] dark:hover:bg-white/[0.05] motion-reduce:transition-none"
        >
          {t("agents.openSession")}
          <ArrowUpRight className="size-3.5" strokeWidth={1.7} />
        </Link>
      </section>
    </article>
  );
}
