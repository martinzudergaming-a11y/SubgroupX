import { ArrowLeft, Braces, Check, GitBranch, ListTodo } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../i18n";
import { activityLabel, OrchestrationStatus, useRelativeTime } from "../../../orchestration/OrchestrationStatus";
import { OrchestrationEmpty, ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import {
  useAgentDetailReadModel,
  useTaskDetailReadModel,
  useTaskResultReadModel,
} from "../../../orchestration/read-model";

export type RunSelection = { kind: "agent" | "task"; id: string };

function BackButton({ onBack }: { onBack: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex h-10 w-full items-center gap-1.5 border-b border-[#E8EBE3] px-3 text-[12px] font-medium text-[#656A63] hover:bg-black/[0.025] active:bg-black/[0.045] dark:border-[#343632] dark:text-[#A5A9A1] dark:hover:bg-white/[0.035] @xl/run:hidden"
    >
      <ArrowLeft className="size-3.5" strokeWidth={1.7} />
      {t("agents.back")}
    </button>
  );
}

function DetailHeading({ icon, eyebrow, title, status }: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  status: React.ReactNode;
}) {
  return (
    <header className="border-b border-[#DDE1D8] px-4 py-4 dark:border-[#383B37]">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6F746C] dark:text-[#A0A59C]">{icon}{eyebrow}</div>
      <div className="mt-1.5 flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 text-[15px] font-semibold leading-[1.35] text-[#30332F] dark:text-[#E4E6E1]">{title}</h3>
        {status}
      </div>
    </header>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[6.2rem_minmax(0,1fr)] items-center border-b border-[#EEF0EB] px-4 py-2 text-[11.5px] last:border-b-0 dark:border-[#30322F]">
      <dt className="text-[#6F746C] dark:text-[#A0A59C]">{label}</dt>
      <dd className="min-w-0 truncate text-[#41453F] dark:text-[#C9CCC6]">{children}</dd>
    </div>
  );
}

function jsonPreview(value: unknown): { text: string; truncated: boolean } {
  const raw = JSON.stringify(value, null, 2) ?? "null";
  return raw.length > 8_000 ? { text: `${raw.slice(0, 8_000)}\n…`, truncated: true } : { text: raw, truncated: false };
}

export function RunDetail({ selection, revision, onBack }: {
  selection: RunSelection | null;
  revision: number;
  onBack: () => void;
}) {
  const t = useT();
  if (!selection) {
    return <OrchestrationEmpty title={t("run.selectTitle")} detail={t("run.selectDetail")} />;
  }
  return selection.kind === "agent"
    ? <AgentDetail key={selection.id} id={selection.id} revision={revision} onBack={onBack} />
    : <TaskDetail key={selection.id} id={selection.id} revision={revision} onBack={onBack} />;
}

function AgentDetail({ id, revision, onBack }: { id: string; revision: number; onBack: () => void }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useAgentDetailReadModel(id, revision);
  return (
    <div data-testid="run-agent-detail" className="min-h-full">
      <BackButton onBack={onBack} />
      {state.status === "loading" ? <ReadModelLoading rows={4} /> : state.status === "error" ? <ReadModelError onRetry={retry} /> : (
        <>
          <DetailHeading icon={<GitBranch className="size-3.5" strokeWidth={1.5} />} eyebrow={t("run.agent")} title={state.data.label ?? t("run.unnamedAgent")} status={<OrchestrationStatus value={state.data.status} />} />
          <dl>
            <DetailRow label={t("run.address")}>{state.data.path}</DetailRow>
            <DetailRow label={t("run.kind")}>{state.data.kind}</DetailRow>
            <DetailRow label={t("run.model")}>{state.data.model ?? "—"}</DetailRow>
            <DetailRow label={t("run.provider")}>{state.data.provider ?? "—"}</DetailRow>
            <DetailRow label={t("agents.activity.updated")}>{relativeTime(state.data.updatedAt)}</DetailRow>
          </dl>
        </>
      )}
    </div>
  );
}

function TaskDetail({ id, revision, onBack }: { id: string; revision: number; onBack: () => void }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useTaskDetailReadModel(id, revision);
  const [showResult, setShowResult] = useState(false);
  return (
    <div data-testid="run-task-detail" className="min-h-full">
      <BackButton onBack={onBack} />
      {state.status === "loading" ? <ReadModelLoading rows={5} /> : state.status === "error" ? <ReadModelError onRetry={retry} /> : (() => {
        const payload = jsonPreview(state.data.payload);
        return (
          <>
            <DetailHeading icon={<ListTodo className="size-3.5" strokeWidth={1.5} />} eyebrow={t("run.task")} title={state.data.title} status={<OrchestrationStatus value={state.data.status} />} />
            <dl>
              <DetailRow label={t("agents.activity.mode")}>{state.data.awaitPolicy === "background" ? t("agents.background") : t("agents.joined")}</DetailRow>
              <DetailRow label={t("run.activity")}>{t(activityLabel(state.data.activity))}</DetailRow>
              <DetailRow label={t("run.waitReason")}>{state.data.waitReason ?? "—"}</DetailRow>
              <DetailRow label={t("agents.activity.updated")}>{relativeTime(state.data.updatedAt)}</DetailRow>
            </dl>
            <section className="border-t border-[#DDE1D8] dark:border-[#383B37]">
              <div className="flex h-9 items-center gap-1.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6F746C] dark:text-[#A0A59C]"><Braces className="size-3.5" strokeWidth={1.5} />{t("run.assignment")}</div>
              <pre className="max-h-72 overflow-auto border-t border-[#EEF0EB] bg-[#F7F7F3] px-4 py-3 text-[10.5px] leading-[1.55] text-[#4B5048] dark:border-[#30322F] dark:bg-[#171815] dark:text-[#BEC2BA]">{payload.text}</pre>
              {payload.truncated && <p className="px-4 py-2 text-[10.5px] text-[#6F746C] dark:text-[#A0A59C]">{t("run.payloadTruncated")}</p>}
            </section>
            {state.data.result && (
              <section className="border-t border-[#DDE1D8] px-4 py-4 dark:border-[#383B37]">
                <p className="text-[12px] leading-[1.5] text-[#555A53] dark:text-[#B3B7AF]">{state.data.result.summary}{state.data.result.summaryTruncated ? ` ${t("run.summaryTruncated")}` : ""}</p>
                <button type="button" onClick={() => setShowResult((value) => !value)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[#DDE1D8] px-2.5 text-[12px] font-medium text-[#464A44] hover:bg-black/[0.04] active:scale-[.97] dark:border-[#3A3D39] dark:text-[#D4D6D1] dark:hover:bg-white/[0.05]">
                  <Check className="size-3.5" strokeWidth={1.7} />{showResult ? t("run.hideResult") : t("run.showResult")}
                </button>
                {showResult && <TaskResult taskId={id} revision={revision} />}
              </section>
            )}
          </>
        );
      })()}
    </div>
  );
}

function TaskResult({ taskId, revision }: { taskId: string; revision: number }) {
  const { state, retry } = useTaskResultReadModel(taskId, revision);
  if (state.status === "loading") return <ReadModelLoading rows={2} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  const body = jsonPreview(state.data.body);
  return <pre className="mt-3 max-h-72 overflow-auto border border-[#E8EBE3] bg-[#F7F7F3] px-3 py-3 text-[10.5px] leading-[1.55] text-[#4B5048] dark:border-[#343632] dark:bg-[#171815] dark:text-[#BEC2BA]">{body.text}</pre>;
}
