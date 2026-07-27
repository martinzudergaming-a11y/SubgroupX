import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentListItem,
  AgentNodeStatus,
  AgentReadDetail,
  AgentRosterCounts,
  OrchestrationActivityItem,
  OrchestrationActivityPage,
  OrchestrationPage,
  RuntimeTaskListItem,
  RuntimeTaskReadDetail,
  SessionRunSnapshot as SessionRunWireSnapshot,
  TaskActivityCode,
  TaskAwaitPolicy,
  TaskKind,
  TaskResultReadDetail,
  TaskStatus,
  TeamListItem,
  TeamListPage,
  TeamMailListItem,
  TeamMailReadDetail,
  TeamMembershipListItem,
  WorkflowListItem,
  WorkflowListPage,
} from "@shared/orchestration";
import { api, ApiError } from "../platform/api";
import { useOrchestrationInvalidation } from "./invalidation-store";

const TERMINAL_TASKS = new Set<TaskStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const PRODUCT_COLLECTION_LIMIT = 100;

export interface RunAgentRow {
  id: string;
  parentId?: string;
  label: string;
  status: AgentNodeStatus;
  activity?: TaskActivityCode;
  currentTask?: string;
  updatedAt: number;
}

export interface BackgroundTaskRow {
  id: string;
  title: string;
  agentId: string;
  agentLabel: string;
  status: TaskStatus;
  awaitPolicy: TaskAwaitPolicy;
  kind: TaskKind;
  teamId?: string;
  activity?: TaskActivityCode;
  waitReason?: string;
  updatedAt: number;
}

export interface SessionRunViewSnapshot {
  sessionId: string;
  revision: number;
  counts: AgentRosterCounts;
  agents: RunAgentRow[];
  backgroundTasks: BackgroundTaskRow[];
  latestTeamTask?: BackgroundTaskRow;
  nextAgentCursor?: string;
  nextTaskCursor?: string;
  workflows: WorkflowListItem[];
  workflowsPartial: boolean;
  teams: TeamMembershipListItem[];
  teamsPartial: boolean;
}

export interface ActivityRow extends BackgroundTaskRow {
  sessionId: string;
  sessionTitle: string;
  summary?: string;
  startedAt?: number;
  settledAt?: number;
}

export interface ActivityViewPage {
  revision: number;
  items: ActivityRow[];
  nextCursor?: string;
}

export type WorkflowSummaryRow = WorkflowListItem & { ownerSessionTitle: string };
export interface WorkflowViewPage {
  items: WorkflowSummaryRow[];
  nextCursor?: string;
}

export type TeamSummaryRow = TeamListItem & { ownerSessionTitle: string };
export interface TeamViewPage {
  items: TeamSummaryRow[];
  nextCursor?: string;
}

function agentLabel(agent: Pick<AgentListItem, "id" | "label" | "kind">): string {
  return agent.label?.trim() || (agent.kind === "session" ? "Session Agent" : `Agent ${agent.id.slice(-4)}`);
}

function taskRow(task: RuntimeTaskListItem, agents: ReadonlyMap<string, AgentListItem>): BackgroundTaskRow {
  const agent = agents.get(task.agentId);
  return {
    id: task.id,
    title: task.title,
    agentId: task.agentId,
    agentLabel: agent ? agentLabel(agent) : `Agent ${task.agentId.slice(-4)}`,
    status: task.status,
    awaitPolicy: task.awaitPolicy,
    kind: task.kind,
    ...(task.teamId ? { teamId: task.teamId } : {}),
    ...(task.activity ? { activity: task.activity } : {}),
    ...(task.waitReason ? { waitReason: task.waitReason } : {}),
    updatedAt: task.updatedAt,
  };
}

