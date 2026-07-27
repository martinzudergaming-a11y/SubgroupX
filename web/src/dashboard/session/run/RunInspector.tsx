import { ArrowUpRight, GitBranch, Network, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../../../platform/router";
import { useT } from "../../../i18n";
import { activityLabel, OrchestrationStatus, useRelativeTime } from "../../../orchestration/OrchestrationStatus";
import { OrchestrationEmpty, ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import { useSessionRunReadModel, type RunAgentRow } from "../../../orchestration/read-model";
import { RunDetail, type RunSelection } from "./RunDetail";

function AgentTreeRow({ agent, depth, selected, onSelect }: {
  agent: RunAgentRow;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      data-testid={`run-agent-${agent.id}`}
      onClick={onSelect}
      className={`relative grid min-h-[54px] w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-[#EEF0EB] py-2.5 pr-3 text-left last:border-b-0 dark:border-[#30322F] ${selected ? "bg-black/[0.035] dark:bg-white/[0.045]" : "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"}`}
      style={{ paddingLeft: `${12 + depth * 18}px` }}
    >
      {depth > 0 && (
        <span aria-hidden className="absolute top-0 h-[27px] w-3 border-b border-l border-[#D8DCD4] dark:border-[#3C3F3B]" style={{ left: `${3 + depth * 18}px` }} />
      )}
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-[#343733] dark:text-[#E0E2DE]">{agent.label}</span>
        </span>
        <span className="mt-1 block truncate text-[11.5px] text-[#686D65] dark:text-[#9A9F96]">{agent.currentTask ?? t(activityLabel(agent.activity))}</span>
      </span>
      <span className="flex flex-col items-end justify-center gap-1">
        <OrchestrationStatus value={agent.status} />
        <span className="text-[10.5px] tabular-nums text-[#6F746C] dark:text-[#A0A59C]">{relativeTime(agent.updatedAt)}</span>
      </span>
    </button>
  );
}

export function RunInspector({ sessionId }: { sessionId: string }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry, loadingMore, loadMore } = useSessionRunReadModel(sessionId);
  const [selection, setSelection] = useState<RunSelection | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setSelection(null), [sessionId]);

  const agents = useMemo(() => {
    if (state.status !== "ready") return [];
    const byParent = new Map<string | undefined, RunAgentRow[]>();
    const ids = new Set(state.data.agents.map((agent) => agent.id));
    for (const agent of state.data.agents) {
      const parentId = agent.parentId && ids.has(agent.parentId) ? agent.parentId : undefined;
      const siblings = byParent.get(parentId) ?? [];
      siblings.push(agent);
      byParent.set(parentId, siblings);
    }
    for (const siblings of byParent.values()) siblings.sort((a, b) => a.label.localeCompare(b.label));
    const rows: { agent: RunAgentRow; depth: number }[] = [];
    const seen = new Set<string>();
    const visit = (agent: RunAgentRow, depth: number) => {
      if (seen.has(agent.id)) return;
      seen.add(agent.id);
      rows.push({ agent, depth });
      for (const child of byParent.get(agent.id) ?? []) visit(child, depth + 1);
    };
    for (const root of byParent.get(undefined) ?? []) visit(root, 0);
    for (const agent of state.data.agents) if (!seen.has(agent.id)) visit(agent, 0);
    return rows;
  }, [state]);

  if (state.status === "loading") {
    return <div className="h-full overflow-y-auto"><RunHeader /><ReadModelLoading rows={5} /></div>;
  }
  if (state.status === "error") {
    return <div className="h-full overflow-y-auto"><RunHeader /><ReadModelError onRetry={retry} /></div>;
  }

  const { backgroundTasks, workflows, teams } = state.data;
  const empty = agents.length === 0 && backgroundTasks.length === 0 && workflows.length === 0 && teams.length === 0;
  return (
    <div data-testid="run-inspector" className="@container/run flex h-full min-h-0 flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <RunHeader />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`${selection ? "hidden" : "flex"} min-h-0 w-full flex-col border-r border-[#DDE1D8] bg-[var(--app-frame)] dark:border-[#383B37] dark:bg-[#1E1E1E] @xl/run:flex @xl/run:w-[46%] @xl/run:min-w-[15rem] @xl/run:max-w-[22rem]`}>
          <div ref={listScrollRef} data-testid="run-list" className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
            {empty ? (
              <OrchestrationEmpty title={t("run.emptyTitle")} detail={t("run.emptyDetail")} />
            ) : (
              <>
                <section aria-labelledby="run-agent-tree-heading">
                  <SectionHeading id="run-agent-tree-heading" label={t("run.agentTree")} value={state.data.nextAgentCursor ? `${agents.length}+` : agents.length} />
                  <div role="tree" aria-label={t("run.agentTree")}>
                    {agents.length > 0 ? agents.map(({ agent, depth }) => (
                      <AgentTreeRow
                        key={agent.id}
                        agent={agent}
                        depth={depth}
                        selected={selection?.kind === "agent" && selection.id === agent.id}
                        onSelect={() => setSelection({ kind: "agent", id: agent.id })}
                      />
                    )) : <p className="px-3 pb-3 text-[12px] text-[#6F746C] dark:text-[#A0A59C]">{t("run.noAgents")}</p>}
                  </div>
                  {state.data.nextAgentCursor && <LoadMore label={t("run.moreAgents")} busy={loadingMore === "agents"} onClick={() => void loadMore("agents")} />}
                </section>

                <section aria-labelledby="run-background-heading" className="border-t border-[#DDE1D8] dark:border-[#383B37]">
                  <SectionHeading id="run-background-heading" label={t("run.backgroundTasks")} value={state.data.nextTaskCursor ? `${backgroundTasks.length}+` : backgroundTasks.length} />
                  {backgroundTasks.length > 0 ? backgroundTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      data-testid={`run-task-${task.id}`}
                      aria-pressed={selection?.kind === "task" && selection.id === task.id}
                      onClick={() => setSelection({ kind: "task", id: task.id })}
                      className={`w-full border-b border-[#EEF0EB] px-3 py-3 text-left last:border-b-0 dark:border-[#30322F] ${selection?.kind === "task" && selection.id === task.id ? "bg-black/[0.035] dark:bg-white/[0.045]" : "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"}`}
                    >
                      <span className="flex min-w-0 items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-medium text-[#343733] dark:text-[#E0E2DE]">{task.title}</span>
                          <span className="mt-1 block truncate text-[11.5px] text-[#686D65] dark:text-[#9A9F96]">{task.agentLabel} · {task.waitReason ?? t(activityLabel(task.activity))}</span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1"><OrchestrationStatus value={task.status} /><span className="text-[10.5px] tabular-nums text-[#6F746C] dark:text-[#A0A59C]">{relativeTime(task.updatedAt)}</span></span>
                      </span>
                    </button>
                  )) : <p className="px-3 pb-3 text-[12px] text-[#6F746C] dark:text-[#A0A59C]">{t("run.noBackground")}</p>}
                  {state.data.nextTaskCursor && <LoadMore label={t("run.moreTasks")} busy={loadingMore === "tasks"} onClick={() => void loadMore("tasks")} />}
                </section>

                {(workflows.length > 0 || teams.length > 0) && (
                  <section aria-labelledby="run-links-heading" className="border-t border-[#DDE1D8] dark:border-[#383B37]">
                    <SectionHeading id="run-links-heading" label={t("run.links")} />
                    {workflows.map((workflow) => <RunLink key={workflow.id} to={`/agents/workflows/${encodeURIComponent(workflow.id)}`} testId={`run-workflow-link-${workflow.id}`} icon={<Workflow className="size-[15px]" strokeWidth={1.5} />} title={workflow.name} detail={t("run.nodesDone", { done: workflow.completedNodeCount, total: workflow.nodeCount })} status={<OrchestrationStatus value={workflow.status} compact />} />)}
                    {teams.map((team) => <RunLink key={team.teamId} to={`/agents/teams/${encodeURIComponent(team.teamId)}`} testId={`run-team-link-${team.teamId}`} icon={<Network className="size-[15px]" strokeWidth={1.5} />} title={team.name} detail={t("run.members", { count: team.memberCount })} status={<OrchestrationStatus value={team.teamStatus} compact />} />)}
                    {(state.data.workflowsPartial || state.data.teamsPartial) && (
                      <p className="border-t border-[#E8EBE3] px-3 py-2 text-[10.5px] text-[#6F746C] dark:border-[#343632] dark:text-[#A0A59C]">
                        {t("run.partialLinks")}
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        <div className={`${selection ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @xl/run:flex`}>
          <RunDetail selection={selection} revision={state.data.revision} onBack={() => setSelection(null)} />
        </div>
      </div>
    </div>
  );
}

function RunHeader() {
  const t = useT();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#DDE1D8] px-3 dark:border-[#383B37]">
      <GitBranch className="size-[15px] text-[#656A63] dark:text-[#A0A49D]" strokeWidth={1.55} />
      <div className="min-w-0"><h2 className="text-[12.5px] font-semibold text-[#30332F] dark:text-[#E4E6E1]">{t("run.title")}</h2><p className="text-[10.5px] leading-none text-[#6F746C] dark:text-[#A0A59C]">{t("run.subtitle")}</p></div>
    </header>
  );
}

function SectionHeading({ id, label, value }: { id: string; label: string; value?: string | number }) {
  return <div className="flex h-8 items-center justify-between px-3"><h3 id={id} className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6F746C] dark:text-[#A0A59C]">{label}</h3>{value !== undefined && <span className="font-mono text-[10px] tabular-nums text-[#6F746C] dark:text-[#A0A59C]">{value}</span>}</div>;
}

function LoadMore({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return <button type="button" disabled={busy} onClick={onClick} className="h-9 w-full border-t border-[#E8EBE3] text-[11.5px] font-medium text-[#656A63] hover:bg-black/[0.025] disabled:opacity-60 dark:border-[#343632] dark:text-[#A5A9A1] dark:hover:bg-white/[0.035]">{busy ? "…" : label}</button>;
}

function RunLink({ to, testId, icon, title, detail, status }: { to: string; testId: string; icon: React.ReactNode; title: string; detail: string; status: React.ReactNode }) {
  return (
    <Link to={to} data-testid={testId} className="group grid min-h-[58px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#EEF0EB] px-3 text-[#343733] last:border-b-0 hover:bg-black/[0.025] dark:border-[#30322F] dark:text-[#E0E2DE] dark:hover:bg-white/[0.035]">
      <span className="text-[#777B75]">{icon}</span><span className="min-w-0"><span className="block truncate text-[12.5px] font-medium">{title}</span><span className="mt-0.5 block text-[11px] text-[#686D65] dark:text-[#9A9F96]">{detail}</span></span><span className="flex items-center gap-2">{status}<ArrowUpRight className="size-3.5 text-[#6F746C] group-hover:text-[#555A53] dark:text-[#A0A59C]" /></span>
    </Link>
  );
}
