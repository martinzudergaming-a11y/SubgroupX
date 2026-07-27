import { Buffer } from "node:buffer";
import type { StatementSync } from "node:sqlite";
import type {
  AgentListItem,
  AgentReadDetail,
  AgentRosterCounts,
  AgentThinkingLevel,
  AgentNodeKind,
  AgentNodeStatus,
  OrchestrationActivityPage,
  OrchestrationInvalidationSnapshot,
  OrchestrationJson,
  OrchestrationPage,
  OrchestrationPageCursor,
  RuntimeTaskListItem,
  RuntimeTaskReadDetail,
  SessionRunSnapshot,
  TeamListItem,
  TeamListPage,
  TeamMailDeliveryStatus,
  TeamMailKind,
  TeamMailListItem,
  TeamMailReadDetail,
  TeamMemberListItem,
  TeamMemberStatus,
  TeamMembershipListItem,
  TeamReadDetail,
  TeamStatus,
  TaskActivityCode,
  TaskAwaitPolicy,
  TaskCancelPolicy,
  TaskKind,
  TaskResultListItem,
  TaskResultReadDetail,
  TaskStatus,
  TaskWaitReasonCode,
  WorkflowCachePolicy,
  WorkflowEdgeCondition,
  WorkflowEdgeListItem,
  WorkflowEffect,
  WorkflowListItem,
  WorkflowListPage,
  WorkflowNodeKind,
  WorkflowNodeListItem,
  WorkflowNodeStatus,
  WorkflowReadDetail,
  WorkflowStatus,
} from "../../../shared/src/orchestration.ts";
import { db, runInTransaction } from "../persistence/core.ts";
import { VISIBLE_AGENT_ANCESTRY_SQL } from "../persistence/orchestration.ts";
import { normalizeSessionTitle } from "../persistence/sessions.ts";
import {
  ACCOUNT_VISIBLE_ORCHESTRATION_CTE,
  SESSION_VISIBLE_ORCHESTRATION_CTE,
  TASK_DETAIL_VISIBILITY_CTE,
} from "../persistence/orchestration-visibility.ts";

export {
  ACCOUNT_VISIBLE_ORCHESTRATION_CTE,
  SESSION_VISIBLE_ORCHESTRATION_CTE,
  TASK_DETAIL_VISIBILITY_CTE,
} from "../persistence/orchestration-visibility.ts";

export const ORCHESTRATION_READ_DEFAULT = 40;
export const ORCHESTRATION_READ_MAX = 100;
export const ORCHESTRATION_RESULT_PREVIEW_MAX_CHARS = 512;
export const ORCHESTRATION_WORKFLOW_NODE_MAX = 64;
export const ORCHESTRATION_WORKFLOW_EDGE_MAX = 256;
export const ORCHESTRATION_SESSION_LINK_MAX = 100;

export interface ReadModelCursor {
  scope: string;
  revision: number;
  updatedAt: number;
  id: string;
}

export interface SessionRunReadOptions {
  agentLimit?: number;
  agentBefore?: ReadModelCursor;
  taskLimit?: number;
  taskBefore?: ReadModelCursor;
}

export class OrchestrationCursorConflictError extends Error {
  override name = "OrchestrationCursorConflictError";

  constructor() {
    super("orchestration cursor is stale; restart this collection");
  }
}