export function adaptSessionRun(wire: SessionRunWireSnapshot): SessionRunViewSnapshot {
  const agentsById = new Map(wire.agents.items.map((agent) => [agent.id, agent]));
  const latestOpenTask = new Map<string, RuntimeTaskListItem>();
  for (const task of wire.tasks.items) {
    if (TERMINAL_TASKS.has(task.status)) continue;
    const current = latestOpenTask.get(task.agentId);
    if (!current || current.updatedAt < task.updatedAt) latestOpenTask.set(task.agentId, task);
  }
  return {
    sessionId: wire.sessionId,
    revision: wire.revision,
    counts: wire.counts,
    agents: wire.agents.items.map((agent) => {
      const current = latestOpenTask.get(agent.id);
      return {
        id: agent.id,
        ...(agent.parentAgentId ? { parentId: agent.parentAgentId } : {}),
        label: agentLabel(agent),
        status: agent.status,
        ...(current?.activity ? { activity: current.activity } : {}),
        ...(current ? { currentTask: current.title } : {}),
        updatedAt: agent.updatedAt,
      };
    }),
    backgroundTasks: wire.tasks.items
      .filter((task) => task.awaitPolicy === "background")
      .map((task) => taskRow(task, agentsById)),
    ...(wire.latestTeamTask
      ? { latestTeamTask: taskRow(wire.latestTeamTask, agentsById) }
      : {}),
    ...(wire.agents.nextCursor ? { nextAgentCursor: wire.agents.nextCursor } : {}),
    ...(wire.tasks.nextCursor ? { nextTaskCursor: wire.tasks.nextCursor } : {}),
    workflows: wire.linkedWorkflows.items,
    workflowsPartial: wire.linkedWorkflows.partial,
    teams: wire.teamMemberships.items,
    teamsPartial: wire.teamMemberships.partial,
  };
}

function adaptActivityItem(
  item: OrchestrationActivityItem,
  sessions: ReadonlyMap<string, string>,
): ActivityRow {
  const task = item.task;
  return {
    id: task.id,
    title: task.title,
    agentId: task.agentId,
    agentLabel: item.agent.label?.trim() || `Agent ${item.agent.id.slice(-4)}`,
    sessionId: task.sessionId,
    sessionTitle: sessions.get(task.sessionId) ?? "Untitled session",
    status: task.status,
    awaitPolicy: task.awaitPolicy,
    kind: task.kind,
    ...(task.teamId ? { teamId: task.teamId } : {}),
    ...(task.activity ? { activity: task.activity } : {}),
    ...(task.waitReason ? { waitReason: task.waitReason } : {}),
    ...(task.result?.summary ? { summary: task.result.summary } : {}),
    updatedAt: task.updatedAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.settledAt ? { settledAt: task.settledAt } : {}),
  };
}

export function adaptActivityPage(wire: OrchestrationActivityPage): ActivityViewPage {
  const sessions = new Map(wire.sessions.map((session) => [session.id, session.title]));
  return {
    revision: wire.revision,
    items: wire.items.map((item) => adaptActivityItem(item, sessions)),
    ...(wire.nextCursor ? { nextCursor: wire.nextCursor } : {}),
  };
}

function adaptWorkflowPage(wire: WorkflowListPage): WorkflowViewPage {
  const sessions = new Map(wire.sessions.map((session) => [session.id, session.title]));
  return {
    items: wire.items.map((workflow) => ({
      ...workflow,
      ownerSessionTitle: sessions.get(workflow.ownerSessionId) ?? "Untitled session",
    })),
    ...(wire.nextCursor ? { nextCursor: wire.nextCursor } : {}),
  };
}

function adaptTeamPage(wire: TeamListPage): TeamViewPage {
  const sessions = new Map(wire.sessions.map((session) => [session.id, session.title]));
  return {
    items: wire.items.map((team) => ({
      ...team,
      ownerSessionTitle: team.ownerSessionId ? (sessions.get(team.ownerSessionId) ?? "Untitled session") : "",
    })),
    ...(wire.nextCursor ? { nextCursor: wire.nextCursor } : {}),
  };
}

function isCursorStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export type ReadModelState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; refreshing: boolean }
  | { status: "error" };

