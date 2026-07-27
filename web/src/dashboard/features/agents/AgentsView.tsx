import { Activity, Users, Waypoints, Workflow } from "lucide-react";
import { ViewHeader } from "../../ui/ViewHeader.tsx";
import type { ComponentType } from "react";
import { useT } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/en";
import { Link } from "../../../platform/router";
import { ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import {
  useActivityReadModel,
  useTeamsReadModel,
  useWorkflowsReadModel,
} from "../../../orchestration/read-model";
import { ActivitySection } from "./ActivitySection";
import { TeamsSection } from "./TeamsSection";
import { WorkflowsSection } from "./WorkflowsSection";
import type { AgentsSection } from "../../types";

const SECTION_PATH: Record<AgentsSection, string> = {
  activity: "/agents/activity",
  workflows: "/agents/workflows",
  teams: "/agents/teams",
};

const SECTION_ICON: Record<AgentsSection, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  activity: Activity,
  workflows: Workflow,
  teams: Users,
};

export function AgentsView({
  section,
  selectedId,
  selectedSubId,
  isLeftSidebarOpen,
  onOpenLeftSidebar,
}: {
  section: AgentsSection;
  selectedId?: string;
  selectedSubId?: string;
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
}) {
  const t = useT();
  return (
    <div data-testid="agents-view" className="@container/agents flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <ViewHeader
        icon={Waypoints}
        title={t("agents.title")}
        subtitle={t("agents.subtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
      />

      <nav aria-label={t("agents.sections")} className="flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-[#DDE1D8] px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden dark:border-[#383B37] sm:px-3">
        {(Object.keys(SECTION_PATH) as AgentsSection[]).map((key) => {
          const Icon = SECTION_ICON[key];
          const active = section === key;
          return (
            <Link
              key={key}
              to={SECTION_PATH[key]}
              aria-current={active ? "page" : undefined}
              data-testid={`agents-tab-${key}`}
              className={`relative flex shrink-0 items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors sm:px-3 ${active ? "text-[#2E312D] dark:text-[#ECEEE9]" : "text-[#7D817A] hover:text-[#3E423C] dark:text-[#7F847B] dark:hover:text-[#D1D4CE]"}`}
            >
              <Icon className="size-3.5" strokeWidth={1.55} />
              {t(`agents.${key}.title` as TranslationKey)}
              {active && <span aria-hidden className="absolute inset-x-2.5 bottom-0 h-px bg-[#5F655C] dark:bg-[#B2B6AD]" />}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        {section === "activity" ? (
          <ActivityResource selectedId={selectedId} />
        ) : section === "workflows" ? (
          <WorkflowResource selectedId={selectedId} />
        ) : (
          <TeamResource selectedId={selectedId} selectedMailId={selectedSubId} />
        )}
      </div>
    </div>
  );
}

function ActivityResource({ selectedId }: { selectedId?: string }) {
  const { state, retry, loadingMore, loadMore } = useActivityReadModel();
  if (state.status === "loading") return <ReadModelLoading rows={7} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  return (
    <ActivitySection
      items={state.data.items}
      selectedId={selectedId}
      partial={Boolean(state.data.nextCursor)}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
    />
  );
}

function WorkflowResource({ selectedId }: { selectedId?: string }) {
  const { state, retry } = useWorkflowsReadModel();
  if (state.status === "loading") return <ReadModelLoading rows={7} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  return <WorkflowsSection items={state.data.items} selectedId={selectedId} partial={Boolean(state.data.nextCursor)} />;
}

function TeamResource({ selectedId, selectedMailId }: { selectedId?: string; selectedMailId?: string }) {
  const { state, retry } = useTeamsReadModel();
  if (state.status === "loading") return <ReadModelLoading rows={7} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  return <TeamsSection items={state.data.items} selectedId={selectedId} selectedMailId={selectedMailId} partial={Boolean(state.data.nextCursor)} />;
}