interface AgentReadRow {
  id: string;
  session_id: string | null;
  root_agent_id: string;
  parent_agent_id: string | null;
  path?: string;
  label: string | null;
  provider: string | null;
  model: string | null;
  thinking_level: AgentThinkingLevel | null;
  kind: AgentNodeKind;
  status: AgentNodeStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TaskReadRow {
  id: string;
  session_id: string;
  owner_session_id: string;
  owner_turn_id: string | null;
  owner_step_id: string | null;
  agent_id: string;
  parent_task_id: string | null;
  workflow_id: string | null;
  team_id: string | null;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  await_policy: TaskAwaitPolicy;
  cancel_policy: TaskCancelPolicy;
  checkpoint_safe: number;
  activity: TaskActivityCode | null;
  wait_reason: TaskWaitReasonCode | null;
  version: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  settled_at: number | null;
  result_id: string | null;
  result_summary: string | null;
  result_summary_truncated: number | null;
  result_version: number | null;
  result_created_at: number | null;
  result_acknowledged_at: number | null;
}

interface TaskDetailRow extends TaskReadRow {
  payload_json: string;
  agent_ord: number;
  lease_generation: number;
}

interface ResultReadRow {
  id: string;
  task_id: string;
  summary: string;
  body_json: string;
  artifacts_json: string;
  version: number;
  created_at: number;
  acknowledged_at: number | null;
}

interface ActivityReadRow extends TaskReadRow {
  agent_label: string | null;
  agent_status: AgentNodeStatus;
}

interface WorkflowListRow {
  id: string;
  owner_session_id: string;
  controller_agent_id?: string | null;
  name: string;
  status: WorkflowStatus;
  definition_version: number;
  graph_revision: number;
  graph_sealed: number;
  run_revision: number;
  node_count: number;
  completed_node_count: number;
  active_node_count: number;
  max_nodes?: number;
  max_edges?: number;
  max_depth?: number;
  max_attempts?: number;
  max_runtime_ms?: number;
  max_tokens?: number;
  max_cost_micros?: number;
  attempts_used?: number;
  tokens_used?: number;
  tokens_reserved?: number;
  cost_used_micros?: number;
  cost_reserved_micros?: number;
  version: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  settled_at: number | null;
}

interface WorkflowNodeReadRow {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  effect: WorkflowEffect;
  cache_policy: WorkflowCachePolicy;
  status: "blocked" | "ready" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  execution_phase: TaskStatus | null;
  executor_agent_id: string | null;
  depth: number;
  max_attempts: number;
  attempt_count: number;
  expanded_by_node_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

interface WorkflowEdgeReadRow {
  from_node_id: string;
  to_node_id: string;
  condition: WorkflowEdgeCondition;
}

interface TeamListRow {
  id: string;
  owner_session_id: string | null;
  owner_available: number;
  lead_agent_id?: string | null;
  name: string;
  status: TeamStatus;
  member_count: number;
  active_member_count: number;
  queued_mail: number;
  claimed_mail: number;
  open_work: number;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TeamMemberReadRow {
  id: string;
  session_id: string;
  session_title: string;
  agent_id: string;
  role: string;
  status: TeamMemberStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TeamMembershipReadRow {
  team_id: string;
  name: string;
  team_status: TeamStatus;
  member_id: string;
  role: string;
  member_status: TeamMemberStatus;
  member_count: number;
  unread_mail: number;
  version: number;
  updated_at: number;
}

interface TeamMailReadRow {
  id: string;
  team_id: string;
  seq: number;
  source_member_id: string;
  source_session_id: string;
  target_member_id: string;
  target_session_id: string;
  kind: TeamMailKind;
  subject: string;
  parent_mail_id: string | null;
  task_id: string | null;
  status: TeamMailDeliveryStatus;
  payload_bytes: number;
  payload_json?: string;
  version: number;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  acknowledged_at: number | null;
  cursor_position: number;
}

const AGENT_LIST_COLUMNS = `
  a.id, a.session_id, a.root_agent_id, a.parent_agent_id, a.label,
  a.provider, a.model, a.thinking_level, a.kind, a.status,
  a.version, a.created_at, a.updated_at`;
const AGENT_DETAIL_COLUMNS = `${AGENT_LIST_COLUMNS}, a.path`;
const TASK_LIST_COLUMNS = `
  t.id, t.session_id, t.owner_session_id, t.owner_turn_id, t.owner_step_id,
  t.agent_id, t.parent_task_id, t.workflow_id, t.team_id, t.kind, t.title, t.status,
  t.await_policy, t.cancel_policy, t.checkpoint_safe, t.activity, t.wait_reason,
  t.version, t.created_at, t.updated_at, t.started_at, t.settled_at,
  r.id AS result_id,
  substr(r.summary, 1, ${ORCHESTRATION_RESULT_PREVIEW_MAX_CHARS}) AS result_summary,
  CASE WHEN length(r.summary) > ${ORCHESTRATION_RESULT_PREVIEW_MAX_CHARS} THEN 1 ELSE 0 END AS result_summary_truncated,
  r.version AS result_version, r.created_at AS result_created_at,
  r.acknowledged_at AS result_acknowledged_at`;
const TASK_DETAIL_COLUMNS = `${TASK_LIST_COLUMNS}, t.payload_json, t.agent_ord, t.lease_generation`;
const TASK_RESULT_JOIN = "LEFT JOIN task_results r ON r.task_id = t.id";
const WORKFLOW_LIST_COLUMNS = `
  w.id, w.owner_session_id, w.name, w.status, w.definition_version,
  w.graph_revision, w.graph_sealed, w.run_revision, w.version,
  w.created_at, w.updated_at, w.started_at, w.settled_at,
  (SELECT COUNT(*) FROM workflow_nodes node WHERE node.workflow_id = w.id) AS node_count,
  (SELECT COUNT(*) FROM workflow_nodes node WHERE node.workflow_id = w.id
    AND node.status IN ('succeeded','failed','cancelled')) AS completed_node_count,
  (SELECT COUNT(*) FROM workflow_nodes node WHERE node.workflow_id = w.id
    AND node.status IN ('running','waiting')) AS active_node_count`;
const WORKFLOW_DETAIL_COLUMNS = `${WORKFLOW_LIST_COLUMNS},
  CASE WHEN w.controller_agent_id IS NULL OR EXISTS (
    SELECT 1 FROM agent_nodes controller
    WHERE controller.id = w.controller_agent_id AND controller.user_id = w.user_id
      AND controller.root_agent_id = w.root_agent_id AND controller.purpose = 'addressable'
  ) THEN w.controller_agent_id ELSE NULL END AS controller_agent_id,
  w.max_nodes, w.max_edges, w.max_depth, w.max_attempts, w.max_runtime_ms,
  w.max_tokens, w.max_cost_micros, w.attempts_used, w.tokens_used,
  w.tokens_reserved, w.cost_used_micros, w.cost_reserved_micros`;
const TEAM_LIST_COLUMNS = `
  team.id,
  CASE WHEN team.owner_session_ref IS NOT NULL AND team.root_agent_ref IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions safe_owner
      JOIN agent_nodes safe_root
        ON safe_root.id = team.root_agent_ref AND safe_root.user_id = team.user_id
       AND safe_root.session_id = safe_owner.id AND safe_root.id = safe_root.root_agent_id
       AND safe_root.parent_agent_id IS NULL AND safe_root.kind = 'session'
       AND safe_root.purpose = 'addressable'
      WHERE safe_owner.id = team.owner_session_ref AND safe_owner.user_id = team.user_id
        AND team.owner_session_id = safe_owner.id AND team.root_agent_id = safe_root.id
    ) THEN team.owner_session_id ELSE NULL END AS owner_session_id,
  CASE WHEN team.owner_session_ref IS NOT NULL AND team.root_agent_ref IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM sessions safe_owner
      JOIN agent_nodes safe_root
        ON safe_root.id = team.root_agent_ref AND safe_root.user_id = team.user_id
       AND safe_root.session_id = safe_owner.id AND safe_root.id = safe_root.root_agent_id
       AND safe_root.parent_agent_id IS NULL AND safe_root.kind = 'session'
       AND safe_root.purpose = 'addressable'
      WHERE safe_owner.id = team.owner_session_ref AND safe_owner.user_id = team.user_id
        AND team.owner_session_id = safe_owner.id AND team.root_agent_id = safe_root.id
    ) THEN 1 ELSE 0 END AS owner_available,
  team.name, team.status, team.version, team.created_at, team.updated_at,
  (SELECT COUNT(*) FROM team_members member
    JOIN sessions member_session
      ON member_session.id = member.session_id AND member_session.user_id = team.user_id
    JOIN agent_nodes member_agent
      ON member_agent.id = member.agent_id AND member_agent.user_id = team.user_id
     AND member_agent.session_id = member.session_id AND member_agent.id = member_agent.root_agent_id
    WHERE member.team_id = team.id AND member.status <> 'removed') AS member_count,
  (SELECT COUNT(*) FROM team_members member
    JOIN sessions member_session
      ON member_session.id = member.session_id AND member_session.user_id = team.user_id
    JOIN agent_nodes member_agent
      ON member_agent.id = member.agent_id AND member_agent.user_id = team.user_id
     AND member_agent.session_id = member.session_id AND member_agent.id = member_agent.root_agent_id
    WHERE member.team_id = team.id AND member.status = 'active') AS active_member_count,
  (SELECT COUNT(*) FROM team_mail mail
    WHERE mail.team_id = team.id AND mail.user_id = team.user_id AND mail.status = 'queued') AS queued_mail,
  (SELECT COUNT(*) FROM team_mail mail
    WHERE mail.team_id = team.id AND mail.user_id = team.user_id AND mail.status = 'claimed') AS claimed_mail,
  (SELECT COUNT(*) FROM runtime_tasks task
    WHERE task.team_id = team.id AND task.user_id = team.user_id
      AND task.kind = 'team_turn'
      AND task.status NOT IN ('succeeded','failed','cancelled','interrupted')) AS open_work`;
const TEAM_MAIL_LIST_COLUMNS = `
  mail.id, mail.team_id, mail.seq, mail.source_member_id, mail.source_session_id,
  mail.target_member_id, mail.target_session_id, mail.kind, mail.subject,
  CASE WHEN parent.team_id = mail.team_id AND parent.user_id = mail.user_id
    THEN mail.parent_mail_id ELSE NULL END AS parent_mail_id,
  CASE WHEN task.user_id = mail.user_id AND task.team_id = mail.team_id
    THEN mail.task_id ELSE NULL END AS task_id,
  mail.status, mail.payload_bytes, mail.version, mail.created_at, mail.updated_at,
  mail.claimed_at, mail.acknowledged_at, mail.seq AS cursor_position`;
const TEAM_MAIL_OWNERSHIP_JOINS = `
  JOIN teams team ON team.id = mail.team_id AND team.user_id = mail.user_id
  JOIN team_members source
    ON source.id = mail.source_member_id AND source.team_id = mail.team_id
   AND source.session_id = mail.source_session_id
  JOIN sessions source_session
    ON source_session.id = mail.source_session_id AND source_session.user_id = mail.user_id
  JOIN agent_nodes source_agent
    ON source_agent.id = source.agent_id AND source_agent.user_id = mail.user_id
   AND source_agent.session_id = source.session_id AND source_agent.id = source_agent.root_agent_id
  JOIN team_members target
    ON target.id = mail.target_member_id AND target.team_id = mail.team_id
   AND target.session_id = mail.target_session_id
  JOIN sessions target_session
    ON target_session.id = mail.target_session_id AND target_session.user_id = mail.user_id
  JOIN agent_nodes target_agent
    ON target_agent.id = target.agent_id AND target_agent.user_id = mail.user_id
   AND target_agent.session_id = target.session_id AND target_agent.id = target_agent.root_agent_id
  LEFT JOIN team_mail parent ON parent.id = mail.parent_mail_id
  LEFT JOIN runtime_tasks task ON task.id = mail.task_id`;

export const SESSION_RUN_COUNT_SQL = `${SESSION_VISIBLE_ORCHESTRATION_CTE}
  SELECT
    COUNT(task.id) AS tasks,
    (SELECT COUNT(*) FROM visible_agents
      WHERE id <> ? AND status <> 'closed') AS active_agents,
    COALESCE(SUM(CASE WHEN task.await_policy = 'background'
      AND task.status NOT IN ('succeeded','failed','cancelled','interrupted') THEN 1 ELSE 0 END), 0) AS background,
    COALESCE(SUM(CASE WHEN task.status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
    COALESCE(SUM(CASE WHEN task.status = 'waiting' THEN 1 ELSE 0 END), 0) AS waiting,
    COALESCE(SUM(CASE WHEN result.id IS NOT NULL AND result.acknowledged_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
  FROM visible_tasks task
  LEFT JOIN task_results result ON result.task_id = task.id`;

const EMPTY_COUNTS: Readonly<AgentRosterCounts> = Object.freeze({
  tasks: 0,
  activeAgents: 0,
  background: 0,
  queued: 0,
  waiting: 0,
  unread: 0,
});

const readStatementCache = new Map<string, StatementSync>();

function prepareReadStatement(sql: string): StatementSync {
  const cached = readStatementCache.get(sql);
  if (cached) return cached;
  const statement = db.prepare(sql);
  readStatementCache.set(sql, statement);
  return statement;
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return ORCHESTRATION_READ_DEFAULT;
  return Math.max(1, Math.min(ORCHESTRATION_READ_MAX, Math.trunc(value!)));
}

function cursorClause(alias: string, before: ReadModelCursor | undefined): {
  sql: string;
  values: Array<string | number>;
} {
  if (!before) return { sql: "", values: [] };
  return {
    sql: ` AND (${alias}.updated_at < ? OR (${alias}.updated_at = ? AND ${alias}.id < ?))`,
    values: [before.updatedAt, before.updatedAt, before.id],
  };
}

function positionCursorClause(
  alias: string,
  column: string,
  before: ReadModelCursor | undefined,
): { sql: string; values: Array<string | number> } {
  if (!before) return { sql: "", values: [] };
  return {
    sql: ` AND (${alias}.${column} < ? OR (${alias}.${column} = ? AND ${alias}.id < ?))`,
    values: [before.updatedAt, before.updatedAt, before.id],
  };
}

function assertCursor(cursor: ReadModelCursor | undefined, scope: string, revision: number): void {
  if (cursor && (cursor.scope !== scope || cursor.revision !== revision)) {
    throw new OrchestrationCursorConflictError();
  }
}

function cursorFor(
  scope: string,
  revision: number,
  row: { updated_at: number; id: string },
): ReadModelCursor {
  return { scope, revision, updatedAt: Number(row.updated_at), id: row.id };
}

export function encodeOrchestrationCursor(cursor: ReadModelCursor): OrchestrationPageCursor {
  return Buffer.from(
    JSON.stringify([cursor.scope, cursor.revision, cursor.updatedAt, cursor.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeOrchestrationCursor(value: unknown): ReadModelCursor | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("invalid orchestration cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("invalid orchestration cursor");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 4
    || typeof parsed[0] !== "string"
    || parsed[0].length < 1
    || parsed[0].length > 256
    || !Number.isSafeInteger(parsed[1])
    || parsed[1] < 0
    || !Number.isSafeInteger(parsed[2])
    || parsed[2] < 0
    || typeof parsed[3] !== "string"
    || parsed[3].length < 1
    || parsed[3].length > 256
  ) throw new TypeError("invalid orchestration cursor");
  return {
    scope: parsed[0],
    revision: parsed[1] as number,
    updatedAt: parsed[2] as number,
    id: parsed[3],
  };
}

function mapResultSummary(row: TaskReadRow): TaskResultListItem | undefined {
  if (
    row.result_id === null
    || row.result_summary === null
    || row.result_version === null
    || row.result_created_at === null
  ) return undefined;
  return {
    id: row.result_id,
    taskId: row.id,
    summary: row.result_summary,
    ...(row.result_summary_truncated === 1 ? { summaryTruncated: true as const } : {}),
    version: Number(row.result_version),
    createdAt: Number(row.result_created_at),
    ...(row.result_acknowledged_at === null
      ? {}
      : { acknowledgedAt: Number(row.result_acknowledged_at) }),
  };
}

function mapAgentList(row: AgentReadRow): AgentListItem {
  return {
    id: row.id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    rootAgentId: row.root_agent_id,
    ...(row.parent_agent_id === null ? {} : { parentAgentId: row.parent_agent_id }),
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.thinking_level === null ? {} : { thinkingLevel: row.thinking_level }),
    kind: row.kind,
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTaskList(row: TaskReadRow): RuntimeTaskListItem {
  const result = mapResultSummary(row);
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerSessionId: row.owner_session_id,
    ...(row.owner_turn_id === null ? {} : { ownerTurnId: row.owner_turn_id }),
    ...(row.owner_step_id === null ? {} : { ownerStepId: row.owner_step_id }),
    agentId: row.agent_id,
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
    ...(row.team_id === null ? {} : { teamId: row.team_id }),
    kind: row.kind,
    title: row.title,
    status: row.status,
    awaitPolicy: row.await_policy,
    cancelPolicy: row.cancel_policy,
    checkpointSafe: row.checkpoint_safe === 1,
    ...(row.activity === null ? {} : { activity: row.activity }),
    ...(row.wait_reason === null ? {} : { waitReason: row.wait_reason }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
    ...(result ? { result } : {}),
  };
}

function mapWorkflowList(row: WorkflowListRow): WorkflowListItem {
  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    name: row.name,
    status: row.status,
    definitionVersion: Number(row.definition_version),
    graphRevision: Number(row.graph_revision),
    graphSealed: row.graph_sealed === 1,
    runRevision: Number(row.run_revision),
    nodeCount: Number(row.node_count),
    completedNodeCount: Number(row.completed_node_count),
    activeNodeCount: Number(row.active_node_count),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapWorkflowNode(row: WorkflowNodeReadRow): WorkflowNodeListItem {
  const phaseStatus: WorkflowNodeStatus | undefined = row.status === "running"
    && row.execution_phase !== null
    ? row.execution_phase === "cancel_requested" ? "cancelling" : row.execution_phase
    : undefined;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    effect: row.effect,
    cachePolicy: row.cache_policy,
    status: phaseStatus ?? row.status,
    ...(row.executor_agent_id === null ? {} : { executorAgentId: row.executor_agent_id }),
    depth: Number(row.depth),
    maxAttempts: Number(row.max_attempts),
    attemptCount: Number(row.attempt_count),
    ...(row.expanded_by_node_id === null ? {} : { expandedByNodeId: row.expanded_by_node_id }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapWorkflowEdge(row: WorkflowEdgeReadRow): WorkflowEdgeListItem {
  return { from: row.from_node_id, to: row.to_node_id, condition: row.condition };
}

function mapTeamList(row: TeamListRow): TeamListItem {
  return {
    id: row.id,
    ...(row.owner_session_id === null ? {} : { ownerSessionId: row.owner_session_id }),
    ownerAvailable: row.owner_available === 1,
    name: row.name,
    status: row.status,
    memberCount: Number(row.member_count),
    activeMemberCount: Number(row.active_member_count),
    queuedMail: Number(row.queued_mail),
    claimedMail: Number(row.claimed_mail),
    openWork: Number(row.open_work),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTeamMember(row: TeamMemberReadRow): TeamMemberListItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: normalizeSessionTitle(row.session_title, "Untitled session"),
    agentId: row.agent_id,
    role: row.role,
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTeamMembership(row: TeamMembershipReadRow): TeamMembershipListItem {
  return {
    teamId: row.team_id,
    name: row.name,
    teamStatus: row.team_status,
    memberId: row.member_id,
    role: row.role,
    memberStatus: row.member_status,
    memberCount: Number(row.member_count),
    unreadMail: Number(row.unread_mail),
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  };
}

function mapTeamMailList(row: TeamMailReadRow): TeamMailListItem {
  return {
    id: row.id,
    teamId: row.team_id,
    seq: Number(row.seq),
    sourceMemberId: row.source_member_id,
    sourceSessionId: row.source_session_id,
    targetMemberId: row.target_member_id,
    targetSessionId: row.target_session_id,
    kind: row.kind,
    subject: row.subject,
    ...(row.parent_mail_id === null ? {} : { parentMailId: row.parent_mail_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    status: row.status,
    payloadBytes: Number(row.payload_bytes),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.claimed_at === null ? {} : { claimedAt: Number(row.claimed_at) }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: Number(row.acknowledged_at) }),
  };
}

function pageFromRows<Row extends { updated_at: number; id: string }, Item>(
  rows: Row[],
  limit: number,
  scope: string,
  revision: number,
  map: (row: Row) => Item,
): { page: OrchestrationPage<Item>; visibleRows: Row[] } {
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const last = visibleRows.at(-1);
  return {
    page: {
      items: visibleRows.map(map),
      ...(hasMore && last
        ? { nextCursor: encodeOrchestrationCursor(cursorFor(scope, revision, last)) }
        : {}),
    },
    visibleRows,
  };
}

function pageFromPositionRows<Row extends { cursor_position: number; id: string }, Item>(
  rows: Row[],
  limit: number,
  scope: string,
  revision: number,
  map: (row: Row) => Item,
): OrchestrationPage<Item> {
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(map),
    ...(hasMore && last
      ? {
          nextCursor: encodeOrchestrationCursor({
            scope,
            revision,
            updatedAt: Number(last.cursor_position),
            id: last.id,
          }),
        }
      : {}),
  };
}

function activityRevision(userId: string): number {
  const row = db.prepare(
    "SELECT activity_revision FROM orchestration_user_revisions WHERE user_id = ?",
  ).get(userId) as { activity_revision: number } | undefined;
  return row ? Number(row.activity_revision) : 0;
}

function sessionMap(userId: string, sessionIds: readonly string[]): Array<{ id: string; title: string }> {
  const ids = [...new Set(sessionIds)].slice(0, ORCHESTRATION_READ_MAX);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, substr(title, 1, 120) AS title
     FROM sessions WHERE user_id = ? AND id IN (${placeholders})`,
  ).all(userId, ...ids) as unknown as Array<{ id: string; title: string }>;
  const byId = new Map(rows.map((row) => [row.id, normalizeSessionTitle(row.title, "Untitled session")]));
  return ids.flatMap((id) => {
    const title = byId.get(id);
    return title === undefined ? [] : [{ id, title }];
  });
}

function linkedWorkflowsForSession(
  userId: string,
  sessionId: string,
  rootAgentId: string,
): { items: WorkflowListItem[]; partial: boolean } {
  const rows = prepareReadStatement(
    `SELECT ${WORKFLOW_LIST_COLUMNS}
     FROM workflows w
     JOIN sessions owner_session
       ON owner_session.id = w.owner_session_id AND owner_session.user_id = w.user_id
     JOIN agent_nodes root_agent
       ON root_agent.id = w.root_agent_id AND root_agent.user_id = w.user_id
      AND root_agent.session_id = w.owner_session_id
      AND root_agent.id = root_agent.root_agent_id AND root_agent.parent_agent_id IS NULL
      AND root_agent.kind = 'session' AND root_agent.purpose = 'addressable'
     WHERE w.user_id = ? AND w.owner_session_id = ? AND w.root_agent_id = ?
     ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`,
  ).all(userId, sessionId, rootAgentId, ORCHESTRATION_SESSION_LINK_MAX + 1) as unknown as WorkflowListRow[];
  return {
    items: rows.slice(0, ORCHESTRATION_SESSION_LINK_MAX).map(mapWorkflowList),
    partial: rows.length > ORCHESTRATION_SESSION_LINK_MAX,
  };
}

function teamMembershipsForSession(
  userId: string,
  sessionId: string,
): { items: TeamMembershipListItem[]; partial: boolean } {
  const rows = prepareReadStatement(
    `SELECT team.id AS team_id, team.name, team.status AS team_status,
       membership.id AS member_id, membership.role, membership.status AS member_status,
       team.version, team.updated_at,
       (SELECT COUNT(*) FROM team_members peer
        JOIN sessions peer_session
          ON peer_session.id = peer.session_id AND peer_session.user_id = team.user_id
        JOIN agent_nodes peer_agent
          ON peer_agent.id = peer.agent_id AND peer_agent.user_id = team.user_id
         AND peer_agent.session_id = peer.session_id AND peer_agent.id = peer_agent.root_agent_id
        WHERE peer.team_id = team.id AND peer.status <> 'removed') AS member_count,
       (SELECT COUNT(*) FROM team_mail mail
        WHERE mail.team_id = team.id AND mail.user_id = team.user_id
          AND mail.target_session_id = membership.session_id
          AND mail.status IN ('queued','claimed')) AS unread_mail
     FROM team_members membership
     JOIN teams team ON team.id = membership.team_id AND team.user_id = ?
     JOIN sessions member_session
       ON member_session.id = membership.session_id AND member_session.user_id = team.user_id
     JOIN agent_nodes member_agent
       ON member_agent.id = membership.agent_id AND member_agent.user_id = team.user_id
      AND member_agent.session_id = membership.session_id
      AND member_agent.id = member_agent.root_agent_id AND member_agent.parent_agent_id IS NULL
      AND member_agent.kind = 'session' AND member_agent.purpose = 'addressable'
     WHERE membership.session_id = ? AND membership.status <> 'removed'
     ORDER BY team.updated_at DESC, team.id DESC LIMIT ?`,
  ).all(userId, sessionId, ORCHESTRATION_SESSION_LINK_MAX + 1) as unknown as TeamMembershipReadRow[];
  return {
    items: rows.slice(0, ORCHESTRATION_SESSION_LINK_MAX).map(mapTeamMembership),
    partial: rows.length > ORCHESTRATION_SESSION_LINK_MAX,
  };
}

export const orchestrationReadModel = {
  activity(
    userId: string,
    options: { limit?: number; before?: ReadModelCursor } = {},
  ): OrchestrationActivityPage {
    return runInTransaction(() => {
      const revision = activityRevision(userId);
      const scope = "activity";
      assertCursor(options.before, scope, revision);
      const limit = boundedLimit(options.limit);
      const cursor = cursorClause("t", options.before);
      const rows = prepareReadStatement(
        `${ACCOUNT_VISIBLE_ORCHESTRATION_CTE}
         SELECT ${TASK_LIST_COLUMNS},
            a.label AS agent_label, a.status AS agent_status
         FROM visible_tasks visible_task
         JOIN runtime_tasks t ON t.id = visible_task.id
         JOIN agent_nodes a
           ON a.id = t.agent_id AND a.user_id = t.user_id
         ${TASK_RESULT_JOIN}
         WHERE 1 = 1${cursor.sql}
         ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
      ).all(userId, userId, ...cursor.values, limit + 1) as unknown as ActivityReadRow[];
      const { page, visibleRows } = pageFromRows(rows, limit, scope, revision, (row) => ({
        task: mapTaskList(row),
        agent: {
          id: row.agent_id,
          ...(row.agent_label === null ? {} : { label: row.agent_label }),
          status: row.agent_status,
        },
      }));
      return {
        ...page,
        revision,
        sessions: sessionMap(userId, visibleRows.map((row) => row.session_id)),
      };
    });
  },

  sessionRun(userId: string, sessionId: string, options: SessionRunReadOptions = {}): SessionRunSnapshot | undefined {
    return runInTransaction(() => {
      const owned = db.prepare(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ?",
      ).get(sessionId, userId) as { id: string } | undefined;
      if (!owned) return undefined;
      const root = db.prepare(
        `SELECT a.id, r.addressable_revision AS revision
         FROM agent_nodes a
         JOIN sessions root_session
           ON root_session.id = a.session_id AND root_session.user_id = a.user_id
         JOIN agent_rosters r
           ON r.root_agent_id = a.id AND r.user_id = a.user_id
         WHERE a.user_id = ? AND a.session_id = ? AND a.id = a.root_agent_id
           AND a.parent_agent_id IS NULL
           AND a.kind = 'session' AND a.purpose = 'addressable'`,
      ).get(userId, sessionId) as { id: string; revision: number } | undefined;
      const revision = root ? Number(root.revision) : 0;
      const agentScope = `session_run:${sessionId}:agents`;
      const taskScope = `session_run:${sessionId}:tasks`;
      assertCursor(options.agentBefore, agentScope, revision);
      assertCursor(options.taskBefore, taskScope, revision);
      if (!root) {
        return {
          sessionId,
          revision,
          counts: { ...EMPTY_COUNTS },
          agents: { items: [] },
          tasks: { items: [] },
          linkedWorkflows: { items: [], partial: false },
          teamMemberships: { items: [], partial: false },
        };
      }

      const agentLimit = boundedLimit(options.agentLimit);
      const agentCursor = cursorClause("a", options.agentBefore);
      const agentRows = prepareReadStatement(
        `${SESSION_VISIBLE_ORCHESTRATION_CTE}
         SELECT ${AGENT_LIST_COLUMNS}
         FROM visible_agents visible_agent
         JOIN agent_nodes a ON a.id = visible_agent.id
         WHERE 1 = 1${agentCursor.sql}
         ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      ).all(
        root.id,
        userId,
        sessionId,
        userId,
        sessionId,
        ...agentCursor.values,
        agentLimit + 1,
      ) as unknown as AgentReadRow[];

      const taskLimit = boundedLimit(options.taskLimit);
      const taskCursor = cursorClause("t", options.taskBefore);
      const taskRows = prepareReadStatement(
        `${SESSION_VISIBLE_ORCHESTRATION_CTE}
         SELECT ${TASK_LIST_COLUMNS}
         FROM visible_tasks visible_task
         JOIN runtime_tasks t ON t.id = visible_task.id
         ${TASK_RESULT_JOIN}
         WHERE 1 = 1${taskCursor.sql}
         ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
      ).all(
        root.id,
        userId,
        sessionId,
        userId,
        sessionId,
        ...taskCursor.values,
        taskLimit + 1,
      ) as unknown as TaskReadRow[];

      const teamMemberships = teamMembershipsForSession(userId, sessionId);

      let latestTeamTaskRow: TaskReadRow | undefined;
      if (teamMemberships.items.length > 0) {
        latestTeamTaskRow = prepareReadStatement(
          `${SESSION_VISIBLE_ORCHESTRATION_CTE}
         SELECT ${TASK_LIST_COLUMNS}
         FROM visible_tasks visible_task
         JOIN runtime_tasks t ON t.id = visible_task.id
         JOIN teams team
           ON team.id = t.team_id AND team.user_id = t.user_id
         JOIN team_members membership
           ON membership.team_id = team.id
          AND membership.session_id = t.session_id
          AND membership.agent_id = t.agent_id
          AND membership.status <> 'removed'
         ${TASK_RESULT_JOIN}
         WHERE t.kind = 'team_turn' AND t.session_id = ?
         ORDER BY t.updated_at DESC, t.id DESC LIMIT 1`,
        ).get(
          root.id,
          userId,
          sessionId,
          userId,
          sessionId,
          sessionId,
        ) as unknown as TaskReadRow | undefined;
      }

      const count = prepareReadStatement(SESSION_RUN_COUNT_SQL).get(
        root.id,
        userId,
        sessionId,
        userId,
        sessionId,
        root.id,
      ) as {
        tasks: number;
        active_agents: number;
        background: number;
        queued: number;
        waiting: number;
        unread: number;
      };

      return {
        sessionId,
        rootAgentId: root.id,
        revision,
        counts: {
          tasks: Number(count.tasks),
          activeAgents: Number(count.active_agents),
          background: Number(count.background),
          queued: Number(count.queued),
          waiting: Number(count.waiting),
          unread: Number(count.unread),
        },
        agents: pageFromRows(agentRows, agentLimit, agentScope, revision, mapAgentList).page,
        tasks: pageFromRows(taskRows, taskLimit, taskScope, revision, mapTaskList).page,
        ...(latestTeamTaskRow ? { latestTeamTask: mapTaskList(latestTeamTaskRow) } : {}),
        linkedWorkflows: linkedWorkflowsForSession(userId, sessionId, root.id),
        teamMemberships,
      };
    });
  },

  workflows(
    userId: string,
    options: { limit?: number; before?: ReadModelCursor } = {},
  ): WorkflowListPage {
    return runInTransaction(() => {
      const scope = "workflows";
      const revision = 0;
      assertCursor(options.before, scope, revision);
      const limit = boundedLimit(options.limit);
      const cursor = cursorClause("w", options.before);
      const rows = prepareReadStatement(
        `SELECT ${WORKFLOW_LIST_COLUMNS}
         FROM workflows w
         JOIN sessions owner_session
           ON owner_session.id = w.owner_session_id AND owner_session.user_id = w.user_id
         JOIN agent_nodes root_agent
           ON root_agent.id = w.root_agent_id AND root_agent.user_id = w.user_id
          AND root_agent.session_id = w.owner_session_id
          AND root_agent.id = root_agent.root_agent_id AND root_agent.parent_agent_id IS NULL
          AND root_agent.kind = 'session' AND root_agent.purpose = 'addressable'
         WHERE w.user_id = ?${cursor.sql}
         ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`,
      ).all(userId, ...cursor.values, limit + 1) as unknown as WorkflowListRow[];
      const { page, visibleRows } = pageFromRows(
        rows,
        limit,
        scope,
        revision,
        mapWorkflowList,
      );
      return {
        ...page,
        sessions: sessionMap(userId, visibleRows.map((row) => row.owner_session_id)),
      };
    });
  },

  workflowDetail(userId: string, workflowId: string): WorkflowReadDetail | undefined {
    return runInTransaction(() => {
      const row = prepareReadStatement(
        `SELECT ${WORKFLOW_DETAIL_COLUMNS}
         FROM workflows w
         JOIN sessions owner_session
           ON owner_session.id = w.owner_session_id AND owner_session.user_id = w.user_id
         JOIN agent_nodes root_agent
           ON root_agent.id = w.root_agent_id AND root_agent.user_id = w.user_id
          AND root_agent.session_id = w.owner_session_id
          AND root_agent.id = root_agent.root_agent_id AND root_agent.parent_agent_id IS NULL
          AND root_agent.kind = 'session' AND root_agent.purpose = 'addressable'
         WHERE w.user_id = ? AND w.id = ?`,
      ).get(userId, workflowId) as WorkflowListRow | undefined;
      if (!row) return undefined;

      const nodeRows = prepareReadStatement(
        `SELECT node.id, node.name, node.kind, node.effect, node.cache_policy,
           node.status, node.execution_phase,
           CASE WHEN executor.id IS NULL THEN NULL ELSE node.executor_agent_id END AS executor_agent_id,
           node.depth, node.max_attempts, node.attempt_count, node.expanded_by_node_id,
           node.version, node.created_at, node.updated_at, node.settled_at
         FROM workflows w
         JOIN workflow_nodes node ON node.workflow_id = w.id
         LEFT JOIN agent_nodes executor
           ON executor.id = node.executor_agent_id AND executor.user_id = w.user_id
          AND executor.root_agent_id = w.root_agent_id AND executor.purpose = 'addressable'
         WHERE w.id = ? AND w.user_id = ?
         ORDER BY node.created_at ASC, node.id ASC LIMIT ?`,
      ).all(workflowId, userId, ORCHESTRATION_WORKFLOW_NODE_MAX + 1) as unknown as WorkflowNodeReadRow[];
      const edgeRows = prepareReadStatement(
        `SELECT edge.from_node_id, edge.to_node_id, edge.condition
         FROM workflows w
         JOIN workflow_edges edge ON edge.workflow_id = w.id
         WHERE w.id = ? AND w.user_id = ?
         ORDER BY edge.from_node_id ASC, edge.to_node_id ASC LIMIT ?`,
      ).all(workflowId, userId, ORCHESTRATION_WORKFLOW_EDGE_MAX + 1) as unknown as WorkflowEdgeReadRow[];
      const nodes = nodeRows.slice(0, ORCHESTRATION_WORKFLOW_NODE_MAX).map(mapWorkflowNode);
      const edges = edgeRows.slice(0, ORCHESTRATION_WORKFLOW_EDGE_MAX).map(mapWorkflowEdge);
      return {
        ...mapWorkflowList(row),
        ...(row.controller_agent_id === null || row.controller_agent_id === undefined
          ? {}
          : { controllerAgentId: row.controller_agent_id }),
        budget: {
          maxNodes: Number(row.max_nodes),
          maxEdges: Number(row.max_edges),
          maxDepth: Number(row.max_depth),
          maxAttempts: Number(row.max_attempts),
          maxRuntimeMs: Number(row.max_runtime_ms),
          maxTokens: Number(row.max_tokens),
          maxCostMicros: Number(row.max_cost_micros),
        },
        attemptsUsed: Number(row.attempts_used),
        tokensUsed: Number(row.tokens_used),
        tokensReserved: Number(row.tokens_reserved),
        costUsedMicros: Number(row.cost_used_micros),
        costReservedMicros: Number(row.cost_reserved_micros),
        nodes,
        edges,
        nodesPartial: nodeRows.length > ORCHESTRATION_WORKFLOW_NODE_MAX,
        edgesPartial: edgeRows.length > ORCHESTRATION_WORKFLOW_EDGE_MAX,
      };
    });
  },

  teams(
    userId: string,
    options: { limit?: number; before?: ReadModelCursor } = {},
  ): TeamListPage {
    return runInTransaction(() => {
      const scope = "teams";
      const revision = 0;
      assertCursor(options.before, scope, revision);
      const limit = boundedLimit(options.limit);
      const cursor = cursorClause("team", options.before);
      const rows = prepareReadStatement(
        `SELECT ${TEAM_LIST_COLUMNS}
         FROM teams team
         WHERE team.user_id = ?
           AND (
             (team.owner_session_ref IS NULL AND team.root_agent_ref IS NULL)
             OR EXISTS (
               SELECT 1 FROM sessions owner_session
               JOIN agent_nodes root_agent
                 ON root_agent.id = team.root_agent_ref AND root_agent.user_id = team.user_id
                AND root_agent.session_id = owner_session.id
                AND root_agent.id = root_agent.root_agent_id AND root_agent.parent_agent_id IS NULL
                AND root_agent.kind = 'session' AND root_agent.purpose = 'addressable'
               WHERE owner_session.id = team.owner_session_ref
                 AND owner_session.user_id = team.user_id
                 AND team.owner_session_id = owner_session.id
                 AND team.root_agent_id = root_agent.id
             )
           )${cursor.sql}
         ORDER BY team.updated_at DESC, team.id DESC LIMIT ?`,
      ).all(userId, ...cursor.values, limit + 1) as unknown as TeamListRow[];
      const { page, visibleRows } = pageFromRows(rows, limit, scope, revision, mapTeamList);
      return {
        ...page,
        sessions: sessionMap(
          userId,
          visibleRows.flatMap((row) => row.owner_session_id === null ? [] : [row.owner_session_id]),
        ),
      };
    });
  },

  teamDetail(userId: string, teamId: string): TeamReadDetail | undefined {
    return runInTransaction(() => {
      const row = prepareReadStatement(
        `SELECT ${TEAM_LIST_COLUMNS},
           CASE WHEN EXISTS (
             SELECT 1 FROM team_members lead_member
             JOIN agent_nodes lead_agent
               ON lead_agent.id = lead_member.agent_id AND lead_agent.user_id = team.user_id
              AND lead_agent.session_id = lead_member.session_id
             WHERE lead_member.team_id = team.id AND lead_member.agent_id = team.lead_agent_id
           ) THEN team.lead_agent_id ELSE NULL END AS lead_agent_id
         FROM teams team
         WHERE team.user_id = ? AND team.id = ?`,
      ).get(userId, teamId) as TeamListRow | undefined;
      if (!row) return undefined;
      const memberRows = prepareReadStatement(
        `SELECT member.id, member.session_id, substr(member_session.title, 1, 120) AS session_title,
           member.agent_id, member.role, member.status, member.version,
           member.created_at, member.updated_at
         FROM teams team
         JOIN team_members member ON member.team_id = team.id
         JOIN sessions member_session
           ON member_session.id = member.session_id AND member_session.user_id = team.user_id
         JOIN agent_nodes member_agent
           ON member_agent.id = member.agent_id AND member_agent.user_id = team.user_id
          AND member_agent.session_id = member.session_id
          AND member_agent.id = member_agent.root_agent_id AND member_agent.parent_agent_id IS NULL
          AND member_agent.kind = 'session' AND member_agent.purpose = 'addressable'
         WHERE team.id = ? AND team.user_id = ?
         ORDER BY member.created_at ASC, member.id ASC LIMIT ?`,
      ).all(teamId, userId, ORCHESTRATION_READ_MAX + 1) as unknown as TeamMemberReadRow[];
      return {
        ...mapTeamList(row),
        ...(row.lead_agent_id === null || row.lead_agent_id === undefined
          ? {}
          : { leadAgentId: row.lead_agent_id }),
        members: memberRows.slice(0, ORCHESTRATION_READ_MAX).map(mapTeamMember),
        membersPartial: memberRows.length > ORCHESTRATION_READ_MAX,
      };
    });
  },

  teamMail(
    userId: string,
    teamId: string,
    options: { limit?: number; before?: ReadModelCursor } = {},
  ): OrchestrationPage<TeamMailListItem> | undefined {
    return runInTransaction(() => {
      const owned = db.prepare(
        "SELECT version FROM teams WHERE id = ? AND user_id = ?",
      ).get(teamId, userId) as { version: number } | undefined;
      if (!owned) return undefined;
      const scope = `team:${teamId}:mail`;
      const revision = Number(owned.version);
      assertCursor(options.before, scope, revision);
      const limit = boundedLimit(options.limit);
      const cursor = positionCursorClause("mail", "seq", options.before);
      const rows = prepareReadStatement(
        `SELECT ${TEAM_MAIL_LIST_COLUMNS}
         FROM team_mail mail
         ${TEAM_MAIL_OWNERSHIP_JOINS}
         WHERE mail.user_id = ? AND mail.team_id = ?${cursor.sql}
         ORDER BY mail.seq DESC, mail.id DESC LIMIT ?`,
      ).all(userId, teamId, ...cursor.values, limit + 1) as unknown as TeamMailReadRow[];
      return pageFromPositionRows(rows, limit, scope, revision, mapTeamMailList);
    });
  },

  teamMailDetail(userId: string, teamId: string, mailId: string): TeamMailReadDetail | undefined {
    const row = prepareReadStatement(
      `SELECT ${TEAM_MAIL_LIST_COLUMNS}, mail.payload_json
       FROM team_mail mail
       ${TEAM_MAIL_OWNERSHIP_JOINS}
       WHERE mail.user_id = ? AND mail.team_id = ? AND mail.id = ?`,
    ).get(userId, teamId, mailId) as TeamMailReadRow | undefined;
    if (!row || row.payload_json === undefined) return undefined;
    return { ...mapTeamMailList(row), payload: JSON.parse(row.payload_json) as OrchestrationJson };
  },

  agentDetail(userId: string, agentId: string): AgentReadDetail | undefined {
    const row = prepareReadStatement(
      `SELECT ${AGENT_DETAIL_COLUMNS}
       FROM agent_nodes a
       JOIN sessions agent_session
         ON agent_session.id = a.session_id AND agent_session.user_id = a.user_id
       WHERE a.user_id = ? AND a.id = ? AND a.purpose = 'addressable'
       ${VISIBLE_AGENT_ANCESTRY_SQL}`,
    ).get(userId, agentId) as AgentReadRow | undefined;
    return row?.path ? { ...mapAgentList(row), path: row.path } : undefined;
  },

  taskDetail(userId: string, taskId: string): RuntimeTaskReadDetail | undefined {
    const row = prepareReadStatement(
      `${TASK_DETAIL_VISIBILITY_CTE}
       SELECT ${TASK_DETAIL_COLUMNS}
       FROM target_task target
       JOIN runtime_tasks t ON t.id = target.id
       JOIN agent_nodes a
         ON a.id = t.agent_id AND a.user_id = t.user_id
       ${TASK_RESULT_JOIN}
       WHERE EXISTS (
         SELECT 1 FROM visible_task_chain chain_root
         WHERE chain_root.parent_task_id IS NULL
       )`,
    ).get(userId, taskId) as TaskDetailRow | undefined;
    if (!row) return undefined;
    return {
      ...mapTaskList(row),
      payload: JSON.parse(row.payload_json) as OrchestrationJson,
      agentOrd: Number(row.agent_ord),
      leaseGeneration: Number(row.lease_generation),
    };
  },

  resultDetail(userId: string, taskId: string): TaskResultReadDetail | undefined {
    const row = prepareReadStatement(
      `${TASK_DETAIL_VISIBILITY_CTE}
       SELECT r.id, r.task_id, r.summary, r.body_json, r.artifacts_json,
          r.version, r.created_at, r.acknowledged_at
       FROM target_task target
       JOIN task_results r ON r.task_id = target.id
       WHERE EXISTS (
         SELECT 1 FROM visible_task_chain chain_root
         WHERE chain_root.parent_task_id IS NULL
       )`,
    ).get(userId, taskId) as ResultReadRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      summary: row.summary,
      body: JSON.parse(row.body_json) as OrchestrationJson,
      artifacts: JSON.parse(row.artifacts_json) as OrchestrationJson,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      ...(row.acknowledged_at === null ? {} : { acknowledgedAt: Number(row.acknowledged_at) }),
    };
  },

  invalidationSnapshot(userId: string, limit = ORCHESTRATION_READ_MAX): OrchestrationInvalidationSnapshot {
    const bounded = boundedLimit(limit);
    return runInTransaction(() => {
      const rows = db.prepare(
        `SELECT a.session_id, r.addressable_revision AS revision
         FROM agent_rosters r
         JOIN agent_nodes a
           ON a.id = r.root_agent_id AND a.user_id = r.user_id
          AND a.id = a.root_agent_id AND a.parent_agent_id IS NULL
          AND a.kind = 'session' AND a.purpose = 'addressable'
         JOIN sessions s ON s.id = a.session_id AND s.user_id = a.user_id
         WHERE r.user_id = ?
         ORDER BY r.updated_at DESC, r.root_agent_id DESC LIMIT ?`,
      ).all(userId, bounded + 1) as unknown as Array<{ session_id: string; revision: number }>;
      return {
        stale: true,
        activityRevision: activityRevision(userId),
        sessionRuns: rows.slice(0, bounded).map((row) => ({
          sessionId: row.session_id,
          revision: Number(row.revision),
        })),
        truncated: rows.length > bounded,
      };
    });
  },
};