function useReadModel<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadModelState<T>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => current.status === "ready"
      ? { ...current, refreshing: true }
      : { status: "loading" });
    void load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, refreshing: false });
      },
      () => {
        if (!controller.signal.aborted) {
          setState((current) => current.status === "ready"
            ? { ...current, refreshing: false }
            : { status: "error" });
        }
      },
    );
    return () => controller.abort();
  }, [key, attempt, load]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const update = useCallback((fn: (current: T) => T) => {
    setState((current) => current.status === "ready"
      ? { status: "ready", data: fn(current.data), refreshing: current.refreshing }
      : current);
  }, []);
  return { state, retry, update };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

export function useSessionRunReadModel(sessionId: string) {
  const sessionInvalidation = useOrchestrationInvalidation(`session:${sessionId}`);
  const workflowInvalidation = useOrchestrationInvalidation("workflows");
  const teamInvalidation = useOrchestrationInvalidation("teams");
  const invalidation = `${sessionInvalidation}:${workflowInvalidation}:${teamInvalidation}`;
  const paginationEpoch = `${sessionId}:${invalidation}`;
  const paginationEpochRef = useRef(paginationEpoch);
  paginationEpochRef.current = paginationEpoch;
  const load = useCallback(
    (signal: AbortSignal) => api.sessionRunSnapshot(sessionId, {}, signal).then(adaptSessionRun),
    [sessionId],
  );
  const resource = useReadModel(`session:${sessionId}:${invalidation}`, load);
  const moreController = useRef<AbortController | null>(null);
  const [loadingMore, setLoadingMore] = useState<"agents" | "tasks" | null>(null);
  useEffect(() => {
    moreController.current?.abort();
    moreController.current = null;
    setLoadingMore(null);
    return () => {
      moreController.current?.abort();
      moreController.current = null;
    };
  }, [paginationEpoch]);
  const loadMore = useCallback(async (kind: "agents" | "tasks") => {
    if (resource.state.status !== "ready" || loadingMore) return;
    const cursor = kind === "agents"
      ? resource.state.data.nextAgentCursor
      : resource.state.data.nextTaskCursor;
    if (!cursor) return;
    const requestEpoch = paginationEpoch;
    const controller = new AbortController();
    moreController.current?.abort();
    moreController.current = controller;
    setLoadingMore(kind);
    try {
      const page = adaptSessionRun(await api.sessionRunSnapshot(
        sessionId,
        kind === "agents" ? { agentCursor: cursor } : { taskCursor: cursor },
        controller.signal,
      ));
      if (controller.signal.aborted || paginationEpochRef.current !== requestEpoch) return;
      resource.update((current) => ({
        ...current,
        agents: kind === "agents" ? mergeById(current.agents, page.agents) : current.agents,
        backgroundTasks: kind === "tasks"
          ? mergeById(current.backgroundTasks, page.backgroundTasks)
          : current.backgroundTasks,
        nextAgentCursor: kind === "agents" ? page.nextAgentCursor : current.nextAgentCursor,
        nextTaskCursor: kind === "tasks" ? page.nextTaskCursor : current.nextTaskCursor,
      }));
    } catch (error) {
      if (
        !controller.signal.aborted
        && paginationEpochRef.current === requestEpoch
        && isCursorStale(error)
      ) resource.retry();
    } finally {
      if (moreController.current === controller) {
        moreController.current = null;
        if (!controller.signal.aborted && paginationEpochRef.current === requestEpoch) {
          setLoadingMore(null);
        }
      }
    }
  }, [loadingMore, paginationEpoch, resource, sessionId]);
  return { ...resource, loadingMore, loadMore };
}

export function useActivityReadModel() {
  const invalidation = useOrchestrationInvalidation("activity");
  const paginationEpochRef = useRef(invalidation);
  paginationEpochRef.current = invalidation;
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationActivitySnapshot(undefined, signal).then(adaptActivityPage),
    [],
  );
  const resource = useReadModel(`activity:${invalidation}`, load);
  const moreController = useRef<AbortController | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    moreController.current?.abort();
    moreController.current = null;
    setLoadingMore(false);
    return () => {
      moreController.current?.abort();
      moreController.current = null;
    };
  }, [invalidation]);
  const loadMore = useCallback(async () => {
    if (resource.state.status !== "ready" || loadingMore || !resource.state.data.nextCursor) return;
    const requestEpoch = invalidation;
    const controller = new AbortController();
    moreController.current?.abort();
    moreController.current = controller;
    setLoadingMore(true);
    try {
      const page = adaptActivityPage(await api.orchestrationActivitySnapshot(
        resource.state.data.nextCursor,
        controller.signal,
      ));
      if (controller.signal.aborted || paginationEpochRef.current !== requestEpoch) return;
      resource.update((current) => ({
        revision: page.revision,
        items: mergeById(current.items, page.items),
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      if (
        !controller.signal.aborted
        && paginationEpochRef.current === requestEpoch
        && isCursorStale(error)
      ) resource.retry();
    } finally {
      if (moreController.current === controller) {
        moreController.current = null;
        if (!controller.signal.aborted && paginationEpochRef.current === requestEpoch) {
          setLoadingMore(false);
        }
      }
    }
  }, [invalidation, loadingMore, resource]);
  return { ...resource, loadingMore, loadMore };
}

export function useWorkflowsReadModel() {
  const invalidation = useOrchestrationInvalidation("workflows");
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationWorkflowList(
      { limit: PRODUCT_COLLECTION_LIMIT },
      signal,
    ).then(adaptWorkflowPage),
    [],
  );
  return useReadModel(`workflows:${invalidation}`, load);
}

export function useWorkflowDetailReadModel(workflowId: string) {
  const invalidation = useOrchestrationInvalidation(`workflow:${workflowId}`);
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationWorkflowDetail(workflowId, signal).then((value) => value.workflow),
    [workflowId],
  );
  return useReadModel(`workflow:${workflowId}:${invalidation}`, load);
}

export function useTeamsReadModel() {
  const invalidation = useOrchestrationInvalidation("teams");
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTeamList(
      { limit: PRODUCT_COLLECTION_LIMIT },
      signal,
    ).then(adaptTeamPage),
    [],
  );
  return useReadModel(`teams:${invalidation}`, load);
}

export function useTeamDetailReadModel(teamId: string) {
  const invalidation = useOrchestrationInvalidation(`team:${teamId}`);
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTeamDetail(teamId, signal).then((value) => value.team),
    [teamId],
  );
  return useReadModel(`team:${teamId}:${invalidation}`, load);
}

export function useTeamMailReadModel(teamId: string) {
  const invalidation = useOrchestrationInvalidation(`team:${teamId}`);
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTeamMail(
      teamId,
      { limit: PRODUCT_COLLECTION_LIMIT },
      signal,
    ),
    [teamId],
  );
  return useReadModel<OrchestrationPage<TeamMailListItem>>(`team-mail:${teamId}:${invalidation}`, load);
}

export function useTeamMailDetailReadModel(teamId: string, mailId: string) {
  const invalidation = useOrchestrationInvalidation(`team:${teamId}`);
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTeamMailDetail(teamId, mailId, signal).then((value) => value.mail),
    [teamId, mailId],
  );
  return useReadModel<TeamMailReadDetail>(`team-mail:${teamId}:${mailId}:${invalidation}`, load);
}

export function useAgentDetailReadModel(agentId: string, revision = 0) {
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationAgentDetail(agentId, signal).then((value) => value.agent),
    [agentId],
  );
  return useReadModel<AgentReadDetail>(`agent:${agentId}:${revision}`, load);
}

export function useTaskDetailReadModel(taskId: string, revision = 0) {
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTaskDetail(taskId, signal).then((value) => value.task),
    [taskId],
  );
  return useReadModel<RuntimeTaskReadDetail>(`task:${taskId}:${revision}`, load);
}

export function useTaskResultReadModel(taskId: string, revision = 0) {
  const load = useCallback(
    (signal: AbortSignal) => api.orchestrationTaskResult(taskId, signal).then((value) => value.result),
    [taskId],
  );
  return useReadModel<TaskResultReadDetail>(`result:${taskId}:${revision}`, load);
}
