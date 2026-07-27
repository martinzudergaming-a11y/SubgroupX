import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  AgentNode,
  AgentNodeKind,
  AgentNodePurpose,
  AgentNodeStatus,
  AgentThinkingLevel,
  AgentRosterCounts,
  OrchestrationJson,
  RuntimeTask,
  TaskActivityCode,
  TaskAwaitPolicy,
  TaskCancelPolicy,
  TaskDigest,
  TaskEvent,
  TaskKind,
  TaskResult,
  TaskStatus,
  TaskWaitReasonCode,
  Team,
  TeamMail,
  TeamMailDeliveryStatus,
  TeamMailKind,
  TeamMailDigest,
  TeamMember,
  TeamMemberStatus,
  TeamSnapshot,
  TeamStatus,
  TeamWorkBudget,
} from "../../../shared/src/orchestration.ts";
import type { AgentTurnStatus, TimelineItem, WireAgentEvent } from "../../../shared/src/protocol.ts";
import { reduceTimeline } from "../../../shared/src/timeline-reducer.ts";
import type { ActiveTeamRouteLease } from "../foundation/team-route-lease.ts";
import { db, runInImmediateTransaction, runInTransaction } from "./core.ts";
import {
  ownedWorkflowPredicate,
  SESSION_EXECUTABLE_OPEN_CTE,
  SESSION_EXECUTABLE_ORCHESTRATION_CTE,
  SESSION_VISIBLE_AGENT_CTE,
  SESSION_VISIBLE_ORCHESTRATION_CTE,
} from "./orchestration-visibility.ts";

export const TASK_PAYLOAD_MAX_BYTES = 64 * 1024;
export const TASK_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
export const TASK_RESULT_SUMMARY_MAX_BYTES = 16 * 1024;
export const TASK_RESULT_BODY_MAX_BYTES = 256 * 1024;
export const TASK_RESULT_ARTIFACTS_MAX_BYTES = 64 * 1024;
export const AGENT_TRANSCRIPT_MAX_MESSAGES = 256;
export const AGENT_TRANSCRIPT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const AGENT_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
export const ORCHESTRATION_QUERY_DEFAULT = 50;
export const ORCHESTRATION_QUERY_MAX = 100;
export const PENDING_RESULT_ACK_MAX_PER_DELIVERY_AGENT = 64;
export const PENDING_RESULT_ACK_MAX_PER_SESSION = 512;
export const PENDING_RESULT_ACK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const PENDING_RESULT_ACK_GC_BATCH = 128;
const WORKFLOW_TASK_DETACH_BATCH_SIZE = 128;

export const WORKFLOW_TASK_DETACH_EVENT_INSERT_SQL = `WITH event_batch AS (
  SELECT
    CAST(json_extract(value, '$[0]') AS TEXT) AS task_id,
    CAST(json_extract(value, '$[1]') AS INTEGER) AS task_version,
    CAST(json_extract(value, '$[2]') AS INTEGER) AS lease_generation,
    CAST(json_extract(value, '$[3]') AS TEXT) AS type,
    CAST(json_extract(value, '$[4]') AS TEXT) AS payload_json,
    CAST(json_extract(value, '$[5]') AS INTEGER) AS payload_bytes,
    CAST(json_extract(value, '$[6]') AS INTEGER) AS created_at
  FROM json_each(?)
)
INSERT INTO task_events
  (task_id, seq, task_version, lease_generation, type, payload_json, payload_bytes, created_at)
SELECT batch.task_id,
       COALESCE((
         SELECT MAX(previous.seq) FROM task_events previous
         WHERE previous.task_id = batch.task_id
       ), 0) + 1,
       batch.task_version,
       batch.lease_generation,
       batch.type,
       batch.payload_json,
       batch.payload_bytes,
       batch.created_at
FROM event_batch batch
JOIN runtime_tasks task INDEXED BY sqlite_autoindex_runtime_tasks_1
  ON task.id = batch.task_id
 AND task.version = batch.task_version
 AND task.workflow_id IS NULL`;

export const VISIBLE_AGENT_ANCESTRY_SQL = `
  AND a.session_id IS NOT NULL
  AND EXISTS (
    WITH RECURSIVE visible_agent_chain(id, parent_agent_id) AS (
      SELECT a.id, a.parent_agent_id
      UNION
      SELECT parent.id, parent.parent_agent_id
      FROM agent_nodes parent
      JOIN visible_agent_chain child ON parent.id = child.parent_agent_id
      WHERE parent.user_id = a.user_id
        AND parent.root_agent_id = a.root_agent_id
        AND parent.session_id = a.session_id
        AND parent.purpose = 'addressable'
    )
    SELECT 1 FROM visible_agent_chain chain_root
    JOIN agent_nodes owned_root
      ON owned_root.id = chain_root.id
     AND owned_root.user_id = a.user_id
     AND owned_root.session_id = a.session_id
    JOIN sessions root_session
      ON root_session.id = owned_root.session_id
     AND root_session.user_id = owned_root.user_id
    WHERE chain_root.id = a.root_agent_id
      AND chain_root.parent_agent_id IS NULL
      AND owned_root.id = owned_root.root_agent_id
      AND owned_root.kind = 'session'
      AND owned_root.purpose = 'addressable'
  )`;

export const OWNED_TASK_WORKFLOW_SQL = `
  AND ${ownedWorkflowPredicate("t", "a")}`;

export const VISIBLE_TASK_ANCESTRY_SQL = `
  AND a.session_id = t.session_id
  AND EXISTS (
    SELECT 1 FROM sessions current_owner
    WHERE current_owner.id = t.owner_session_id
      AND current_owner.user_id = t.user_id
  )
  ${OWNED_TASK_WORKFLOW_SQL}
  AND EXISTS (
    WITH RECURSIVE visible_task_chain(id, parent_task_id) AS (
      SELECT t.id, t.parent_task_id
      UNION
      SELECT parent.id, parent.parent_task_id
      FROM runtime_tasks parent
      JOIN visible_task_chain child ON parent.id = child.parent_task_id
      JOIN agent_nodes parent_agent
        ON parent_agent.id = parent.agent_id
       AND parent_agent.user_id = parent.user_id
       AND parent_agent.session_id = parent.session_id
       AND parent_agent.purpose = 'addressable'
      JOIN sessions parent_owner
        ON parent_owner.id = parent.owner_session_id
       AND parent_owner.user_id = parent.user_id
      WHERE parent.user_id = t.user_id
        AND parent.session_id = t.session_id
        AND parent_agent.root_agent_id = a.root_agent_id
        AND (parent.workflow_id IS NULL OR EXISTS (
          SELECT 1 FROM workflows parent_workflow
          JOIN sessions parent_workflow_owner
            ON parent_workflow_owner.id = parent_workflow.owner_session_id
           AND parent_workflow_owner.user_id = parent_workflow.user_id
          JOIN agent_nodes parent_workflow_root
            ON parent_workflow_root.id = parent_workflow.root_agent_id
           AND parent_workflow_root.user_id = parent_workflow.user_id
          JOIN sessions parent_root_session
            ON parent_root_session.id = parent_workflow_root.session_id
           AND parent_root_session.user_id = parent_workflow_root.user_id
          WHERE parent_workflow.id = parent.workflow_id
            AND parent_workflow.user_id = parent.user_id
            AND parent_workflow_root.session_id = parent.session_id
            AND parent_workflow_root.root_agent_id = parent_agent.root_agent_id
            AND parent_workflow_root.id = parent_workflow_root.root_agent_id
            AND parent_workflow_root.parent_agent_id IS NULL
            AND parent_workflow_root.kind = 'session'
            AND parent_workflow_root.purpose = 'addressable'
        ))
        AND EXISTS (
          WITH RECURSIVE parent_agent_chain(id, parent_agent_id) AS (
            SELECT parent_agent.id, parent_agent.parent_agent_id
            UNION
            SELECT ancestor.id, ancestor.parent_agent_id
            FROM agent_nodes ancestor
            JOIN parent_agent_chain child_agent
              ON ancestor.id = child_agent.parent_agent_id
            WHERE ancestor.user_id = parent_agent.user_id
              AND ancestor.root_agent_id = parent_agent.root_agent_id
              AND ancestor.session_id = parent_agent.session_id
              AND ancestor.purpose = 'addressable'
          )
          SELECT 1 FROM parent_agent_chain chain_root
          JOIN agent_nodes owned_root
            ON owned_root.id = chain_root.id
           AND owned_root.user_id = parent_agent.user_id
           AND owned_root.session_id = parent_agent.session_id
          JOIN sessions root_session
            ON root_session.id = owned_root.session_id
           AND root_session.user_id = owned_root.user_id
          WHERE chain_root.id = parent_agent.root_agent_id
            AND chain_root.parent_agent_id IS NULL
            AND owned_root.id = owned_root.root_agent_id
            AND owned_root.kind = 'session'
            AND owned_root.purpose = 'addressable'
        )
    )
    SELECT 1 FROM visible_task_chain WHERE parent_task_id IS NULL
  )`;
export const JOINED_PROGRESS_MAX_EVENT_BYTES = 128 * 1024;
export const JOINED_PROGRESS_MAX_ITEMS = 256;
export const JOINED_PROGRESS_MAX_BYTES = 512 * 1024;
const JOINED_PROGRESS_COMPACT_AT_ITEMS = 192;
const JOINED_PROGRESS_COMPACT_TO_ITEMS = 128;
const JOINED_PROGRESS_COMPACT_AT_BYTES = 384 * 1024;
const JOINED_PROGRESS_COMPACT_TO_BYTES = 256 * 1024;
export const ORCHESTRATION_TREE_OPEN_TASK_LIMIT = 64;

export class OrchestrationTaskCapacityError extends Error {
  override name = "OrchestrationTaskCapacityError";
}
export const TEAM_MAX_MEMBERS = 16;
export const TEAM_MAX_MEMBER_HISTORY = 64;
export const TEAM_MAX_OPEN_MAIL_PER_MEMBER = 256;
export const TEAM_MAX_OPEN_WORK = 64;
export const TEAM_MAIL_MAX_HOPS = 8;
export const TEAM_MAIL_MAX_CLAIMS = 16;
export const TEAM_MAIL_PAYLOAD_MAX_BYTES = 64 * 1024;
export const TEAM_PROVISION_REQUEST_MAX_BYTES = 16 * 1024;
export const TEAM_MAIL_QUERY_MAX = 100;
export const TEAM_MAIL_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TEAM_WORK_MAX_MODEL_CYCLES = 64;
export const TEAM_WORK_MAX_TOKENS = 4_000_000;
const RECOVERY_BATCH_SIZE = 100;
const OPEN_TASK_STATUS_SQL = "'queued','starting','running','waiting','cancel_requested'";

export const EXACT_TEAM_WORK_MAIL_SQL = `SELECT work.id, work.target_session_id
  FROM runtime_tasks task
  JOIN team_mail work INDEXED BY idx_team_mail_work_task
    ON work.task_id = task.id AND work.user_id = task.user_id AND work.kind = 'work'
  WHERE task.id = ? AND task.user_id = ? AND task.kind = 'team_turn'`;

export function runnableBackgroundCandidatesSql(rootCount: number): string {
  if (!Number.isSafeInteger(rootCount) || rootCount < 1 || rootCount > ORCHESTRATION_QUERY_MAX) {
    throw new RangeError("Runnable background root count is out of bounds");
  }
  const placeholders = Array.from({ length: rootCount }, () => "?").join(",");
  return `WITH candidates AS (
    SELECT a.root_agent_id, t.user_id, t.session_id, t.id AS task_id,
      t.kind AS task_kind, a.kind AS agent_kind, t.created_at,
      ROW_NUMBER() OVER (
        PARTITION BY a.root_agent_id
        ORDER BY t.created_at ASC, t.id ASC
      ) AS root_ord
    FROM agent_nodes a INDEXED BY idx_agent_nodes_dispatch_children
    CROSS JOIN runtime_tasks t INDEXED BY idx_runtime_tasks_agent_open
      ON t.agent_id = a.id AND t.user_id = a.user_id
    JOIN agent_nodes root ON root.id = a.root_agent_id
      AND root.user_id = t.user_id AND root.id = root.root_agent_id
    JOIN sessions session ON session.id = t.session_id
      AND session.user_id = t.user_id AND root.session_id = session.id
    LEFT JOIN agent_turns owner_turn
      ON owner_turn.session_id = t.owner_session_id
        AND owner_turn.id = t.owner_turn_id
        AND owner_turn.status = 'in_progress'
    WHERE (t.await_policy = 'background' OR t.kind = 'team_turn')
      -- Repeat the partial-index predicate exactly. SQLite can then seek each
      -- Agent's open FIFO instead of scanning every queued background Task.
      AND t.status IN (${OPEN_TASK_STATUS_SQL}) AND t.status = 'queued'
      AND a.status <> 'closed'
      AND (
        (t.kind IN ('delegation','workflow_node') AND a.kind = 'subagent')
        OR (
          t.kind = 'team_turn' AND a.kind = 'session' AND a.id = a.root_agent_id
          AND session.status NOT IN ('running','closed')
          AND NOT EXISTS (
            SELECT 1 FROM pending_messages pending
            WHERE pending.session_id = t.session_id AND pending.consumed = 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_turns live_turn
            WHERE live_turn.session_id = t.session_id AND live_turn.status = 'in_progress'
          )
          AND EXISTS (
            SELECT 1 FROM team_mail work
            JOIN teams team ON team.id = work.team_id AND team.id = t.team_id
            JOIN team_members source ON source.id = work.source_member_id AND source.team_id = team.id
            JOIN team_members target ON target.id = work.target_member_id AND target.team_id = team.id
            WHERE work.task_id = t.id AND work.kind = 'work'
              AND work.status <> 'cancelled'
              AND (work.deadline_at > ? OR EXISTS (
                SELECT 1 FROM team_turn_outcomes outcome WHERE outcome.task_id = t.id
              ))
              AND team.user_id = t.user_id AND team.status = 'active'
              AND source.status = 'active' AND target.status = 'active'
              AND source.session_id = t.owner_session_id
              AND target.session_id = t.session_id AND target.agent_id = t.agent_id
          )
        )
      )
      AND a.root_agent_id IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM runtime_tasks earlier INDEXED BY idx_runtime_tasks_agent_open
        WHERE earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
          AND earlier.status IN (${OPEN_TASK_STATUS_SQL})
      )
      AND (t.cancel_policy <> 'linked' OR owner_turn.id IS NOT NULL)
  )
  SELECT root_agent_id, user_id, session_id, task_id, task_kind, agent_kind, created_at
  FROM candidates WHERE root_ord = 1
  ORDER BY root_agent_id ASC`;
}
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const ACTIVE_RECOVERY_STATUSES = new Set<TaskStatus>([
  "starting",
  "running",
  "waiting",
  "cancel_requested",
]);
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  queued: new Set(["starting", "cancel_requested"]),
  starting: new Set(["running", "cancel_requested", "failed", "interrupted"]),
  running: new Set(["waiting", "cancel_requested", "succeeded", "failed", "interrupted"]),
  waiting: new Set(["queued", "cancel_requested", "failed", "interrupted"]),
  cancel_requested: new Set(["cancelled", "failed", "interrupted"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

const AGENT_TRANSITIONS: Readonly<Record<AgentNodeStatus, ReadonlySet<AgentNodeStatus>>> = {
  initializing: new Set(["idle", "running", "interrupted", "error", "closed"]),
  idle: new Set(["running", "error", "closed"]),
  running: new Set(["idle", "interrupted", "error", "closed"]),
  interrupted: new Set(["initializing", "idle", "error", "closed"]),
  error: new Set(["initializing", "idle", "closed"]),
  closed: new Set(),
};

const TEAM_TRANSITIONS: Readonly<Record<TeamStatus, ReadonlySet<TeamStatus>>> = {
  active: new Set(["paused", "closed"]),
  paused: new Set(["active", "closed"]),
  closed: new Set(),
};

const TEAM_MEMBER_TRANSITIONS: Readonly<Record<TeamMemberStatus, ReadonlySet<TeamMemberStatus>>> = {
  active: new Set(["paused", "removed"]),
  paused: new Set(["active", "removed"]),
  removed: new Set(),
};

interface AgentNodeRow {
  id: string;
  user_id: string;
  session_id: string | null;
  root_agent_id: string;
  parent_agent_id: string | null;
  path: string;
  label: string | null;
  provider: string | null;
  model: string | null;
  thinking_level: AgentThinkingLevel | null;
  kind: AgentNodeKind;
  purpose: AgentNodePurpose;
  status: AgentNodeStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

interface RuntimeTaskRow {
  id: string;
  user_id: string;
  session_id: string;
  owner_session_id: string;
  owner_turn_id: string | null;
  owner_step_id: string | null;
  agent_id: string;
  agent_ord: number;
  parent_task_id: string | null;
  workflow_id: string | null;
  team_id: string | null;
  kind: TaskKind;
  title: string;
  payload_json: string;
  payload_bytes: number;
  status: TaskStatus;
  await_policy: TaskAwaitPolicy;
  cancel_policy: TaskCancelPolicy;
  checkpoint_safe: number;
  capability_contract_version: number;
  provider_tokens_used: number;
  provider_cost_used_micros: number;
  activity: TaskActivityCode | null;
  wait_reason: TaskWaitReasonCode | null;
  lease_generation: number;
  version: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  settled_at: number | null;
}

interface TeamRow {
  id: string;
  user_id: string;
  owner_session_id: string;
  root_agent_id: string | null;
  owner_session_ref: string | null;
  root_agent_ref: string | null;
  provision_key: string | null;
  provision_request_json: string | null;
  provision_state: "ready" | "provisioning" | "failed";
  lead_agent_id: string | null;
  name: string;
  status: TeamStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TeamMemberReservationRow {
  id: string;
  team_id: string;
  user_id: string;
  actor_session_id: string;
  role: string;
  provisioned_session_id: string;
  provisioned_agent_id: string;
  member_id: string;
  operation_key: string | null;
  request_json: string | null;
  status: "reserved" | "finalized" | "cancelled";
  provision_generation: number;
  provision_claim_token: string | null;
  provision_claim_expires_at: number | null;
  expires_at: number;
  cleanup_requested_at: number | null;
  cleanup_completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TeamMemberProvisionReservation {
  id: string;
  teamId: string;
  userId: string;
  actorSessionId: string;
  role: string;
  provisionedSessionId: string;
  provisionedAgentId: string;
  memberId: string;
  operationKey?: string;
  request?: OrchestrationJson;
  status: TeamMemberReservationRow["status"];
  provisionGeneration: number;
  provisionClaimToken?: string;
  provisionClaimExpiresAt?: number;
  expiresAt: number;
  cleanupRequestedAt?: number;
}

export interface TeamMemberProvisionClaim {
  reservation: TeamMemberProvisionReservation;
  teamName: string;
  generation: number;
  claimToken: string;
  claimExpiresAt: number;
}

interface TeamMemberRow {
  id: string;
  team_id: string;
  session_id: string;
  agent_id: string;
  role: string;
  status: TeamMemberStatus;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TeamMailRow {
  id: string;
  team_id: string;
  user_id: string;
  seq: number;
  source_member_id: string;
  source_session_id: string;
  target_member_id: string;
  target_session_id: string;
  kind: TeamMailKind;
  subject: string;
  payload_json: string;
  payload_bytes: number;
  idempotency_key: string;
  parent_mail_id: string | null;
  task_id: string | null;
  hop: number;
  deadline_at: number;
  budget_turns: number | null;
  budget_tokens: number | null;
  child_reserved_turns: number;
  child_reserved_tokens: number;
  budget_root_mail_id: string | null;
  budget_remaining_turns: number | null;
  budget_remaining_tokens: number | null;
  route_reserved_turns: number;
  route_reserved_tokens: number;
  route_used_turns: number;
  route_used_tokens: number;
  self_used_model_cycles: number;
  self_used_tokens: number;
  status: TeamMailDeliveryStatus;
  claim_generation: number;
  claim_token: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  claim_expires_at: number | null;
  acknowledged_at: number | null;
}

interface TeamTurnOutcomeRow {
  task_id: string;
  user_id: string;
  session_id: string;
  turn_id: string;
  task_lease_generation: number;
  mail_claim_generation: number;
  status: "completed" | "failed" | "interrupted" | "cancelled";
  summary: string;
  body_json: string;
  artifacts_json: string;
  model_cycles: number;
  tokens: number;
  created_at: number;
  updated_at: number;
}

export interface TeamTurnOutcome {
  taskId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  taskLeaseGeneration: number;
  mailClaimGeneration: number;
  status: TeamTurnOutcomeRow["status"];
  summary: string;
  body: OrchestrationJson;
  artifacts: OrchestrationJson;
  usage: { modelCycles: number; tokens: number };
  createdAt: number;
  updatedAt: number;
}

interface TaskEventRow {
  task_id: string;
  seq: number;
  task_version: number;
  lease_generation: number;
  type: string;
  payload_json: string;
  payload_bytes: number;
  created_at: number;
}

interface TaskProgressRow {
  task_id: string;
  lease_generation: number;
  last_seq: number;
  turn_id: string;
  status: AgentTurnStatus;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  source: "worker" | "recovery";
  owner_timeline_seq: number;
  nested_seq_highwater: number;
  omitted_items: number;
  omitted_bytes: number;
  snapshot_json: string;
  snapshot_bytes: number;
  item_count: number;
  last_event_hash: string;
  updated_at: number;
}

export interface JoinedTaskProgress {
  taskId: string;
  leaseGeneration: number;
  lastSeq: number;
  turnId: string;
  status: AgentTurnStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  source: "worker" | "recovery";
  ownerTimelineSeq: number;
  nestedSeqHighwater: number;
  omittedItems: number;
  omittedBytes: number;
  items: TimelineItem[];
  bytes: number;
  updatedAt: number;
}

export type CommitJoinedProgressResult =
  | {
      kind: "committed";
      progress: JoinedTaskProgress;
      parent: Extract<TimelineItem, { kind: "tool" }>;
      wire: "event" | "snapshot";
      legacyFallback: boolean;
    }
  | { kind: "duplicate"; progress: JoinedTaskProgress }
  | { kind: "stale" };

interface TaskResultRow {
  id: string;
  task_id: string;
  summary: string;
  body_json: string;
  artifacts_json: string;
  version: number;
  created_at: number;
  acknowledged_at: number | null;
}

interface TaskDigestRow extends RuntimeTaskRow {
  result_id: string | null;
  acknowledged_at: number | null;
}

export interface OrchestrationCursor {
  updatedAt: number;
  id: string;
}

export interface OrchestrationListOptions {
  limit?: number;
  before?: OrchestrationCursor;
}

export interface RunnableBackgroundRoot {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  taskId: string;
  taskKind: TaskKind;
  agentKind: AgentNodeKind;
  createdAt: number;
}

export interface RunnableBackgroundRootQuery {
  afterRootAgentId?: string;
  userId?: string;
  limit?: number;
}

export interface RunnableBackgroundRootPage {
  roots: RunnableBackgroundRoot[];
  scannedThrough?: string;
  exhausted: boolean;
}

export interface NewAgentNode {
  id: string;
  userId: string;
  sessionId?: string;
  rootAgentId: string;
  parentAgentId?: string;
  path: string;
  label?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  kind: AgentNodeKind;
  purpose?: AgentNodePurpose;
  status?: AgentNodeStatus;
  createdAt: number;
}

export interface NewRuntimeTask {
  id: string;
  userId: string;
  sessionId: string;
  ownerSessionId: string;
  ownerTurnId?: string;
  ownerStepId?: string;
  agentId: string;
  parentTaskId?: string;
  workflowId?: string;
  teamId?: string;
  kind: TaskKind;
  title: string;
  payload: OrchestrationJson;
  awaitPolicy: TaskAwaitPolicy;
  cancelPolicy: TaskCancelPolicy;
  checkpointSafe: boolean;
  capabilityContractVersion?: number;
  createdAt: number;
}

export interface NewTeamMember {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
}

export interface NewTeam {
  id: string;
  userId: string;
  ownerSessionId: string;
  actorSessionId: string;
  rootAgentId: string;
  name: string;
  members: readonly NewTeamMember[];
  leadMemberId: string;
  createdAt: number;
}

export interface NewProvisionedTeamRole {
  reservationId: string;
  operationKey: string;
  request: OrchestrationJson;
  role: string;
  provisionedSessionId: string;
  provisionedAgentId: string;
  memberId: string;
}

export interface NewProvisionedTeam {
  id: string;
  userId: string;
  ownerSessionId: string;
  actorSessionId: string;
  rootAgentId: string;
  ownerMember: NewTeamMember;
  name: string;
  idempotencyKey: string;
  request: OrchestrationJson;
  roles: readonly NewProvisionedTeamRole[];
  createdAt: number;
}

export interface NewTeamMail {
  id: string;
  userId: string;
  teamId: string;
  sourceSessionId: string;
  targetMemberId: string;
  kind: Exclude<TeamMailKind, "work">;
  subject: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  taskId?: string;
  activeParentLease?: ActiveTeamRouteLease;
  deadlineAt: number;
  createdAt: number;
}

export interface NewTeamWork {
  mailId: string;
  taskId: string;
  userId: string;
  teamId: string;
  sourceSessionId: string;
  targetMemberId: string;
  title: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  parentTaskId?: string;
  activeParentLease?: ActiveTeamRouteLease;
  ownerTurnId?: string;
  ownerStepId?: string;
  awaitPolicy: "background";
  cancelPolicy: TaskCancelPolicy;
  checkpointSafe: boolean;
  deadlineAt: number;
  budget: TeamWorkBudget;
  createdAt: number;
}

export interface TeamMailCursor {
  createdAt: number;
  id: string;
}

export interface TeamMailListOptions {
  limit?: number;
  before?: TeamMailCursor;
  status?: TeamMailDeliveryStatus;
}

export interface TaskTransitionInput {
  id: string;
  userId: string;
  expectedVersion: number;
  expectedLeaseGeneration: number;
  nextStatus: TaskStatus;
  at: number;
  activity?: TaskActivityCode;
  waitReason?: TaskWaitReasonCode;
  eventType?: string;
  eventPayload?: OrchestrationJson;
}

export interface TaskOwnerQuery extends OrchestrationListOptions {
  ownerSessionId: string;
  ownerTurnId?: string;
  ownerStepId?: string;
}

export interface NewTaskResult {
  id: string;
  taskId: string;
  userId: string;
  summary: string;
  body: OrchestrationJson;
  artifacts: OrchestrationJson;
  expectedTaskVersion: number;
  expectedLeaseGeneration: number;
  createdAt: number;
}

export interface TaskRecoveryResult {
  interrupted: number;
  requeued: number;
  waiting: number;
  cancelled: number;
}

export interface OrchestrationRevisionChange {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  revision: number;
  activityRevision: number;
}

export interface NewAgentTask {
  agent: NewAgentNode;
  task: NewRuntimeTask;
  initialMessages?: readonly OrchestrationJson[];
}

export interface AgentTranscriptSnapshot {
  version: number;
  messages: readonly OrchestrationJson[];
}

export interface AgentRosterSnapshot {
  rootAgentId: string;
  revision: number;
  nodes: AgentNode[];
  tasks: TaskDigest[];
  counts: AgentRosterCounts;
}

function limitOf(value: number | undefined): number {
  if (value === undefined) return ORCHESTRATION_QUERY_DEFAULT;
  if (!Number.isFinite(value)) return ORCHESTRATION_QUERY_DEFAULT;
  return Math.max(1, Math.min(ORCHESTRATION_QUERY_MAX, Math.trunc(value)));
}

function encodeJson(value: OrchestrationJson, maxBytes: number, field: string): { json: string; bytes: number } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable`, { cause: error });
  }
  if (json === undefined) throw new TypeError(`${field} must be JSON serializable`);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  return { json, bytes };
}

function assertUtf8Bytes(value: string, maxBytes: number, field: string): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

function assertBoundedText(value: string, maxBytes: number, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`);
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} must not contain control characters`);
  assertUtf8Bytes(value, maxBytes, field);
}

function assertEventType(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 64) {
    throw new RangeError("event type must contain 1 to 64 UTF-8 bytes");
  }
}

function rowExists(sql: string, ...values: Array<string | number>): boolean {
  return db.prepare(sql).get(...values) !== undefined;
}

interface AgentRootRow {
  root_agent_id: string;
  user_id: string;
  purpose: AgentNodePurpose;
}

function agentRootRow(agentId: string, userId: string): AgentRootRow | undefined {
  return db.prepare(
    "SELECT root_agent_id, user_id, purpose FROM agent_nodes WHERE id = ? AND user_id = ?",
  ).get(agentId, userId) as AgentRootRow | undefined;
}

interface OwnedRootScope {
  rootAgentId: string;
  sessionId: string;
}

function ownedRootScope(userId: string, rootAgentId: string): OwnedRootScope | undefined {
  const row = db.prepare(
    `SELECT root.id AS root_agent_id, root.session_id
     FROM agent_nodes root
     JOIN sessions root_session
       ON root_session.id = root.session_id AND root_session.user_id = root.user_id
     WHERE root.id = ? AND root.user_id = ?
       AND root.id = root.root_agent_id AND root.parent_agent_id IS NULL
       AND root.kind = 'session' AND root.purpose = 'addressable'`,
  ).get(rootAgentId, userId) as { root_agent_id: string; session_id: string } | undefined;
  return row ? { rootAgentId: row.root_agent_id, sessionId: row.session_id } : undefined;
}

function rootScopeForAgent(userId: string, agentId: string): OwnedRootScope | undefined {
  const row = db.prepare(
    `SELECT agent.root_agent_id, root.session_id
     FROM agent_nodes agent
     JOIN agent_nodes root
       ON root.id = agent.root_agent_id AND root.user_id = agent.user_id
     JOIN sessions root_session
       ON root_session.id = root.session_id AND root_session.user_id = root.user_id
     WHERE agent.id = ? AND agent.user_id = ?
       AND root.id = root.root_agent_id AND root.parent_agent_id IS NULL
       AND root.kind = 'session' AND root.purpose = 'addressable'`,
  ).get(agentId, userId) as { root_agent_id: string; session_id: string } | undefined;
  return row ? { rootAgentId: row.root_agent_id, sessionId: row.session_id } : undefined;
}

function rootScopeForTask(userId: string, taskId: string): OwnedRootScope | undefined {
  const row = db.prepare(
    `SELECT agent.root_agent_id, root.session_id
     FROM runtime_tasks task
     JOIN agent_nodes agent ON agent.id = task.agent_id AND agent.user_id = task.user_id
     JOIN agent_nodes root
       ON root.id = agent.root_agent_id AND root.user_id = agent.user_id
     JOIN sessions root_session
       ON root_session.id = root.session_id AND root_session.user_id = root.user_id
     WHERE task.id = ? AND task.user_id = ?
       AND root.id = root.root_agent_id AND root.parent_agent_id IS NULL
       AND root.kind = 'session' AND root.purpose = 'addressable'`,
  ).get(taskId, userId) as { root_agent_id: string; session_id: string } | undefined;
  return row ? { rootAgentId: row.root_agent_id, sessionId: row.session_id } : undefined;
}

function visibleSessionParams(scope: OwnedRootScope, userId: string): readonly [string, string, string, string, string] {
  return [scope.rootAgentId, userId, scope.sessionId, userId, scope.sessionId];
}

function executableSessionParams(scope: OwnedRootScope, userId: string): readonly [string, string, string] {
  return [scope.rootAgentId, userId, scope.sessionId];
}

export function bumpOrchestrationActivityRevisionInTransaction(userId: string, at: number): number {
  const row = db.prepare(
    `INSERT INTO orchestration_user_revisions (user_id, activity_revision, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       activity_revision = activity_revision + 1,
       updated_at = excluded.updated_at
     RETURNING activity_revision`,
  ).get(userId, at) as { activity_revision: number };
  return Number(row.activity_revision);
}

function bumpRoster(rootAgentId: string, userId: string, at: number, addressable = true): number {
  const row = db.prepare(
    `UPDATE agent_rosters
     SET revision = revision + 1,
         addressable_revision = addressable_revision + ?,
         updated_at = ?
     WHERE root_agent_id = ? AND user_id = ? RETURNING revision`,
  ).get(addressable ? 1 : 0, at, rootAgentId, userId) as { revision: number } | undefined;
  if (!row) throw new Error("Agent roster not found for owned tree");
  if (addressable) bumpOrchestrationActivityRevisionInTransaction(userId, at);
  return Number(row.revision);
}

function bumpRosterForAgent(agentId: string, userId: string, at: number): number {
  const root = agentRootRow(agentId, userId);
  if (!root) throw new Error("Agent not found while advancing its roster");
  return bumpRoster(root.root_agent_id, root.user_id, at, root.purpose === "addressable");
}

function rosterRevisionForAgent(agentId: string, userId: string): number {
  const row = db.prepare(
    `SELECT r.revision, r.addressable_revision, a.purpose FROM agent_nodes a
     JOIN agent_rosters r ON r.root_agent_id = a.root_agent_id AND r.user_id = a.user_id
     WHERE a.id = ? AND a.user_id = ?`,
  ).get(agentId, userId) as {
    revision: number;
    addressable_revision: number;
    purpose: AgentNodePurpose;
  } | undefined;
  if (!row) throw new Error("Agent roster not found for owned tree");
  return Number(row.purpose === "addressable" ? row.addressable_revision : row.revision);
}

function isJsonRecord(value: OrchestrationJson): value is { [key: string]: OrchestrationJson } {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function assertContentBlocks(
  content: OrchestrationJson,
  index: number,
  allowed: ReadonlySet<string>,
): void {
  if (!Array.isArray(content)) throw new TypeError(`Agent transcript message ${index} has invalid content`);
  for (const [blockIndex, block] of content.entries()) {
    if (!isJsonRecord(block) || typeof block.type !== "string" || !allowed.has(block.type)) {
      throw new TypeError(`Agent transcript message ${index} has invalid content block ${blockIndex}`);
    }
    if (block.type === "text" && typeof block.text !== "string") {
      throw new TypeError(`Agent transcript text block ${index}:${blockIndex} is incomplete`);
    }
    if (block.type === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) {
      throw new TypeError(`Agent transcript image block ${index}:${blockIndex} is incomplete`);
    }
    if (block.type === "thinking" && typeof block.thinking !== "string") {
      throw new TypeError(`Agent transcript thinking block ${index}:${blockIndex} is incomplete`);
    }
    if (
      block.type === "toolCall"
      && (typeof block.id !== "string" || typeof block.name !== "string" || !isJsonRecord(block.arguments))
    ) {
      throw new TypeError(`Agent transcript Tool call ${index}:${blockIndex} is incomplete`);
    }
  }
}

function assertAgentMessageShape(message: OrchestrationJson, index: number): void {
  if (message === null || Array.isArray(message) || typeof message !== "object") {
    throw new TypeError(`Agent transcript message ${index} must be a pi Message object`);
  }
  const value = message as Record<string, OrchestrationJson>;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "toolResult") {
    throw new TypeError(`Agent transcript message ${index} has an invalid role`);
  }
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    throw new TypeError(`Agent transcript message ${index} requires a finite timestamp`);
  }
  if (value.role === "user") {
    if (typeof value.content !== "string") assertContentBlocks(value.content, index, new Set(["text", "image"]));
    return;
  }
  if (value.role === "toolResult") {
    assertContentBlocks(value.content, index, new Set(["text", "image"]));
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string" || typeof value.isError !== "boolean") {
      throw new TypeError(`Agent transcript tool result ${index} is incomplete`);
    }
    return;
  }
  assertContentBlocks(value.content, index, new Set(["text", "thinking", "toolCall"]));
  if (
    typeof value.api !== "string"
    || typeof value.provider !== "string"
    || typeof value.model !== "string"
    || (value.stopReason !== "stop" && value.stopReason !== "length" && value.stopReason !== "toolUse"
      && value.stopReason !== "error" && value.stopReason !== "aborted")
    || value.usage === null
    || Array.isArray(value.usage)
    || typeof value.usage !== "object"
  ) {
    throw new TypeError(`Agent transcript assistant message ${index} is incomplete`);
  }
  const usage = value.usage as { [key: string]: OrchestrationJson };
  const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (usageFields.some((field) => typeof usage[field] !== "number" || !Number.isFinite(usage[field]))) {
    throw new TypeError(`Agent transcript assistant usage ${index} is incomplete`);
  }
  const cost = usage.cost;
  if (!isJsonRecord(cost)) {
    throw new TypeError(`Agent transcript assistant cost ${index} is incomplete`);
  }
  const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (costFields.some((field) => typeof cost[field] !== "number" || !Number.isFinite(cost[field]))) {
    throw new TypeError(`Agent transcript assistant cost ${index} is incomplete`);
  }
}

function deepFreezeJson<T extends OrchestrationJson>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function cursorSql(
  column = "updated_at",
  alias = "",
): { clause: string; values: (before: OrchestrationCursor | undefined) => Array<string | number | null> } {
  const prefix = alias ? `${alias}.` : "";
  return {
    clause: `(? IS NULL OR ${prefix}${column} < ? OR (${prefix}${column} = ? AND ${prefix}id < ?))`,
    values: (before) => [
      before?.updatedAt ?? null,
      before?.updatedAt ?? 0,
      before?.updatedAt ?? 0,
      before?.id ?? "",
    ],
  };
}

function mapAgent(row: AgentNodeRow): AgentNode {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    rootAgentId: row.root_agent_id,
    ...(row.parent_agent_id === null ? {} : { parentAgentId: row.parent_agent_id }),
    path: row.path,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.thinking_level === null ? {} : { thinkingLevel: row.thinking_level }),
    kind: row.kind,
    purpose: row.purpose,
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTask(row: RuntimeTaskRow): RuntimeTask {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    ownerSessionId: row.owner_session_id,
    ...(row.owner_turn_id === null ? {} : { ownerTurnId: row.owner_turn_id }),
    ...(row.owner_step_id === null ? {} : { ownerStepId: row.owner_step_id }),
    agentId: row.agent_id,
    agentOrd: Number(row.agent_ord),
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
    ...(row.team_id === null ? {} : { teamId: row.team_id }),
    kind: row.kind,
    title: row.title,
    payload: JSON.parse(row.payload_json) as OrchestrationJson,
    status: row.status,
    awaitPolicy: row.await_policy,
    cancelPolicy: row.cancel_policy,
    checkpointSafe: row.checkpoint_safe === 1,
    capabilityContractVersion: Number(row.capability_contract_version),
    providerTokensUsed: Number(row.provider_tokens_used),
    providerCostUsedMicros: Number(row.provider_cost_used_micros),
    ...(row.activity === null ? {} : { activity: row.activity }),
    ...(row.wait_reason === null ? {} : { waitReason: row.wait_reason }),
    leaseGeneration: Number(row.lease_generation),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapTeam(row: TeamRow): Team {
  if (!row.root_agent_id) throw new Error("Team has no Session root binding");
  return {
    id: row.id,
    userId: row.user_id,
    ownerSessionId: row.owner_session_id,
    rootAgentId: row.root_agent_id,
    ownerAvailable: row.owner_session_ref !== null && row.root_agent_ref !== null,
    ...(row.lead_agent_id === null ? {} : { leadAgentId: row.lead_agent_id }),
    name: row.name,
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTeamMember(row: TeamMemberRow): TeamMember {
  return {
    id: row.id,
    teamId: row.team_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    role: row.role,
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapTeamMemberReservation(row: TeamMemberReservationRow): TeamMemberProvisionReservation {
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    actorSessionId: row.actor_session_id,
    role: row.role,
    provisionedSessionId: row.provisioned_session_id,
    provisionedAgentId: row.provisioned_agent_id,
    memberId: row.member_id,
    ...(row.operation_key === null ? {} : { operationKey: row.operation_key }),
    ...(row.request_json === null ? {} : { request: JSON.parse(row.request_json) as OrchestrationJson }),
    status: row.status,
    provisionGeneration: Number(row.provision_generation),
    ...(row.provision_claim_token === null
      ? {}
      : { provisionClaimToken: row.provision_claim_token }),
    ...(row.provision_claim_expires_at === null
      ? {}
      : { provisionClaimExpiresAt: Number(row.provision_claim_expires_at) }),
    expiresAt: Number(row.expires_at),
    ...(row.cleanup_requested_at === null
      ? {}
      : { cleanupRequestedAt: Number(row.cleanup_requested_at) }),
  };
}

function mapTeamMail(row: TeamMailRow): TeamMail {
  const budget = row.budget_turns === null || row.budget_tokens === null
    ? undefined
    : { maxModelCycles: Number(row.budget_turns), maxTokens: Number(row.budget_tokens) };
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
    payload: JSON.parse(row.payload_json) as OrchestrationJson,
    idempotencyKey: row.idempotency_key,
    ...(row.parent_mail_id === null ? {} : { parentMailId: row.parent_mail_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    hop: Number(row.hop),
    deadlineAt: Number(row.deadline_at),
    ...(budget ? { budget } : {}),
    ...(budget ? {
      childBudgetReserved: {
        maxModelCycles: Number(row.child_reserved_turns),
        maxTokens: Number(row.child_reserved_tokens),
      },
    } : {}),
    status: row.status,
    claimGeneration: Number(row.claim_generation),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.claimed_at === null ? {} : { claimedAt: Number(row.claimed_at) }),
    ...(row.claim_expires_at === null ? {} : { claimExpiresAt: Number(row.claim_expires_at) }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: Number(row.acknowledged_at) }),
  };
}

function mapTeamMailDigest(row: TeamMailRow): TeamMailDigest {
  const { payload: _payload, ...digest } = mapTeamMail(row);
  return { ...digest, payloadBytes: Number(row.payload_bytes) };
}

function mapTeamTurnOutcome(row: TeamTurnOutcomeRow): TeamTurnOutcome {
  return {
    taskId: row.task_id,
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    taskLeaseGeneration: Number(row.task_lease_generation),
    mailClaimGeneration: Number(row.mail_claim_generation),
    status: row.status,
    summary: row.summary,
    body: JSON.parse(row.body_json) as OrchestrationJson,
    artifacts: JSON.parse(row.artifacts_json) as OrchestrationJson,
    usage: { modelCycles: Number(row.model_cycles), tokens: Number(row.tokens) },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapDigest(row: TaskDigestRow): TaskDigest {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    title: row.title,
    status: row.status,
    awaitPolicy: row.await_policy,
    ...(row.activity === null ? {} : { activity: row.activity }),
    ...(row.wait_reason === null ? {} : { waitReason: row.wait_reason }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
    ...(row.result_id === null ? {} : { resultId: row.result_id }),
    unreadResult: row.result_id !== null && row.acknowledged_at === null,
  };
}

function mapEvent(row: TaskEventRow): TaskEvent {
  return {
    taskId: row.task_id,
    seq: Number(row.seq),
    taskVersion: Number(row.task_version),
    leaseGeneration: Number(row.lease_generation),
    type: row.type,
    payload: JSON.parse(row.payload_json) as OrchestrationJson,
    createdAt: Number(row.created_at),
  };
}

function mapProgress(row: TaskProgressRow): JoinedTaskProgress {
  return {
    taskId: row.task_id,
    leaseGeneration: Number(row.lease_generation),
    lastSeq: Number(row.last_seq),
    turnId: row.turn_id,
    status: row.status,
    startedAt: Number(row.started_at),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    source: row.source,
    ownerTimelineSeq: Number(row.owner_timeline_seq),
    nestedSeqHighwater: Number(row.nested_seq_highwater),
    omittedItems: Number(row.omitted_items),
    omittedBytes: Number(row.omitted_bytes),
    items: JSON.parse(row.snapshot_json) as TimelineItem[],
    bytes: Number(row.snapshot_bytes),
    updatedAt: Number(row.updated_at),
  };
}

function mapResult(row: TaskResultRow): TaskResult {
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
}

function appendEventEncoded(
  taskId: string,
  taskVersion: number,
  leaseGeneration: number,
  type: string,
  encoded: { json: string; bytes: number },
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO task_events
      (task_id, seq, task_version, lease_generation, type, payload_json, payload_bytes, created_at)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?
       FROM task_events WHERE task_id = ?`,
  ).run(
    taskId,
    taskVersion,
    leaseGeneration,
    type,
    encoded.json,
    encoded.bytes,
    createdAt,
    taskId,
  );
}

export function detachWorkflowTasksOwnedBySessionInTransaction(ownerSessionId: string, at: number): number {
  const selectWorkflow = db.prepare(
    `SELECT rowid AS detach_rowid, id, user_id
     FROM workflows
     WHERE owner_session_id = ? AND rowid > ?
     ORDER BY rowid ASC
     LIMIT 1`,
  );
  const selectBatch = db.prepare(
    `SELECT rowid AS detach_rowid, id, status
     FROM runtime_tasks
     WHERE workflow_id = ? AND user_id = ?
       AND session_id <> ? AND owner_session_id <> ?
       AND rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`,
  );
  const updateBatch = db.prepare(
    `UPDATE runtime_tasks
     SET workflow_id = NULL,
         status = CASE
           WHEN status IN ('succeeded', 'failed', 'cancelled', 'interrupted') THEN status
           WHEN status = 'queued' THEN 'cancelled'
           ELSE 'interrupted'
         END,
         activity = NULL,
         wait_reason = NULL,
         settled_at = CASE
           WHEN status IN ('succeeded', 'failed', 'cancelled', 'interrupted') THEN settled_at
           ELSE MAX(updated_at + 1, ?)
         END,
         version = version + 1,
         updated_at = MAX(updated_at + 1, ?)
     WHERE id IN (
       SELECT CAST(json_extract(value, '$[0]') AS TEXT) FROM json_each(?)
     )
       AND workflow_id IS NOT NULL
       AND session_id <> ? AND owner_session_id <> ?
       AND EXISTS (
         SELECT 1 FROM workflows owned_workflow
         WHERE owned_workflow.id = runtime_tasks.workflow_id
           AND owned_workflow.user_id = runtime_tasks.user_id
           AND owned_workflow.owner_session_id = ?
       )
     RETURNING id, status, lease_generation, version, updated_at`,
  );
  const insertEvents = db.prepare(WORKFLOW_TASK_DETACH_EVENT_INSERT_SQL);
  type Candidate = {
    detach_rowid: number;
    id: string;
    status: TaskStatus;
  };
  type OwnedWorkflow = {
    detach_rowid: number;
    id: string;
    user_id: string;
  };
  type Updated = {
    id: string;
    status: TaskStatus;
    lease_generation: number;
    version: number;
    updated_at: number;
  };

  let changed = 0;
  let workflowCursor = 0;
  while (true) {
    const workflow = selectWorkflow.get(ownerSessionId, workflowCursor) as OwnedWorkflow | undefined;
    if (!workflow) break;
    let taskCursor = 0;
    while (true) {
      const candidates = selectBatch.all(
        workflow.id,
        workflow.user_id,
        ownerSessionId,
        ownerSessionId,
        taskCursor,
        WORKFLOW_TASK_DETACH_BATCH_SIZE,
      ) as unknown as Candidate[];
      if (candidates.length === 0) break;

      const idsJson = JSON.stringify(candidates.map((candidate) => [candidate.id]));
      const updated = updateBatch.all(
        at,
        at,
        idsJson,
        ownerSessionId,
        ownerSessionId,
        ownerSessionId,
      ) as unknown as Updated[];
      if (updated.length !== candidates.length) {
        throw new Error("Workflow Task detach batch changed unexpectedly");
      }
      const priorById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const events = updated.map((task) => {
        const prior = priorById.get(task.id);
        if (!prior) throw new Error("Workflow Task detach result was not selected");
        const terminal = TERMINAL_TASK_STATUSES.has(prior.status);
        const payload = encodeJson(
          {
            workflowId: workflow.id,
            reason: "owner_session_deleted",
            priorStatus: prior.status,
            status: task.status,
          },
          TASK_EVENT_PAYLOAD_MAX_BYTES,
          "Task event payload",
        );
        return [
          task.id,
          task.version,
          task.lease_generation,
          terminal ? "workflow:detached" : `workflow:${task.status}`,
          payload.json,
          payload.bytes,
          task.updated_at,
        ];
      });
      const inserted = insertEvents.run(JSON.stringify(events));
      if (Number(inserted.changes) !== events.length) {
        throw new Error("Workflow Task detach events were not appended atomically");
      }

      taskCursor = candidates.at(-1)!.detach_rowid;
      changed += candidates.length;
    }
    workflowCursor = workflow.detach_rowid;
  }
  return changed;
}

function insertAgentNode(input: NewAgentNode): AgentNode {
  const status = input.status ?? "initializing";
  const purpose = input.purpose ?? "addressable";
  if (!input.path.startsWith("/")) throw new Error("Agent path must be absolute inside its tree");
  assertUtf8Bytes(input.path, 512, "Agent path");
  if (input.label !== undefined) assertUtf8Bytes(input.label, 256, "Agent label");
  if (
    input.sessionId !== undefined
    && !rowExists("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?", input.sessionId, input.userId)
  ) throw new Error("Agent Session is not owned by the user");
  if (input.rootAgentId === input.id) {
    if (input.parentAgentId !== undefined) throw new Error("A root Agent cannot have a parent");
    if (input.kind !== "session") throw new Error("A root Agent must be Session-backed");
    if (input.sessionId === undefined) throw new Error("A root Agent requires a real Session");
    if (purpose !== "addressable") throw new Error("A Session root must be addressable");
  } else {
    if (input.kind === "session") throw new Error("A Session Agent must be a tree root");
    const parent = input.parentAgentId === undefined
      ? undefined
      : db.prepare(
        "SELECT root_agent_id, purpose FROM agent_nodes WHERE id = ? AND user_id = ?",
      ).get(input.parentAgentId, input.userId) as {
        root_agent_id: string;
        purpose: AgentNodePurpose;
      } | undefined;
    if (!parent || parent.root_agent_id !== input.rootAgentId) {
      throw new Error("Agent parent must belong to the same owned tree");
    }
    const root = db.prepare(
      `SELECT session_id FROM agent_nodes
       WHERE id = ? AND user_id = ? AND root_agent_id = ?
         AND parent_agent_id IS NULL AND kind = 'session' AND purpose = 'addressable'`,
    ).get(
      input.rootAgentId,
      input.userId,
      input.rootAgentId,
    ) as { session_id: string | null } | undefined;
    if (!root) throw new Error("Agent root is not owned by the user");
    if (input.kind === "subagent" && (!input.sessionId || input.sessionId !== root.session_id)) {
      throw new Error("A SubAgent must use its root Session");
    }
    if (
      purpose === "addressable"
      && !rowExists(
        `SELECT 1 FROM agent_nodes a
         JOIN sessions agent_session
           ON agent_session.id = a.session_id AND agent_session.user_id = a.user_id
         WHERE a.id = ? AND a.user_id = ? AND a.root_agent_id = ?
           AND a.session_id = ? AND a.purpose = 'addressable'
         ${VISIBLE_AGENT_ANCESTRY_SQL}`,
        input.parentAgentId!,
        input.userId,
        input.rootAgentId,
        input.sessionId!,
      )
    ) throw new Error("An addressable Agent requires a recursively visible addressable parent");
  }
  if ((input.provider === undefined) !== (input.model === undefined)) {
    throw new Error("Agent provider and model provenance must be stored together");
  }
  if (input.kind === "subagent" && (input.provider === undefined || input.model === undefined)) {
    throw new Error("A SubAgent requires pinned provider/model provenance");
  }
  if (purpose === "joined_slot" && (input.kind !== "subagent" || input.label !== "Joined delegation slot")) {
    throw new Error("A joined slot requires its reserved SubAgent identity");
  }
  if (input.provider !== undefined) assertUtf8Bytes(input.provider, 128, "Agent provider");
  if (input.model !== undefined) assertUtf8Bytes(input.model, 256, "Agent model");
  const row = db.prepare(
    `INSERT INTO agent_nodes
       (id, user_id, session_id, root_agent_id, parent_agent_id, path, label,
        provider, model, thinking_level, kind, purpose, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
  ).get(
    input.id,
    input.userId,
    input.sessionId ?? null,
    input.rootAgentId,
    input.parentAgentId ?? null,
    input.path,
    input.label ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.thinkingLevel ?? null,
    input.kind,
    purpose,
    status,
    input.createdAt,
    input.createdAt,
  ) as unknown as AgentNodeRow;
  if (input.rootAgentId === input.id) {
    db.prepare(
      `INSERT INTO agent_rosters (root_agent_id, user_id, revision, updated_at)
       VALUES (?, ?, 1, ?)`,
    ).run(input.id, input.userId, input.createdAt);
    bumpOrchestrationActivityRevisionInTransaction(input.userId, input.createdAt);
  } else {
    bumpRoster(input.rootAgentId, input.userId, input.createdAt, purpose === "addressable");
  }
  return mapAgent(row);
}

export function insertWorkflowExecutorAgentsInTransaction(
  inputs: readonly NewAgentNode[],
): AgentNode[] {
  return inputs.map((input) => {
    if (
      input.kind !== "subagent"
      || (input.purpose ?? "addressable") !== "addressable"
      || (input.status ?? "initializing") !== "idle"
    ) {
      throw new Error("Workflow launch can provision only idle addressable Child Agents");
    }
    return insertAgentNode(input);
  });
}

export function closeWorkflowExecutorAgentInTransaction(input: {
  userId: string;
  agentId: string;
  at: number;
}): boolean {
  const row = db.prepare(
    `UPDATE agent_nodes
     SET status = 'closed', version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND id <> root_agent_id
       AND kind = 'subagent' AND purpose = 'addressable' AND status <> 'closed'
     RETURNING *`,
  ).get(input.at, input.agentId, input.userId) as AgentNodeRow | undefined;
  if (!row) return false;
  bumpRoster(row.root_agent_id, row.user_id, input.at, true);
  return true;
}

type RuntimeTaskCreationAuthority = "delegation" | "workflow" | "team";

function assertTaskCreationAuthority(input: NewRuntimeTask, authority: RuntimeTaskCreationAuthority): void {
  const expectedKind: TaskKind = authority === "workflow"
    ? "workflow_node"
    : authority === "team"
      ? "team_turn"
      : "delegation";
  if (input.kind !== expectedKind) {
    throw new Error(`${expectedKind} Tasks require their trusted orchestration creator`);
  }
  if (authority === "workflow" && input.workflowId === undefined) {
    throw new Error("A Workflow Task requires its durable Workflow identity");
  }
  if (authority !== "workflow" && input.workflowId !== undefined) {
    throw new Error("Only a Workflow coordinator can bind a Task to a Workflow");
  }
  if (authority !== "workflow" && input.capabilityContractVersion !== undefined) {
    throw new Error("Only a Workflow coordinator can attest a Task capability contract");
  }
  const managed = db.prepare(
    `SELECT workflow_id, retired_at FROM workflow_managed_executors
     WHERE agent_id = ?`,
  ).get(input.agentId) as { workflow_id: string; retired_at: number | null } | undefined;
  if (managed) {
    if (managed.retired_at !== null) {
      throw new Error("A retired Workflow executor cannot accept another Task");
    }
    if (authority !== "workflow" || input.workflowId !== managed.workflow_id) {
      throw new Error("A managed Workflow executor accepts only its owning Workflow Tasks");
    }
  }
}

function insertRuntimeTask(
  input: NewRuntimeTask,
  authority: RuntimeTaskCreationAuthority = "delegation",
): RuntimeTask {
  assertTaskCreationAuthority(input, authority);
  const payload = encodeJson(input.payload, TASK_PAYLOAD_MAX_BYTES, "Task payload");
  const createdEvent = encodeJson({ status: "queued" }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
  assertUtf8Bytes(input.title, 512, "Task title");
  if (!input.title.trim()) throw new Error("Task title must not be empty");
  if (input.kind === "delegation" && (input.workflowId || input.teamId)) {
    throw new Error("Delegation Tasks cannot forge Workflow or Team ownership");
  }
  if (input.kind === "workflow_node" && input.teamId) {
    throw new Error("Workflow node Tasks cannot forge Team ownership");
  }
  if (input.kind === "team_turn" && (!input.teamId || input.workflowId)) {
    throw new Error("Team turn Tasks require exactly one Team owner");
  }
  const sessionOwned = rowExists(
    "SELECT 1 FROM sessions WHERE id = ? AND user_id = ?",
    input.sessionId,
    input.userId,
  );
  const ownerSessionOwned = rowExists(
    "SELECT 1 FROM sessions WHERE id = ? AND user_id = ?",
    input.ownerSessionId,
    input.userId,
  );
  const agent = db.prepare(
    "SELECT session_id, root_agent_id, purpose FROM agent_nodes WHERE id = ? AND user_id = ?",
  ).get(input.agentId, input.userId) as {
    session_id: string | null;
    root_agent_id: string;
    purpose: AgentNodePurpose;
  } | undefined;
  if (!sessionOwned || !ownerSessionOwned || !agent) {
    throw new Error("Task Agent and Sessions must be owned by the same user");
  }
  if (agent.session_id !== null && agent.session_id !== input.sessionId) {
    throw new Error("Task execution Session must match its Agent context");
  }
  if (
    agent.purpose === "addressable"
    && !rowExists(
      `SELECT 1 FROM agent_nodes a
       JOIN sessions agent_session
         ON agent_session.id = a.session_id AND agent_session.user_id = a.user_id
       WHERE a.id = ? AND a.user_id = ? AND a.session_id = ?
         AND a.purpose = 'addressable'
       ${VISIBLE_AGENT_ANCESTRY_SQL}`,
      input.agentId,
      input.userId,
      input.sessionId,
    )
  ) throw new Error("An addressable Task requires a recursively visible Agent parent");
  if (
    input.cancelPolicy === "linked"
    && (
      !input.ownerTurnId
      || !rowExists(
        `SELECT 1 FROM agent_turns
         WHERE id = ? AND session_id = ? AND status = 'in_progress'`,
        input.ownerTurnId,
        input.ownerSessionId,
      )
    )
  ) throw new Error("A linked Task requires a live owner Turn in its owner Session");
  const agentOrd = Number((db.prepare(
    "SELECT COALESCE(MAX(agent_ord), 0) + 1 AS ord FROM runtime_tasks WHERE agent_id = ?",
  ).get(input.agentId) as { ord: number }).ord);
  if (
    input.parentTaskId !== undefined
    && !(input.kind === "team_turn"
      ? rowExists(
        `SELECT 1 FROM runtime_tasks
         WHERE id = ? AND user_id = ? AND kind = 'team_turn' AND team_id = ?`,
        input.parentTaskId,
        input.userId,
        input.teamId ?? "",
      )
      : rowExists(
        `SELECT 1 FROM runtime_tasks parent_task
         JOIN agent_nodes parent_agent
           ON parent_agent.id = parent_task.agent_id
          AND parent_agent.user_id = parent_task.user_id
         JOIN agent_nodes child_agent
           ON child_agent.id = ?
          AND child_agent.user_id = parent_task.user_id
         WHERE parent_task.id = ? AND parent_task.user_id = ?
           AND parent_task.status IN ('starting', 'running', 'waiting', 'cancel_requested')
           AND parent_agent.root_agent_id = child_agent.root_agent_id`,
        input.agentId,
        input.parentTaskId,
        input.userId,
      ))
  ) throw new Error("Parent Task must belong to the same owned Agent tree");
  if (
    input.parentTaskId !== undefined
    && input.kind !== "team_turn"
    && agent.purpose === "addressable"
    && !rowExists(
      `SELECT 1 FROM runtime_tasks t
       JOIN agent_nodes a
         ON a.id = t.agent_id AND a.user_id = t.user_id
        AND a.purpose = 'addressable'
       JOIN sessions execution_session
         ON execution_session.id = t.session_id AND execution_session.user_id = t.user_id
       JOIN sessions owner_session
         ON owner_session.id = t.owner_session_id AND owner_session.user_id = t.user_id
       WHERE t.id = ? AND t.user_id = ? AND t.session_id = ?
         ${VISIBLE_AGENT_ANCESTRY_SQL}
         ${VISIBLE_TASK_ANCESTRY_SQL}
         ${OWNED_TASK_WORKFLOW_SQL}`,
      input.parentTaskId,
      input.userId,
      input.sessionId,
    )
  ) throw new Error("An addressable Task requires a recursively visible addressable parent Task");
  if (
    input.workflowId !== undefined
    && !rowExists(
      `SELECT 1 FROM workflows workflow
       JOIN sessions workflow_owner
         ON workflow_owner.id = workflow.owner_session_id
        AND workflow_owner.user_id = workflow.user_id
       JOIN agent_nodes workflow_root
         ON workflow_root.id = workflow.root_agent_id
        AND workflow_root.user_id = workflow.user_id
       JOIN sessions root_session
         ON root_session.id = workflow_root.session_id
        AND root_session.user_id = workflow_root.user_id
       WHERE workflow.id = ? AND workflow.user_id = ?
         AND workflow_root.session_id = ? AND workflow_root.root_agent_id = ?
         AND workflow_root.id = workflow_root.root_agent_id
         AND workflow_root.parent_agent_id IS NULL
         AND workflow_root.kind = 'session' AND workflow_root.purpose = 'addressable'`,
      input.workflowId,
      input.userId,
      input.sessionId,
      agent.root_agent_id,
    )
  ) throw new Error("Workflow must own the Task Agent root");
  const row = db.prepare(
    `INSERT INTO runtime_tasks
       (id, user_id, session_id, owner_session_id, owner_turn_id, owner_step_id,
        agent_id, agent_ord, parent_task_id, workflow_id, team_id, kind, title, payload_json, payload_bytes,
        status, await_policy, cancel_policy, checkpoint_safe, capability_contract_version, activity, wait_reason,
        lease_generation, version, created_at, updated_at, started_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, 0, 1, ?, ?, NULL, NULL)
     RETURNING *`,
  ).get(
    input.id,
    input.userId,
    input.sessionId,
    input.ownerSessionId,
    input.ownerTurnId ?? null,
    input.ownerStepId ?? null,
    input.agentId,
    agentOrd,
    input.parentTaskId ?? null,
    input.workflowId ?? null,
    input.teamId ?? null,
    input.kind,
    input.title,
    payload.json,
    payload.bytes,
    input.awaitPolicy,
    input.cancelPolicy,
    input.checkpointSafe ? 1 : 0,
    input.capabilityContractVersion ?? 0,
    input.createdAt,
    input.createdAt,
  ) as unknown as RuntimeTaskRow;
  appendEventEncoded(input.id, 1, 0, "created", createdEvent, input.createdAt);
  bumpTaskProjections(row, input.createdAt);
  return mapTask(row);
}

export function createWorkflowRuntimeTaskInTransaction(input: {
  id: string;
  userId: string;
  sessionId: string;
  ownerSessionId: string;
  agentId: string;
  workflowId: string;
  workflowNodeId: string;
  title: string;
  payload: OrchestrationJson;
  checkpointSafe: boolean;
  capabilityContractVersion: number;
  createdAt: number;
}): RuntimeTask {
  if (!rowExists(
    `SELECT 1 FROM workflows workflow
     JOIN workflow_nodes node ON node.workflow_id = workflow.id
     JOIN agent_nodes agent ON agent.id = node.executor_agent_id
     WHERE workflow.id = ? AND workflow.user_id = ? AND workflow.owner_session_id = ?
       AND node.id = ? AND node.executor_agent_id = ? AND node.status = 'ready'
       AND agent.root_agent_id = workflow.root_agent_id`,
    input.workflowId,
    input.userId,
    input.ownerSessionId,
    input.workflowNodeId,
    input.agentId,
  )) throw new Error("Workflow Task does not match one ready durable node binding");
  const open = db.prepare(
    `SELECT COUNT(*) AS count FROM runtime_tasks task
     JOIN agent_nodes agent ON agent.id = task.agent_id
     WHERE task.user_id = ? AND agent.root_agent_id = (
       SELECT root_agent_id FROM agent_nodes WHERE id = ? AND user_id = ?
     ) AND task.status NOT IN ('succeeded','failed','cancelled','interrupted')`,
  ).get(input.userId, input.agentId, input.userId) as { count: number };
  if (Number(open.count) >= ORCHESTRATION_TREE_OPEN_TASK_LIMIT) {
    throw new OrchestrationTaskCapacityError(
      `Open Task limit reached (${ORCHESTRATION_TREE_OPEN_TASK_LIMIT})`,
    );
  }
  const { workflowNodeId: _workflowNodeId, ...taskInput } = input;
  return insertRuntimeTask({
    ...taskInput,
    kind: "workflow_node",
    awaitPolicy: "background",
    cancelPolicy: "detached",
  }, "workflow");
}

export function completeCachedWorkflowTaskInTransaction(input: {
  id: string;
  taskId: string;
  userId: string;
  cacheKey: string;
  summary: string;
  body: OrchestrationJson;
  artifacts: OrchestrationJson;
  createdAt: number;
}): { task: RuntimeTask; result: TaskResult } {
  assertUtf8Bytes(input.summary, TASK_RESULT_SUMMARY_MAX_BYTES, "Task result summary");
  const body = encodeJson(input.body, TASK_RESULT_BODY_MAX_BYTES, "Task result body");
  const artifacts = encodeJson(input.artifacts, TASK_RESULT_ARTIFACTS_MAX_BYTES, "Task result artifacts");
  const current = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND kind = 'workflow_node'",
  ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
  if (!current || current.status !== "queued" || current.lease_generation !== 0) {
    throw new Error("A Workflow cache hit requires its fresh queued Task");
  }
  const row = db.prepare(
    `UPDATE runtime_tasks
     SET status = 'succeeded', version = version + 1, updated_at = ?,
         started_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND status = 'queued'
       AND lease_generation = 0
     RETURNING *`,
  ).get(
    input.createdAt,
    input.createdAt,
    input.createdAt,
    input.taskId,
    input.userId,
    current.version,
  ) as RuntimeTaskRow | undefined;
  if (!row) throw new Error("Workflow cache Task changed during atomic completion");
  db.prepare(
    `INSERT INTO task_results
       (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
  ).run(input.id, input.taskId, input.summary, body.json, artifacts.json, input.createdAt);
  appendEventEncoded(
    row.id,
    row.version,
    row.lease_generation,
    "workflow_cache_hit",
    encodeJson({ cacheKey: input.cacheKey }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
    input.createdAt,
  );
  bumpRosterForAgent(row.agent_id, row.user_id, input.createdAt);
  const resultRow = db.prepare("SELECT * FROM task_results WHERE id = ?").get(input.id) as unknown as TaskResultRow;
  return { task: mapTask(row), result: mapResult(resultRow) };
}

export function cancelRuntimeTaskInTransaction(input: {
  id: string;
  userId: string;
  at: number;
  eventPayload?: OrchestrationJson;
}): RuntimeTask | null {
  const current = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
  ).get(input.id, input.userId) as RuntimeTaskRow | undefined;
  if (!current) return null;
  if (TERMINAL_TASK_STATUSES.has(current.status) || current.status === "cancel_requested") {
    return mapTask(current);
  }
  const immediate = current.status === "queued" || current.status === "waiting";
  const nextStatus: TaskStatus = immediate ? "cancelled" : "cancel_requested";
  const row = db.prepare(
    `UPDATE runtime_tasks
     SET status = ?, activity = NULL, wait_reason = NULL,
         lease_generation = lease_generation + ?, version = version + 1,
         updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
       AND status = ?
     RETURNING *`,
  ).get(
    nextStatus,
    immediate ? 1 : 0,
    input.at,
    immediate ? input.at : null,
    current.id,
    current.user_id,
    current.version,
    current.lease_generation,
    current.status,
  ) as RuntimeTaskRow | undefined;
  if (!row) return null;
  projectWorkflowTaskPhaseInTransaction(row, input.at);
  appendEventEncoded(
    row.id,
    row.version,
    row.lease_generation,
    immediate ? "cancel:workflow:terminal" : "cancel:workflow:requested",
    encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
    input.at,
  );
  bumpRosterForAgent(row.agent_id, row.user_id, input.at);
  return mapTask(row);
}

function projectWorkflowTaskPhaseInTransaction(task: RuntimeTaskRow, at: number): void {
  if (task.kind !== "workflow_node") return;
  const target = db.prepare(
    `SELECT attempt.workflow_id, attempt.node_id, attempt.attempt_no,
            attempt.execution_phase, workflow.graph_revision,
            workflow.run_revision, workflow.version
     FROM workflow_node_attempts attempt
     JOIN workflow_nodes node
       ON node.workflow_id = attempt.workflow_id AND node.id = attempt.node_id
      AND node.attempt_count = attempt.attempt_no
     JOIN workflows workflow ON workflow.id = attempt.workflow_id
     WHERE attempt.task_id = ? AND workflow.user_id = ?`,
  ).get(task.id, task.user_id) as {
    workflow_id: string;
    node_id: string;
    attempt_no: number;
    execution_phase: TaskStatus;
    graph_revision: number;
    run_revision: number;
    version: number;
  } | undefined;
  if (!target || target.execution_phase === task.status) return;
  const attemptChanged = db.prepare(
    `UPDATE workflow_node_attempts SET execution_phase = ?
     WHERE workflow_id = ? AND node_id = ? AND attempt_no = ?
       AND task_id = ? AND execution_phase = ?`,
  ).run(
    task.status,
    target.workflow_id,
    target.node_id,
    target.attempt_no,
    task.id,
    target.execution_phase,
  ).changes;
  if (attemptChanged !== 1) throw new Error("Workflow attempt phase changed during Task lifecycle projection");
  const nodeChanged = db.prepare(
    `UPDATE workflow_nodes SET execution_phase = ?, version = version + 1, updated_at = ?
     WHERE workflow_id = ? AND id = ? AND attempt_count = ? AND status = 'running'`,
  ).run(task.status, at, target.workflow_id, target.node_id, target.attempt_no).changes;
  if (nodeChanged !== 1) throw new Error("Workflow node phase changed during Task lifecycle projection");
  const workflow = db.prepare(
    `UPDATE workflows SET run_revision = run_revision + 1, version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND version = ?
     RETURNING graph_revision, run_revision, version`,
  ).get(at, target.workflow_id, task.user_id, target.version) as {
    graph_revision: number;
    run_revision: number;
    version: number;
  } | undefined;
  if (!workflow) throw new Error("Workflow changed during Task lifecycle projection");
  const payload = encodeJson(
    { node: target.node_id, task: task.id, phase: task.status },
    TASK_EVENT_PAYLOAD_MAX_BYTES,
    "Workflow Task phase event payload",
  );
  const seq = Number((db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workflow_events WHERE workflow_id = ?",
  ).get(target.workflow_id) as { seq: number }).seq);
  db.prepare(
    `INSERT INTO workflow_events
       (workflow_id, seq, workflow_version, graph_revision, run_revision, type,
        mutation_id, request_digest, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'workflow.node_state', NULL, NULL, ?, ?)`,
  ).run(
    target.workflow_id,
    seq,
    workflow.version,
    workflow.graph_revision,
    workflow.run_revision,
    payload.json,
    at,
  );
}

function encodeAgentTranscript(messages: readonly OrchestrationJson[]) {
  if (messages.length > AGENT_TRANSCRIPT_MAX_MESSAGES) {
    throw new RangeError(`Agent transcript exceeds ${AGENT_TRANSCRIPT_MAX_MESSAGES} messages`);
  }
  const encoded = messages.map((message, index) => {
    assertAgentMessageShape(message, index);
    return encodeJson(message, AGENT_TRANSCRIPT_MAX_MESSAGE_BYTES, `Agent transcript message ${index}`);
  });
  const totalBytes = encoded.reduce((sum, message) => sum + message.bytes, 0);
  if (totalBytes > AGENT_TRANSCRIPT_MAX_BYTES) {
    throw new RangeError(`Agent transcript exceeds ${AGENT_TRANSCRIPT_MAX_BYTES} UTF-8 bytes`);
  }
  return { encoded, totalBytes };
}

function insertInitialAgentTranscript(
  agentId: string,
  taskId: string,
  messages: readonly OrchestrationJson[],
  savedAt: number,
): void {
  const { encoded, totalBytes } = encodeAgentTranscript(messages);
  db.prepare(
    `INSERT INTO agent_transcripts
       (agent_id, version, source_task_id, lease_generation, message_count, total_bytes, saved_at)
     VALUES (?, 1, ?, 0, ?, ?, ?)`,
  ).run(agentId, taskId, messages.length, totalBytes, savedAt);
  const insert = db.prepare(
    `INSERT INTO agent_messages (agent_id, seq, msg_json, msg_bytes, saved_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  encoded.forEach((message, index) => {
    insert.run(agentId, index + 1, message.json, message.bytes, savedAt);
  });
}

export const agentTaskDao = {
  create(input: NewAgentTask): { agent: AgentNode; task: RuntimeTask; revision: number } {
    if (input.task.kind !== "delegation") {
      throw new Error("Child Agent creation accepts delegation Tasks only");
    }
    if (input.task.agentId !== input.agent.id) {
      throw new Error("Initial Task must target the Agent created with it");
    }
    if (input.task.userId !== input.agent.userId) {
      throw new Error("Initial Agent and Task must have the same owner");
    }
    if (input.agent.sessionId !== undefined && input.task.sessionId !== input.agent.sessionId) {
      throw new Error("Initial Task execution Session must match its Agent context");
    }
    return runInTransaction(() => {
      const agent = insertAgentNode(input.agent);
      const task = insertRuntimeTask(input.task, "delegation");
      if (input.initialMessages !== undefined) {
        insertInitialAgentTranscript(agent.id, task.id, input.initialMessages, input.task.createdAt);
      }
      return { agent, task, revision: rosterRevisionForAgent(agent.id, agent.userId) };
    });
  },
};

export const orchestrationRevisionDao = {
  activity(userId: string): number {
    const row = db.prepare(
      "SELECT activity_revision FROM orchestration_user_revisions WHERE user_id = ?",
    ).get(userId) as { activity_revision: number } | undefined;
    return row ? Number(row.activity_revision) : 0;
  },
};

export const agentNodeDao = {
  create(input: NewAgentNode): AgentNode {
    return runInTransaction(() => insertAgentNode(input));
  },

  byId(userId: string, id: string): AgentNode | undefined {
    const row = db.prepare("SELECT * FROM agent_nodes WHERE user_id = ? AND id = ?").get(userId, id) as
      | AgentNodeRow
      | undefined;
    return row ? mapAgent(row) : undefined;
  },

    rootBySession(userId: string, sessionId: string): AgentNode | undefined {
    const row = db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND session_id = ? AND id = root_agent_id
         AND parent_agent_id IS NULL AND kind = 'session' AND purpose = 'addressable'`,
    ).get(userId, sessionId) as AgentNodeRow | undefined;
    return row ? mapAgent(row) : undefined;
  },

  listBySession(userId: string, sessionId: string, options: OrchestrationListOptions = {}): AgentNode[] {
    const cursor = cursorSql();
    return (db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND session_id = ? AND ${cursor.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(userId, sessionId, ...cursor.values(options.before), limitOf(options.limit)) as unknown as AgentNodeRow[])
      .map(mapAgent);
  },

  listByRoot(userId: string, rootAgentId: string, options: OrchestrationListOptions = {}): AgentNode[] {
    const cursor = cursorSql();
    return (db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND root_agent_id = ? AND ${cursor.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(userId, rootAgentId, ...cursor.values(options.before), limitOf(options.limit)) as unknown as AgentNodeRow[])
      .map(mapAgent);
  },

  roster(
    userId: string,
    rootAgentId: string,
    options: Readonly<{ addressableOnly?: boolean }> = {},
  ): AgentRosterSnapshot | undefined {
    return runInTransaction(() => {
      const roster = db.prepare(
        `SELECT ${options.addressableOnly ? "addressable_revision" : "revision"} AS revision
         FROM agent_rosters WHERE root_agent_id = ? AND user_id = ?`,
      ).get(rootAgentId, userId) as { revision: number } | undefined;
      if (!roster) return undefined;
      if (options.addressableOnly) {
        const scope = ownedRootScope(userId, rootAgentId);
        if (!scope) {
          return {
            rootAgentId,
            revision: Number(roster.revision),
            nodes: [],
            tasks: [],
            counts: { tasks: 0, activeAgents: 0, background: 0, queued: 0, waiting: 0, unread: 0 },
          };
        }
        const agentValues = executableSessionParams(scope, userId);
        const closureValues = visibleSessionParams(scope, userId);
        const nodes = (db.prepare(
          `${SESSION_VISIBLE_AGENT_CTE}
           SELECT a.* FROM visible_agents visible_agent
           JOIN agent_nodes a ON a.id = visible_agent.id
           ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
        ).all(...agentValues, ORCHESTRATION_QUERY_MAX) as unknown as AgentNodeRow[]).map(mapAgent);
        const tasks = (db.prepare(
          `${SESSION_VISIBLE_ORCHESTRATION_CTE}
           SELECT t.*, r.id AS result_id, r.acknowledged_at,
             CASE
               WHEN t.status = 'waiting' THEN 0
               WHEN t.status IN ('succeeded','failed','cancelled','interrupted')
                    AND r.id IS NOT NULL AND r.acknowledged_at IS NULL THEN 1
               WHEN t.status IN ('starting','running','cancel_requested') THEN 2
               WHEN t.status IN ('succeeded','failed','cancelled','interrupted') THEN 3
               ELSE 4
             END AS roster_priority
           FROM visible_tasks visible_task
           JOIN runtime_tasks t ON t.id = visible_task.id
           LEFT JOIN task_results r ON r.task_id = t.id
           ORDER BY roster_priority ASC,
             CASE WHEN t.status = 'queued' THEN t.created_at END ASC,
             CASE WHEN t.status <> 'queued' THEN t.updated_at END DESC,
             t.id ASC
           LIMIT ?`,
        ).all(...closureValues, ORCHESTRATION_QUERY_MAX) as unknown as TaskDigestRow[]).map(mapDigest);
        const countRow = db.prepare(
          `${SESSION_VISIBLE_ORCHESTRATION_CTE}
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
           LEFT JOIN task_results result ON result.task_id = task.id`,
        ).get(...closureValues, rootAgentId) as {
          tasks: number;
          active_agents: number;
          background: number;
          queued: number;
          waiting: number;
          unread: number;
        };
        return {
          rootAgentId,
          revision: Number(roster.revision),
          nodes,
          tasks,
          counts: {
            tasks: Number(countRow.tasks),
            activeAgents: Number(countRow.active_agents),
            background: Number(countRow.background),
            queued: Number(countRow.queued),
            waiting: Number(countRow.waiting),
            unread: Number(countRow.unread),
          },
        };
      }
      const nodes = (db.prepare(
        `SELECT * FROM agent_nodes WHERE user_id = ? AND root_agent_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(userId, rootAgentId, ORCHESTRATION_QUERY_MAX) as unknown as AgentNodeRow[]).map(mapAgent);
      const tasks = (db.prepare(
        `SELECT t.*, r.id AS result_id, r.acknowledged_at,
            CASE
              WHEN t.status = 'waiting' THEN 0
              WHEN t.status IN ('succeeded','failed','cancelled','interrupted')
                   AND r.id IS NOT NULL AND r.acknowledged_at IS NULL THEN 1
              WHEN t.status IN ('starting','running','cancel_requested') THEN 2
              WHEN t.status IN ('succeeded','failed','cancelled','interrupted') THEN 3
              ELSE 4
            END AS roster_priority
         FROM runtime_tasks t
         JOIN agent_nodes a ON a.id = t.agent_id
         LEFT JOIN task_results r ON r.task_id = t.id
         WHERE t.user_id = ? AND a.root_agent_id = ?
         ORDER BY roster_priority ASC,
           CASE WHEN t.status = 'queued' THEN t.created_at END ASC,
           CASE WHEN t.status <> 'queued' THEN t.updated_at END DESC,
           t.id ASC
         LIMIT ?`,
      ).all(userId, rootAgentId, ORCHESTRATION_QUERY_MAX) as unknown as TaskDigestRow[]).map(mapDigest);
      const countRow = db.prepare(
        `SELECT
           COUNT(*) AS tasks,
           COALESCE(SUM(CASE WHEN t.await_policy = 'background'
             AND t.status NOT IN ('succeeded','failed','cancelled','interrupted') THEN 1 ELSE 0 END), 0) AS background,
           COALESCE(SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
           COALESCE(SUM(CASE WHEN t.status = 'waiting' THEN 1 ELSE 0 END), 0) AS waiting,
           COALESCE(SUM(CASE WHEN t.status IN ('succeeded','failed','cancelled','interrupted')
             AND r.id IS NOT NULL AND r.acknowledged_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
         FROM runtime_tasks t
         JOIN agent_nodes a ON a.id = t.agent_id
         LEFT JOIN task_results r ON r.task_id = t.id
         WHERE t.user_id = ? AND a.root_agent_id = ?`,
      ).get(userId, rootAgentId) as {
        tasks: number;
        background: number;
        queued: number;
        waiting: number;
        unread: number;
      };
      const activeAgents = db.prepare(
        `SELECT COUNT(*) AS count FROM agent_nodes
         WHERE user_id = ? AND root_agent_id = ? AND id <> ? AND status <> 'closed'`,
      ).get(userId, rootAgentId, rootAgentId) as { count: number };
      return {
        rootAgentId,
        revision: Number(roster.revision),
        nodes,
        tasks,
        counts: {
          tasks: Number(countRow.tasks),
          activeAgents: Number(activeAgents.count),
          background: Number(countRow.background),
          queued: Number(countRow.queued),
          waiting: Number(countRow.waiting),
          unread: Number(countRow.unread),
        },
      };
    });
  },

  rosterRevision(userId: string, rootAgentId: string): number | undefined {
    const row = db.prepare(
      "SELECT revision FROM agent_rosters WHERE root_agent_id = ? AND user_id = ?",
    ).get(rootAgentId, userId) as { revision: number } | undefined;
    return row ? Number(row.revision) : undefined;
  },

  addressableRosterRevision(userId: string, rootAgentId: string): number | undefined {
    const row = db.prepare(
      "SELECT addressable_revision AS revision FROM agent_rosters WHERE root_agent_id = ? AND user_id = ?",
    ).get(rootAgentId, userId) as { revision: number } | undefined;
    return row ? Number(row.revision) : undefined;
  },

  directTargets(
    userId: string,
    rootAgentId: string,
    target: string,
    options: Readonly<{ addressableOnly?: boolean }> = {},
  ): AgentNode[] {
    if (options.addressableOnly) {
      const scope = ownedRootScope(userId, rootAgentId);
      if (!scope) return [];
      return (db.prepare(
        `${SESSION_VISIBLE_AGENT_CTE}
         SELECT a.* FROM visible_agents visible
         JOIN agent_nodes a ON a.id = visible.id
         WHERE a.id = ? OR a.path = ?
         ORDER BY a.id ASC LIMIT 2`,
      ).all(...executableSessionParams(scope, userId), target, target) as unknown as AgentNodeRow[]).map(mapAgent);
    }
    return (db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND root_agent_id = ?
         AND (id = ? OR path = ?)
       ORDER BY id ASC LIMIT 2`,
    ).all(userId, rootAgentId, target, target) as unknown as AgentNodeRow[]).map(mapAgent);
  },

  labelTargets(
    userId: string,
    rootAgentId: string,
    label: string,
    options: Readonly<{ addressableOnly?: boolean }> = {},
  ): AgentNode[] {
    if (options.addressableOnly) {
      const scope = ownedRootScope(userId, rootAgentId);
      if (!scope) return [];
      return (db.prepare(
        `${SESSION_VISIBLE_AGENT_CTE}
         SELECT a.* FROM visible_agents visible
         JOIN agent_nodes a ON a.id = visible.id
         WHERE a.label = ?
         ORDER BY a.id ASC LIMIT 2`,
      ).all(...executableSessionParams(scope, userId), label) as unknown as AgentNodeRow[]).map(mapAgent);
    }
    return (db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND root_agent_id = ? AND label = ?
       ORDER BY id ASC LIMIT 2`,
    ).all(userId, rootAgentId, label) as unknown as AgentNodeRow[]).map(mapAgent);
  },

  listOwnedByIds(userId: string, rootAgentId: string, ids: readonly string[]): AgentNode[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)].slice(0, ORCHESTRATION_QUERY_MAX);
    const placeholders = unique.map(() => "?").join(",");
    return (db.prepare(
      `SELECT * FROM agent_nodes
       WHERE user_id = ? AND root_agent_id = ? AND id IN (${placeholders})`,
    ).all(userId, rootAgentId, ...unique) as unknown as AgentNodeRow[]).map(mapAgent);
  },

  countLiveByRoot(userId: string, rootAgentId: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM agent_nodes a
       WHERE a.user_id = ? AND a.root_agent_id = ? AND a.status <> 'closed'
         AND (
           a.status IN ('initializing','running')
           OR EXISTS (
             SELECT 1 FROM runtime_tasks t
             WHERE t.agent_id = a.id AND t.status IN (${OPEN_TASK_STATUS_SQL})
           )
         )`,
    ).get(userId, rootAgentId) as { count: number };
    return Number(row.count);
  },

  countNonClosedByRoot(userId: string, rootAgentId: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM agent_nodes
       WHERE user_id = ? AND root_agent_id = ? AND status <> 'closed'`,
    ).get(userId, rootAgentId) as { count: number };
    return Number(row.count);
  },

  transitionStatus(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    nextStatus: AgentNodeStatus;
    at: number;
  }): AgentNode | null {
    return runInTransaction(() => {
      const current = this.byId(input.userId, input.id);
      if (!current || current.version !== input.expectedVersion) return null;
      if (!AGENT_TRANSITIONS[current.status].has(input.nextStatus)) {
        throw new Error(`invalid Agent status transition: ${current.status} -> ${input.nextStatus}`);
      }
      const row = db.prepare(
        `UPDATE agent_nodes
         SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND status = ?
         RETURNING *`,
      ).get(
        input.nextStatus,
        input.at,
        input.id,
        input.userId,
        input.expectedVersion,
        current.status,
      ) as AgentNodeRow | undefined;
      if (!row) return null;
      bumpRoster(row.root_agent_id, row.user_id, input.at, row.purpose === "addressable");
      return mapAgent(row);
    });
  },

  reconfigureJoinedSlot(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    taskId: string;
    taskLeaseGeneration: number;
    provider: string;
    model: string;
    thinkingLevel?: AgentThinkingLevel;
    at: number;
  }): AgentNode | null {
    assertUtf8Bytes(input.provider, 128, "Agent provider");
    assertUtf8Bytes(input.model, 256, "Agent model");
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE agent_nodes AS agent
         SET provider = ?, model = ?, thinking_level = ?, version = version + 1, updated_at = ?
         WHERE agent.id = ? AND agent.user_id = ? AND agent.version = ?
           AND agent.kind = 'subagent' AND agent.purpose = 'joined_slot'
           AND EXISTS (
             SELECT 1 FROM runtime_tasks task
             WHERE task.id = ? AND task.agent_id = agent.id AND task.user_id = agent.user_id
               AND task.status = 'starting' AND task.lease_generation = ?
           )
         RETURNING *`,
      ).get(
        input.provider,
        input.model,
        input.thinkingLevel ?? null,
        input.at,
        input.id,
        input.userId,
        input.expectedVersion,
        input.taskId,
        input.taskLeaseGeneration,
      ) as AgentNodeRow | undefined;
      if (!row) return null;
      bumpRoster(row.root_agent_id, row.user_id, input.at, false);
      return mapAgent(row);
    });
  },

  recoverAfterRestart(now: number): number {
    return runInTransaction(() => {
      const rows = db.prepare(
        `UPDATE agent_nodes
         SET status = 'interrupted', version = version + 1, updated_at = ?
         WHERE status IN ('initializing', 'running')
         RETURNING root_agent_id, user_id, purpose`,
      ).all(now) as unknown as AgentRootRow[];
      const roots = new Map<string, { userId: string; addressable: boolean }>();
      for (const row of rows) {
        const existing = roots.get(row.root_agent_id);
        roots.set(row.root_agent_id, {
          userId: row.user_id,
          addressable: Boolean(existing?.addressable || row.purpose === "addressable"),
        });
      }
      for (const [rootAgentId, value] of roots) {
        bumpRoster(rootAgentId, value.userId, now, value.addressable);
      }
      return rows.length;
    });
  },
};

const TERMINAL_PROGRESS_TOOL_STATUSES = new Set(["success", "error", "denied"]);

function recoverProgressItems(
  items: readonly TimelineItem[],
  status: "failed" | "interrupted",
): TimelineItem[] {
  const resultText = status === "failed"
    ? "The Child Agent failed before this Step settled."
    : "The Child Agent stopped before this Step settled.";
  return items.map((item): TimelineItem => {
    if (item.kind === "assistant") {
      return item.streaming ? { ...item, streaming: false } : item;
    }
    if (item.kind !== "tool") return item;
    const children = item.children ? recoverProgressItems(item.children, status) : undefined;
    if (TERMINAL_PROGRESS_TOOL_STATUSES.has(item.status)) {
      return children === item.children || children === undefined ? item : { ...item, children };
    }
    return {
      ...item,
      status: status === "failed" ? "error" : "denied",
      ...(status === "interrupted" ? { termination: "cancelled" as const } : {}),
      resultText,
      isError: status === "failed",
      runningElapsedMs: undefined,
      ...(children ? { children } : {}),
    };
  });
}

function recoverJoinedProgressAttempt(
  task: RuntimeTaskRow,
  status: "failed" | "interrupted",
  at: number,
): void {
  const progress = db.prepare(
    `SELECT * FROM task_progress
     WHERE task_id = ? AND lease_generation = ? AND status = 'in_progress'`,
  ).get(task.id, task.lease_generation) as TaskProgressRow | undefined;
  if (!progress) return;
  if (!task.owner_step_id) throw new Error("Joined Child progress lost its owner Step");
  const parentRow = db.prepare(
    "SELECT item_json FROM timeline WHERE session_id = ? AND seq = ?",
  ).get(task.owner_session_id, progress.owner_timeline_seq) as { item_json: string } | undefined;
  if (!parentRow) throw new Error("Joined Child progress owner Timeline Step is missing during recovery");
  const parent = JSON.parse(parentRow.item_json) as TimelineItem;
  if (parent.kind !== "tool" || parent.id !== task.owner_step_id) {
    throw new Error("Joined Child recovery found a different owner Timeline Step");
  }
  const children = recoverProgressItems(
    parent.children ?? (JSON.parse(progress.snapshot_json) as TimelineItem[]),
    status,
  );
  if (children.length > JOINED_PROGRESS_MAX_ITEMS) throw new RangeError("Recovered Child progress item bound changed");
  const snapshotJson = JSON.stringify(children);
  const snapshotBytes = Buffer.byteLength(snapshotJson, "utf8");
  if (snapshotBytes > JOINED_PROGRESS_MAX_BYTES) throw new RangeError("Recovered Child progress byte bound changed");
  const completedAt = at;
  const durationMs = Math.max(0, at - progress.started_at);
  const recoveryEvent: WireAgentEvent = {
    t: "turn_end",
    turnId: progress.turn_id,
    status,
    completedAt,
    durationMs,
  };
  const recoveryHash = createHash("sha256").update(JSON.stringify(recoveryEvent)).digest("hex");
  const recoverySeq = progress.last_seq + 1;
  const nextParent: Extract<TimelineItem, { kind: "tool" }> = {
    ...parent,
    children,
    childProgress: {
      taskId: task.id,
      leaseGeneration: progress.lease_generation,
      turnId: progress.turn_id,
      status,
      startedAt: progress.started_at,
      completedAt,
      durationMs,
      lastSeq: recoverySeq,
      source: "recovery",
      ...(progress.omitted_items > 0 ? {
        omittedItems: progress.omitted_items,
        omittedBytes: progress.omitted_bytes,
      } : {}),
    },
  };
  const progressUpdate = db.prepare(
    `UPDATE task_progress
     SET last_seq = ?, status = ?, completed_at = ?, duration_ms = ?, source = 'recovery',
         snapshot_json = ?, snapshot_bytes = ?, item_count = ?, last_event_hash = ?, updated_at = ?
     WHERE task_id = ? AND lease_generation = ? AND status = 'in_progress'`,
  ).run(
    recoverySeq,
    status,
    completedAt,
    durationMs,
    snapshotJson,
    snapshotBytes,
    children.length,
    recoveryHash,
    at,
    task.id,
    task.lease_generation,
  );
  if (progressUpdate.changes !== 1) throw new Error("Joined Child recovery lost its progress fence");
  const parentUpdate = db.prepare(
    "UPDATE timeline SET item_json = ? WHERE session_id = ? AND seq = ? AND item_json = ?",
  ).run(JSON.stringify(nextParent), task.owner_session_id, progress.owner_timeline_seq, parentRow.item_json);
  if (parentUpdate.changes !== 1) throw new Error("Joined Child recovery lost its owner Timeline fence");
}

export class JoinedProgressInvariantError extends Error {
  override name = "JoinedProgressInvariantError";
}

function settleJoinedProgressForTaskStatus(task: RuntimeTaskRow, nextStatus: TaskStatus, at: number): void {
  if (task.await_policy !== "join") return;
  const progress = db.prepare(
    "SELECT status FROM task_progress WHERE task_id = ? AND lease_generation = ?",
  ).get(task.id, task.lease_generation) as { status: AgentTurnStatus } | undefined;
  if (nextStatus === "succeeded") {
    if (!progress) throw new JoinedProgressInvariantError("A joined Task cannot succeed without Child progress");
    if (progress.status !== "completed") {
      throw new JoinedProgressInvariantError(
        `A joined Task cannot succeed with Child progress ${progress.status}`,
      );
    }
    return;
  }
  if (progress?.status !== "in_progress") return;
  recoverJoinedProgressAttempt(task, nextStatus === "failed" ? "failed" : "interrupted", at);
}

export const runtimeTaskDao = {
  create(input: NewRuntimeTask): RuntimeTask {
    if (input.kind === "team_turn") throw new Error("team_turn Tasks require an atomic Team assignment");
    if (input.kind !== "delegation") throw new Error("workflow_node Tasks require their trusted orchestration creator");
    return runInTransaction(() => insertRuntimeTask(input, "delegation"));
  },

  createWithRosterRevision(input: NewRuntimeTask): { task: RuntimeTask; revision: number } {
    if (input.kind === "team_turn") throw new Error("team_turn Tasks require an atomic Team assignment");
    if (input.kind !== "delegation") throw new Error("workflow_node Tasks require their trusted orchestration creator");
    return runInTransaction(() => {
      const task = insertRuntimeTask(input, "delegation");
      return { task, revision: rosterRevisionForAgent(task.agentId, task.userId) };
    });
  },

  byId(userId: string, id: string): RuntimeTask | undefined {
    const row = db.prepare("SELECT * FROM runtime_tasks WHERE user_id = ? AND id = ?").get(userId, id) as
      | RuntimeTaskRow
      | undefined;
    return row ? mapTask(row) : undefined;
  },

  claim(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    at: number;
    eventPayload?: OrchestrationJson;
  }): RuntimeTask | null {
    const eventType = "claimed";
    const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const scope = rootScopeForTask(input.userId, input.id);
      if (!scope) return null;
      const row = db.prepare(
        `${SESSION_EXECUTABLE_OPEN_CTE}
         UPDATE runtime_tasks AS t
         SET status = 'starting', lease_generation = lease_generation + 1,
             version = version + 1, updated_at = ?, activity = NULL,
             wait_reason = NULL, settled_at = NULL
         WHERE id = ? AND user_id = ? AND version = ? AND status = 'queued'
           AND t.kind IN ('delegation','workflow_node')
           AND EXISTS (
             SELECT 1 FROM executable_open_tasks candidate
             WHERE candidate.id = t.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM executable_open_tasks visible_active
             CROSS JOIN runtime_tasks active
             WHERE active.id = visible_active.id
               AND active.agent_id = t.agent_id
               AND active.id <> t.id
               AND active.status IN ('starting', 'running', 'waiting', 'cancel_requested')
           )
           AND NOT EXISTS (
             SELECT 1 FROM executable_open_tasks visible_earlier
             CROSS JOIN runtime_tasks earlier
             WHERE earlier.id = visible_earlier.id
               AND earlier.agent_id = t.agent_id
               AND earlier.agent_ord < t.agent_ord
               AND earlier.status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
           )
           AND (
             t.cancel_policy <> 'linked'
             OR EXISTS (
               SELECT 1 FROM agent_turns owner_turn
               WHERE owner_turn.session_id = t.owner_session_id
                 AND owner_turn.id = t.owner_turn_id
                 AND owner_turn.status = 'in_progress'
             )
           )
         RETURNING *`,
      ).get(
        ...executableSessionParams(scope, input.userId),
        input.at,
        input.id,
        input.userId,
        input.expectedVersion,
      ) as RuntimeTaskRow | undefined;
      if (!row) return null;
      projectWorkflowTaskPhaseInTransaction(row, input.at);
      appendEventEncoded(row.id, row.version, row.lease_generation, eventType, event, input.at);
      bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  transition(input: TaskTransitionInput): RuntimeTask | null {
    const eventType = input.eventType ?? `status:${input.nextStatus}`;
    assertEventType(eventType);
    const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const current = db.prepare(
        "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
      ).get(input.id, input.userId) as RuntimeTaskRow | undefined;
      if (
        !current
        || current.version !== input.expectedVersion
        || current.lease_generation !== input.expectedLeaseGeneration
      ) return null;
      if (current.kind === "team_turn") {
        throw new Error("Team Tasks require their dedicated executor seam");
      }
      if (
        current.kind === "workflow_node"
        && (input.nextStatus === "succeeded" || input.nextStatus === "failed")
      ) throw new Error("workflow_node Task terminal result requires its trusted Workflow owner");
      if (!TASK_TRANSITIONS[current.status].has(input.nextStatus)) {
        throw new Error(`invalid Task status transition: ${current.status} -> ${input.nextStatus}`);
      }
      if (input.nextStatus === "waiting" && input.waitReason === undefined) {
        throw new Error("waiting Tasks require a bounded wait reason");
      }
      const terminal = TERMINAL_TASK_STATUSES.has(input.nextStatus);
      if (terminal) settleJoinedProgressForTaskStatus(current, input.nextStatus, input.at);
      const activity = input.nextStatus === "running" ? (input.activity ?? "model") : null;
      const waitReason = input.nextStatus === "waiting" ? input.waitReason! : null;
      const row = db.prepare(
        `UPDATE runtime_tasks
         SET status = ?, activity = ?, wait_reason = ?, version = version + 1,
             updated_at = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
             settled_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? AND status = ?
         RETURNING *`,
      ).get(
        input.nextStatus,
        activity,
        waitReason,
        input.at,
        input.nextStatus,
        input.at,
        terminal ? 1 : 0,
        input.at,
        input.id,
        input.userId,
        input.expectedVersion,
        input.expectedLeaseGeneration,
        current.status,
      ) as RuntimeTaskRow | undefined;
      if (!row) return null;
      projectWorkflowTaskPhaseInTransaction(row, input.at);
      appendEventEncoded(row.id, row.version, row.lease_generation, eventType, event, input.at);
      bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  updateActivity(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    expectedLeaseGeneration: number;
    activity: TaskActivityCode;
    at: number;
    eventPayload?: OrchestrationJson;
  }): RuntimeTask | null {
    const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE runtime_tasks
         SET activity = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
           AND kind IN ('delegation','workflow_node')
           AND status IN ('starting', 'running')
         RETURNING *`,
      ).get(
        input.activity,
        input.at,
        input.id,
        input.userId,
        input.expectedVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!row) return null;
      appendEventEncoded(row.id, row.version, row.lease_generation, "activity", event, input.at);
      bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  retireLease(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    expectedLeaseGeneration: number;
    at: number;
  }): RuntimeTask | null {
    return runInTransaction(() => {
      const current = db.prepare(
        "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
      ).get(input.id, input.userId) as RuntimeTaskRow | undefined;
      if (
        !current
        || current.version !== input.expectedVersion
        || current.lease_generation !== input.expectedLeaseGeneration
        || !ACTIVE_RECOVERY_STATUSES.has(current.status)
      ) return null;
      if (current.kind === "team_turn") {
        throw new Error("Reserved Task kinds require their dedicated executor seam");
      }
      const nextStatus: TaskStatus = current.status === "cancel_requested"
        ? "cancelled"
        : current.status === "waiting"
          ? "waiting"
          : current.checkpoint_safe === 1
            ? "queued"
            : "interrupted";
      settleJoinedProgressForTaskStatus(current, nextStatus, input.at);
      const terminal = nextStatus === "cancelled" || nextStatus === "interrupted";
      const row = db.prepare(
        `UPDATE runtime_tasks
         SET status = ?, activity = NULL,
             wait_reason = CASE WHEN ? = 'waiting' THEN wait_reason ELSE NULL END,
             lease_generation = lease_generation + 1, version = version + 1,
             updated_at = ?, settled_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
         RETURNING *`,
      ).get(
        nextStatus,
        nextStatus,
        input.at,
        terminal ? input.at : null,
        input.id,
        input.userId,
        input.expectedVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!row) return null;
      projectWorkflowTaskPhaseInTransaction(row, input.at);
      const event = encodeJson(
        { previousStatus: current.status, reason: "runtime_closed" },
        TASK_EVENT_PAYLOAD_MAX_BYTES,
        "Task event payload",
      );
      appendEventEncoded(row.id, row.version, row.lease_generation, `runtime:retired:${nextStatus}`, event, input.at);
      bumpTaskProjections(row, input.at);
      const projected = db.prepare(
        `UPDATE agent_nodes
         SET status = 'interrupted', version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'running'
         RETURNING id`,
      ).get(input.at, row.agent_id, row.user_id) as { id: string } | undefined;
      if (projected) bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  listBySession(userId: string, sessionId: string, options: OrchestrationListOptions = {}): RuntimeTask[] {
    const cursor = cursorSql();
    return (db.prepare(
      `SELECT * FROM runtime_tasks
       WHERE user_id = ? AND session_id = ? AND ${cursor.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(userId, sessionId, ...cursor.values(options.before), limitOf(options.limit)) as unknown as RuntimeTaskRow[])
      .map(mapTask);
  },

  listByOwner(userId: string, query: TaskOwnerQuery): RuntimeTask[] {
    const cursor = cursorSql();
    const turnClause = query.ownerTurnId === undefined ? "" : " AND owner_turn_id = ?";
    const stepClause = query.ownerStepId === undefined ? "" : " AND owner_step_id = ?";
    const ownerValues: string[] = [];
    if (query.ownerTurnId !== undefined) ownerValues.push(query.ownerTurnId);
    if (query.ownerStepId !== undefined) ownerValues.push(query.ownerStepId);
    return (db.prepare(
      `SELECT * FROM runtime_tasks
       WHERE user_id = ? AND owner_session_id = ?${turnClause}${stepClause} AND ${cursor.clause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(
      userId,
      query.ownerSessionId,
      ...ownerValues,
      ...cursor.values(query.before),
      limitOf(query.limit),
    ) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  listDigestsByRoot(userId: string, rootAgentId: string, options: OrchestrationListOptions = {}): TaskDigest[] {
    const cursor = cursorSql("updated_at", "t");
    return (db.prepare(
      `SELECT t.*, r.id AS result_id, r.acknowledged_at
       FROM runtime_tasks t
       JOIN agent_nodes a ON a.id = t.agent_id
       LEFT JOIN task_results r ON r.task_id = t.id
       WHERE t.user_id = ? AND a.root_agent_id = ? AND ${cursor.clause}
       ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
    ).all(userId, rootAgentId, ...cursor.values(options.before), limitOf(options.limit)) as unknown as TaskDigestRow[])
      .map(mapDigest);
  },

  listOpenByRoot(userId: string, rootAgentId: string, limit = ORCHESTRATION_QUERY_MAX): RuntimeTask[] {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return [];
    return (db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT t.* FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       WHERE t.id = visible.id AND t.kind IN ('delegation','workflow_node')
       ORDER BY t.created_at ASC, t.agent_id ASC, t.agent_ord ASC LIMIT ?`,
    ).all(...executableSessionParams(scope, userId), limitOf(limit)) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  listSchedulingAgentWorkerByRoot(
    userId: string,
    rootAgentId: string,
    limit = ORCHESTRATION_QUERY_MAX,
  ): RuntimeTask[] {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return [];
    return (db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT t.* FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
       WHERE t.id = visible.id AND a.kind = 'subagent'
         AND t.kind IN ('delegation','workflow_node')
         AND (
           t.status IN ('starting','running','cancel_requested')
           OR (
             t.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM executable_open_tasks visible_earlier
               CROSS JOIN runtime_tasks earlier
               WHERE earlier.id = visible_earlier.id
                 AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
                 AND earlier.status NOT IN ('succeeded','failed','cancelled','interrupted')
             )
           )
         )
       ORDER BY CASE WHEN t.status IN ('starting','running','cancel_requested') THEN 0 ELSE 1 END,
         t.created_at ASC, t.agent_id ASC, t.agent_ord ASC LIMIT ?`,
    ).all(...executableSessionParams(scope, userId), limitOf(limit)) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  countOpenByRoot(userId: string, rootAgentId: string, awaitPolicy?: TaskAwaitPolicy): number {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return 0;
    const policyClause = awaitPolicy === undefined ? "" : " AND t.await_policy = ?";
    const values = awaitPolicy === undefined
      ? executableSessionParams(scope, userId)
      : [...executableSessionParams(scope, userId), awaitPolicy];
    const row = db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT COUNT(*) AS count
       FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       WHERE t.id = visible.id AND t.kind IN ('delegation','workflow_node')${policyClause}`,
    ).get(...values) as { count: number };
    return Number(row.count);
  },

  countOpenByAgent(userId: string, agentId: string): number {
    const scope = rootScopeForAgent(userId, agentId);
    if (!scope) return 0;
    const row = db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT COUNT(*) AS count
       FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       WHERE t.id = visible.id AND t.agent_id = ?
         AND t.kind IN ('delegation','workflow_node')`,
    ).get(...executableSessionParams(scope, userId), agentId) as { count: number };
    return Number(row.count);
  },

  listOpenByAgent(userId: string, agentId: string, limit = ORCHESTRATION_QUERY_MAX): RuntimeTask[] {
    const scope = rootScopeForAgent(userId, agentId);
    if (!scope) return [];
    return (db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT t.* FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       WHERE t.id = visible.id AND t.agent_id = ?
         AND t.kind IN ('delegation','workflow_node')
       ORDER BY t.agent_ord ASC LIMIT ?`,
    ).all(
      ...executableSessionParams(scope, userId),
      agentId,
      limitOf(limit),
    ) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  listDigestsByAgent(userId: string, agentId: string, limit = 8): TaskDigest[] {
    const scope = rootScopeForAgent(userId, agentId);
    if (!scope) return [];
    return (db.prepare(
      `${SESSION_VISIBLE_ORCHESTRATION_CTE}
       SELECT t.*, r.id AS result_id, r.acknowledged_at,
          CASE
            WHEN t.status = 'waiting' THEN 0
            WHEN t.status IN ('starting','running','cancel_requested') THEN 1
            WHEN t.status IN ('succeeded','failed','cancelled','interrupted')
                 AND r.id IS NOT NULL AND r.acknowledged_at IS NULL THEN 2
            WHEN t.status = 'queued' THEN 3
            ELSE 4
          END AS target_priority
       FROM visible_tasks visible
       CROSS JOIN runtime_tasks t
       LEFT JOIN task_results r ON r.task_id = t.id
       WHERE t.id = visible.id AND t.agent_id = ?
       ORDER BY target_priority ASC,
         CASE WHEN t.status = 'queued' THEN t.agent_ord END ASC,
         CASE WHEN t.status <> 'queued' THEN t.updated_at END DESC,
         t.id ASC
       LIMIT ?`,
    ).all(
      ...visibleSessionParams(scope, userId),
      agentId,
      limitOf(limit),
    ) as unknown as TaskDigestRow[]).map(mapDigest);
  },

  stateFingerprintByAgent(userId: string, agentId: string): string {
    const scope = rootScopeForAgent(userId, agentId);
    if (!scope) return "0:0:0";
    const row = db.prepare(
      `${SESSION_VISIBLE_ORCHESTRATION_CTE}
       SELECT COUNT(*) AS task_count,
          COALESCE(SUM(t.version), 0) AS task_versions,
          COALESCE(SUM(r.version), 0) AS result_versions
       FROM visible_tasks visible
       CROSS JOIN runtime_tasks t
       LEFT JOIN task_results r ON r.task_id = t.id
       WHERE t.id = visible.id AND t.agent_id = ?`,
    ).get(...visibleSessionParams(scope, userId), agentId) as {
      task_count: number;
      task_versions: number;
      result_versions: number;
    };
    return `${Number(row.task_count)}:${Number(row.task_versions)}:${Number(row.result_versions)}`;
  },

  terminalOutcomeByRoot(userId: string, rootAgentId: string): {
    unreadFailure: boolean;
    latestStatus?: TaskStatus;
  } {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return { unreadFailure: false };
    const row = db.prepare(
      `${SESSION_VISIBLE_ORCHESTRATION_CTE}
       SELECT
         EXISTS(
           SELECT 1 FROM visible_tasks visible_failed
           CROSS JOIN runtime_tasks failed
           JOIN task_results failed_result ON failed_result.task_id = failed.id
           WHERE failed.id = visible_failed.id
             AND failed.status = 'failed' AND failed_result.acknowledged_at IS NULL
         ) AS unread_failure,
         (
           SELECT latest.status FROM visible_tasks visible_latest
           CROSS JOIN runtime_tasks latest
           WHERE latest.id = visible_latest.id             AND latest.status IN ('succeeded','failed','cancelled','interrupted')
           ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1
         ) AS latest_status`,
    ).get(...visibleSessionParams(scope, userId)) as {
      unread_failure: number;
      latest_status: TaskStatus | null;
    };
    return {
      unreadFailure: Number(row.unread_failure) === 1,
      ...(row.latest_status ? { latestStatus: row.latest_status } : {}),
    };
  },

  countRunnableByRoot(userId: string, rootAgentId: string, awaitPolicy?: TaskAwaitPolicy): number {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return 0;
    const policyClause = awaitPolicy === undefined ? "" : " AND t.await_policy = ?";
    const values = awaitPolicy === undefined
      ? executableSessionParams(scope, userId)
      : [...executableSessionParams(scope, userId), awaitPolicy];
    const row = db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT COUNT(*) AS count
       FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       WHERE t.id = visible.id AND (           t.status IN ('starting', 'running', 'cancel_requested')
           OR (
             t.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM executable_open_tasks visible_earlier
               CROSS JOIN runtime_tasks earlier
               WHERE earlier.id = visible_earlier.id
                 AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
                 AND earlier.status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
             )
           )
         )${policyClause}`,
    ).get(...values) as { count: number };
    return Number(row.count);
  },

  countRunnableAgentWorkerByRoot(userId: string, rootAgentId: string, awaitPolicy?: TaskAwaitPolicy): number {
    const scope = ownedRootScope(userId, rootAgentId);
    if (!scope) return 0;
    const policyClause = awaitPolicy === undefined ? "" : " AND t.await_policy = ?";
    const values = awaitPolicy === undefined
      ? executableSessionParams(scope, userId)
      : [...executableSessionParams(scope, userId), awaitPolicy];
    const row = db.prepare(
      `${SESSION_EXECUTABLE_OPEN_CTE}
       SELECT COUNT(*) AS count
       FROM executable_open_tasks visible
       CROSS JOIN runtime_tasks t
       JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
       WHERE t.id = visible.id AND a.kind = 'subagent'
         AND t.kind IN ('delegation','workflow_node')
         AND (
           t.status IN ('starting', 'running', 'cancel_requested')
           OR (
             t.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM executable_open_tasks visible_earlier
               CROSS JOIN runtime_tasks earlier
               WHERE earlier.id = visible_earlier.id
                 AND earlier.agent_id = t.agent_id AND earlier.agent_ord < t.agent_ord
                 AND earlier.status NOT IN ('succeeded','failed','cancelled','interrupted')
             )
           )
         )${policyClause}`,
    ).get(...values) as { count: number };
    return Number(row.count);
  },

  scanRunnableBackgroundRoots(query: RunnableBackgroundRootQuery = {}): RunnableBackgroundRootPage {
    const after = query.afterRootAgentId ?? "";
    const limit = limitOf(query.limit);
    const rootRows = query.userId === undefined
      ? db.prepare(
        `SELECT id FROM agent_nodes
         WHERE id = root_agent_id AND kind = 'session' AND status <> 'closed'
           AND (? = '' OR id > ?)
         ORDER BY id ASC LIMIT ?`,
      ).all(after, after, limit) as unknown as Array<{ id: string }>
      : db.prepare(
        `SELECT id FROM agent_nodes
         WHERE user_id = ? AND id = root_agent_id AND kind = 'session' AND status <> 'closed'
           AND (? = '' OR id > ?)
         ORDER BY id ASC LIMIT ?`,
    ).all(query.userId, after, after, limit) as unknown as Array<{ id: string }>;
    if (rootRows.length === 0) return { roots: [], exhausted: true };
    const rootIds = rootRows.map((row) => row.id);
    const rows = db.prepare(runnableBackgroundCandidatesSql(rootIds.length))
      .all(Date.now(), ...rootIds) as unknown as Array<{
      root_agent_id: string;
      user_id: string;
      session_id: string;
      task_id: string;
      task_kind: TaskKind;
      agent_kind: AgentNodeKind;
      created_at: number;
    }>;
    return {
      roots: rows.map((row) => ({
        userId: row.user_id,
        sessionId: row.session_id,
        rootAgentId: row.root_agent_id,
        taskId: row.task_id,
        taskKind: row.task_kind,
        agentKind: row.agent_kind,
        createdAt: row.created_at,
      })),
      scannedThrough: rootIds[rootIds.length - 1]!,
      exhausted: rootRows.length < limit,
    };
  },

  ownedAtOrAfterTimelineSeq(userId: string, ownerSessionId: string, seq: number): boolean {
    return rowExists(
      `SELECT 1 FROM runtime_tasks t
       LEFT JOIN agent_turns turn
         ON turn.session_id = t.owner_session_id AND turn.id = t.owner_turn_id
       WHERE t.user_id = ? AND t.owner_session_id = ?
         AND (
           (turn.start_seq IS NOT NULL AND turn.start_seq >= ?)
           OR EXISTS (
             SELECT 1 FROM timeline item
             WHERE item.session_id = t.owner_session_id AND item.seq >= ?
               AND json_extract(item.item_json, '$.id') = t.owner_step_id
           )
         )
       LIMIT 1`,
      userId,
      ownerSessionId,
      seq,
      seq,
    );
  },

  ownedThroughTimelineSeq(userId: string, ownerSessionId: string, seq: number): boolean {
    return rowExists(
      `SELECT 1 FROM runtime_tasks t
       LEFT JOIN agent_turns turn
         ON turn.session_id = t.owner_session_id AND turn.id = t.owner_turn_id
       WHERE t.user_id = ? AND t.owner_session_id = ?
         AND (
           (t.owner_turn_id IS NULL AND t.owner_step_id IS NULL)
           OR (turn.start_seq IS NOT NULL AND turn.start_seq <= ?)
           OR EXISTS (
             SELECT 1 FROM timeline item
             WHERE item.session_id = t.owner_session_id AND item.seq <= ?
               AND json_extract(item.item_json, '$.id') = t.owner_step_id
           )
         )
       LIMIT 1`,
      userId,
      ownerSessionId,
      seq,
      seq,
    );
  },

  recoverActiveByRoot(userId: string, rootAgentId: string, now: number, recoveryId: string): TaskRecoveryResult {
    assertEventType(recoveryId);
    const recovered: TaskRecoveryResult = { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 };
    runInTransaction(() => {
      const rows = db.prepare(
        `SELECT t.* FROM runtime_tasks t
         JOIN agent_nodes a ON a.id = t.agent_id
         WHERE t.user_id = ? AND a.root_agent_id = ?
           AND t.kind IN ('delegation','workflow_node')
           AND t.status IN ('starting','running','waiting','cancel_requested')
         ORDER BY t.updated_at ASC, t.id ASC`,
      ).all(userId, rootAgentId) as unknown as RuntimeTaskRow[];
      for (const current of rows) {
        const nextStatus: TaskStatus = current.status === "cancel_requested"
          ? "cancelled"
          : current.status === "waiting"
            ? "waiting"
          : current.checkpoint_safe === 1
            ? "queued"
            : "interrupted";
        settleJoinedProgressForTaskStatus(current, nextStatus, now);
        const terminal = nextStatus !== "queued" && nextStatus !== "waiting";
        const eventType = nextStatus === "queued"
          ? "recovered:requeued"
          : nextStatus === "waiting"
            ? "recovered:waiting"
          : nextStatus === "cancelled"
            ? "recovered:cancelled"
            : "recovered:interrupted";
        const event = encodeJson(
          { reason: "runtime_takeover", recoveryId, previousStatus: current.status },
          TASK_EVENT_PAYLOAD_MAX_BYTES,
          "Task event payload",
        );
        const row = db.prepare(
          `UPDATE runtime_tasks
           SET status = ?, activity = NULL,
               wait_reason = CASE WHEN ? = 'waiting' THEN wait_reason ELSE NULL END,
               lease_generation = lease_generation + 1, version = version + 1,
               updated_at = ?, settled_at = ?
           WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
             AND status IN ('starting','running','waiting','cancel_requested')
           RETURNING *`,
        ).get(
          nextStatus,
          nextStatus,
          now,
          terminal ? now : null,
          current.id,
          userId,
          current.version,
          current.lease_generation,
        ) as RuntimeTaskRow | undefined;
        if (!row) continue;
        projectWorkflowTaskPhaseInTransaction(row, now);
        appendEventEncoded(row.id, row.version, row.lease_generation, eventType, event, now);
        bumpTaskProjections(row, now);
        if (nextStatus === "queued") recovered.requeued += 1;
        else if (nextStatus === "waiting") recovered.waiting += 1;
        else if (nextStatus === "cancelled") recovered.cancelled += 1;
        else recovered.interrupted += 1;
      }
      const agents = db.prepare(
        `UPDATE agent_nodes
         SET status = 'interrupted', version = version + 1, updated_at = ?
         WHERE user_id = ? AND root_agent_id = ? AND id <> root_agent_id
           AND status IN ('initializing','running')
         RETURNING id, purpose`,
      ).all(now, userId, rootAgentId) as unknown as Array<{ id: string; purpose: AgentNodePurpose }>;
      if (agents.length > 0) {
        bumpRoster(rootAgentId, userId, now, agents.some((agent) => agent.purpose === "addressable"));
      }
    });
    return recovered;
  },

  cancelOrphanedLinkedByRoot(userId: string, rootAgentId: string, now: number): number {
    return runInTransaction(() => {
      const rows = db.prepare(
        `UPDATE runtime_tasks AS task
         SET status = 'cancelled', activity = NULL, wait_reason = NULL,
             lease_generation = lease_generation + 1, version = version + 1,
             updated_at = ?, settled_at = ?
         WHERE task.user_id = ? AND task.kind IN ('delegation','workflow_node')
           AND task.status IN ('queued','waiting') AND task.cancel_policy = 'linked'
           AND EXISTS (
             SELECT 1 FROM agent_nodes agent
             WHERE agent.id = task.agent_id AND agent.root_agent_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_turns owner_turn
             WHERE owner_turn.session_id = task.owner_session_id
               AND owner_turn.id = task.owner_turn_id
               AND owner_turn.status = 'in_progress'
           )
         RETURNING *`,
      ).all(now, now, userId, rootAgentId) as unknown as RuntimeTaskRow[];
      for (const row of rows) {
        recoverJoinedProgressAttempt(
          { ...row, lease_generation: row.lease_generation - 1 },
          "interrupted",
          now,
        );
        const event = encodeJson(
          { reason: "linked_owner_not_running" },
          TASK_EVENT_PAYLOAD_MAX_BYTES,
          "Task event payload",
        );
        appendEventEncoded(row.id, row.version, row.lease_generation, "cancel:linked_owner_gone", event, now);
        bumpTaskProjections(row, now);
      }
      return rows.length;
    });
  },

  cancelOrphanedLinked(now: number, limit = ORCHESTRATION_QUERY_MAX): number {
    return runInTransaction(() => {
      const candidates = db.prepare(
        `SELECT task.* FROM runtime_tasks task
         LEFT JOIN agent_turns owner_turn
           ON owner_turn.session_id = task.owner_session_id
             AND owner_turn.id = task.owner_turn_id
             AND owner_turn.status = 'in_progress'
         WHERE task.kind IN ('delegation','workflow_node')
           AND task.status IN ('queued','waiting') AND task.cancel_policy = 'linked'
           AND owner_turn.id IS NULL
         ORDER BY task.updated_at ASC, task.id ASC
         LIMIT ?`,
      ).all(limitOf(limit)) as unknown as RuntimeTaskRow[];
      let cancelled = 0;
      for (const current of candidates) {
        settleJoinedProgressForTaskStatus(current, "cancelled", now);
        const row = db.prepare(
          `UPDATE runtime_tasks
           SET status = 'cancelled', activity = NULL, wait_reason = NULL,
               lease_generation = lease_generation + 1, version = version + 1,
               updated_at = ?, settled_at = ?
           WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
             AND kind IN ('delegation','workflow_node')
             AND status IN ('queued','waiting') AND cancel_policy = 'linked'
           RETURNING *`,
        ).get(
          now,
          now,
          current.id,
          current.user_id,
          current.version,
          current.lease_generation,
        ) as RuntimeTaskRow | undefined;
        if (!row) continue;
        const event = encodeJson(
          { reason: "linked_owner_not_running" },
          TASK_EVENT_PAYLOAD_MAX_BYTES,
          "Task event payload",
        );
        appendEventEncoded(row.id, row.version, row.lease_generation, "cancel:linked_owner_gone", event, now);
        bumpRosterForAgent(row.agent_id, row.user_id, now);
        cancelled += 1;
      }
      return cancelled;
    });
  },

  recoverAfterRestart(now: number, recoveryId: string): TaskRecoveryResult {
    assertEventType(recoveryId);
    const recovered: TaskRecoveryResult = { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 };
    while (true) {
      const batch = db.prepare(
        `SELECT * FROM runtime_tasks
         WHERE kind IN ('delegation','workflow_node')
           AND status IN ('starting', 'running', 'waiting', 'cancel_requested')
           AND NOT (
             status = 'waiting' AND EXISTS (
               SELECT 1 FROM task_events e
               WHERE e.task_id = runtime_tasks.id
                 AND e.task_version = runtime_tasks.version
                 AND e.type = 'recovered:waiting'
                 AND json_extract(e.payload_json, '$.recoveryId') = ?
             )
           )
         ORDER BY updated_at ASC, id ASC LIMIT ?`,
      ).all(recoveryId, RECOVERY_BATCH_SIZE) as unknown as RuntimeTaskRow[];
      if (batch.length === 0) return recovered;
      let batchRecovered = 0;
      runInTransaction(() => {
        for (const current of batch) {
          const nextStatus: TaskStatus = current.status === "cancel_requested"
            ? "cancelled"
            : current.status === "waiting"
              ? "waiting"
            : current.checkpoint_safe === 1
              ? "queued"
              : "interrupted";
          settleJoinedProgressForTaskStatus(current, nextStatus, now);
          const eventType = nextStatus === "queued"
            ? "recovered:requeued"
            : nextStatus === "waiting"
              ? "recovered:waiting"
            : nextStatus === "cancelled"
              ? "recovered:cancelled"
              : "recovered:interrupted";
          const event = encodeJson(
            { reason: "process_restart", recoveryId, previousStatus: current.status },
            TASK_EVENT_PAYLOAD_MAX_BYTES,
            "Task event payload",
          );
          const terminal = nextStatus !== "queued" && nextStatus !== "waiting";
          const row = db.prepare(
            `UPDATE runtime_tasks
             SET status = ?, activity = NULL,
                 wait_reason = CASE WHEN ? = 'waiting' THEN wait_reason ELSE NULL END,
                 lease_generation = lease_generation + 1, version = version + 1,
                 updated_at = ?, settled_at = ?
             WHERE id = ? AND version = ? AND lease_generation = ?
               AND kind IN ('delegation','workflow_node')
               AND status IN ('starting', 'running', 'waiting', 'cancel_requested')
             RETURNING *`,
          ).get(
            nextStatus,
            nextStatus,
            now,
            terminal ? now : null,
            current.id,
            current.version,
            current.lease_generation,
          ) as RuntimeTaskRow | undefined;
          if (!row) continue;
          projectWorkflowTaskPhaseInTransaction(row, now);
          appendEventEncoded(row.id, row.version, row.lease_generation, eventType, event, now);
          bumpTaskProjections(row, now);
          if (nextStatus === "queued") recovered.requeued += 1;
          else if (nextStatus === "waiting") recovered.waiting += 1;
          else if (nextStatus === "cancelled") recovered.cancelled += 1;
          else recovered.interrupted += 1;
          batchRecovered += 1;
        }
      });
      if (batch.length < RECOVERY_BATCH_SIZE || batchRecovered === 0) return recovered;
    }
  },
};

export const taskEventDao = {
  listRecent(userId: string, taskId: string, limit?: number): TaskEvent[] {
    const rows = db.prepare(
      `SELECT e.* FROM task_events e
       JOIN runtime_tasks t ON t.id = e.task_id
       WHERE t.user_id = ? AND e.task_id = ?
       ORDER BY e.seq DESC LIMIT ?`,
    ).all(userId, taskId, limitOf(limit)) as unknown as TaskEventRow[];
    return rows.reverse().map(mapEvent);
  },
};

interface AcknowledgedTaskResult {
  result: TaskResult;
  change: OrchestrationRevisionChange;
}

function acknowledgeTaskResultInTransaction(input: {
  userId: string;
  taskId: string;
  expectedVersion: number;
  at: number;
}, projection: "addressable" | "executable" = "addressable"): AcknowledgedTaskResult | null {
  const row = projection === "executable"
    ? (() => {
        const scope = rootScopeForTask(input.userId, input.taskId);
        if (!scope) return undefined;
        return db.prepare(
          `${SESSION_EXECUTABLE_ORCHESTRATION_CTE}
           UPDATE task_results SET acknowledged_at = ?, version = version + 1
           WHERE task_id = ? AND version = ? AND acknowledged_at IS NULL
             AND EXISTS (
               SELECT 1 FROM executable_tasks visible
               WHERE visible.id = task_results.task_id
             )
           RETURNING *`,
        ).get(
          ...visibleSessionParams(scope, input.userId),
          input.at,
          input.taskId,
          input.expectedVersion,
        ) as TaskResultRow | undefined;
      })()
    : db.prepare(
      `UPDATE task_results SET acknowledged_at = ?, version = version + 1
       WHERE task_id = ? AND version = ? AND acknowledged_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runtime_tasks t
          JOIN agent_nodes a
            ON a.id = t.agent_id AND a.user_id = t.user_id
            AND a.purpose = 'addressable'
           JOIN sessions execution_session
             ON execution_session.id = t.session_id
            AND execution_session.user_id = t.user_id
           JOIN sessions owner_session
             ON owner_session.id = t.owner_session_id
            AND owner_session.user_id = t.user_id
           WHERE t.id = task_results.task_id AND t.user_id = ?
           ${VISIBLE_AGENT_ANCESTRY_SQL}
           ${VISIBLE_TASK_ANCESTRY_SQL}
           ${OWNED_TASK_WORKFLOW_SQL}
         )
       RETURNING *`,
    ).get(input.at, input.taskId, input.expectedVersion, input.userId) as TaskResultRow | undefined;
  if (!row) return null;
  const task = db.prepare(
    `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? RETURNING *`,
  ).get(input.at, input.taskId, input.userId) as RuntimeTaskRow | undefined;
  if (!task) throw new Error("Task not found while acknowledging its result");
  const agent = db.prepare(
    `SELECT root_agent_id, purpose FROM agent_nodes
     WHERE id = ? AND user_id = ?`,
  ).get(task.agent_id, task.user_id) as {
    root_agent_id: string;
    purpose: AgentNodePurpose;
  } | undefined;
  if (!agent) throw new Error("Agent disappeared while acknowledging its result");
  const event = encodeJson({ resultId: row.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
  appendEventEncoded(task.id, task.version, task.lease_generation, "result:acknowledged", event, input.at);
  bumpRoster(agent.root_agent_id, task.user_id, input.at, agent.purpose === "addressable");
  db.prepare("DELETE FROM pending_result_acknowledgements WHERE task_id = ?").run(task.id);
  const revision = db.prepare(
    `SELECT addressable_revision FROM agent_rosters
     WHERE root_agent_id = ? AND user_id = ?`,
  ).get(agent.root_agent_id, task.user_id) as { addressable_revision: number };
  return {
    result: mapResult(row),
    change: {
      userId: task.user_id,
      sessionId: task.session_id,
      rootAgentId: agent.root_agent_id,
      revision: Number(revision.addressable_revision),
      activityRevision: orchestrationRevisionDao.activity(task.user_id),
    },
  };
}

const JOINED_PROGRESS_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
  "assistant_start",
  "assistant_update",
  "assistant_end",
  "tool_start",
  "tool_status",
  "tool_end",
]);

function assertJoinedProgressEvent(event: WireAgentEvent): void {
  if (!JOINED_PROGRESS_EVENT_TYPES.has(event.t)) {
    throw new TypeError(`Unsupported joined Child progress event: ${event.t}`);
  }
}

function eventTurnId(event: WireAgentEvent): string | undefined {
  return "turnId" in event && typeof event.turnId === "string" ? event.turnId : undefined;
}

function joinedEventFits(value: unknown, maxBytes: number): boolean {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let remaining = maxBytes;
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > 32_768 || --remaining < 0) return false;
    const entry = stack.pop();
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") {
      remaining -= 16;
      continue;
    }
    if (entry === undefined) continue;
    if (typeof entry === "string") {
      if (entry.length > remaining) return false;
      remaining -= Buffer.byteLength(entry, "utf8") + 2;
      if (remaining < 0) return false;
      continue;
    }
    if (typeof entry !== "object") return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    if (Array.isArray(entry)) {
      remaining -= entry.length + 2;
      if (remaining < 0 || nodes + stack.length + entry.length > 32_768) return false;
      for (let index = entry.length - 1; index >= 0; index -= 1) stack.push(entry[index]);
      continue;
    }
    for (const key in entry as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      if (key.length > remaining) return false;
      remaining -= Buffer.byteLength(key, "utf8") + 3;
      if (remaining < 0) return false;
      stack.push((entry as Record<string, unknown>)[key]);
      if (nodes + stack.length > 32_768) return false;
    }
  }
  return true;
}

function oversizedEventFingerprint(event: WireAgentEvent): string {
  const record = event as unknown as Record<string, unknown>;
  return JSON.stringify({
    t: event.t,
    id: typeof record.id === "string" ? [record.id.length, record.id.slice(0, 64)] : null,
    turnId: typeof record.turnId === "string" ? [record.turnId.length, record.turnId.slice(0, 64)] : null,
  });
}

function isTerminalProgressItem(item: TimelineItem): boolean {
  if (item.kind === "assistant") return item.streaming !== true;
  if (item.kind === "tool") return TERMINAL_PROGRESS_TOOL_STATUSES.has(item.status);
  return item.kind !== "compaction_pending";
}

function progressEventIds(event: WireAgentEvent): Set<string> {
  const ids = new Set<string>();
  if ("id" in event && typeof event.id === "string") ids.add(event.id);
  if (event.t === "assistant_update" || event.t === "assistant_end") {
    for (const block of event.blocks) if (block.type === "toolCall") ids.add(block.id);
  }
  return ids;
}

interface CompactedJoinedItems {
  items: TimelineItem[];
  nestedSeqHighwater: number;
  omittedItems: number;
  omittedBytes: number;
  changed: boolean;
}

function compactJoinedItems(input: {
  items: TimelineItem[];
  nestedSeqHighwater: number;
  omittedItems: number;
  omittedBytes: number;
  protectedIds: ReadonlySet<string>;
  omittedEventBytes?: number;
}): CompactedJoinedItems {
  let rows = input.items.slice();
  let highwater = input.nestedSeqHighwater;
  let omittedItems = input.omittedItems;
  let omittedBytes = input.omittedBytes;
  let changed = input.omittedEventBytes !== undefined;
  if (input.omittedEventBytes !== undefined) {
    omittedItems += 1;
    omittedBytes += input.omittedEventBytes;
  }
  const build = (): TimelineItem[] => rows.slice().sort((left, right) => left.seq - right.seq);
  const snapshotBytes = (items: TimelineItem[]) => Buffer.byteLength(JSON.stringify(items), "utf8");
  let snapshot = build();
  const needsCompaction = snapshot.length > JOINED_PROGRESS_COMPACT_AT_ITEMS
    || snapshotBytes(snapshot) > JOINED_PROGRESS_COMPACT_AT_BYTES;
  const overTarget = () => snapshot.length > JOINED_PROGRESS_COMPACT_TO_ITEMS
    || snapshotBytes(snapshot) > JOINED_PROGRESS_COMPACT_TO_BYTES;
  const overHard = () => snapshot.length > JOINED_PROGRESS_MAX_ITEMS
    || snapshotBytes(snapshot) > JOINED_PROGRESS_MAX_BYTES;
  if (needsCompaction) {
    while (overTarget()) {
      let index = rows.findIndex((item) =>
        !input.protectedIds.has(item.id) && isTerminalProgressItem(item));
      if (index < 0) index = rows.findIndex((item) => isTerminalProgressItem(item));
      if (index < 0) index = rows.findIndex((item) => !input.protectedIds.has(item.id));
      if (index < 0) index = 0;
      const [removed] = rows.splice(index, 1);
      if (!removed) break;
      omittedItems += 1;
      omittedBytes += Buffer.byteLength(JSON.stringify(removed), "utf8");
      changed = true;
      snapshot = build();
    }
  }
  while (overHard() && rows.length > 0) {
    let index = rows.findIndex((item) => isTerminalProgressItem(item));
    if (index < 0) index = 0;
    const [removed] = rows.splice(index, 1);
    if (!removed) break;
    omittedItems += 1;
    omittedBytes += Buffer.byteLength(JSON.stringify(removed), "utf8");
    changed = true;
    snapshot = build();
  }
  return { items: snapshot, nestedSeqHighwater: highwater, omittedItems, omittedBytes, changed };
}

export const joinedTaskProgressDao = {
  byTask(userId: string, taskId: string): JoinedTaskProgress | undefined {
    const row = db.prepare(
      `SELECT progress.* FROM task_progress progress
       JOIN runtime_tasks task ON task.id = progress.task_id
       WHERE task.user_id = ? AND progress.task_id = ?`,
    ).get(userId, taskId) as TaskProgressRow | undefined;
    return row ? mapProgress(row) : undefined;
  },

  projectionByTask(userId: string, taskId: string): {
    progress: JoinedTaskProgress;
    parent: Extract<TimelineItem, { kind: "tool" }>;
  } | undefined {
    const row = db.prepare(
      `SELECT progress.*, timeline.item_json AS parent_json
       FROM task_progress progress
       JOIN runtime_tasks task ON task.id = progress.task_id
       JOIN timeline ON timeline.session_id = task.owner_session_id
         AND timeline.seq = progress.owner_timeline_seq
       WHERE task.user_id = ? AND progress.task_id = ?`,
    ).get(userId, taskId) as (TaskProgressRow & { parent_json: string }) | undefined;
    if (!row) return undefined;
    const parent = JSON.parse(row.parent_json) as TimelineItem;
    if (parent.kind !== "tool") throw new Error("Joined Child projection no longer points to a tool Step");
    return { progress: mapProgress(row), parent };
  },

  commit(input: {
    userId: string;
    taskId: string;
    expectedLeaseGeneration: number;
    progressSeq: number;
    ownerTimelineSeq: number;
    event: WireAgentEvent;
    at: number;
  }): CommitJoinedProgressResult {
    if (!Number.isSafeInteger(input.progressSeq) || input.progressSeq < 1) {
      throw new RangeError("Joined Child progress seq must be a positive safe integer");
    }
    if (!Number.isFinite(input.at)) throw new RangeError("Joined Child progress time must be finite");
    assertJoinedProgressEvent(input.event);
    let eventJson: string | undefined;
    let eventBytes = JOINED_PROGRESS_MAX_EVENT_BYTES + 1;
    if (joinedEventFits(input.event, JOINED_PROGRESS_MAX_EVENT_BYTES)) {
      try {
        eventJson = JSON.stringify(input.event);
        eventBytes = Buffer.byteLength(eventJson, "utf8");
        if (eventBytes > JOINED_PROGRESS_MAX_EVENT_BYTES) eventJson = undefined;
      } catch {
        eventJson = undefined;
      }
    }
    const oversizedEvent = eventJson === undefined;
    const eventHash = createHash("sha256")
      .update(eventJson ?? `omitted:${oversizedEventFingerprint(input.event)}`)
      .digest("hex");
    return runInTransaction(() => {
      const task = db.prepare(
        "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
      ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
      if (
        !task
        || task.lease_generation !== input.expectedLeaseGeneration
        || (task.status !== "running" && task.status !== "cancel_requested")
        || task.await_policy !== "join"
        || !task.owner_step_id
      ) return { kind: "stale" };
      const parentRow = db.prepare(
        "SELECT item_json FROM timeline WHERE session_id = ? AND seq = ?",
      ).get(task.owner_session_id, input.ownerTimelineSeq) as { item_json: string } | undefined;
      if (!parentRow) throw new Error("Joined Child owner Timeline Step is missing");
      const parent = JSON.parse(parentRow.item_json) as TimelineItem;
      if (
        parent.kind !== "tool"
        || parent.id !== task.owner_step_id
        || (task.owner_turn_id !== null && parent.turnId !== task.owner_turn_id)
      ) throw new Error("Joined Child owner Timeline Step does not match Task provenance");

      const priorRow = db.prepare("SELECT * FROM task_progress WHERE task_id = ?")
        .get(task.id) as TaskProgressRow | undefined;
      if (priorRow && input.expectedLeaseGeneration < priorRow.lease_generation) return { kind: "stale" };
      if (priorRow && input.ownerTimelineSeq !== priorRow.owner_timeline_seq) {
        throw new Error("Joined Child progress cannot change its pinned owner Timeline seq");      }
      const newAttempt = !priorRow || input.expectedLeaseGeneration > priorRow.lease_generation;
      if (newAttempt && (input.progressSeq !== 1 || input.event.t !== "turn_start")) {
        throw new Error("A joined Child attempt must begin with seq=1 turn_start");
      }
      if (newAttempt && oversizedEvent) throw new Error("A joined Child turn_start must fit its progress boundary");
      if (!newAttempt) {
        if (input.progressSeq <= priorRow.last_seq) {
          if (input.progressSeq === priorRow.last_seq && eventHash !== priorRow.last_event_hash) {
            throw new Error("Conflicting joined Child progress payload for the same cursor");
          }
          return { kind: "duplicate", progress: mapProgress(priorRow) };
        }
        if (input.progressSeq !== priorRow.last_seq + 1) {
          throw new Error("Joined Child progress sequence contains a gap");
        }
        if (priorRow.status !== "in_progress") {
          throw new Error("Joined Child progress cannot continue after a terminal boundary");
        }
        if (input.event.t === "turn_start") throw new Error("Joined Child progress cannot start a second Turn");
      }

      const prior = newAttempt ? undefined : priorRow;
      const turnId = input.event.t === "turn_start" ? input.event.turnId : prior?.turn_id;
      const startedAt = input.event.t === "turn_start" ? input.event.startedAt : prior?.started_at;
      if (!turnId || startedAt === undefined) throw new Error("Joined Child progress is missing its turn_start boundary");
      const nestedTurnId = eventTurnId(input.event);
      if (nestedTurnId !== undefined && nestedTurnId !== turnId) {
        throw new Error("Joined Child progress crossed its durable Turn boundary");
      }
      const priorItems = newAttempt ? [] : JSON.parse(prior!.snapshot_json) as TimelineItem[];
      let nestedSeqHighwater = newAttempt ? 0 : prior!.nested_seq_highwater;
      const allocateNestedSeq = () => ++nestedSeqHighwater;
      const reducedItems = oversizedEvent
        ? priorItems
        : reduceTimeline(priorItems, input.event, input.at, allocateNestedSeq);
      const terminalEvent = !oversizedEvent && input.event.t === "turn_end" ? input.event : undefined;
      if (terminalEvent && reducedItems.some((item) =>
        (item.kind === "assistant" && item.streaming === true)
        || (item.kind === "tool" && !TERMINAL_PROGRESS_TOOL_STATUSES.has(item.status)))) {
        throw new Error("Joined Child turn_end cannot leave projected Steps in progress");
      }
      const compacted = compactJoinedItems({
        items: reducedItems,
        nestedSeqHighwater,
        omittedItems: prior?.omitted_items ?? 0,
        omittedBytes: prior?.omitted_bytes ?? 0,
        protectedIds: progressEventIds(input.event),
        ...(oversizedEvent ? { omittedEventBytes: eventBytes } : {}),
      });
      const items = compacted.items;
      nestedSeqHighwater = compacted.nestedSeqHighwater;
      const snapshotJson = JSON.stringify(items);
      const snapshotBytes = Buffer.byteLength(snapshotJson, "utf8");
      const status: AgentTurnStatus = terminalEvent?.status ?? "in_progress";
      const completedAt = terminalEvent?.completedAt ?? null;
      const durationMs = terminalEvent?.durationMs ?? null;
      const nextParent: Extract<TimelineItem, { kind: "tool" }> = {
        ...parent,
        children: items,
        childProgress: {
          taskId: task.id,
          leaseGeneration: input.expectedLeaseGeneration,
          turnId,
          status,
          startedAt,
          ...(completedAt === null ? {} : { completedAt }),
          ...(durationMs === null ? {} : { durationMs }),
          lastSeq: input.progressSeq,
          source: "worker",
          ...(compacted.omittedItems > 0 ? {
            omittedItems: compacted.omittedItems,
            omittedBytes: compacted.omittedBytes,
          } : {}),
        },
      };
      const nextParentJson = JSON.stringify(nextParent);
      db.prepare(
        `INSERT INTO task_progress
          (task_id, lease_generation, last_seq, turn_id, status, started_at, completed_at,
          duration_ms, source, owner_timeline_seq, nested_seq_highwater, omitted_items, omitted_bytes,
           snapshot_json, snapshot_bytes, item_count,
           last_event_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           lease_generation = excluded.lease_generation,
           last_seq = excluded.last_seq,
           turn_id = excluded.turn_id,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           duration_ms = excluded.duration_ms,
           source = excluded.source,
           owner_timeline_seq = excluded.owner_timeline_seq,
           nested_seq_highwater = excluded.nested_seq_highwater,
           omitted_items = excluded.omitted_items,
           omitted_bytes = excluded.omitted_bytes,
           snapshot_json = excluded.snapshot_json,
           snapshot_bytes = excluded.snapshot_bytes,
           item_count = excluded.item_count,
           last_event_hash = excluded.last_event_hash,
           updated_at = excluded.updated_at`,
      ).run(
        task.id,
        input.expectedLeaseGeneration,
        input.progressSeq,
        turnId,
        status,
        startedAt,
        completedAt,
        durationMs,
        input.ownerTimelineSeq,
        nestedSeqHighwater,
        compacted.omittedItems,
        compacted.omittedBytes,
        snapshotJson,
        snapshotBytes,
        items.length,
        eventHash,
        input.at,
      );
      const updated = db.prepare(
        "UPDATE timeline SET item_json = ? WHERE session_id = ? AND seq = ? AND item_json = ?",
      ).run(nextParentJson, task.owner_session_id, input.ownerTimelineSeq, parentRow.item_json);
      if (updated.changes !== 1) throw new Error("Joined Child owner Timeline Step changed during progress commit");
      const progressRow = db.prepare("SELECT * FROM task_progress WHERE task_id = ?").get(task.id) as unknown as TaskProgressRow;
      return {
        kind: "committed",
        progress: mapProgress(progressRow),
        parent: nextParent,
        wire: compacted.changed || oversizedEvent ? "snapshot" : "event",
        legacyFallback: !oversizedEvent,
      };    });
  },
};

export type SettleRuntimeTaskResultInput = NewTaskResult & {
  nextStatus: "succeeded" | "failed";
  eventType?: string;
  eventPayload?: OrchestrationJson;
};

export type SettleRuntimeTaskWithoutResultInput = Omit<TaskTransitionInput, "nextStatus"> & {
  nextStatus: "cancelled" | "interrupted";
};

function settleRuntimeTaskResultInTransaction(
  input: SettleRuntimeTaskResultInput,
  authority: RuntimeTaskCreationAuthority,
): { task: RuntimeTask; result: TaskResult } | null {
  assertUtf8Bytes(input.summary, TASK_RESULT_SUMMARY_MAX_BYTES, "Task result summary");
  const body = encodeJson(input.body, TASK_RESULT_BODY_MAX_BYTES, "Task result body");
  const artifacts = encodeJson(input.artifacts, TASK_RESULT_ARTIFACTS_MAX_BYTES, "Task result artifacts");
  const eventType = input.eventType ?? `worker:${input.nextStatus}`;
  assertEventType(eventType);
  const current = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
  ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
  if (
    !current
    || current.version !== input.expectedTaskVersion
    || current.lease_generation !== input.expectedLeaseGeneration
  ) return null;
  const expectedKind: TaskKind = authority === "workflow"
    ? "workflow_node"
    : authority === "team"
      ? "team_turn"
      : "delegation";
  if (current.kind !== expectedKind) {
    throw new Error(`${current.kind} Task settlement requires its trusted orchestration owner`);
  }
  if (!TASK_TRANSITIONS[current.status].has(input.nextStatus)) {
    throw new Error(`invalid Task status transition: ${current.status} -> ${input.nextStatus}`);
  }
  settleJoinedProgressForTaskStatus(current, input.nextStatus, input.createdAt);
  const taskRow = db.prepare(
    `UPDATE runtime_tasks
     SET status = ?, activity = NULL, wait_reason = NULL, version = version + 1,
         updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? AND status = ?
     RETURNING *`,
  ).get(
    input.nextStatus,
    input.createdAt,
    input.createdAt,
    input.taskId,
    input.userId,
    input.expectedTaskVersion,
    input.expectedLeaseGeneration,
    current.status,
  ) as RuntimeTaskRow | undefined;
  if (!taskRow) return null;
  db.prepare(
    `INSERT INTO task_results
       (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
  ).run(input.id, input.taskId, input.summary, body.json, artifacts.json, input.createdAt);
  const baseEvent = input.eventPayload ?? {};
  const event = encodeJson(
    { ...(isJsonRecord(baseEvent) ? baseEvent : {}), resultId: input.id },
    TASK_EVENT_PAYLOAD_MAX_BYTES,
    "Task event payload",
  );
  appendEventEncoded(
    taskRow.id,
    taskRow.version,
    taskRow.lease_generation,
    eventType,
    event,
    input.createdAt,
  );
  bumpRosterForAgent(taskRow.agent_id, taskRow.user_id, input.createdAt);
  const resultRow = db.prepare("SELECT * FROM task_results WHERE task_id = ?").get(input.taskId) as unknown as TaskResultRow;
  return { task: mapTask(taskRow), result: mapResult(resultRow) };
}

export function settleWorkflowRuntimeTaskResultInTransaction(
  input: SettleRuntimeTaskResultInput & { workflowId: string; workflowNodeId: string },
): { task: RuntimeTask; result: TaskResult } | null {
  if (!rowExists(
    `SELECT 1 FROM workflow_node_attempts attempt
     JOIN runtime_tasks task ON task.id = attempt.task_id
     JOIN workflows workflow ON workflow.id = attempt.workflow_id
     WHERE attempt.workflow_id = ? AND attempt.node_id = ? AND attempt.task_id = ?
       AND attempt.status IN ('running','cancel_requested')
       AND task.user_id = ? AND task.lease_generation = ?
       AND workflow.user_id = ?`,
    input.workflowId,
    input.workflowNodeId,
    input.taskId,
    input.userId,
    input.expectedLeaseGeneration,
    input.userId,
  )) return null;
  return settleRuntimeTaskResultInTransaction(input, "workflow");
}

export function settleWorkflowRuntimeTaskWithoutResultInTransaction(
  input: SettleRuntimeTaskWithoutResultInput,
): RuntimeTask | null {
  const eventType = input.eventType ?? `worker:${input.nextStatus}`;
  assertEventType(eventType);
  const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
  const current = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND kind = 'workflow_node'",
  ).get(input.id, input.userId) as RuntimeTaskRow | undefined;
  if (
    !current
    || current.version !== input.expectedVersion
    || current.lease_generation !== input.expectedLeaseGeneration
  ) return null;
  if (!TASK_TRANSITIONS[current.status].has(input.nextStatus)) {
    throw new Error(`invalid Task status transition: ${current.status} -> ${input.nextStatus}`);
  }
  const row = db.prepare(
    `UPDATE runtime_tasks
     SET status = ?, activity = NULL, wait_reason = NULL, version = version + 1,
         updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? AND status = ?
     RETURNING *`,
  ).get(
    input.nextStatus,
    input.at,
    input.at,
    input.id,
    input.userId,
    input.expectedVersion,
    input.expectedLeaseGeneration,
    current.status,
  ) as RuntimeTaskRow | undefined;
  if (!row) return null;
  projectWorkflowTaskPhaseInTransaction(row, input.at);
  appendEventEncoded(row.id, row.version, row.lease_generation, eventType, event, input.at);
  bumpRosterForAgent(row.agent_id, row.user_id, input.at);
  return mapTask(row);
}

export const taskResultDao = {
  settle(input: SettleRuntimeTaskResultInput): { task: RuntimeTask; result: TaskResult } | null {
    return runInTransaction(() => settleRuntimeTaskResultInTransaction(input, "delegation"));
  },

  create(input: NewTaskResult): TaskResult | null {
    assertUtf8Bytes(input.summary, TASK_RESULT_SUMMARY_MAX_BYTES, "Task result summary");
    const body = encodeJson(input.body, TASK_RESULT_BODY_MAX_BYTES, "Task result body");
    const artifacts = encodeJson(input.artifacts, TASK_RESULT_ARTIFACTS_MAX_BYTES, "Task result artifacts");
    return runInTransaction(() => {
      const task = db.prepare(
        "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
      ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
      if (!task) throw new Error("Task not found");
      if (task.kind !== "delegation") {
        throw new Error(`${task.kind} Task result requires its trusted orchestration owner`);      }
      if (
        task.version !== input.expectedTaskVersion
        || task.lease_generation !== input.expectedLeaseGeneration
      ) return null;
      if (!TERMINAL_TASK_STATUSES.has(task.status)) throw new Error("Task result requires a terminal Task");
      const versionedTask = db.prepare(
        `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
         RETURNING *`,
      ).get(
        input.createdAt,
        task.id,
        input.userId,
        input.expectedTaskVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!versionedTask) return null;
      db.prepare(
        `INSERT INTO task_results
           (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      ).run(input.id, input.taskId, input.summary, body.json, artifacts.json, input.createdAt);
      const event = encodeJson({ resultId: input.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
      appendEventEncoded(
        versionedTask.id,
        versionedTask.version,
        versionedTask.lease_generation,
        "result:stored",
        event,
        input.createdAt,
      );
      bumpTaskProjections(versionedTask, input.createdAt);
      return this.byTask(input.userId, input.taskId)!;
    });
  },

  byTask(userId: string, taskId: string): TaskResult | undefined {
    const row = db.prepare(
      `SELECT r.* FROM task_results r
       JOIN runtime_tasks t ON t.id = r.task_id
       WHERE t.user_id = ? AND r.task_id = ?`,
    ).get(userId, taskId) as TaskResultRow | undefined;
    return row ? mapResult(row) : undefined;
  },

  acknowledge(input: {
    userId: string;
    taskId: string;
    expectedVersion: number;
    at: number;
  }): TaskResult | null {
    return runInTransaction(() => acknowledgeTaskResultInTransaction(input, "executable")?.result ?? null);
  },

  acknowledgeDetailed(input: {
    userId: string;
    taskId: string;
    expectedVersion: number;
    at: number;
  }): AcknowledgedTaskResult | null {
    return runInTransaction(() => acknowledgeTaskResultInTransaction(input));
  },
};

function prunePendingResultAcksInTransaction(userId: string, sessionId: string, at: number): number {
  return Number(db.prepare(
    `DELETE FROM pending_result_acknowledgements
     WHERE rowid IN (
       SELECT rowid FROM pending_result_acknowledgements
       WHERE user_id = ? AND session_id = ? AND created_at < ?
       ORDER BY created_at ASC, rowid ASC LIMIT ?
     )`,
  ).run(
    userId,
    sessionId,
    at - PENDING_RESULT_ACK_MAX_AGE_MS,
    PENDING_RESULT_ACK_GC_BATCH,
  ).changes);
}

export const taskResultDeliveryDao = {
  stage(input: {
    userId: string;
    sessionId: string;
    deliveryAgentId: string;
    deliveryStepId: string;
    results: ReadonlyArray<{ taskId: string; expectedVersion: number }>;
    acknowledgeOnError?: boolean;
    at: number;
  }): number {
    if (!input.deliveryStepId || Buffer.byteLength(input.deliveryStepId, "utf8") > 256) {
      throw new Error("Result delivery Step id is invalid");
    }
    if (input.results.length === 0) return 0;
    if (input.results.length > 8) throw new Error("Result delivery batch exceeds 8 results");
    return runInTransaction(() => {
      prunePendingResultAcksInTransaction(input.userId, input.sessionId, input.at);
      const delivery = db.prepare(
        `SELECT a.root_agent_id FROM agent_nodes a
         JOIN sessions delivery_session
           ON delivery_session.id = a.session_id AND delivery_session.user_id = a.user_id
         WHERE a.id = ? AND a.user_id = ? AND a.session_id = ? AND a.purpose = 'addressable'
         ${VISIBLE_AGENT_ANCESTRY_SQL}`,
      ).get(input.deliveryAgentId, input.userId, input.sessionId) as { root_agent_id: string } | undefined;
      if (!delivery) throw new Error("Result delivery Agent is not owned by this Session");
      const insert = db.prepare(
        `INSERT INTO pending_result_acknowledgements
           (user_id, session_id, delivery_agent_id, delivery_step_id,
            task_id, expected_result_version, acknowledge_on_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_agent_id, delivery_step_id, task_id) DO UPDATE SET
           expected_result_version = excluded.expected_result_version,
           acknowledge_on_error = excluded.acknowledge_on_error,
           created_at = excluded.created_at`,
      );
      const existing = db.prepare(
        `SELECT 1 FROM pending_result_acknowledgements
         WHERE user_id = ? AND session_id = ? AND delivery_agent_id = ?
           AND delivery_step_id = ? AND task_id = ?`,
      );
      let retained = Number((db.prepare(
        `SELECT COUNT(*) AS count FROM pending_result_acknowledgements
         WHERE user_id = ? AND session_id = ? AND delivery_agent_id = ?`,
      ).get(input.userId, input.sessionId, input.deliveryAgentId) as { count: number }).count);
      let retainedInSession = Number((db.prepare(
        `SELECT COUNT(*) AS count FROM pending_result_acknowledgements
         WHERE user_id = ? AND session_id = ?`,
      ).get(input.userId, input.sessionId) as { count: number }).count);
      let staged = 0;
      for (const result of input.results) {
        if (!Number.isSafeInteger(result.expectedVersion) || result.expectedVersion < 1) {
          throw new Error("Result delivery version is invalid");
        }
        const owned = db.prepare(
          `${SESSION_EXECUTABLE_ORCHESTRATION_CTE}
           SELECT 1 FROM task_results r
           JOIN executable_tasks visible ON visible.id = r.task_id
           WHERE r.task_id = ? AND r.version = ? AND r.acknowledged_at IS NULL`,
        ).get(
          ...visibleSessionParams({
            rootAgentId: delivery.root_agent_id,
            sessionId: input.sessionId,
          }, input.userId),
          result.taskId,
          result.expectedVersion,
        );
        if (!owned) continue;
        const alreadyRetained = Boolean(existing.get(
          input.userId,
          input.sessionId,
          input.deliveryAgentId,
          input.deliveryStepId,
          result.taskId,
        ));
        if (
          !alreadyRetained
          && (
            retained >= PENDING_RESULT_ACK_MAX_PER_DELIVERY_AGENT
            || retainedInSession >= PENDING_RESULT_ACK_MAX_PER_SESSION
          )
        ) continue;
        staged += insert.run(
          input.userId,
          input.sessionId,
          input.deliveryAgentId,
          input.deliveryStepId,
          result.taskId,
          result.expectedVersion,
          input.acknowledgeOnError ? 1 : 0,
          input.at,
        ).changes > 0 ? 1 : 0;
        if (!alreadyRetained) {
          retained += 1;
          retainedInSession += 1;
        }
      }
      return staged;    });
  },

  discard(input: {
    userId: string;
    sessionId: string;
    deliveryAgentId: string;
    deliveryStepIds: readonly string[];
    preserveErrorDeliveries?: boolean;
  }): number {
    const stepIds = [...new Set(input.deliveryStepIds)].filter(Boolean);
    if (stepIds.length > PENDING_RESULT_ACK_MAX_PER_SESSION) {
      throw new Error("Result delivery discard batch exceeds Session bound");
    }
    if (stepIds.length === 0) return 0;
    const placeholders = stepIds.map(() => "?").join(",");
    return Number(db.prepare(
      `DELETE FROM pending_result_acknowledgements
       WHERE user_id = ? AND session_id = ? AND delivery_agent_id = ?
         AND delivery_step_id IN (${placeholders})
         ${input.preserveErrorDeliveries ? "AND acknowledge_on_error = 0" : ""}`,
    ).run(input.userId, input.sessionId, input.deliveryAgentId, ...stepIds).changes);
  },

  commitDelivered(input: {
    userId: string;
    sessionId: string;
    deliveryAgentId: string;
    deliveryStepIds: readonly string[];
    at: number;
  }): OrchestrationRevisionChange[] {
    const stepIds = [...new Set(input.deliveryStepIds)].filter(Boolean);
    if (stepIds.length > PENDING_RESULT_ACK_MAX_PER_SESSION) {
      throw new Error("Result delivery commit batch exceeds Session bound");
    }
    if (stepIds.length === 0) return [];
    return runInTransaction(() => {
      const placeholders = stepIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT task_id, expected_result_version
         FROM pending_result_acknowledgements
         WHERE user_id = ? AND session_id = ? AND delivery_agent_id = ?
           AND delivery_step_id IN (${placeholders})
         ORDER BY created_at ASC, task_id ASC`,
      ).all(
        input.userId,
        input.sessionId,
        input.deliveryAgentId,
        ...stepIds,
      ) as unknown as Array<{ task_id: string; expected_result_version: number }>;
      const changes: OrchestrationRevisionChange[] = [];
      for (const row of rows) {
        const acknowledged = acknowledgeTaskResultInTransaction({
          userId: input.userId,
          taskId: row.task_id,
          expectedVersion: Number(row.expected_result_version),
          at: input.at,
        }, "executable");
        if (acknowledged) changes.push(acknowledged.change);
      }
      db.prepare(
        `DELETE FROM pending_result_acknowledgements
         WHERE user_id = ? AND session_id = ? AND delivery_agent_id = ?
           AND delivery_step_id IN (${placeholders})`,
      ).run(input.userId, input.sessionId, input.deliveryAgentId, ...stepIds);
      return changes;
    });
  },

  commitPersisted(userId: string, sessionId: string, at: number): OrchestrationRevisionChange[] {
    const changes: OrchestrationRevisionChange[] = [];
    for (;;) {
      const reconciled = runInTransaction(() => {
        const pruned = prunePendingResultAcksInTransaction(userId, sessionId, at);
        const discarded = Number(db.prepare(
          `DELETE FROM pending_result_acknowledgements
           WHERE rowid IN (
             SELECT p.rowid FROM pending_result_acknowledgements p
             WHERE p.user_id = ? AND p.session_id = ?
               AND p.acknowledge_on_error = 0 AND (
               EXISTS (
                 SELECT 1 FROM agent_nodes root_delivery
                 JOIN messages root_message ON root_message.session_id = p.session_id
                 WHERE root_delivery.id = p.delivery_agent_id
                   AND root_delivery.user_id = p.user_id
                   AND root_delivery.id = root_delivery.root_agent_id
                   AND root_delivery.kind = 'session'
                   AND json_valid(root_message.msg_json)
                   AND json_extract(root_message.msg_json, '$.role') = 'toolResult'
                   AND json_extract(root_message.msg_json, '$.toolCallId') = p.delivery_step_id
                   AND json_extract(root_message.msg_json, '$.isError') = 1
               )
               OR EXISTS (
                 SELECT 1 FROM agent_messages agent_delivery
                 WHERE agent_delivery.agent_id = p.delivery_agent_id
                   AND json_extract(agent_delivery.msg_json, '$.role') = 'toolResult'
                   AND json_extract(agent_delivery.msg_json, '$.toolCallId') = p.delivery_step_id
                   AND json_extract(agent_delivery.msg_json, '$.isError') = 1
               )
             )
             ORDER BY p.created_at ASC, p.rowid ASC LIMIT ?
           )`,
        ).run(userId, sessionId, PENDING_RESULT_ACK_GC_BATCH).changes);

        const delivered = db.prepare(
          `SELECT DISTINCT p.delivery_agent_id, p.delivery_step_id
           FROM pending_result_acknowledgements p
           WHERE p.user_id = ? AND p.session_id = ? AND (
           EXISTS (
             SELECT 1 FROM agent_nodes root_delivery
             JOIN messages root_message ON root_message.session_id = p.session_id
             WHERE root_delivery.id = p.delivery_agent_id
               AND root_delivery.user_id = p.user_id
               AND root_delivery.id = root_delivery.root_agent_id
               AND root_delivery.kind = 'session'
               AND json_valid(root_message.msg_json)
               AND json_extract(root_message.msg_json, '$.role') = 'toolResult'
               AND json_extract(root_message.msg_json, '$.toolCallId') = p.delivery_step_id
               AND (
                 json_extract(root_message.msg_json, '$.isError') = 0
                 OR (
                   p.acknowledge_on_error = 1
                   AND json_extract(root_message.msg_json, '$.isError') = 1
                 )
               )
           )
           OR EXISTS (
             SELECT 1 FROM agent_messages agent_delivery
             WHERE agent_delivery.agent_id = p.delivery_agent_id
               AND json_extract(agent_delivery.msg_json, '$.role') = 'toolResult'
               AND json_extract(agent_delivery.msg_json, '$.toolCallId') = p.delivery_step_id
               AND (
                 json_extract(agent_delivery.msg_json, '$.isError') = 0
                 OR (
                   p.acknowledge_on_error = 1
                   AND json_extract(agent_delivery.msg_json, '$.isError') = 1
                 )
               )
           )
         )
         ORDER BY p.delivery_agent_id, p.delivery_step_id
         LIMIT ?`,
        ).all(userId, sessionId, PENDING_RESULT_ACK_GC_BATCH) as unknown as Array<{
          delivery_agent_id: string;
          delivery_step_id: string;
        }>;
        return { delivered, discarded, pruned };
      });
      for (const row of reconciled.delivered) {
        changes.push(...taskResultDeliveryDao.commitDelivered({
          userId,
          sessionId,
          deliveryAgentId: row.delivery_agent_id,
          deliveryStepIds: [row.delivery_step_id],
          at,
        }));
      }
      if (
        reconciled.delivered.length < PENDING_RESULT_ACK_GC_BATCH
        && reconciled.discarded < PENDING_RESULT_ACK_GC_BATCH
        && reconciled.pruned < PENDING_RESULT_ACK_GC_BATCH
      ) break;
    }
    return changes;
  },

  countPending(userId: string, deliveryAgentId?: string): number {
    const row = deliveryAgentId
      ? db.prepare(
        `SELECT COUNT(*) AS count FROM pending_result_acknowledgements
         WHERE user_id = ? AND delivery_agent_id = ?`,
      ).get(userId, deliveryAgentId)
      : db.prepare(
        "SELECT COUNT(*) AS count FROM pending_result_acknowledgements WHERE user_id = ?",
      ).get(userId);
    return Number((row as { count: number }).count);
  },
};

export const agentMessageDao = {
  load(userId: string, agentId: string): AgentTranscriptSnapshot | undefined {
    return runInTransaction(() => {
      if (!rowExists("SELECT 1 FROM agent_nodes WHERE id = ? AND user_id = ?", agentId, userId)) return undefined;
      const manifest = db.prepare(
        "SELECT version, message_count, total_bytes FROM agent_transcripts WHERE agent_id = ?",
      ).get(agentId) as { version: number; message_count: number; total_bytes: number } | undefined;
      if (!manifest) return Object.freeze({ version: 0, messages: Object.freeze([]) });
      const rows = db.prepare(
        "SELECT msg_json, msg_bytes FROM agent_messages WHERE agent_id = ? ORDER BY seq ASC",
      ).all(agentId) as unknown as Array<{ msg_json: string; msg_bytes: number }>;
      const totalBytes = rows.reduce((sum, row) => sum + Number(row.msg_bytes), 0);
      if (rows.length !== Number(manifest.message_count) || totalBytes !== Number(manifest.total_bytes)) {
        throw new Error("Agent transcript manifest does not match its message rows");
      }
      const messages = rows.map((row, index) => {
        const parsed = JSON.parse(row.msg_json) as OrchestrationJson;
        assertAgentMessageShape(parsed, index);
        return deepFreezeJson(parsed);
      });
      return Object.freeze({ version: Number(manifest.version), messages: Object.freeze(messages) });
    });
  },

  replaceFromTask(input: {
    userId: string;
    agentId: string;
    taskId: string;
    leaseGeneration: number;
    expectedVersion: number;
    messages: readonly OrchestrationJson[];
    savedAt: number;
  }): AgentTranscriptSnapshot | null {
    const { messages } = input;
    const { encoded, totalBytes } = encodeAgentTranscript(messages);
    return runInTransaction(() => {
      if (!rowExists(
        `SELECT 1 FROM runtime_tasks
         WHERE id = ? AND user_id = ? AND agent_id = ? AND lease_generation = ?
           AND status IN ('starting','running','waiting','cancel_requested')`,
        input.taskId,
        input.userId,
        input.agentId,
        input.leaseGeneration,
      )) return null;
      const nextVersion = input.expectedVersion + 1;
      const changed = input.expectedVersion === 0
        ? db.prepare(
          `INSERT INTO agent_transcripts
             (agent_id, version, source_task_id, lease_generation, message_count, total_bytes, saved_at)
           SELECT ?, 1, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM agent_nodes WHERE id = ? AND user_id = ?)
             AND NOT EXISTS (SELECT 1 FROM agent_transcripts WHERE agent_id = ?)`,
        ).run(
          input.agentId,
          input.taskId,
          input.leaseGeneration,
          messages.length,
          totalBytes,
          input.savedAt,
          input.agentId,
          input.userId,
          input.agentId,
        ).changes
        : db.prepare(
          `UPDATE agent_transcripts
           SET version = version + 1, source_task_id = ?, lease_generation = ?,
               message_count = ?, total_bytes = ?, saved_at = ?
           WHERE agent_id = ? AND version = ?`,
        ).run(
          input.taskId,
          input.leaseGeneration,
          messages.length,
          totalBytes,
          input.savedAt,
          input.agentId,
          input.expectedVersion,
        ).changes;
      if (changed !== 1) return null;
      db.prepare("DELETE FROM agent_messages WHERE agent_id = ?").run(input.agentId);
      const insert = db.prepare(
        `INSERT INTO agent_messages (agent_id, seq, msg_json, msg_bytes, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      encoded.forEach((message, index) => {
        insert.run(input.agentId, index + 1, message.json, message.bytes, input.savedAt);
      });
      const canonical = encoded.map((message, index) => {
        const parsed = JSON.parse(message.json) as OrchestrationJson;
        assertAgentMessageShape(parsed, index);
        return deepFreezeJson(parsed);
      });
      return Object.freeze({ version: nextVersion, messages: Object.freeze(canonical) });
    });
  },
};

interface OwnedTeamMemberRow extends TeamMemberRow {
  team_user_id: string;
  team_status: TeamStatus;
  root_agent_id: string | null;
  agent_status: AgentNodeStatus;
}

function ownedTeam(userId: string, teamId: string): TeamRow | undefined {
  return db.prepare(
    "SELECT * FROM teams WHERE id = ? AND user_id = ?",
  ).get(teamId, userId) as
    | TeamRow
    | undefined;
}

function ownedTeamMember(userId: string, teamId: string, memberId: string): OwnedTeamMemberRow | undefined {
  return db.prepare(
    `SELECT m.*, t.user_id AS team_user_id, t.status AS team_status, t.root_agent_id,
            a.status AS agent_status
     FROM team_members m
     JOIN teams t ON t.id = m.team_id
     JOIN agent_nodes a
      ON a.id = m.agent_id AND a.session_id = m.session_id
      AND a.id = a.root_agent_id AND a.parent_agent_id IS NULL
      AND a.kind = 'session' AND a.purpose = 'addressable'
     WHERE m.id = ? AND m.team_id = ? AND t.user_id = ?`,
  ).get(memberId, teamId, userId) as OwnedTeamMemberRow | undefined;
}

function ownedTeamMemberBySession(
  userId: string,
  teamId: string,
  sessionId: string,
): OwnedTeamMemberRow | undefined {
  return db.prepare(
    `SELECT m.*, t.user_id AS team_user_id, t.status AS team_status, t.root_agent_id,
            a.status AS agent_status
     FROM team_members m
     JOIN teams t ON t.id = m.team_id
     JOIN agent_nodes a
       ON a.id = m.agent_id AND a.session_id = m.session_id
      AND a.id = a.root_agent_id AND a.parent_agent_id IS NULL
      AND a.kind = 'session' AND a.purpose = 'addressable'
     WHERE m.session_id = ? AND m.team_id = ? AND t.user_id = ?`,
  ).get(sessionId, teamId, userId) as OwnedTeamMemberRow | undefined;
}

function bumpTeam(teamId: string, userId: string, at: number): number {
  const row = db.prepare(
    `UPDATE teams SET version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? RETURNING version`,
  ).get(at, teamId, userId) as { version: number } | undefined;
  if (!row) throw new Error("Team not found while advancing its revision");
  return Number(row.version);
}

function bumpTaskProjections(task: RuntimeTaskRow, at: number): void {
  bumpRosterForAgent(task.agent_id, task.user_id, at);
  if (task.team_id) bumpTeam(task.team_id, task.user_id, at);
}

function assertTeamName(name: string): void {
  assertBoundedText(name, 256, "Team name");
}

function assertTeamRootOpen(team: TeamRow): void {
  if (!team.root_agent_id || !team.owner_session_ref || !team.root_agent_ref || !rowExists(
    `SELECT 1 FROM agent_nodes
     WHERE id = ? AND user_id = ? AND id = root_agent_id AND kind = 'session' AND status <> 'closed'`,
    team.root_agent_ref,
    team.user_id,
  )) throw new Error("Team owner Session Agent is closed or missing");
  if (team.status === "active" && !rowExists(
    `SELECT 1 FROM team_members member JOIN agent_nodes agent ON agent.id = member.agent_id
     WHERE member.team_id = ? AND member.agent_id = ? AND member.status = 'active'
       AND agent.id = agent.root_agent_id AND agent.kind = 'session' AND agent.status <> 'closed'`,
    team.id,
    team.lead_agent_id ?? "",
  )) throw new Error("Active Team lead Session Agent is closed or missing");
}

function assertTeamRole(role: string): void {
  assertBoundedText(role, 64, "Team role");
}

function assertMailIdentity(value: string, field: string): void {
  assertBoundedText(value, 128, field);
}

function assertMailSubject(subject: string): void {
  assertBoundedText(subject, 512, "Team mail subject");
}

function assertMailDeadline(createdAt: number, deadlineAt: number): void {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(deadlineAt)) {
    throw new RangeError("Team mail times must be safe integers");
  }
  if (deadlineAt <= createdAt || deadlineAt - createdAt > TEAM_MAIL_MAX_TTL_MS) {
    throw new RangeError(`Team mail deadline must be within ${TEAM_MAIL_MAX_TTL_MS} ms`);
  }
}

function assertWorkBudget(budget: TeamWorkBudget): void {
  if (!Number.isSafeInteger(budget.maxModelCycles) || budget.maxModelCycles < 1 || budget.maxModelCycles > TEAM_WORK_MAX_MODEL_CYCLES) {
    throw new RangeError(`Team work turn budget must be from 1 to ${TEAM_WORK_MAX_MODEL_CYCLES}`);
  }
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1 || budget.maxTokens > TEAM_WORK_MAX_TOKENS) {
    throw new RangeError(`Team work token budget must be from 1 to ${TEAM_WORK_MAX_TOKENS}`);
  }
}

function assertMemberAvailable(member: OwnedTeamMemberRow, field: string): void {
  if (member.team_status !== "active") throw new Error("Team is not active");
  if (member.status !== "active") throw new Error(`${field} Team member is not active`);
  if (member.agent_status === "closed") throw new Error(`${field} Team member Session Agent is closed`);
}

function assertTeamAdmin(userId: string, teamId: string, actorSessionId: string): TeamRow {
  const team = ownedTeam(userId, teamId);
  if (!team) throw new Error("Owned Team not found");
  if (team.status === "closed") throw new Error("Closed Team is read-only");
  if (team.owner_session_ref === actorSessionId) return team;
  const lead = db.prepare(
    `SELECT 1 FROM team_members member
     WHERE member.team_id = ? AND member.session_id = ? AND member.agent_id = ?
       AND member.status = 'active'`,
  ).get(teamId, actorSessionId, team.lead_agent_id ?? "");
  if (!lead) throw new Error("Team administration requires the owner or active lead Session");
  return team;
}

function parentMailForRoute(input: {
  userId: string;
  teamId: string;
  sourceMemberId: string;
  targetMemberId: string;
  kind: TeamMailKind;
  parentMailId?: string;
  taskId?: string;
  createdAt: number;
  deadlineAt: number;
  budget?: TeamWorkBudget;
}): { parent: TeamMailRow | undefined; hop: number; taskId: string | undefined } {
  assertMailDeadline(input.createdAt, input.deadlineAt);
  if (!input.parentMailId) {
    if (input.kind === "result" || input.kind === "ack") {
      throw new Error(`${input.kind} mail requires a parent envelope`);
    }
    return { parent: undefined, hop: 0, taskId: input.taskId };
  }
  const parent = db.prepare(
    "SELECT * FROM team_mail WHERE id = ? AND team_id = ? AND user_id = ?",
  ).get(input.parentMailId, input.teamId, input.userId) as TeamMailRow | undefined;
  if (!parent) throw new Error("Parent Team mail was not found in this Team");
  if (parent.deadline_at <= input.createdAt) throw new Error("Parent Team route has expired");
  if (input.deadlineAt > parent.deadline_at) throw new Error("A Team route cannot extend its parent deadline");
  if (parent.target_member_id !== input.sourceMemberId) {
    throw new Error("Only the target of a Team envelope can continue its route");
  }
  const hop = Number(parent.hop) + 1;
  if (hop > TEAM_MAIL_MAX_HOPS) throw new Error(`Team mail hop limit reached (${TEAM_MAIL_MAX_HOPS})`);
  if (input.kind === "result" || input.kind === "ack") {
    if (input.targetMemberId !== parent.source_member_id) {
      throw new Error(`${input.kind} mail must return to the parent source`);
    }
  }
  const inheritedTaskId = input.kind === "work"
    ? input.taskId
    : input.taskId ?? parent.task_id ?? undefined;
  if (input.kind === "result" && !inheritedTaskId) {
    throw new Error("result mail requires a Team Task reference");
  }
  if (input.kind !== "work" && input.taskId && parent.task_id && input.taskId !== parent.task_id) {
    throw new Error("Team reply Task does not match its parent envelope");
  }
  if (input.kind === "work" && parent.budget_turns !== null && parent.budget_tokens !== null) {
    if (!input.budget) throw new Error("Nested Team work requires an explicit budget");
    if (parent.budget_turns <= 1) throw new Error("Parent Team work has no remaining turn budget");
    if (
      input.budget.maxModelCycles > parent.budget_turns - 1
      || input.budget.maxTokens > parent.budget_tokens
    ) throw new Error("Nested Team work cannot expand its parent budget");
  }
  return { parent, hop, taskId: inheritedTaskId };
}

interface InsertTeamMailInput {
  id: string;
  userId: string;
  teamId: string;
  sourceSessionId: string;
  targetMemberId: string;
  kind: TeamMailKind;
  subject: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  taskId?: string;
  activeParentLease?: ActiveTeamRouteLease;
  deadlineAt: number;
  budget?: TeamWorkBudget;
  createdAt: number;
  advanceTeam?: boolean;
}

function assertActiveTeamRouteLease(input: {
  userId: string;
  teamId: string;
  sourceSessionId: string;
  parentMailId?: string;
  createdAt: number;
  lease?: ActiveTeamRouteLease;
}): void {
  const lease = input.lease;
  if (!lease) return;
  if (input.parentMailId !== lease.mailId) {
    throw new Error("Active Team parent lease does not match its route envelope");
  }
  if (
    !Number.isSafeInteger(lease.expectedTaskLeaseGeneration)
    || lease.expectedTaskLeaseGeneration < 0
    || !Number.isSafeInteger(lease.claimGeneration)
    || lease.claimGeneration < 1
  ) throw new Error("Active Team parent lease has invalid generations");
  assertMailIdentity(lease.taskId, "Active Team parent Task");
  assertMailIdentity(lease.mailId, "Active Team parent mail");
  assertMailIdentity(lease.claimToken, "Active Team parent claim token");
  const valid = rowExists(
    `SELECT 1 FROM runtime_tasks task
     JOIN team_mail mail
       ON mail.id = ? AND mail.user_id = task.user_id
      AND mail.team_id = task.team_id AND mail.task_id = task.id
     WHERE task.id = ? AND task.user_id = ? AND task.team_id = ?
       AND task.session_id = ? AND task.kind = 'team_turn'
       AND task.status = 'running' AND task.settled_at IS NULL
       AND task.lease_generation = ?
       AND mail.kind = 'work' AND mail.status = 'claimed'
       AND mail.target_session_id = ?
       AND mail.claim_token = ? AND mail.claim_generation = ?
       AND mail.claim_expires_at > ? AND mail.deadline_at > ?`,
    lease.mailId,
    lease.taskId,
    input.userId,
    input.teamId,
    input.sourceSessionId,
    lease.expectedTaskLeaseGeneration,
    input.sourceSessionId,
    lease.claimToken,
    lease.claimGeneration,
    input.createdAt,
    input.createdAt,
  );
  if (!valid) throw new Error("Active Team parent lease is no longer valid");
}

function insertTeamMail(input: InsertTeamMailInput): { mail: TeamMail; created: boolean } {
  assertMailIdentity(input.idempotencyKey, "Team mail idempotency key");
  assertMailSubject(input.subject);
  const encoded = encodeJson(input.payload, TEAM_MAIL_PAYLOAD_MAX_BYTES, "Team mail payload");
  if (input.kind === "work") {
    if (!input.budget) throw new Error("Team work mail requires a budget");
    assertWorkBudget(input.budget);
  } else if (input.budget) {
    throw new Error("Only Team work mail can carry an execution budget");
  }
  const source = ownedTeamMemberBySession(input.userId, input.teamId, input.sourceSessionId);
  const target = ownedTeamMember(input.userId, input.teamId, input.targetMemberId);
  if (!source || !target) throw new Error("Team mail members must belong to the same owned Team");
  const team = ownedTeam(input.userId, input.teamId);
  if (!team) throw new Error("Owned Team not found");
  const route = parentMailForRoute({ ...input, sourceMemberId: source.id });

  const existing = db.prepare(
    `SELECT * FROM team_mail
     WHERE team_id = ? AND source_member_id = ? AND idempotency_key = ?`,
  ).get(input.teamId, source?.id ?? "", input.idempotencyKey) as TeamMailRow | undefined;
  if (existing) {
    const same = existing.target_member_id === target.id
      && existing.kind === input.kind
      && existing.subject === input.subject
      && existing.payload_json === encoded.json
      && existing.parent_mail_id === (input.parentMailId ?? null)
      && existing.task_id === (route.taskId ?? null)
      && existing.deadline_at === input.deadlineAt
      && existing.budget_turns === (input.budget?.maxModelCycles ?? null)
      && existing.budget_tokens === (input.budget?.maxTokens ?? null);
    if (!same) throw new Error("Team mail idempotency key conflicts with another envelope");
    return { mail: mapTeamMail(existing), created: false };
  }

  assertActiveTeamRouteLease({
    userId: input.userId,
    teamId: input.teamId,
    sourceSessionId: source.session_id,
    parentMailId: input.parentMailId,
    createdAt: input.createdAt,
    ...(input.activeParentLease ? { lease: input.activeParentLease } : {}),
  });

  assertMemberAvailable(source, "Source");
  assertMemberAvailable(target, "Target");
  assertTeamRootOpen(team);
  if (source.id === target.id) throw new Error("Team mail requires two different members");

  const outstanding = db.prepare(
    `SELECT COUNT(*) AS count FROM team_mail
     WHERE team_id = ? AND target_member_id = ? AND status IN ('queued', 'claimed')`,
  ).get(input.teamId, target.id) as { count: number };
  if (Number(outstanding.count) >= TEAM_MAX_OPEN_MAIL_PER_MEMBER) {
    throw new Error(`Team inbox limit reached (${TEAM_MAX_OPEN_MAIL_PER_MEMBER})`);
  }
  if (route.taskId && !rowExists(
    `SELECT 1 FROM runtime_tasks t
     JOIN team_members target ON target.agent_id = t.agent_id AND target.team_id = ?
     WHERE t.id = ? AND t.user_id = ? AND t.kind = 'team_turn'
       AND (
         ? = 'work'
         OR EXISTS (
           SELECT 1 FROM team_mail work
           WHERE work.task_id = t.id AND work.team_id = ? AND work.kind = 'work'
         )
       )`,
    input.teamId,
    route.taskId,
    input.userId,
    input.kind,
    input.teamId,
  )) throw new Error("Team mail Task is not owned by this Team");

  const row = db.prepare(
    `INSERT INTO team_mail
       (id, team_id, user_id, seq, source_member_id, source_session_id,
        target_member_id, target_session_id, kind, subject, payload_json, payload_bytes,
        idempotency_key, parent_mail_id, task_id, hop, deadline_at, budget_turns, budget_tokens,
        budget_root_mail_id, budget_remaining_turns, budget_remaining_tokens,
        status, claim_generation,
        claim_token, version, created_at, updated_at, claimed_at, claim_expires_at, acknowledged_at)
     SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'queued', 0, NULL, 1, ?, ?, NULL, NULL, NULL
     FROM team_mail WHERE team_id = ?
     RETURNING *`,
  ).get(
    input.id,
    input.teamId,
    input.userId,
    source.id,
    source.session_id,
    target.id,
    target.session_id,
    input.kind,
    input.subject,
    encoded.json,
    encoded.bytes,
    input.idempotencyKey,
    input.parentMailId ?? null,
    route.taskId ?? null,
    route.hop,
    input.deadlineAt,
    input.budget?.maxModelCycles ?? null,
    input.budget?.maxTokens ?? null,
    input.kind === "work" ? (route.parent?.budget_root_mail_id ?? route.parent?.id ?? input.id) : null,
    input.budget?.maxModelCycles ?? null,
    input.budget?.maxTokens ?? null,
    input.createdAt,
    input.createdAt,
    input.teamId,
  ) as unknown as TeamMailRow;
  if (input.advanceTeam !== false) bumpTeam(input.teamId, input.userId, input.createdAt);
  return { mail: mapTeamMail(row), created: true };
}

function teamSnapshotOwned(userId: string, id: string): TeamSnapshot | undefined {
  const team = ownedTeam(userId, id);
  if (!team) return undefined;
  const members = (db.prepare(
    `SELECT * FROM team_members WHERE team_id = ?
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
              created_at ASC, id ASC`,
  ).all(id) as unknown as TeamMemberRow[]).map(mapTeamMember);
  const mail = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
       COALESCE(SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed
     FROM team_mail WHERE team_id = ?`,
  ).get(id) as { queued: number; claimed: number };
  const work = db.prepare(
    `SELECT COUNT(*) AS count FROM runtime_tasks
     WHERE team_id = ? AND status NOT IN ('succeeded','failed','cancelled','interrupted')`,
  ).get(id) as { count: number };
  return {
    team: mapTeam(team),
    members,
    queuedMail: Number(mail.queued),
    claimedMail: Number(mail.claimed),
    openWork: Number(work.count),
  };
}

function ensureTeamMemberRoot(input: NewTeamMember, userId: string, at: number): AgentNode {
  const existing = db.prepare(
    `SELECT * FROM agent_nodes
     WHERE session_id = ? AND user_id = ? AND id = root_agent_id
       AND parent_agent_id IS NULL AND kind = 'session'`,
  ).get(input.sessionId, userId) as AgentNodeRow | undefined;
  if (existing) {
    if (
      existing.id !== input.agentId
      || existing.id !== existing.root_agent_id
      || existing.parent_agent_id !== null
      || existing.kind !== "session"
      || existing.status === "closed"
    ) throw new Error("Team membership requires the Session's self-root Agent");
    return mapAgent(existing);
  }
  return insertAgentNode({
    id: input.agentId,
    userId,
    sessionId: input.sessionId,
    rootAgentId: input.agentId,
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: at,
  });
}

function deterministicTeamResultId(taskId: string): string {
  return `team_result_${taskId}`;
}

function settleTeamOutcomeInTransaction(input: {
  userId: string;
  taskId: string;
  resultId: string;
  at: number;
}): { task: RuntimeTask; result: TaskResult; mail: TeamMail } | null {
  const outcome = db.prepare(
    "SELECT * FROM team_turn_outcomes WHERE user_id = ? AND task_id = ?",
  ).get(input.userId, input.taskId) as TeamTurnOutcomeRow | undefined;
  const current = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND kind = 'team_turn'",
  ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
  const mail = db.prepare(
    "SELECT * FROM team_mail WHERE user_id = ? AND task_id = ? AND kind = 'work'",
  ).get(input.userId, input.taskId) as TeamMailRow | undefined;
  if (!outcome || !current || !mail) return null;
  const existingResult = db.prepare("SELECT * FROM task_results WHERE task_id = ?")
    .get(current.id) as unknown as TaskResultRow | undefined;
  if (TERMINAL_TASK_STATUSES.has(current.status) && existingResult) {
    let projectedMail = mail;
    if (mail.status !== "acknowledged" && mail.status !== "cancelled") {
      const acknowledged = db.prepare(
        `UPDATE team_mail SET status = 'acknowledged', acknowledged_at = ?,
           claim_token = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status IN ('queued','claimed') RETURNING *`,
      ).get(input.at, input.at, mail.id, input.userId) as TeamMailRow | undefined;
      if (!acknowledged) return null;
      projectedMail = acknowledged;
    }
    return { task: mapTask(current), result: mapResult(existingResult), mail: mapTeamMail(projectedMail) };
  }
  if (TERMINAL_TASK_STATUSES.has(current.status)) return null;
  if (
    current.lease_generation !== outcome.task_lease_generation
    || mail.claim_generation !== outcome.mail_claim_generation
  ) return null;
  const completedBeforeDeadline = outcome.created_at <= mail.deadline_at;
  const nextStatus: TaskStatus = outcome.status === "completed" && completedBeforeDeadline
    ? "succeeded"
    : outcome.status === "failed"
      ? "failed"
      : outcome.status === "cancelled"
        ? "cancelled"
      : "interrupted";
  const terminal = db.prepare(
    `UPDATE runtime_tasks SET status = ?, activity = NULL, wait_reason = NULL,
       lease_generation = lease_generation + 1, version = version + 1,
       updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
       AND status NOT IN ('succeeded','failed','cancelled','interrupted') RETURNING *`,
  ).get(
    nextStatus,
    input.at,
    input.at,
    current.id,
    input.userId,
    current.version,
    current.lease_generation,
  ) as RuntimeTaskRow | undefined;
  if (!terminal) return null;
  db.prepare(
    `INSERT INTO task_results
       (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
  ).run(
    input.resultId,
    terminal.id,
    outcome.summary,
    outcome.body_json,
    outcome.artifacts_json,
    outcome.created_at,
  );
  const versioned = db.prepare(
    `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
  ).get(input.at, terminal.id, input.userId, terminal.version) as RuntimeTaskRow | undefined;
  if (!versioned) throw new Error("Team outcome result version edge was lost");
  const acknowledged = db.prepare(
    `UPDATE team_mail SET status = 'acknowledged', acknowledged_at = ?,
       claim_token = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND status IN ('queued','claimed') RETURNING *`,
  ).get(input.at, input.at, mail.id, input.userId) as TeamMailRow | undefined;
  if (!acknowledged) throw new Error("Team outcome mail acknowledgement edge was lost");
  appendEventEncoded(
    versioned.id,
    versioned.version,
    versioned.lease_generation,
    `team:outcome:${nextStatus}`,
    encodeJson(
      { outcomeTurnId: outcome.turn_id, modelCycles: outcome.model_cycles, tokens: outcome.tokens },
      TASK_EVENT_PAYLOAD_MAX_BYTES,
      "Task event payload",
    ),
    input.at,
  );
  bumpTaskProjections(versioned, input.at);
  const result = db.prepare("SELECT * FROM task_results WHERE task_id = ?")
    .get(versioned.id) as unknown as TaskResultRow;
  return { task: mapTask(versioned), result: mapResult(result), mail: mapTeamMail(acknowledged) };
}

function closeTeamWork(teamId: string, userId: string, at: number): void {
  const tasks = db.prepare(
    `SELECT * FROM runtime_tasks
     WHERE team_id = ? AND user_id = ?
       AND status NOT IN ('succeeded','failed','cancelled','interrupted')`,
  ).all(teamId, userId) as unknown as RuntimeTaskRow[];
  const event = encodeJson({ teamId }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
  for (const task of tasks) {
    if (settleTeamOutcomeInTransaction({
      userId,
      taskId: task.id,
      resultId: deterministicTeamResultId(task.id),
      at,
    })) continue;
    const nextStatus: TaskStatus = task.status === "queued" || task.status === "cancel_requested"
      ? "cancelled"
      : "interrupted";
    const row = db.prepare(
      `UPDATE runtime_tasks
       SET status = ?, activity = NULL, wait_reason = NULL,
           lease_generation = lease_generation + 1, version = version + 1,
           updated_at = ?, settled_at = ?
       WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
         AND status = ? RETURNING *`,
    ).get(
      nextStatus,
      at,
      at,
      task.id,
      userId,
      task.version,
      task.lease_generation,
      task.status,
    ) as RuntimeTaskRow | undefined;
    if (!row) continue;
    db.prepare(
      `INSERT INTO task_results
         (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
       VALUES (?, ?, 'Team closed before this work completed.', ?, '[]', 1, ?, NULL)`,
    ).run(
      deterministicTeamResultId(row.id),
      row.id,
      encodeJson({ reason: "team_closed" }, TASK_RESULT_BODY_MAX_BYTES, "Task result body").json,
      at,
    );
    const versioned = db.prepare(
      `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
    ).get(at, row.id, userId, row.version) as RuntimeTaskRow | undefined;
    if (!versioned) throw new Error("Team close result version edge was lost");
    appendEventEncoded(
      versioned.id,
      versioned.version,
      versioned.lease_generation,
      `team:closed:${nextStatus}`,
      event,
      at,
    );
    bumpTaskProjections(versioned, at);
  }
}

const TEAM_PROVISION_CLAIM_MIN_MS = 1_000;
const TEAM_PROVISION_CLAIM_MAX_MS = 2 * 60_000;

export type TeamMemberProvisionClaimResult =
  | { state: "claimed"; claim: TeamMemberProvisionClaim }
  | { state: "busy" | "finalized" | "closed"; reservation: TeamMemberProvisionReservation };

interface ClaimMemberProvisionInput {
  reservationId: string;
  userId: string;
  actorSessionId: string;
  teamId: string;
  claimToken: string;
  at: number;
  leaseMs?: number;
}

function claimMemberProvisionInTransaction(
  input: ClaimMemberProvisionInput,
): TeamMemberProvisionClaimResult {
  assertMailIdentity(input.claimToken, "Team provision claim token");
  const leaseMs = input.leaseMs ?? 30_000;
  if (
    !Number.isSafeInteger(leaseMs)
    || leaseMs < TEAM_PROVISION_CLAIM_MIN_MS
    || leaseMs > TEAM_PROVISION_CLAIM_MAX_MS
  ) {
    throw new RangeError(
      `Team provision claim must last from ${TEAM_PROVISION_CLAIM_MIN_MS} to ${TEAM_PROVISION_CLAIM_MAX_MS} ms`,
    );
  }
  const reservation = db.prepare(
    `SELECT * FROM team_member_reservations
     WHERE id = ? AND team_id = ? AND user_id = ? AND actor_session_id = ?`,
  ).get(
    input.reservationId,
    input.teamId,
    input.userId,
    input.actorSessionId,
  ) as unknown as TeamMemberReservationRow | undefined;
  if (!reservation) throw new Error("Owned Team member reservation not found");
  if (reservation.status === "finalized") {
    return { state: "finalized", reservation: mapTeamMemberReservation(reservation) };
  }
  const team = ownedTeam(input.userId, input.teamId);
  const writable = Boolean(
    team
    && team.owner_session_id === input.actorSessionId
    && team.owner_session_ref
    && team.root_agent_ref
    && team.status !== "closed"
    && (team.status === "active" || (team.status === "paused" && team.provision_state === "provisioning")),
  );
  if (
    reservation.status !== "reserved"
    || reservation.cleanup_requested_at !== null
    || reservation.expires_at <= input.at
    || !writable
  ) return { state: "closed", reservation: mapTeamMemberReservation(reservation) };

  if (
    reservation.provision_claim_token === input.claimToken
    && reservation.provision_claim_expires_at !== null
    && reservation.provision_claim_expires_at > input.at
  ) {
    return {
      state: "claimed",
      claim: {
        reservation: mapTeamMemberReservation(reservation),
        teamName: team!.name,
        generation: Number(reservation.provision_generation),
        claimToken: input.claimToken,
        claimExpiresAt: Number(reservation.provision_claim_expires_at),
      },
    };
  }
  if (
    reservation.provision_claim_token !== null
    && reservation.provision_claim_expires_at !== null
    && reservation.provision_claim_expires_at > input.at
  ) return { state: "busy", reservation: mapTeamMemberReservation(reservation) };

  const claimExpiresAt = Math.min(reservation.expires_at, input.at + leaseMs);
  const claimed = db.prepare(
    `UPDATE team_member_reservations
     SET provision_generation = provision_generation + 1,
         provision_claim_token = ?, provision_claim_expires_at = ?, updated_at = ?
     WHERE id = ? AND team_id = ? AND user_id = ? AND actor_session_id = ?
       AND status = 'reserved' AND cleanup_requested_at IS NULL AND expires_at > ?
       AND provision_generation = ?
       AND (provision_claim_token IS NULL OR provision_claim_expires_at IS NULL
            OR provision_claim_expires_at <= ?)
     RETURNING *`,
  ).get(
    input.claimToken,
    claimExpiresAt,
    input.at,
    reservation.id,
    reservation.team_id,
    reservation.user_id,
    reservation.actor_session_id,
    input.at,
    reservation.provision_generation,
    input.at,
  ) as TeamMemberReservationRow | undefined;
  if (!claimed) {
    const latest = db.prepare("SELECT * FROM team_member_reservations WHERE id = ?")
      .get(reservation.id) as unknown as TeamMemberReservationRow;
    return { state: "busy", reservation: mapTeamMemberReservation(latest) };
  }
  return {
    state: "claimed",
    claim: {
      reservation: mapTeamMemberReservation(claimed),
      teamName: team!.name,
      generation: Number(claimed.provision_generation),
      claimToken: input.claimToken,
      claimExpiresAt,
    },
  };
}

export const teamDao = {
  beginProvisioned(input: NewProvisionedTeam): {
    snapshot: TeamSnapshot;
    reservations: TeamMemberProvisionReservation[];
    state: TeamRow["provision_state"];
  } {
    assertTeamName(input.name);
    assertMailIdentity(input.idempotencyKey, "Team provision operation key");
    assertMailIdentity(input.id, "Team id");
    if (input.ownerSessionId !== input.actorSessionId) {
      throw new Error("Team owner must be the authenticated actor Session");
    }
    if (input.roles.length > TEAM_MAX_MEMBERS - 1) {
      throw new RangeError(`A Team supports at most ${TEAM_MAX_MEMBERS - 1} provisioned roles`);
    }
    assertTeamRole(input.ownerMember.role);
    if (
      input.ownerMember.sessionId !== input.ownerSessionId
      || input.ownerMember.agentId !== input.rootAgentId
    ) throw new Error("Provisioned Team owner must use its Session root Agent");
    const request = encodeJson(
      input.request,
      TEAM_PROVISION_REQUEST_MAX_BYTES,
      "Team provision request",
    );
    const identities = new Set<string>([
      input.id,
      input.ownerMember.id,
      input.ownerSessionId,
      input.rootAgentId,
    ]);
    const operationKeys = new Set<string>();
    for (const role of input.roles) {
      assertTeamRole(role.role);
      assertMailIdentity(role.reservationId, "Team member reservation id");
      assertMailIdentity(role.operationKey, "Team role operation key");
      assertMailIdentity(role.provisionedSessionId, "Provisioned Team Session id");
      assertMailIdentity(role.provisionedAgentId, "Provisioned Team Agent id");
      assertMailIdentity(role.memberId, "Reserved Team member id");
      if (operationKeys.has(role.operationKey)) throw new Error("Team role operation keys must be unique");
      operationKeys.add(role.operationKey);
      for (const identity of [
        role.reservationId,
        role.provisionedSessionId,
        role.provisionedAgentId,
        role.memberId,
      ]) {
        if (identities.has(identity)) throw new Error("Provisioned Team identities must be unique");
        identities.add(identity);
      }
    }
    return runInTransaction(() => {
      const existing = db.prepare(
        `SELECT * FROM teams
         WHERE user_id = ? AND owner_session_id = ? AND provision_key = ?`,
      ).get(input.userId, input.ownerSessionId, input.idempotencyKey) as TeamRow | undefined;
      if (existing) {
        if (existing.provision_request_json !== request.json) {
          throw new Error("Team provision idempotency key conflicts with another request");
        }
        return {
          snapshot: teamSnapshotOwned(input.userId, existing.id)!,
          reservations: (db.prepare(
            `SELECT * FROM team_member_reservations
             WHERE team_id = ? ORDER BY created_at ASC, id ASC`,
          ).all(existing.id) as unknown as TeamMemberReservationRow[]).map(mapTeamMemberReservation),
          state: existing.provision_state,
        };
      }
      const root = db.prepare(
        `SELECT * FROM agent_nodes
         WHERE id = ? AND user_id = ? AND session_id = ?
           AND id = root_agent_id AND kind = 'session'`,
      ).get(input.rootAgentId, input.userId, input.ownerSessionId) as AgentNodeRow | undefined;
      if (!root || root.status === "closed") throw new Error("Team owner requires its open Session root Agent");
      db.prepare(
        `INSERT INTO teams
           (id, user_id, owner_session_id, root_agent_id, owner_session_ref, root_agent_ref,
            provision_key, provision_request_json, provision_state, lead_agent_id,
            name, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, 'paused', 1, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.ownerSessionId,
        input.rootAgentId,
        input.ownerSessionId,
        input.rootAgentId,
        input.idempotencyKey,
        request.json,
        input.rootAgentId,
        input.name,
        input.createdAt,
        input.createdAt,
      );
      const owner = ensureTeamMemberRoot(input.ownerMember, input.userId, input.createdAt);
      db.prepare(
        `INSERT INTO team_members
           (id, team_id, session_id, agent_id, role, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      ).run(
        input.ownerMember.id,
        input.id,
        input.ownerSessionId,
        owner.id,
        input.ownerMember.role,
        input.createdAt,
        input.createdAt,
      );
      const insertReservation = db.prepare(
        `INSERT INTO team_member_reservations
           (id, team_id, user_id, actor_session_id, role, provisioned_session_id,
            provisioned_agent_id, member_id, operation_key, request_json, status,
            expires_at, cleanup_requested_at, cleanup_completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, ?)`,
      );
      for (const role of input.roles) {
        const roleRequest = encodeJson(
          role.request,
          TEAM_PROVISION_REQUEST_MAX_BYTES,
          "Team role provision request",
        );
        insertReservation.run(
          role.reservationId,
          input.id,
          input.userId,
          input.actorSessionId,
          role.role,
          role.provisionedSessionId,
          role.provisionedAgentId,
          role.memberId,
          role.operationKey,
          roleRequest.json,
          input.createdAt + 5 * 60_000,
          input.createdAt,
          input.createdAt,
        );
      }
      return {
        snapshot: teamSnapshotOwned(input.userId, input.id)!,
        reservations: (db.prepare(
          `SELECT * FROM team_member_reservations
           WHERE team_id = ? ORDER BY created_at ASC, id ASC`,
        ).all(input.id) as unknown as TeamMemberReservationRow[]).map(mapTeamMemberReservation),
        state: "provisioning" as const,
      };
    });
  },

  activateProvisioned(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    at: number;
  }): TeamSnapshot {
    return runInTransaction(() => {
      const team = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      if (team.provision_state === "failed" || team.status === "closed") {
        throw new Error("Team provision operation is closed");
      }
      if (team.provision_state === "ready" && team.status === "active") {
        return teamSnapshotOwned(input.userId, input.teamId)!;
      }
      const open = db.prepare(
        `SELECT COUNT(*) AS count FROM team_member_reservations
         WHERE team_id = ? AND status <> 'finalized'`,
      ).get(input.teamId) as { count: number };
      if (Number(open.count) !== 0) throw new Error("Team roles are not fully provisioned");
      const activated = db.prepare(
        `UPDATE teams SET status = 'active', provision_state = 'ready',
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'paused'
           AND provision_state = 'provisioning' RETURNING *`,
      ).get(input.at, input.teamId, input.userId) as TeamRow | undefined;
      if (!activated) throw new Error("Team provision activation edge was lost");
      db.prepare(
        `UPDATE sessions SET team_provision_state = 'published', updated_at = ?
         WHERE user_id = ? AND team_provision_team_id = ?
           AND team_provision_state = 'provisional'
           AND EXISTS (
             SELECT 1 FROM team_member_reservations reservation
             WHERE reservation.id = sessions.team_provision_reservation_id
               AND reservation.team_id = ? AND reservation.status = 'finalized'
           )`,
      ).run(input.at, input.userId, input.teamId, input.teamId);
      assertTeamRootOpen(activated);
      return teamSnapshotOwned(input.userId, input.teamId)!;
    });
  },

  create(input: NewTeam): TeamSnapshot {
    assertTeamName(input.name);
    if (input.members.length < 1 || input.members.length > TEAM_MAX_MEMBERS) {
      throw new RangeError(`A Team requires 1 to ${TEAM_MAX_MEMBERS} members`);
    }
    const memberIds = new Set(input.members.map((member) => member.id));
    const sessionIds = new Set(input.members.map((member) => member.sessionId));
    const agentIds = new Set(input.members.map((member) => member.agentId));
    if (
      memberIds.size !== input.members.length
      || sessionIds.size !== input.members.length
      || agentIds.size !== input.members.length
    ) throw new Error("Team member identities, Sessions, and Agents must be unique");
    if (!memberIds.has(input.leadMemberId)) throw new Error("Team lead must be one of its members");
    input.members.forEach((member) => assertTeamRole(member.role));
    if (input.ownerSessionId !== input.actorSessionId) {
      throw new Error("Team owner must be the authenticated actor Session");
    }

    return runInTransaction(() => {
      const root = db.prepare(
        `SELECT * FROM agent_nodes
         WHERE id = ? AND user_id = ? AND session_id = ? AND id = root_agent_id AND kind = 'session'`,
      ).get(input.rootAgentId, input.userId, input.ownerSessionId) as AgentNodeRow | undefined;
      if (!root || root.status === "closed") throw new Error("Team owner requires its open Session root Agent");
      db.prepare(
        `INSERT INTO teams
           (id, user_id, owner_session_id, root_agent_id, owner_session_ref, root_agent_ref,
            lead_agent_id, name, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'active', 1, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.ownerSessionId,
        input.rootAgentId,
        input.ownerSessionId,
        input.rootAgentId,
        input.name,
        input.createdAt,
        input.createdAt,
      );
      let leadAgentId: string | undefined;
      for (const member of input.members) {
        const agent = ensureTeamMemberRoot(member, input.userId, input.createdAt);
        db.prepare(
          `INSERT INTO team_members
             (id, team_id, session_id, agent_id, role, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        ).run(
          member.id,
          input.id,
          member.sessionId,
          agent.id,
          member.role,
          input.createdAt,
          input.createdAt,
        );
        if (member.id === input.leadMemberId) leadAgentId = agent.id;
      }
      if (!leadAgentId) throw new Error("Team lead Agent was not created");
      db.prepare("UPDATE teams SET lead_agent_id = ? WHERE id = ?").run(leadAgentId, input.id);
      return teamSnapshotOwned(input.userId, input.id)!;
    });
  },

  byId(userId: string, id: string): Team | undefined {
    const row = ownedTeam(userId, id);
    return row ? mapTeam(row) : undefined;
  },

  snapshot(userId: string, id: string): TeamSnapshot | undefined {
    return runInTransaction(() => teamSnapshotOwned(userId, id));
  },

  memberHistory(userId: string, teamId: string, limit = TEAM_MAX_MEMBER_HISTORY): TeamMember[] {
    return (db.prepare(
      `SELECT history.member_id AS id, history.team_id, history.session_id, history.agent_id,
              history.role, history.status, 1 AS version, history.created_at, history.updated_at
       FROM team_member_history history
       JOIN teams team ON team.id = history.team_id AND team.user_id = history.user_id
       WHERE history.user_id = ? AND history.team_id = ?
       ORDER BY history.created_at ASC, history.member_id ASC LIMIT ?`,
    ).all(userId, teamId, Math.min(TEAM_MAX_MEMBER_HISTORY, limitOf(limit))) as unknown as TeamMemberRow[])
      .map(mapTeamMember);
  },

  revision(userId: string, id: string): number | undefined {
    const row = db.prepare(
      "SELECT version FROM teams WHERE id = ? AND user_id = ?",
    ).get(id, userId) as
      | { version: number }
      | undefined;
    return row ? Number(row.version) : undefined;
  },

  listForSession(userId: string, sessionId: string, limit = ORCHESTRATION_QUERY_DEFAULT): Team[] {
    return (db.prepare(
      `SELECT DISTINCT t.* FROM teams t
       LEFT JOIN team_members m ON m.team_id = t.id
       WHERE t.user_id = ?
         AND (t.owner_session_ref = ? OR (m.session_id = ? AND m.status <> 'removed'))
       ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
    ).all(userId, sessionId, sessionId, limitOf(limit)) as unknown as TeamRow[]).map(mapTeam);
  },

  listForUser(
    userId: string,
    options: { beforeUpdatedAt?: number; beforeId?: string; limit?: number } = {},
  ): Team[] {
    const limit = limitOf(options.limit ?? ORCHESTRATION_QUERY_DEFAULT);
    const beforeUpdatedAt = options.beforeUpdatedAt ?? Number.MAX_SAFE_INTEGER;
    const beforeId = options.beforeId ?? "\uffff";
    return (db.prepare(
      `SELECT * FROM teams
       WHERE user_id = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(userId, beforeUpdatedAt, beforeUpdatedAt, beforeId, limit) as unknown as TeamRow[]).map(mapTeam);
  },

  contextForSession(userId: string, sessionId: string): {
    teams: Array<{
      id: string;
      name: string;
      status: TeamStatus;
      role: string;
      unread: number;
    }>;
    results: Array<{ taskId: string; status: TaskStatus; summary: string }>;
  } {
    const teams = db.prepare(
      `SELECT team.id, team.name, team.status, member.role,
         (SELECT COUNT(*) FROM team_mail mail
          WHERE mail.team_id = team.id AND mail.target_session_id = ?
            AND mail.status = 'queued') AS unread
       FROM team_members member
       JOIN teams team ON team.id = member.team_id AND team.user_id = ?
       WHERE member.session_id = ? AND member.status <> 'removed'
       ORDER BY team.updated_at DESC, team.id DESC LIMIT 8`,
    ).all(sessionId, userId, sessionId) as unknown as Array<{
      id: string;
      name: string;
      status: TeamStatus;
      role: string;
      unread: number;
    }>;
    const results = db.prepare(
      `SELECT task.id AS taskId, task.status, result.summary
       FROM runtime_tasks task
       JOIN task_results result ON result.task_id = task.id
       WHERE task.user_id = ? AND task.owner_session_id = ? AND task.kind = 'team_turn'
       ORDER BY task.updated_at DESC, task.id DESC LIMIT 8`,
    ).all(userId, sessionId) as unknown as Array<{
      taskId: string;
      status: TaskStatus;
      summary: string;
    }>;
    return {
      teams: teams.map((team) => ({ ...team, unread: Number(team.unread) })),
      results: results.map((result) => ({ ...result, summary: truncateUtf8Bytes(result.summary, 512) })),
    };
  },

  reserveMember(input: {
    id: string;
    operationKey: string;
    request: OrchestrationJson;
    userId: string;
    actorSessionId: string;
    teamId: string;
    role: string;
    provisionedSessionId: string;
    provisionedAgentId: string;
    memberId: string;
    at: number;
    ttlMs?: number;
  }): { reservation: TeamMemberProvisionReservation; teamName: string } {
    assertMailIdentity(input.id, "Team member reservation id");
    assertMailIdentity(input.operationKey, "Team role operation key");
    assertMailIdentity(input.provisionedSessionId, "Provisioned Team Session id");
    assertMailIdentity(input.provisionedAgentId, "Provisioned Team Agent id");
    assertMailIdentity(input.memberId, "Reserved Team member id");
    assertTeamRole(input.role);
    const request = encodeJson(input.request, TEAM_PROVISION_REQUEST_MAX_BYTES, "Team role provision request");
    const ttlMs = input.ttlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 10 * 60_000) {
      throw new RangeError("Team member reservation must last from 30 to 600 seconds");
    }
    return runInTransaction(() => {
      const team = ownedTeam(input.userId, input.teamId);
      if (!team) throw new Error("Owned Team not found");
      const existing = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE team_id = ? AND operation_key = ?`,
      ).get(input.teamId, input.operationKey) as TeamMemberReservationRow | undefined;
      if (existing) {
        if (
          existing.user_id !== input.userId
          || existing.actor_session_id !== input.actorSessionId
          || existing.role !== input.role
          || existing.request_json !== request.json
        ) throw new Error("Team role idempotency key conflicts with another request");
        if (existing.status === "cancelled") {
          throw new Error("Team role provision operation is closed");
        }
        return { reservation: mapTeamMemberReservation(existing), teamName: team.name };
      }
      const writableTeam = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      if (writableTeam.status !== "active") throw new Error("Team is not active");
      assertTeamRootOpen(writableTeam);
      const counts = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND status <> 'removed') AS members,
           (SELECT COUNT(*) FROM team_member_reservations
             WHERE team_id = ? AND status = 'reserved' AND cleanup_requested_at IS NULL
               AND expires_at > ?) AS reservations,
           (SELECT COUNT(*) FROM team_member_history WHERE team_id = ?) AS history`,
      ).get(input.teamId, input.teamId, input.at, input.teamId) as {
        members: number;
        reservations: number;
        history: number;
      };
      if (Number(counts.members) + Number(counts.reservations) >= TEAM_MAX_MEMBERS) {
        throw new Error(`Team member limit reached (${TEAM_MAX_MEMBERS})`);
      }
      if (Number(counts.history) + Number(counts.reservations) >= TEAM_MAX_MEMBER_HISTORY) {
        throw new Error(`Team member history limit reached (${TEAM_MAX_MEMBER_HISTORY})`);
      }
      db.prepare(
        `INSERT INTO team_member_reservations
           (id, team_id, user_id, actor_session_id, role, provisioned_session_id,
            provisioned_agent_id, member_id, operation_key, request_json, status,
            expires_at, cleanup_requested_at, cleanup_completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        input.teamId,
        input.userId,
        input.actorSessionId,
        input.role,
        input.provisionedSessionId,
        input.provisionedAgentId,
        input.memberId,
        input.operationKey,
        request.json,
        input.at + ttlMs,
        input.at,
        input.at,
      );
      bumpTeam(input.teamId, input.userId, input.at);
      const row = db.prepare("SELECT * FROM team_member_reservations WHERE id = ?")
        .get(input.id) as unknown as TeamMemberReservationRow;
      return { reservation: mapTeamMemberReservation(row), teamName: team.name };
    });
  },

  claimMemberProvision(input: ClaimMemberProvisionInput): TeamMemberProvisionClaimResult {
    return runInTransaction(() => claimMemberProvisionInTransaction(input));
  },

  claimNextMemberProvision(input: {
    claimToken: string;
    at: number;
    leaseMs?: number;
  }): TeamMemberProvisionClaim | undefined {
    return runInTransaction(() => {
      const candidate = db.prepare(
        `SELECT reservation.id, reservation.user_id, reservation.actor_session_id,
                reservation.team_id
         FROM team_member_reservations reservation
         JOIN teams team ON team.id = reservation.team_id
           AND team.user_id = reservation.user_id
         WHERE reservation.status = 'reserved'
           AND reservation.cleanup_requested_at IS NULL
           AND reservation.expires_at > ?
           AND (reservation.provision_claim_token IS NULL
                OR reservation.provision_claim_expires_at IS NULL
                OR reservation.provision_claim_expires_at <= ?)
           AND team.owner_session_id = reservation.actor_session_id
           AND team.owner_session_ref IS NOT NULL AND team.root_agent_ref IS NOT NULL
           AND team.status <> 'closed'
           AND (team.status = 'active'
                OR (team.status = 'paused' AND team.provision_state = 'provisioning'))
         ORDER BY reservation.created_at, reservation.id LIMIT 1`,
      ).get(input.at, input.at) as {
        id: string;
        user_id: string;
        actor_session_id: string;
        team_id: string;
      } | undefined;
      if (!candidate) return undefined;
      const result = claimMemberProvisionInTransaction({
        reservationId: candidate.id,
        userId: candidate.user_id,
        actorSessionId: candidate.actor_session_id,
        teamId: candidate.team_id,
        claimToken: input.claimToken,
        at: input.at,
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      });
      return result.state === "claimed" ? result.claim : undefined;
    });
  },

  isActiveMemberProvisionClaim(input: {
    reservationId: string;
    userId: string;
    sessionId: string;
    generation: number;
    claimToken: string;
    at: number;
  }): boolean {
    return rowExists(
      `SELECT 1 FROM team_member_reservations reservation
       JOIN teams team ON team.id = reservation.team_id
         AND team.user_id = reservation.user_id
       WHERE reservation.id = ? AND reservation.user_id = ?
         AND reservation.provisioned_session_id = ?
         AND reservation.status = 'reserved' AND reservation.cleanup_requested_at IS NULL
         AND reservation.expires_at > ?
         AND reservation.provision_generation = ?
         AND reservation.provision_claim_token = ?
         AND reservation.provision_claim_expires_at > ?
         AND team.owner_session_ref IS NOT NULL AND team.root_agent_ref IS NOT NULL
         AND team.status <> 'closed'
         AND (team.status = 'active'
              OR (team.status = 'paused' AND team.provision_state = 'provisioning'))`,
      input.reservationId,
      input.userId,
      input.sessionId,
      input.at,
      input.generation,
      input.claimToken,
      input.at,
    );
  },

  finalizeReservedMember(input: {
    reservationId: string;
    userId: string;
    actorSessionId: string;
    teamId: string;
    generation: number;
    claimToken: string;
    member: NewTeamMember;
    at: number;
  }): TeamMember {
    return runInTransaction(() => {
      const team = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      if (
        team.status !== "active"
        && !(team.status === "paused" && team.provision_state === "provisioning")
      ) throw new Error("Team is not accepting provisioned roles");
      const reservation = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE id = ? AND team_id = ? AND user_id = ? AND actor_session_id = ?
           AND status <> 'cancelled'`,
      ).get(
        input.reservationId,
        input.teamId,
        input.userId,
        input.actorSessionId,
      ) as TeamMemberReservationRow | undefined;
      if (
        !reservation
        || reservation.role !== input.member.role
        || reservation.provisioned_session_id !== input.member.sessionId
        || reservation.provisioned_agent_id !== input.member.agentId
        || reservation.member_id !== input.member.id
      ) {
        throw new Error("Team member reservation does not match its provisioned identity");
      }
      if (reservation.status === "finalized") {
        const existing = ownedTeamMember(input.userId, input.teamId, input.member.id);
        if (!existing) throw new Error("Finalized Team member reservation lost its member");
        return mapTeamMember(existing);
      }
      if (
        reservation.cleanup_requested_at !== null
        || reservation.expires_at <= input.at
        || reservation.provision_generation !== input.generation
        || reservation.provision_claim_token !== input.claimToken
        || reservation.provision_claim_expires_at === null
        || reservation.provision_claim_expires_at <= input.at
      ) {
        throw new Error("Team member reservation is unavailable or expired");
      }
      const counts = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM team_members
             WHERE team_id = ? AND status <> 'removed') AS members,
           (SELECT COUNT(*) FROM team_member_reservations
             WHERE team_id = ? AND id <> ? AND status = 'reserved'
               AND cleanup_requested_at IS NULL AND expires_at > ?) AS reservations,
           (SELECT COUNT(*) FROM team_member_history WHERE team_id = ?) AS history`,
      ).get(
        input.teamId,
        input.teamId,
        input.reservationId,
        input.at,
        input.teamId,
      ) as { members: number; reservations: number; history: number };
      if (Number(counts.members) + Number(counts.reservations) >= TEAM_MAX_MEMBERS) {
        throw new Error(`Team member limit reached (${TEAM_MAX_MEMBERS})`);
      }
      if (Number(counts.history) + Number(counts.reservations) >= TEAM_MAX_MEMBER_HISTORY) {
        throw new Error(`Team member history limit reached (${TEAM_MAX_MEMBER_HISTORY})`);
      }
      const agent = ensureTeamMemberRoot(input.member, input.userId, input.at);
      db.prepare(
        `INSERT INTO team_members
           (id, team_id, session_id, agent_id, role, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      ).run(
        input.member.id,
        input.teamId,
        input.member.sessionId,
        agent.id,
        input.member.role,
        input.at,
        input.at,
      );
      const finalized = db.prepare(
        `UPDATE team_member_reservations
         SET status = 'finalized', provision_claim_token = NULL,
             provision_claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'reserved' AND provision_generation = ?
           AND provision_claim_token = ? RETURNING id`,
      ).get(input.at, input.reservationId, input.generation, input.claimToken);
      if (!finalized) throw new Error("Team member reservation changed during finalization");
      if (team.status === "active") {
        const published = db.prepare(
          `UPDATE sessions
           SET team_provision_state = 'published', updated_at = ?
           WHERE id = ? AND user_id = ?
             AND team_provision_team_id = ? AND team_provision_reservation_id = ?
             AND team_provision_state = 'provisional'`,
        ).run(
          input.at,
          input.member.sessionId,
          input.userId,
          input.teamId,
          input.reservationId,
        ).changes;
        if (published !== 1) throw new Error("Provisioned Team Session publication edge was lost");
      }
      bumpTeam(input.teamId, input.userId, input.at);
      const row = ownedTeamMember(input.userId, input.teamId, input.member.id);
      if (!row) throw new Error("Reserved Team member was not created");
      return mapTeamMember(row);
    });
  },

  failMemberProvisionClaim(input: {
    reservationId: string;
    userId: string;
    actorSessionId: string;
    teamId: string;
    generation: number;
    claimToken: string;
    at: number;
  }): {
    owned: boolean;
    retire: Array<{ reservationId: string; userId: string; sessionId: string }>;
  } {
    return runInTransaction(() => {
      const reservation = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE id = ? AND team_id = ? AND user_id = ? AND actor_session_id = ?`,
      ).get(
        input.reservationId,
        input.teamId,
        input.userId,
        input.actorSessionId,
      ) as TeamMemberReservationRow | undefined;
      if (
        !reservation
        || reservation.status !== "reserved"
        || reservation.cleanup_requested_at !== null
        || reservation.provision_generation !== input.generation
        || reservation.provision_claim_token !== input.claimToken
        || reservation.provision_claim_expires_at === null
        || reservation.provision_claim_expires_at <= input.at
      ) return { owned: false, retire: [] };
      const team = ownedTeam(input.userId, input.teamId);
      if (!team) return { owned: false, retire: [] };

      const failWholeTeam = team.status === "paused" && team.provision_state === "provisioning";
      if (failWholeTeam) {
        db.prepare(
          `UPDATE teams SET status = 'closed', provision_state = 'failed',
             version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'paused'
             AND provision_state = 'provisioning'`,
        ).run(input.at, input.teamId, input.userId);
        closeTeamWork(input.teamId, input.userId, input.at);
      }
      const affected = failWholeTeam
        ? db.prepare(
          `SELECT * FROM team_member_reservations
           WHERE team_id = ? AND user_id = ? AND status <> 'cancelled'`,
        ).all(input.teamId, input.userId) as unknown as TeamMemberReservationRow[]
        : [reservation];
      const retire: Array<{ reservationId: string; userId: string; sessionId: string }> = [];
      for (const row of affected) {
        const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
          .get(row.provisioned_session_id, row.user_id);
        if (session) {
          db.prepare(
            `UPDATE team_member_reservations
             SET status = 'reserved', cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
                 provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status <> 'cancelled'`,
          ).run(input.at, input.at, row.id);
          retire.push({
            reservationId: row.id,
            userId: row.user_id,
            sessionId: row.provisioned_session_id,
          });
        } else {
          db.prepare(
            `UPDATE team_member_reservations
             SET status = 'cancelled', cleanup_completed_at = ?,
                 provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status <> 'cancelled'`,
          ).run(input.at, input.at, row.id);
        }
      }
      bumpTeam(input.teamId, input.userId, input.at);
      return { owned: true, retire };
    });
  },

  isReservedProvisionSession(userId: string, sessionId: string): boolean {
    return rowExists(
      `SELECT 1 FROM team_member_reservations
       WHERE user_id = ? AND provisioned_session_id = ? AND status = 'reserved'
         AND cleanup_requested_at IS NULL`,
      userId,
      sessionId,
    );
  },

  recoverMemberReservations(at: number): {
    finalized: number;
    cancelled: number;
    retire: Array<{ reservationId: string; userId: string; sessionId: string }>;
  } {
    return runInTransaction(() => {
      const rows = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE status = 'reserved' ORDER BY created_at ASC, id ASC LIMIT ?`,
      ).all(ORCHESTRATION_QUERY_MAX) as unknown as TeamMemberReservationRow[];
      let finalized = 0;
      let cancelled = 0;
      for (const reservation of rows) {
        const sessionId = reservation.provisioned_session_id;
        const agentId = reservation.provisioned_agent_id;
        const memberId = reservation.member_id;
        const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
          .get(sessionId, reservation.user_id);
        if (reservation.cleanup_requested_at !== null) {
          if (!session) {
            db.prepare(
              `UPDATE team_member_reservations SET status = 'cancelled',
                 cleanup_completed_at = ?, provision_claim_token = NULL,
                 provision_claim_expires_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'reserved'`,
            ).run(at, at, reservation.id);
            cancelled += 1;
          }
          continue;
        }
        const existing = db.prepare("SELECT 1 FROM team_members WHERE id = ? AND team_id = ?")
          .get(memberId, reservation.team_id);
        if (existing) {
          db.prepare(
            `UPDATE team_member_reservations SET status = 'finalized',
               provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
             WHERE id = ?`,
          ).run(at, reservation.id);
          const existingTeam = ownedTeam(reservation.user_id, reservation.team_id);
          if (existingTeam?.status === "active") {
            db.prepare(
              `UPDATE sessions SET team_provision_state = 'published', updated_at = ?
               WHERE id = ? AND user_id = ? AND team_provision_reservation_id = ?
                 AND team_provision_state = 'provisional'`,
            ).run(at, sessionId, reservation.user_id, reservation.id);
          }
          finalized += 1;
          continue;
        }
        const team = ownedTeam(reservation.user_id, reservation.team_id);
        const canFinalize = Boolean(
          session && team
          && (team.status === "active" || (team.status === "paused" && team.provision_state === "provisioning"))
          && team.owner_session_ref && team.root_agent_ref && reservation.expires_at > at,
        );
        if (canFinalize) {
          const counts = db.prepare(
            `SELECT
              (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND status <> 'removed') AS members,
              (SELECT COUNT(*) FROM team_member_history WHERE team_id = ?) AS history`,
          ).get(reservation.team_id, reservation.team_id) as { members: number; history: number };
          if (Number(counts.members) < TEAM_MAX_MEMBERS && Number(counts.history) < TEAM_MAX_MEMBER_HISTORY) {
            ensureTeamMemberRoot({
              id: memberId,
              sessionId,
              agentId,
              role: reservation.role,
            }, reservation.user_id, at);
            db.prepare(
              `INSERT INTO team_members
                 (id, team_id, session_id, agent_id, role, status, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
            ).run(memberId, reservation.team_id, sessionId, agentId, reservation.role, at, at);
            db.prepare(
              `UPDATE team_member_reservations SET status = 'finalized',
                 provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
               WHERE id = ?`,
            ).run(at, reservation.id);
            if (team!.status === "active") {
              db.prepare(
                `UPDATE sessions SET team_provision_state = 'published', updated_at = ?
                 WHERE id = ? AND user_id = ? AND team_provision_reservation_id = ?
                   AND team_provision_state = 'provisional'`,
              ).run(at, sessionId, reservation.user_id, reservation.id);
            }
            bumpTeam(reservation.team_id, reservation.user_id, at);
            finalized += 1;
            continue;
          }
        }
        if (
          !session
          && reservation.expires_at > at
          && team
          && team.owner_session_ref
          && team.root_agent_ref
          && (team.status === "active" || (team.status === "paused" && team.provision_state === "provisioning"))
        ) continue;
        if (team?.provision_state === "provisioning") {
          db.prepare(
            `UPDATE teams SET status = 'closed', provision_state = 'failed',
               version = version + 1, updated_at = ?
             WHERE id = ? AND user_id = ? AND provision_state = 'provisioning'`,
          ).run(at, team.id, team.user_id);
        }
        if (session) {
          db.prepare(
            `UPDATE team_member_reservations SET cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
               provision_claim_token = NULL, provision_claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND status = 'reserved'`,
          ).run(at, at, reservation.id);
        } else {
          db.prepare(
            `UPDATE team_member_reservations SET status = 'cancelled',
               cleanup_completed_at = ?, provision_claim_token = NULL,
               provision_claim_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'reserved'`,
          ).run(at, at, reservation.id);
          cancelled += 1;
        }
      }
      const failedOpen = db.prepare(
        `SELECT reservation.* FROM team_member_reservations reservation
         JOIN teams team ON team.id = reservation.team_id
         WHERE reservation.status = 'reserved' AND team.provision_state = 'failed'
         ORDER BY reservation.created_at, reservation.id LIMIT ?`,
      ).all(ORCHESTRATION_QUERY_MAX) as unknown as TeamMemberReservationRow[];
      for (const reservation of failedOpen) {
        const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
          .get(reservation.provisioned_session_id, reservation.user_id);
        if (session) {
          db.prepare(
            `UPDATE team_member_reservations SET cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
               provision_claim_token = NULL, provision_claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND status = 'reserved'`,
          ).run(at, at, reservation.id);
        } else {
          const changed = db.prepare(
            `UPDATE team_member_reservations SET status = 'cancelled', cleanup_completed_at = ?,
               provision_claim_token = NULL, provision_claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND status = 'reserved'`,
          ).run(at, at, reservation.id).changes;
          cancelled += Number(changed);
        }
      }
      const readyTeams = db.prepare(
        `SELECT team.id, team.user_id FROM teams team
         WHERE team.provision_state = 'provisioning' AND team.status = 'paused'
           AND NOT EXISTS (
             SELECT 1 FROM team_member_reservations reservation
             WHERE reservation.team_id = team.id AND reservation.status <> 'finalized'
           )`,
      ).all() as unknown as Array<{ id: string; user_id: string }>;
      for (const team of readyTeams) {
        db.prepare(
          `UPDATE teams SET status = 'active', provision_state = 'ready',
             version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?`,
        ).run(at, team.id, team.user_id);
        db.prepare(
          `UPDATE sessions SET team_provision_state = 'published', updated_at = ?
           WHERE user_id = ? AND team_provision_team_id = ?
             AND team_provision_state = 'provisional'
             AND EXISTS (
               SELECT 1 FROM team_member_reservations reservation
               WHERE reservation.id = sessions.team_provision_reservation_id
                 AND reservation.team_id = ? AND reservation.status = 'finalized'
             )`,
        ).run(at, team.user_id, team.id, team.id);
      }
      const retire = (db.prepare(
        `SELECT id AS reservation_id, user_id, provisioned_session_id
         FROM team_member_reservations
         WHERE status = 'reserved' AND cleanup_requested_at IS NOT NULL
         ORDER BY cleanup_requested_at, id LIMIT ?`,
      ).all(ORCHESTRATION_QUERY_MAX) as unknown as Array<{
        reservation_id: string;
        user_id: string;
        provisioned_session_id: string;
      }>).map((row) => ({
        reservationId: row.reservation_id,
        userId: row.user_id,
        sessionId: row.provisioned_session_id,
      }));
      return { finalized, cancelled, retire };
    });
  },

  requestMemberReservationCleanup(input: {
    reservationId: string;
    userId: string;
    actorSessionId: string;
    teamId: string;
    at: number;
  }): { reservation: TeamMemberProvisionReservation; needsRetire: boolean } {
    return runInTransaction(() => {
      if (!ownedTeam(input.userId, input.teamId)) throw new Error("Owned Team not found");
      const row = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE id = ? AND team_id = ? AND user_id = ? AND actor_session_id = ?`,
      ).get(
        input.reservationId,
        input.teamId,
        input.userId,
        input.actorSessionId,
      ) as TeamMemberReservationRow | undefined;
      if (!row || row.status === "finalized") throw new Error("Open Team member reservation not found");
      if (row.status === "cancelled") {
        return { reservation: mapTeamMemberReservation(row), needsRetire: false };
      }
      const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
        .get(row.provisioned_session_id, row.user_id);
      if (session) {
        db.prepare(
          `UPDATE team_member_reservations SET cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
             provision_claim_token = NULL, provision_claim_expires_at = NULL,
             updated_at = ? WHERE id = ? AND status = 'reserved'`,
        ).run(input.at, input.at, row.id);
      } else {
        db.prepare(
          `UPDATE team_member_reservations SET status = 'cancelled', cleanup_completed_at = ?,
             provision_claim_token = NULL, provision_claim_expires_at = NULL,
             updated_at = ? WHERE id = ? AND status = 'reserved'`,
        ).run(input.at, input.at, row.id);
      }
      bumpTeam(input.teamId, input.userId, input.at);
      const updated = db.prepare("SELECT * FROM team_member_reservations WHERE id = ?")
        .get(row.id) as unknown as TeamMemberReservationRow;
      return { reservation: mapTeamMemberReservation(updated), needsRetire: Boolean(session) };
    });
  },

  completeMemberReservationCleanup(input: {
    reservationId: string;
    userId: string;
    sessionId: string;
    at: number;
  }): boolean {
    return runInTransaction(() => {
      if (rowExists("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?", input.sessionId, input.userId)) {
        throw new Error("Provisioned Team Session still exists; cleanup cannot be acknowledged");
      }
      return db.prepare(
        `UPDATE team_member_reservations SET status = 'cancelled', cleanup_completed_at = ?,
           provision_claim_token = NULL, provision_claim_expires_at = NULL,
           updated_at = ? WHERE id = ? AND user_id = ? AND provisioned_session_id = ?
           AND status = 'reserved' AND cleanup_requested_at IS NOT NULL`,
      ).run(input.at, input.at, input.reservationId, input.userId, input.sessionId).changes > 0;
    });
  },

  failProvisioned(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    at: number;
  }): Array<{ reservationId: string; userId: string; sessionId: string }> {
    return runInTransaction(() => {
      const team = ownedTeam(input.userId, input.teamId);
      if (!team || team.owner_session_id !== input.actorSessionId || team.provision_key === null) {
        throw new Error("Owned Team provision operation not found");
      }
      if (team.provision_state === "ready") throw new Error("Active Team provision cannot be rolled back");
      if (team.provision_state !== "failed" || team.status !== "closed") {
        db.prepare(
          `UPDATE teams SET status = 'closed', provision_state = 'failed',
             version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?`,
        ).run(input.at, input.teamId, input.userId);
        closeTeamWork(input.teamId, input.userId, input.at);
      }
      const rows = db.prepare(
        `SELECT * FROM team_member_reservations
         WHERE team_id = ? AND user_id = ? AND status <> 'cancelled'`,
      ).all(input.teamId, input.userId) as unknown as TeamMemberReservationRow[];
      for (const row of rows) {
        const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?")
          .get(row.provisioned_session_id, row.user_id);
        if (session) {
          db.prepare(
            `UPDATE team_member_reservations SET status = 'reserved',
               cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
               provision_claim_token = NULL, provision_claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND status <> 'cancelled'`,
          ).run(input.at, input.at, row.id);
        } else {
          db.prepare(
            `UPDATE team_member_reservations SET status = 'cancelled', cleanup_completed_at = ?,
               provision_claim_token = NULL, provision_claim_expires_at = NULL,
               updated_at = ? WHERE id = ? AND status <> 'cancelled'`,
          ).run(input.at, input.at, row.id);
        }
      }
      return (db.prepare(
        `SELECT id, user_id, provisioned_session_id FROM team_member_reservations
         WHERE team_id = ? AND status = 'reserved' AND cleanup_requested_at IS NOT NULL
         ORDER BY created_at, id`,
      ).all(input.teamId) as unknown as Array<{
        id: string;
        user_id: string;
        provisioned_session_id: string;
      }>).map((row) => ({
        reservationId: row.id,
        userId: row.user_id,
        sessionId: row.provisioned_session_id,
      }));
    });
  },

  addMember(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    member: NewTeamMember;
    at: number;
  }): TeamMember {
    assertTeamRole(input.member.role);
    return runInTransaction(() => {
      const team = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      if (!team || team.status === "closed" || !team.root_agent_id) throw new Error("Open owned Team not found");
      assertTeamRootOpen(team);
      const counts = db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM team_member_history WHERE team_id = ?) AS history,
          (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND status <> 'removed') AS current,
          (SELECT COUNT(*) FROM team_member_reservations
            WHERE team_id = ? AND status = 'reserved' AND cleanup_requested_at IS NULL
              AND expires_at > ?) AS reservations`,
      ).get(input.teamId, input.teamId, input.teamId, input.at) as {
        history: number;
        current: number;
        reservations: number;
      };
      if (Number(counts.current) + Number(counts.reservations) >= TEAM_MAX_MEMBERS) {
        throw new Error(`Team member limit reached (${TEAM_MAX_MEMBERS})`);
      }
      if (Number(counts.history) + Number(counts.reservations) >= TEAM_MAX_MEMBER_HISTORY) {
        throw new Error(`Team member history limit reached (${TEAM_MAX_MEMBER_HISTORY})`);
      }
      ensureTeamMemberRoot(input.member, input.userId, input.at);
      const row = db.prepare(
        `INSERT INTO team_members
           (id, team_id, session_id, agent_id, role, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?) RETURNING *`,
      ).get(
        input.member.id,
        input.teamId,
        input.member.sessionId,
        input.member.agentId,
        input.member.role,
        input.at,
        input.at,
      ) as unknown as TeamMemberRow;
      bumpTeam(input.teamId, input.userId, input.at);
      return mapTeamMember(row);
    });
  },

  transitionMember(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    memberId: string;
    expectedVersion: number;
    nextStatus: TeamMemberStatus;
    role?: string;
    at: number;
  }): TeamMember | null {
    if (input.role !== undefined) assertTeamRole(input.role);
    return runInTransaction(() => {
      const team = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      const member = ownedTeamMember(input.userId, input.teamId, input.memberId);
      if (!team || !member || member.version !== input.expectedVersion) return null;
      if (!TEAM_MEMBER_TRANSITIONS[member.status].has(input.nextStatus)) {
        throw new Error(`invalid Team member transition: ${member.status} -> ${input.nextStatus}`);
      }
      if (team.lead_agent_id === member.agent_id && input.nextStatus !== "active") {
        throw new Error("Select another Team lead before pausing or removing this member");
      }
      if (input.nextStatus === "removed") {
        const open = db.prepare(
          `SELECT COUNT(DISTINCT t.id) AS count FROM team_mail mail
           JOIN runtime_tasks t ON t.id = mail.task_id
           WHERE mail.team_id = ?
             AND (mail.source_member_id = ? OR mail.target_member_id = ?)
             AND t.status NOT IN ('succeeded','failed','cancelled','interrupted')`,
        ).get(input.teamId, member.id, member.id) as { count: number };
        if (Number(open.count) > 0) throw new Error("A Team member with open work cannot be removed");
      }
      const row = db.prepare(
        `UPDATE team_members SET status = ?, role = COALESCE(?, role),
             version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ? AND version = ? AND status = ? RETURNING *`,
      ).get(
        input.nextStatus,
        input.role ?? null,
        input.at,
        input.memberId,
        input.teamId,
        input.expectedVersion,
        member.status,
      ) as TeamMemberRow | undefined;
      if (!row) return null;
      if (input.nextStatus === "removed") {
        db.prepare(
          `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
             claim_expires_at = NULL, version = version + 1, updated_at = ?
           WHERE team_id = ? AND (source_member_id = ? OR target_member_id = ?)
             AND status IN ('queued','claimed')`,
        ).run(input.at, input.teamId, input.memberId, input.memberId);
      }
      bumpTeam(input.teamId, input.userId, input.at);
      return mapTeamMember(row);
    });
  },

  updateMemberRole(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    memberId: string;
    expectedVersion: number;
    role: string;
    at: number;
  }): TeamMember | null {
    assertTeamRole(input.role);
    return runInTransaction(() => {
      assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      const row = db.prepare(
        `UPDATE team_members SET role = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND team_id = ? AND version = ? AND status <> 'removed'
           AND EXISTS (SELECT 1 FROM teams WHERE id = team_members.team_id AND user_id = ?)
         RETURNING *`,
      ).get(
        input.role,
        input.at,
        input.memberId,
        input.teamId,
        input.expectedVersion,
        input.userId,
      ) as TeamMemberRow | undefined;
      if (!row) return null;
      bumpTeam(input.teamId, input.userId, input.at);
      return mapTeamMember(row);
    });
  },

  setLead(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    memberId: string;
    expectedTeamVersion: number;
    at: number;
  }): Team | null {
    return runInTransaction(() => {
      const team = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      const member = ownedTeamMember(input.userId, input.teamId, input.memberId);
      if (!team || !member || member.status !== "active" || member.agent_status === "closed") {
        throw new Error("Team lead must be an active member with an open Session Agent");
      }
      assertTeamRootOpen(team);
      const row = db.prepare(
        `UPDATE teams SET lead_agent_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND status <> 'closed' RETURNING *`,
      ).get(
        member.agent_id,
        input.at,
        input.teamId,
        input.userId,
        input.expectedTeamVersion,
      ) as TeamRow | undefined;
      return row ? mapTeam(row) : null;
    });
  },

  transitionStatus(input: {
    userId: string;
    actorSessionId: string;
    teamId: string;
    expectedVersion: number;
    nextStatus: TeamStatus;
    at: number;
  }): Team | null {
    return runInTransaction(() => {
      const current = assertTeamAdmin(input.userId, input.teamId, input.actorSessionId);
      if (!current || current.version !== input.expectedVersion) return null;
      if (!TEAM_TRANSITIONS[current.status].has(input.nextStatus)) {
        throw new Error(`invalid Team status transition: ${current.status} -> ${input.nextStatus}`);
      }
      if (
        input.nextStatus === "active"
        && !rowExists(
          `SELECT 1 FROM team_members m JOIN agent_nodes a ON a.id = m.agent_id
           WHERE m.team_id = ? AND m.agent_id = ? AND m.status = 'active'
             AND a.id = a.root_agent_id AND a.kind = 'session' AND a.status <> 'closed'`,
          input.teamId,
          current.lead_agent_id ?? "",
        )
      ) throw new Error("An active Team requires an active lead member");
      if (input.nextStatus === "active") assertTeamRootOpen(current);
      const row = db.prepare(
        `UPDATE teams SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND status = ? RETURNING *`,
      ).get(
        input.nextStatus,
        input.at,
        input.teamId,
        input.userId,
        input.expectedVersion,
        current.status,
      ) as TeamRow | undefined;
      if (!row) return null;
      if (input.nextStatus === "closed") {
        closeTeamWork(input.teamId, input.userId, input.at);
        db.prepare(
          `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
             claim_expires_at = NULL, version = version + 1, updated_at = ?
           WHERE team_id = ? AND status IN ('queued','claimed')`,
        ).run(input.at, input.teamId);
      }
      return mapTeam(ownedTeam(input.userId, input.teamId) ?? row);
    });
  },

  assignWork(input: NewTeamWork): { mail: TeamMail; task: RuntimeTask; created: boolean } {
    assertMailIdentity(input.idempotencyKey, "Team mail idempotency key");
    assertBoundedText(input.title, 512, "Team work title");
    assertMailDeadline(input.createdAt, input.deadlineAt);
    assertWorkBudget(input.budget);
    if (input.awaitPolicy !== "background") {
      throw new Error("Team work supports background await only");
    }
    const assignment = encodeJson(input.payload, TASK_PAYLOAD_MAX_BYTES, "Team work payload");
    const write = () => {
      const team = ownedTeam(input.userId, input.teamId);
      const source = ownedTeamMemberBySession(input.userId, input.teamId, input.sourceSessionId);
      const target = ownedTeamMember(input.userId, input.teamId, input.targetMemberId);
      if (!team || !source || !target || !team.root_agent_id) {
        throw new Error("Team work members must belong to the same owned Team");
      }
      const route = parentMailForRoute({
        userId: input.userId,
        teamId: input.teamId,
        sourceMemberId: source.id,
        targetMemberId: input.targetMemberId,
        kind: "work",
        parentMailId: input.parentMailId,
        createdAt: input.createdAt,
        deadlineAt: input.deadlineAt,
        budget: input.budget,
      });
      const routedParentTaskId = route.parent?.task_id ?? undefined;
      if (input.parentTaskId && input.parentTaskId !== routedParentTaskId) {
        throw new Error("Team work parent Task does not match its parent envelope");
      }
      const parentTaskId = input.parentTaskId ?? routedParentTaskId;
      const taskPayload = {
        teamId: input.teamId,
        sourceMemberId: source.id,
        targetMemberId: input.targetMemberId,
        sourceSessionId: source.session_id,
        targetSessionId: target.session_id,
        deadlineAt: input.deadlineAt,
        budget: {
          maxModelCycles: input.budget.maxModelCycles,
          maxTokens: input.budget.maxTokens,
        },
        assignment: JSON.parse(assignment.json) as OrchestrationJson,
      } satisfies OrchestrationJson;
      const expectedPayload = JSON.stringify(taskPayload);
      const existing = db.prepare(
        `SELECT * FROM team_mail
         WHERE team_id = ? AND source_member_id = ? AND idempotency_key = ?`,
      ).get(input.teamId, source.id, input.idempotencyKey) as TeamMailRow | undefined;
      if (existing) {
        if (existing.kind !== "work" || !existing.task_id || existing.target_member_id !== input.targetMemberId) {
          throw new Error("Team work idempotency key conflicts with another envelope");
        }
        const taskRow = db.prepare(
          "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ?",
        ).get(existing.task_id, input.userId) as RuntimeTaskRow | undefined;
        if (!taskRow) throw new Error("Team work idempotency key refers to missing work");
        const same = existing.subject === input.title
          && existing.parent_mail_id === (input.parentMailId ?? null)
          && existing.deadline_at === input.deadlineAt
          && existing.budget_turns === input.budget.maxModelCycles
          && existing.budget_tokens === input.budget.maxTokens
          && taskRow.kind === "team_turn"
          && taskRow.team_id === input.teamId
          && taskRow.title === input.title
          && taskRow.payload_json === expectedPayload
          && taskRow.session_id === target.session_id
          && taskRow.owner_session_id === source.session_id
          && taskRow.owner_turn_id === (input.ownerTurnId ?? null)
          && taskRow.owner_step_id === (input.ownerStepId ?? null)
          && taskRow.agent_id === target.agent_id
          && taskRow.parent_task_id === (parentTaskId ?? null)
          && taskRow.await_policy === input.awaitPolicy
          && taskRow.cancel_policy === input.cancelPolicy
          && taskRow.checkpoint_safe === (input.checkpointSafe ? 1 : 0);
        if (!same) {
          throw new Error("Team work idempotency key conflicts with another assignment");
        }
        return { mail: mapTeamMail(existing), task: mapTask(taskRow), created: false };
      }
      assertActiveTeamRouteLease({
        userId: input.userId,
        teamId: input.teamId,
        sourceSessionId: source.session_id,
        parentMailId: input.parentMailId,
        createdAt: input.createdAt,
        ...(input.activeParentLease ? { lease: input.activeParentLease } : {}),
      });
      assertMemberAvailable(source, "Source");
      assertMemberAvailable(target, "Target");
      assertTeamRootOpen(team);
      if (source.id === target.id) throw new Error("Team work requires two different members");
      if (route.parent) {
        const reserved = db.prepare(
          `UPDATE team_mail
           SET child_reserved_turns = child_reserved_turns + ?,
               child_reserved_tokens = child_reserved_tokens + ?,
               budget_remaining_turns = budget_remaining_turns - ?,
               budget_remaining_tokens = budget_remaining_tokens - ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? AND team_id = ? AND kind = 'work'
             AND budget_remaining_turns >= ? AND budget_remaining_tokens >= ?
           RETURNING id, budget_root_mail_id`,
        ).get(
          input.budget.maxModelCycles,
          input.budget.maxTokens,
          input.budget.maxModelCycles,
          input.budget.maxTokens,
          input.createdAt,
          route.parent.id,
          input.userId,
          input.teamId,
          input.budget.maxModelCycles,
          input.budget.maxTokens,
        ) as { id: string; budget_root_mail_id: string | null } | undefined;
        if (!reserved) throw new Error("Parent Team route has no remaining aggregate budget");
        const rootId = reserved.budget_root_mail_id ?? route.parent.id;
        if (rootId === route.parent.id) {
          const root = db.prepare(
            `UPDATE team_mail SET
               route_reserved_turns = route_reserved_turns + ?,
               route_reserved_tokens = route_reserved_tokens + ?,
               version = version + 1, updated_at = ?
             WHERE id = ? AND user_id = ? AND kind = 'work'
               AND route_used_turns + route_reserved_turns + ? <= budget_turns
               AND route_used_tokens + route_reserved_tokens + ? <= budget_tokens
             RETURNING id`,
          ).get(
            input.budget.maxModelCycles,
            input.budget.maxTokens,
            input.createdAt,
            rootId,
            input.userId,
            input.budget.maxModelCycles,
            input.budget.maxTokens,
          );
          if (!root) throw new Error("Team route aggregate budget was concurrently exhausted");
        }
      }
      const openWork = db.prepare(
        `SELECT COUNT(*) AS count FROM runtime_tasks
         WHERE team_id = ? AND status NOT IN ('succeeded','failed','cancelled','interrupted')`,
      ).get(input.teamId) as { count: number };
      if (Number(openWork.count) >= TEAM_MAX_OPEN_WORK) {
        throw new Error(`Team open work limit reached (${TEAM_MAX_OPEN_WORK})`);
      }
      const task = insertRuntimeTask({
        id: input.taskId,
        userId: input.userId,
        sessionId: target.session_id,
        ownerSessionId: source.session_id,
        ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
        ...(input.ownerStepId ? { ownerStepId: input.ownerStepId } : {}),
        agentId: target.agent_id,
        ...(parentTaskId ? { parentTaskId } : {}),
        teamId: input.teamId,
        kind: "team_turn",
        title: input.title,
        payload: taskPayload,
        awaitPolicy: input.awaitPolicy,
        cancelPolicy: input.cancelPolicy,
        checkpointSafe: input.checkpointSafe,
        createdAt: input.createdAt,
      }, "team");
      const result = insertTeamMail({
        id: input.mailId,
        userId: input.userId,
        teamId: input.teamId,
        sourceSessionId: source.session_id,
        targetMemberId: input.targetMemberId,
        kind: "work",
        subject: input.title,
        payload: { taskId: task.id, title: input.title },
        idempotencyKey: input.idempotencyKey,
        ...(input.parentMailId ? { parentMailId: input.parentMailId } : {}),
        taskId: task.id,
        deadlineAt: input.deadlineAt,
        budget: input.budget,
        createdAt: input.createdAt,
        advanceTeam: false,
      });
      if (!result.created || route.hop !== result.mail.hop) {
        throw new Error("Team work insertion lost its atomic idempotency edge");
      }
      return { mail: result.mail, task, created: true };
    };
    return input.activeParentLease
      ? runInImmediateTransaction(write)
      : runInTransaction(write);
  },
};

function cancelTeamTaskForMail(mail: TeamMailRow, at: number, reason: string): void {
  if (!mail.task_id) return;
  const task = db.prepare(
    "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND team_id = ? AND kind = 'team_turn'",
  ).get(mail.task_id, mail.user_id, mail.team_id) as RuntimeTaskRow | undefined;
  if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return;
  const nextStatus: TaskStatus = task.status === "queued" || task.status === "cancel_requested"
    ? "cancelled"
    : "interrupted";
  const row = db.prepare(
    `UPDATE runtime_tasks SET status = ?, activity = NULL, wait_reason = NULL,
       lease_generation = lease_generation + 1, version = version + 1,
       updated_at = ?, settled_at = ?
     WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? AND status = ?
     RETURNING *`,
  ).get(
    nextStatus,
    at,
    at,
    task.id,
    task.user_id,
    task.version,
    task.lease_generation,
    task.status,
  ) as RuntimeTaskRow | undefined;
  if (!row) return;
  appendEventEncoded(
    row.id,
    row.version,
    row.lease_generation,
    `team:${reason}:${nextStatus}`,
    encodeJson({ mailId: mail.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
    at,
  );
  const resultId = `result_team_cancel_${row.id}`;
  db.prepare(
    `INSERT OR IGNORE INTO task_results
       (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, '[]', 1, ?, NULL)`,
  ).run(
    resultId,
    row.id,
    `Team work ended before execution (${reason}).`,
    JSON.stringify({ reason, mailId: mail.id }),
    at,
  );
  const versioned = db.prepare(
    `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
  ).get(at, row.id, row.user_id, row.version) as RuntimeTaskRow | undefined;
  if (!versioned) throw new Error("Team cancellation result version edge was lost");
  appendEventEncoded(
    versioned.id,
    versioned.version,
    versioned.lease_generation,
    "result:stored",
    encodeJson({ resultId }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
    at,
  );
  bumpTaskProjections(versioned, at);
}

function recoverTeamMailLeases(input: {
  userId: string;
  at: number;
  targetSessionId?: string;
  mailId?: string;
}): { requeued: number; cancelled: number } {
  const targetClause = `${input.targetSessionId ? " AND target_session_id = ?" : ""}${input.mailId ? " AND id = ?" : ""}`;
  const values = [
    ...(input.targetSessionId ? [input.targetSessionId] : []),
    ...(input.mailId ? [input.mailId] : []),
  ];
  const outcomes = db.prepare(
    `SELECT task_id FROM team_mail
     WHERE user_id = ?${targetClause} AND kind = 'work' AND status IN ('queued','claimed')
       AND task_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM team_turn_outcomes outcome WHERE outcome.task_id = team_mail.task_id
       )`,
  ).all(input.userId, ...values) as unknown as Array<{ task_id: string }>;
  for (const outcome of outcomes) {
    settleTeamOutcomeInTransaction({
      userId: input.userId,
      taskId: outcome.task_id,
      resultId: deterministicTeamResultId(outcome.task_id),
      at: input.at,
    });
  }
  db.prepare(
    `DELETE FROM team_mail_claims
     WHERE mail_id IN (
       SELECT mail.id FROM team_mail mail
       WHERE mail.user_id = ?${targetClause} AND mail.kind = 'work'
         AND mail.status = 'claimed' AND mail.claim_expires_at <= ?
         AND mail.task_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_turns turn
           WHERE turn.source = 'team' AND turn.team_task_id = mail.task_id
         )
     )`,
  ).run(input.userId, ...values, input.at);
  const cancelled = db.prepare(
    `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
       claim_expires_at = NULL, version = version + 1, updated_at = ?
     WHERE user_id = ?${targetClause} AND status IN ('queued','claimed')
       AND (deadline_at <= ? OR (
         status = 'claimed' AND claim_expires_at <= ? AND (
           (kind <> 'work' AND claim_generation >= ?)
           OR (kind = 'work' AND (
             SELECT COUNT(*) FROM team_mail_claims attempts WHERE attempts.mail_id = team_mail.id
           ) >= ?)
         )
       ))
       AND NOT (
         kind = 'work' AND task_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM team_turn_outcomes outcome
           WHERE outcome.task_id = team_mail.task_id
         )
       )
       AND NOT (
         kind = 'work' AND task_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM agent_turns turn
           WHERE turn.source = 'team' AND turn.team_task_id = team_mail.task_id
         )
       ) RETURNING *`,
  ).all(
    input.at,
    input.userId,
    ...values,
    input.at,
    input.at,
    TEAM_MAIL_MAX_CLAIMS,
    TEAM_MAIL_MAX_CLAIMS,
  ) as unknown as TeamMailRow[];
  const requeued = db.prepare(
    `UPDATE team_mail SET status = 'queued', claim_token = NULL,
       claimed_at = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ?
     WHERE user_id = ?${targetClause} AND status = 'claimed'
       AND claim_expires_at <= ? AND (
         (((kind <> 'work' AND claim_generation < ?)
            OR (kind = 'work' AND (
              SELECT COUNT(*) FROM team_mail_claims attempts WHERE attempts.mail_id = team_mail.id
            ) < ?)) AND deadline_at > ?)
         OR (kind = 'work' AND task_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM team_turn_outcomes outcome
           WHERE outcome.task_id = team_mail.task_id
         ))
       )
       AND NOT (
         kind = 'work' AND task_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM agent_turns turn
           WHERE turn.source = 'team' AND turn.team_task_id = team_mail.task_id
         )
       )
     RETURNING *`,
  ).all(
    input.at,
    input.userId,
    ...values,
    input.at,
    TEAM_MAIL_MAX_CLAIMS,
    TEAM_MAIL_MAX_CLAIMS,
    input.at,
  ) as unknown as TeamMailRow[];
  const teams = new Map<string, string>();
  for (const mail of cancelled) {
    teams.set(mail.team_id, mail.user_id);
    cancelTeamTaskForMail(mail, input.at, mail.deadline_at <= input.at ? "deadline" : "delivery_exhausted");
  }
  for (const mail of requeued) {
    teams.set(mail.team_id, mail.user_id);
    if (!mail.task_id || mail.kind !== "work") continue;
    const task = db.prepare(
      "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND team_id = ? AND kind = 'team_turn'",
    ).get(mail.task_id, mail.user_id, mail.team_id) as RuntimeTaskRow | undefined;
    if (!task || task.status === "queued") continue;
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      const hasResult = rowExists("SELECT 1 FROM task_results WHERE task_id = ?", task.id);
      db.prepare(
        `UPDATE team_mail SET status = ?, acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE NULL END,
           version = version + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
      ).run(hasResult ? "acknowledged" : "cancelled", hasResult ? "acknowledged" : "cancelled", input.at, input.at, mail.id);
      continue;
    }
    const nextStatus: TaskStatus = "queued";
    const terminal = false;
    const fenced = db.prepare(
      `UPDATE runtime_tasks SET status = ?, activity = NULL, wait_reason = NULL,
         lease_generation = lease_generation + 1, version = version + 1,
         updated_at = ?, settled_at = ?
       WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
         AND status = ? RETURNING *`,
    ).get(
      nextStatus,
      input.at,
      terminal ? input.at : null,
      task.id,
      task.user_id,
      task.version,
      task.lease_generation,
      task.status,
    ) as RuntimeTaskRow | undefined;
    if (!fenced) continue;
    appendEventEncoded(
      fenced.id,
      fenced.version,
      fenced.lease_generation,
      nextStatus === "queued" ? "team:delivery_requeued" : `team:delivery_${nextStatus}`,
      encodeJson({ mailId: mail.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
      input.at,
    );
    bumpTaskProjections(fenced, input.at);
    if (terminal) {
      db.prepare(
        `UPDATE team_mail SET status = 'cancelled', version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(input.at, mail.id);
    }
  }
  for (const [teamId, userId] of teams) bumpTeam(teamId, userId, input.at);
  return { requeued: requeued.length, cancelled: cancelled.length };
}

function exactTeamWorkMail(userId: string, taskId: string): {
  id: string;
  targetSessionId: string;
} | undefined {
  const row = db.prepare(EXACT_TEAM_WORK_MAIL_SQL).get(taskId, userId) as {
    id: string;
    target_session_id: string;
  } | undefined;
  return row ? { id: row.id, targetSessionId: row.target_session_id } : undefined;
}

export const teamMailDao = {
  remainingWorkBudget(userId: string, mailId: string): TeamWorkBudget | undefined {
    const row = db.prepare(
      `SELECT budget_remaining_turns, budget_remaining_tokens FROM team_mail
       WHERE id = ? AND user_id = ? AND kind = 'work'`,
    ).get(mailId, userId) as {
      budget_remaining_turns: number | null;
      budget_remaining_tokens: number | null;
    } | undefined;
    if (!row || row.budget_remaining_turns == null || row.budget_remaining_tokens == null) return undefined;
    return {
      maxModelCycles: Number(row.budget_remaining_turns),
      maxTokens: Number(row.budget_remaining_tokens),
    };
  },

  listTeamDigests(
    userId: string,
    teamId: string,
    options: TeamMailListOptions = {},
  ): TeamMailDigest[] {
    if (!ownedTeam(userId, teamId)) throw new Error("Owned Team not found");
    const limit = Math.min(TEAM_MAIL_QUERY_MAX, limitOf(options.limit ?? ORCHESTRATION_QUERY_DEFAULT));
    const before = options.before;
    return (db.prepare(
      `SELECT *, 'null' AS payload_json FROM team_mail
       WHERE user_id = ? AND team_id = ?
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      userId,
      teamId,
      before?.createdAt ?? null,
      before?.createdAt ?? 0,
      before?.createdAt ?? 0,
      before?.id ?? "",
      limit,
    ) as unknown as TeamMailRow[]).map(mapTeamMailDigest);
  },
  send(input: NewTeamMail): { mail: TeamMail; created: boolean } {
    if ((input as { kind: TeamMailKind }).kind === "work") {
      throw new Error("work mail must use the atomic Team assignment seam");
    }
    const write = () => insertTeamMail(input);
    return input.activeParentLease
      ? runInImmediateTransaction(write)
      : runInTransaction(write);
  },

  byId(userId: string, id: string): TeamMail | undefined {
    const row = db.prepare("SELECT * FROM team_mail WHERE id = ? AND user_id = ?").get(id, userId) as
      | TeamMailRow
      | undefined;
    return row ? mapTeamMail(row) : undefined;
  },

  byTask(userId: string, taskId: string): TeamMail | undefined {
    const row = db.prepare(
      "SELECT * FROM team_mail WHERE user_id = ? AND task_id = ? AND kind = 'work'",
    ).get(userId, taskId) as TeamMailRow | undefined;
    return row ? mapTeamMail(row) : undefined;
  },

  byIdempotency(
    userId: string,
    teamId: string,
    sourceSessionId: string,
    idempotencyKey: string,
  ): TeamMail | undefined {
    const row = db.prepare(
      `SELECT mail.* FROM team_mail mail
       JOIN teams team ON team.id = mail.team_id AND team.user_id = mail.user_id
       JOIN team_members source
         ON source.id = mail.source_member_id AND source.team_id = mail.team_id
        AND source.session_id = mail.source_session_id
       WHERE mail.user_id = ? AND mail.team_id = ? AND source.session_id = ?
         AND mail.idempotency_key = ?`,
    ).get(userId, teamId, sourceSessionId, idempotencyKey) as TeamMailRow | undefined;
    return row ? mapTeamMail(row) : undefined;
  },

  listInbox(userId: string, targetSessionId: string, options: TeamMailListOptions = {}): TeamMail[] {
    const limit = Math.min(TEAM_MAIL_QUERY_MAX, limitOf(options.limit));
    const statusClause = options.status ? " AND m.status = ?" : "";
    const values = options.status ? [options.status] : [];
    return (db.prepare(
      `SELECT m.* FROM team_mail m
       JOIN teams t ON t.id = m.team_id AND t.user_id = m.user_id
       JOIN team_members recipient
         ON recipient.id = m.target_member_id
        AND recipient.team_id = m.team_id
        AND recipient.session_id = m.target_session_id
       WHERE m.user_id = ? AND m.target_session_id = ?
         AND recipient.status <> 'removed'${statusClause}
         AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ).all(
      userId,
      targetSessionId,
      ...values,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? 0,
      options.before?.createdAt ?? 0,
      options.before?.id ?? "",
      limit,
    ) as unknown as TeamMailRow[]).map(mapTeamMail);
  },

  listInboxDigests(userId: string, targetSessionId: string, options: TeamMailListOptions = {}): TeamMailDigest[] {
    const limit = Math.min(TEAM_MAIL_QUERY_MAX, limitOf(options.limit));
    const statusClause = options.status ? " AND m.status = ?" : "";
    const values = options.status ? [options.status] : [];
    return (db.prepare(
      `SELECT m.*, 'null' AS payload_json FROM team_mail m
       JOIN team_members recipient ON recipient.id = m.target_member_id AND recipient.team_id = m.team_id
       WHERE m.user_id = ? AND m.target_session_id = ? AND recipient.status <> 'removed'${statusClause}
         AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ).all(
      userId,
      targetSessionId,
      ...values,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? 0,
      options.before?.createdAt ?? 0,
      options.before?.id ?? "",
      limit,
    ) as unknown as TeamMailRow[]).map(mapTeamMailDigest);
  },

  listOutbox(userId: string, sourceSessionId: string, options: TeamMailListOptions = {}): TeamMail[] {
    const limit = Math.min(TEAM_MAIL_QUERY_MAX, limitOf(options.limit));
    const statusClause = options.status ? " AND status = ?" : "";
    const values = options.status ? [options.status] : [];
    return (db.prepare(
      `SELECT * FROM team_mail
       WHERE user_id = ? AND source_session_id = ?${statusClause}
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      userId,
      sourceSessionId,
      ...values,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? 0,
      options.before?.createdAt ?? 0,
      options.before?.id ?? "",
      limit,
    ) as unknown as TeamMailRow[]).map(mapTeamMail);
  },

  listOutboxDigests(userId: string, sourceSessionId: string, options: TeamMailListOptions = {}): TeamMailDigest[] {
    const limit = Math.min(TEAM_MAIL_QUERY_MAX, limitOf(options.limit));
    const statusClause = options.status ? " AND status = ?" : "";
    const values = options.status ? [options.status] : [];
    return (db.prepare(
      `SELECT team_mail.*, 'null' AS payload_json FROM team_mail
       WHERE user_id = ? AND source_session_id = ?${statusClause}
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(
      userId,
      sourceSessionId,
      ...values,
      options.before?.createdAt ?? null,
      options.before?.createdAt ?? 0,
      options.before?.createdAt ?? 0,
      options.before?.id ?? "",
      limit,
    ) as unknown as TeamMailRow[]).map(mapTeamMailDigest);
  },

  claimNext(input: {
    userId: string;
    targetSessionId: string;
    claimToken: string;
    at: number;
    leaseMs?: number;
  }): TeamMail | undefined {
    assertMailIdentity(input.claimToken, "Team mail claim token");
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError("Team mail lease must be an integer from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      recoverTeamMailLeases({
        userId: input.userId,
        targetSessionId: input.targetSessionId,
        at: input.at,
      });
      const priorAttempt = db.prepare(
        `SELECT c.mail_id, c.claim_generation FROM team_mail_claims c
         JOIN team_mail m ON m.id = c.mail_id
         WHERE m.user_id = ? AND c.target_session_id = ? AND c.claim_token = ?`,
      ).get(input.userId, input.targetSessionId, input.claimToken) as
        | { mail_id: string; claim_generation: number }
        | undefined;
      if (priorAttempt) {
        const retry = db.prepare("SELECT * FROM team_mail WHERE id = ? AND user_id = ?")
          .get(priorAttempt.mail_id, input.userId) as TeamMailRow | undefined;
        if (
          retry?.kind !== "work"
          && retry?.claim_token === input.claimToken
          && retry.claim_generation === priorAttempt.claim_generation
        ) return mapTeamMail(retry);
        return undefined;
      }
      const row = db.prepare(
        `UPDATE team_mail
         SET status = 'claimed', claim_generation = claim_generation + 1,
             claim_token = ?, claimed_at = ?, claim_expires_at = MIN(deadline_at, ?),
             version = version + 1, updated_at = ?
         WHERE id = (
           SELECT m.id FROM team_mail m
           JOIN teams t ON t.id = m.team_id AND t.user_id = m.user_id
           JOIN team_members recipient
             ON recipient.id = m.target_member_id
            AND recipient.team_id = m.team_id
            AND recipient.session_id = m.target_session_id
           JOIN team_members sender
             ON sender.id = m.source_member_id
            AND sender.team_id = m.team_id
            AND sender.session_id = m.source_session_id
           JOIN agent_nodes recipient_agent
             ON recipient_agent.id = recipient.agent_id
            AND recipient_agent.id = recipient_agent.root_agent_id
           JOIN agent_nodes sender_agent
             ON sender_agent.id = sender.agent_id
            AND sender_agent.id = sender_agent.root_agent_id
           JOIN agent_nodes owner_agent ON owner_agent.id = t.root_agent_id
           WHERE m.user_id = ? AND m.target_session_id = ?
             AND m.kind <> 'work'
             AND t.status = 'active' AND recipient.status = 'active' AND sender.status = 'active'
             AND recipient_agent.status <> 'closed' AND sender_agent.status <> 'closed'
             AND owner_agent.status <> 'closed'
             AND EXISTS (
               SELECT 1 FROM team_members lead_member
               JOIN agent_nodes lead_agent ON lead_agent.id = lead_member.agent_id
               WHERE lead_member.team_id = t.id AND lead_member.agent_id = t.lead_agent_id
                 AND lead_member.status = 'active' AND lead_agent.status <> 'closed'
             )
             AND (m.status = 'queued' OR (m.status = 'claimed' AND m.claim_expires_at <= ?))
             AND m.deadline_at > ?
             AND m.claim_generation < ?
           ORDER BY m.created_at ASC, m.id ASC LIMIT 1
         )
         AND (status = 'queued' OR (status = 'claimed' AND claim_expires_at <= ?))
         AND claim_generation < ?
         RETURNING *`,
      ).get(
        input.claimToken,
        input.at,
        input.at + leaseMs,
        input.at,
        input.userId,
        input.targetSessionId,
        input.at,
        input.at,
        TEAM_MAIL_MAX_CLAIMS,
        input.at,
        TEAM_MAIL_MAX_CLAIMS,
      ) as TeamMailRow | undefined;
      if (!row) return undefined;
      db.prepare(
        `INSERT INTO team_mail_claims
           (mail_id, target_session_id, claim_token, claim_generation, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, row.target_session_id, input.claimToken, row.claim_generation, input.at);
      bumpTeam(row.team_id, row.user_id, input.at);
      return mapTeamMail(row);
    });
  },

  claimWork(input: {
    userId: string;
    targetSessionId: string;
    taskId: string;
    claimToken: string;
    at: number;
    leaseMs?: number;
  }): TeamMail | undefined {
    assertMailIdentity(input.claimToken, "Team mail claim token");
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError("Team mail lease must be an integer from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      const workMail = exactTeamWorkMail(input.userId, input.taskId);
      if (!workMail || workMail.targetSessionId !== input.targetSessionId) return undefined;
      recoverTeamMailLeases({ userId: input.userId, mailId: workMail.id, at: input.at });
      const priorAttempt = db.prepare(
        `SELECT claim.mail_id, claim.claim_generation FROM team_mail_claims claim
         JOIN team_mail mail ON mail.id = claim.mail_id
         WHERE mail.user_id = ? AND claim.target_session_id = ? AND claim.claim_token = ?`,
      ).get(input.userId, input.targetSessionId, input.claimToken) as
        | { mail_id: string; claim_generation: number }
        | undefined;
      if (priorAttempt) {
        const retry = db.prepare("SELECT * FROM team_mail WHERE id = ? AND user_id = ?")
          .get(priorAttempt.mail_id, input.userId) as TeamMailRow | undefined;
        if (
          retry?.task_id === input.taskId
          && retry.claim_token === input.claimToken
          && retry.claim_generation === priorAttempt.claim_generation
        ) return mapTeamMail(retry);
        return undefined;
      }
      const row = db.prepare(
        `UPDATE team_mail SET status = 'claimed', claim_generation = claim_generation + 1,
           claim_token = ?, claimed_at = ?, claim_expires_at = MIN(deadline_at, ?),
           version = version + 1, updated_at = ?
         WHERE user_id = ? AND target_session_id = ? AND task_id = ? AND kind = 'work'
           AND status = 'queued' AND deadline_at > ? AND claim_generation < ?
           AND EXISTS (
             SELECT 1 FROM teams team
             JOIN team_members source
               ON source.team_id = team.id AND source.id = team_mail.source_member_id
             JOIN team_members target
               ON target.team_id = team.id AND target.id = team_mail.target_member_id
             WHERE team.id = team_mail.team_id AND team.user_id = team_mail.user_id
               AND team.status = 'active' AND source.status = 'active' AND target.status = 'active'
           ) RETURNING *`,
      ).get(
        input.claimToken,
        input.at,
        input.at + leaseMs,
        input.at,
        input.userId,
        input.targetSessionId,
        input.taskId,
        input.at,
        TEAM_MAIL_MAX_CLAIMS,
      ) as TeamMailRow | undefined;
      if (!row) return undefined;
      db.prepare(
        `INSERT INTO team_mail_claims
           (mail_id, target_session_id, claim_token, claim_generation, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, row.target_session_id, input.claimToken, row.claim_generation, input.at);
      bumpTeam(row.team_id, row.user_id, input.at);
      return mapTeamMail(row);
    });
  },

  renewClaim(input: {
    userId: string;
    targetSessionId: string;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
    leaseMs?: number;
  }): TeamMail | null {
    assertMailIdentity(input.claimToken, "Team mail claim token");
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError("Team mail lease must be an integer from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE team_mail SET claim_expires_at = MIN(deadline_at, ?),
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND target_session_id = ?
           AND kind <> 'work'
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ?
           AND deadline_at > ? AND claim_expires_at > ? RETURNING *`,
      ).get(
        input.at + leaseMs,
        input.at,
        input.mailId,
        input.userId,
        input.targetSessionId,
        input.claimToken,
        input.claimGeneration,
        input.at,
        input.at,
      ) as TeamMailRow | undefined;
      if (!row) return null;
      bumpTeam(row.team_id, row.user_id, input.at);
      return mapTeamMail(row);
    });
  },

  renewWorkClaim(input: {
    userId: string;
    targetSessionId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
    leaseMs?: number;
  }): TeamMail | null {
    assertMailIdentity(input.claimToken, "Team mail claim token");
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError("Team mail lease must be an integer from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE team_mail SET claim_expires_at = MIN(deadline_at, ?),
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND target_session_id = ? AND kind = 'work'
           AND task_id = ?
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ?
           AND deadline_at > ? AND claim_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM runtime_tasks task
             WHERE task.id = team_mail.task_id AND task.user_id = team_mail.user_id
               AND task.kind = 'team_turn' AND task.lease_generation = ?
               AND task.status IN ('starting','running','waiting')
           ) RETURNING *`,
      ).get(
        input.at + leaseMs,
        input.at,
        input.mailId,
        input.userId,
        input.targetSessionId,
        input.taskId,
        input.claimToken,
        input.claimGeneration,
        input.at,
        input.at,
        input.expectedTaskLeaseGeneration,
      ) as TeamMailRow | undefined;
      if (!row) return null;
      bumpTeam(row.team_id, row.user_id, input.at);
      return mapTeamMail(row);
    });
  },

  recoverLeases(userId: string, at: number): { requeued: number; cancelled: number } {
    return runInTransaction(() => recoverTeamMailLeases({ userId, at }));
  },

  acknowledge(input: {
    userId: string;
    targetSessionId: string;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
  }): TeamMail | null {
    assertMailIdentity(input.claimToken, "Team mail claim token");
    if (!Number.isSafeInteger(input.claimGeneration) || input.claimGeneration < 1) {
      throw new RangeError("Team mail claim generation must be a positive integer");
    }
    return runInTransaction(() => {
      const current = db.prepare(
        `SELECT * FROM team_mail
         WHERE id = ? AND user_id = ? AND target_session_id = ?`,
      ).get(input.mailId, input.userId, input.targetSessionId) as TeamMailRow | undefined;
      if (!current || current.kind === "work") return null;
      if (
        current.status === "acknowledged"
        && current.claim_token === input.claimToken
        && current.claim_generation === input.claimGeneration
      ) return mapTeamMail(current);
      const row = db.prepare(
        `UPDATE team_mail
         SET status = 'acknowledged', acknowledged_at = ?, claim_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND target_session_id = ?
           AND kind <> 'work'
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ?
           AND claim_expires_at > ? AND deadline_at > ?
         RETURNING *`,
      ).get(
        input.at,
        input.at,
        input.mailId,
        input.userId,
        input.targetSessionId,
        input.claimToken,
        input.claimGeneration,
        input.at,
        input.at,
      ) as TeamMailRow | undefined;
      if (!row) return null;
      bumpTeam(row.team_id, row.user_id, input.at);
      return mapTeamMail(row);
    });
  },
};

export const teamTurnOutcomeDao = {
  byTask(userId: string, taskId: string): TeamTurnOutcome | undefined {
    const row = db.prepare(
      "SELECT * FROM team_turn_outcomes WHERE user_id = ? AND task_id = ?",
    ).get(userId, taskId) as TeamTurnOutcomeRow | undefined;
    return row ? mapTeamTurnOutcome(row) : undefined;
  },

  record(input: {
    taskId: string;
    userId: string;
    sessionId: string;
    turnId: string;
    taskLeaseGeneration: number;
    mailClaimGeneration: number;
    status: TeamTurnOutcome["status"];
    summary: string;
    body: OrchestrationJson;
    artifacts: OrchestrationJson;
    at: number;
  }): TeamTurnOutcome {
    assertUtf8Bytes(input.summary, TASK_RESULT_SUMMARY_MAX_BYTES, "Team Turn outcome summary");
    const body = encodeJson(input.body, TASK_RESULT_BODY_MAX_BYTES, "Team Turn outcome body");
    const artifacts = encodeJson(input.artifacts, TASK_RESULT_ARTIFACTS_MAX_BYTES, "Team Turn outcome artifacts");
    if (!Number.isSafeInteger(input.taskLeaseGeneration) || input.taskLeaseGeneration < 0
      || !Number.isSafeInteger(input.mailClaimGeneration) || input.mailClaimGeneration < 1) {
      throw new RangeError("Team Turn outcome requires exact durable lease generations");
    }
    const binding = db.prepare(
      `SELECT mail.self_used_model_cycles, mail.self_used_tokens
       FROM runtime_tasks task
       JOIN team_mail mail ON mail.task_id = task.id AND mail.user_id = task.user_id
       WHERE task.id = ? AND task.user_id = ? AND task.session_id = ? AND task.kind = 'team_turn'
         AND task.lease_generation = ? AND mail.kind = 'work'
         AND mail.claim_generation = ?`,
    ).get(
      input.taskId,
      input.userId,
      input.sessionId,
      input.taskLeaseGeneration,
      input.mailClaimGeneration,
    ) as { self_used_model_cycles: number; self_used_tokens: number } | undefined;
    if (!binding) throw new Error("Team Turn outcome lost its exact Task/mail lease");
    const usage = {
      modelCycles: Number(binding.self_used_model_cycles),
      tokens: Number(binding.self_used_tokens),
    };
    const turn = db.prepare(
      `SELECT 1 FROM agent_turns
       WHERE session_id = ? AND id = ? AND source = 'team' AND team_task_id = ?
         AND team_task_lease_generation = ? AND team_mail_claim_generation = ?`,
    ).get(
      input.sessionId,
      input.turnId,
      input.taskId,
      input.taskLeaseGeneration,
      input.mailClaimGeneration,
    );
    if (!turn) throw new Error("Team Turn outcome Agent Turn was not found");
    db.prepare(
      `INSERT INTO team_turn_outcomes
         (task_id, user_id, session_id, turn_id, task_lease_generation,
          mail_claim_generation, status, summary, body_json,
          artifacts_json, model_cycles, tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO NOTHING`,
    ).run(
      input.taskId,
      input.userId,
      input.sessionId,
      input.turnId,
      input.taskLeaseGeneration,
      input.mailClaimGeneration,
      input.status,
      input.summary,
      body.json,
      artifacts.json,
      usage.modelCycles,
      usage.tokens,
      input.at,
      input.at,
    );
    const row = db.prepare("SELECT * FROM team_turn_outcomes WHERE task_id = ?")
      .get(input.taskId) as TeamTurnOutcomeRow | undefined;
    if (!row) throw new Error("Team Turn outcome was not stored");
    const exact = row.user_id === input.userId
      && row.session_id === input.sessionId
      && row.turn_id === input.turnId
      && row.task_lease_generation === input.taskLeaseGeneration
      && row.mail_claim_generation === input.mailClaimGeneration
      && row.status === input.status
      && row.summary === input.summary
      && row.body_json === body.json
      && row.artifacts_json === artifacts.json
      && row.model_cycles === usage.modelCycles
      && row.tokens === usage.tokens;
    if (!exact) throw new Error("Team Turn outcome conflicts with its durable Task binding");
    return mapTeamTurnOutcome(row);
  },
};

export const teamTaskDao = {
  remainingProviderBudget(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
  }): TeamWorkBudget | undefined {
    const row = db.prepare(
      `SELECT mail.budget_remaining_turns, mail.budget_remaining_tokens
       FROM team_mail mail
       JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
       WHERE mail.user_id = ? AND mail.task_id = ? AND mail.kind = 'work'
         AND task.kind = 'team_turn' AND task.status = 'running'
         AND task.lease_generation = ?
         AND mail.id = ? AND mail.status = 'claimed'
         AND mail.claim_token = ? AND mail.claim_generation = ?
         AND mail.claim_expires_at > ? AND mail.deadline_at > ?`,
    ).get(
      input.userId,
      input.taskId,
      input.expectedTaskLeaseGeneration,
      input.mailId,
      input.claimToken,
      input.claimGeneration,
      input.at,
      input.at,
    ) as {
      budget_remaining_turns: number | null;
      budget_remaining_tokens: number | null;
    } | undefined;
    if (!row || row.budget_remaining_turns == null || row.budget_remaining_tokens == null) return undefined;
    return {
      maxModelCycles: Number(row.budget_remaining_turns),
      maxTokens: Number(row.budget_remaining_tokens),
    };
  },

  activeTurnsAffectedBySessionDeletion(
    userId: string,
    sessionId: string,
    limit = ORCHESTRATION_QUERY_MAX,
    afterTaskId = "",
  ): Array<{ taskId: string; sessionId: string; turnId: string; ownerDeleted: boolean }> {
    return (db.prepare(
      `SELECT task.id AS task_id, task.session_id, turn.id AS turn_id,
         CASE WHEN team.owner_session_ref = ? OR team.owner_session_id = ? THEN 1 ELSE 0 END AS owner_deleted
       FROM runtime_tasks task
       JOIN teams team ON team.id = task.team_id AND team.user_id = task.user_id
       JOIN agent_turns turn ON turn.session_id = task.session_id
         AND turn.team_task_id = task.id AND turn.source = 'team'
         AND turn.status = 'in_progress'
       WHERE task.user_id = ? AND task.kind = 'team_turn'
         AND task.id > ?
         AND task.status IN ('starting','running','waiting','cancel_requested')
         AND (
           task.session_id = ? OR task.owner_session_id = ?
           OR team.owner_session_ref = ? OR team.owner_session_id = ?
         )
       ORDER BY task.id LIMIT ?`,
    ).all(
      sessionId,
      sessionId,
      userId,
      afterTaskId,
      sessionId,
      sessionId,
      sessionId,
      sessionId,
      limitOf(limit),
    ) as unknown as Array<{
      task_id: string;
      session_id: string;
      turn_id: string;
      owner_deleted: number;
    }>).map((row) => ({
      taskId: row.task_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      ownerDeleted: row.owner_deleted === 1,
    }));
  },

  attemptMatches(
    userId: string,
    taskId: string,
    taskLeaseGeneration: number,
    mailClaimGeneration: number,
  ): boolean {
    return rowExists(
      `SELECT 1 FROM runtime_tasks task
       JOIN team_mail mail ON mail.task_id = task.id AND mail.user_id = task.user_id
       WHERE task.id = ? AND task.user_id = ? AND task.kind = 'team_turn'
         AND task.lease_generation = ? AND mail.kind = 'work'
         AND mail.claim_generation = ?`,
      taskId,
      userId,
      taskLeaseGeneration,
      mailClaimGeneration,
    );
  },

  usageByTask(userId: string, taskId: string): { modelCycles: number; tokens: number } {
    const row = db.prepare(
      `SELECT self_used_model_cycles, self_used_tokens FROM team_mail
       WHERE user_id = ? AND task_id = ? AND kind = 'work'`,
    ).get(userId, taskId) as {
      self_used_model_cycles: number;
      self_used_tokens: number;
    } | undefined;
    if (!row) throw new Error("Team Task durable usage ledger was not found");
    return {
      modelCycles: Number(row.self_used_model_cycles),
      tokens: Number(row.self_used_tokens),
    };
  },

  recoverAfterRestart(now: number, recoveryId: string): TaskRecoveryResult {
    assertEventType(recoveryId);
    const sessions = db.prepare(
      `SELECT DISTINCT user_id, session_id FROM runtime_tasks
       WHERE kind = 'team_turn' AND status IN ('starting','running','waiting','cancel_requested')`,
    ).all() as unknown as Array<{ user_id: string; session_id: string }>;
    const total: TaskRecoveryResult = { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 };
    for (const row of sessions) {
      const result = this.recoverActiveBySession(row.user_id, row.session_id, now, recoveryId);
      total.interrupted += result.interrupted;
      total.requeued += result.requeued;
      total.waiting += result.waiting;
      total.cancelled += result.cancelled;
    }
    return total;
  },

  sweepBlockedAttempts(now: number, limit = ORCHESTRATION_QUERY_MAX): number {
    return runInTransaction(() => {
      const rows = db.prepare(
        `SELECT mail.*, task.cancel_policy, task.owner_session_id, task.owner_turn_id,
           CASE WHEN task.cancel_policy = 'linked' AND NOT EXISTS (
             SELECT 1 FROM agent_turns live_owner
             WHERE live_owner.session_id = task.owner_session_id
               AND live_owner.id = task.owner_turn_id
               AND live_owner.status = 'in_progress'
           ) THEN 1 ELSE 0 END AS owner_turn_gone
         FROM team_mail mail
         JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
         WHERE mail.kind = 'work' AND mail.status IN ('queued','claimed')
           AND task.kind = 'team_turn'
           AND (
             EXISTS (
               SELECT 1 FROM team_turn_outcomes outcome WHERE outcome.task_id = task.id
             )
             OR NOT EXISTS (
               SELECT 1 FROM agent_turns accepted
               WHERE accepted.source = 'team' AND accepted.team_task_id = task.id
             )
           )
           AND (
             mail.deadline_at <= ?
             OR (mail.status = 'claimed' AND mail.claim_expires_at <= ?)
             OR (
               task.cancel_policy = 'linked' AND NOT EXISTS (
                 SELECT 1 FROM agent_turns owner_turn
                 WHERE owner_turn.session_id = task.owner_session_id
                   AND owner_turn.id = task.owner_turn_id
                   AND owner_turn.status = 'in_progress'
               )
             )
           )
         ORDER BY mail.updated_at ASC, mail.id ASC LIMIT ?`,
      ).all(now, now, limitOf(limit)) as unknown as Array<TeamMailRow & {
        cancel_policy: TaskCancelPolicy;
        owner_turn_gone: number;
      }>;
      let changed = 0;
      for (const mail of rows) {
        if (settleTeamOutcomeInTransaction({
          userId: mail.user_id,
          taskId: mail.task_id!,
          resultId: deterministicTeamResultId(mail.task_id!),
          at: now,
        })) {
          changed += 1;
          continue;
        }
        if (mail.deadline_at <= now || mail.owner_turn_gone === 1) {
          const cancelled = db.prepare(
            `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
               claim_expires_at = NULL, version = version + 1, updated_at = ?
             WHERE id = ? AND user_id = ? AND status IN ('queued','claimed') RETURNING *`,
          ).get(now, mail.id, mail.user_id) as TeamMailRow | undefined;
          if (!cancelled) continue;
          cancelTeamTaskForMail(
            cancelled,
            now,
            mail.deadline_at <= now ? "deadline" : "linked_owner_gone",
          );
          changed += 1;
          continue;
        }
        const recovered = recoverTeamMailLeases({ userId: mail.user_id, mailId: mail.id, at: now });
        changed += recovered.requeued + recovered.cancelled;
      }
      return changed;
    });
  },

  listUnsettledOutcomes(limit = ORCHESTRATION_QUERY_MAX): Array<{ userId: string; taskId: string }> {
    return db.prepare(
      `SELECT task.user_id AS userId, task.id AS taskId
       FROM runtime_tasks task
       JOIN team_turn_outcomes outcome ON outcome.task_id = task.id AND outcome.user_id = task.user_id
       LEFT JOIN task_results result ON result.task_id = task.id
       WHERE task.kind = 'team_turn' AND result.task_id IS NULL
         AND task.status NOT IN ('succeeded','failed','cancelled','interrupted')
       ORDER BY outcome.created_at ASC, task.id ASC LIMIT ?`,
    ).all(limitOf(limit)) as unknown as Array<{ userId: string; taskId: string }>;
  },

  listQueuedUsers(limit = ORCHESTRATION_QUERY_MAX): string[] {
    return (db.prepare(
      `SELECT task.user_id FROM runtime_tasks task
       JOIN team_mail work ON work.task_id = task.id AND work.kind = 'work'
       WHERE task.kind = 'team_turn' AND task.status = 'queued' AND work.status <> 'cancelled'
       GROUP BY task.user_id ORDER BY MIN(task.created_at) ASC LIMIT ?`,
    ).all(limitOf(limit)) as unknown as Array<{ user_id: string }>).map((row) => row.user_id);
  },

  listQueued(userId: string, limit = ORCHESTRATION_QUERY_MAX): RuntimeTask[] {
    return (db.prepare(
      `SELECT task.* FROM runtime_tasks task
       JOIN team_mail work ON work.task_id = task.id AND work.kind = 'work'
       JOIN teams team ON team.id = task.team_id AND team.user_id = task.user_id
       JOIN team_members source
         ON source.id = work.source_member_id AND source.team_id = team.id
       JOIN team_members target
         ON target.id = work.target_member_id AND target.team_id = team.id
       JOIN agent_nodes target_agent
         ON target_agent.id = target.agent_id AND target_agent.id = task.agent_id
        AND target_agent.session_id = task.session_id AND target_agent.id = target_agent.root_agent_id
       JOIN sessions target_session ON target_session.id = task.session_id AND target_session.user_id = task.user_id
       WHERE task.user_id = ? AND task.kind = 'team_turn' AND task.status = 'queued'
         AND work.status <> 'cancelled' AND (
           work.deadline_at > ? OR EXISTS (
             SELECT 1 FROM team_turn_outcomes outcome
             WHERE outcome.task_id = task.id AND outcome.created_at <= work.deadline_at
           )
         )
         AND team.status = 'active' AND source.status = 'active' AND target.status = 'active'
         AND target_agent.status <> 'closed'
         AND target_session.status NOT IN ('running','closed')
         AND NOT EXISTS (
           SELECT 1 FROM pending_messages pending
           WHERE pending.session_id = task.session_id AND pending.consumed = 0
         )
         AND NOT EXISTS (
           SELECT 1 FROM runtime_tasks earlier INDEXED BY idx_runtime_tasks_agent_open
           WHERE earlier.agent_id = task.agent_id AND earlier.agent_ord < task.agent_ord
             AND earlier.status IN (${OPEN_TASK_STATUS_SQL})
         )
       ORDER BY task.created_at ASC, task.id ASC LIMIT ?`,
    ).all(userId, Date.now(), limitOf(limit)) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  listOpenBySession(userId: string, sessionId: string, limit = ORCHESTRATION_QUERY_MAX): RuntimeTask[] {
    return (db.prepare(
      `SELECT * FROM runtime_tasks
       WHERE user_id = ? AND session_id = ? AND kind = 'team_turn'
         AND status NOT IN ('succeeded','failed','cancelled','interrupted')
       ORDER BY agent_ord ASC LIMIT ?`,
    ).all(userId, sessionId, limitOf(limit)) as unknown as RuntimeTaskRow[]).map(mapTask);
  },

  claimWithMail(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    claimToken: string;
    at: number;
    leaseMs: number;
  }): { task: RuntimeTask; mail: TeamMail } | null {
    assertMailIdentity(input.claimToken, "Team work claim token");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 300_000) {
      throw new RangeError("Team work lease must be from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      db.prepare(
        `DELETE FROM team_mail_claims
         WHERE mail_id IN (
           SELECT mail.id FROM team_mail mail
           JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
           WHERE task.id = ? AND task.user_id = ? AND task.kind = 'team_turn'
             AND task.status = 'queued' AND mail.kind = 'work' AND mail.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM agent_turns turn
               WHERE turn.source = 'team' AND turn.team_task_id = task.id
             )
         )`,
      ).run(input.id, input.userId);
      const workMail = exactTeamWorkMail(input.userId, input.id);
      if (!workMail) return null;
      recoverTeamMailLeases({ userId: input.userId, mailId: workMail.id, at: input.at });
      const pair = db.prepare(
        `SELECT task.*, work.id AS work_id FROM runtime_tasks task
         JOIN team_mail work ON work.task_id = task.id AND work.kind = 'work'
         JOIN teams team ON team.id = task.team_id AND team.user_id = task.user_id
         JOIN team_members source ON source.id = work.source_member_id AND source.team_id = team.id
         JOIN team_members target ON target.id = work.target_member_id AND target.team_id = team.id
         JOIN agent_nodes source_agent ON source_agent.id = source.agent_id AND source_agent.id = source_agent.root_agent_id
         JOIN agent_nodes target_agent ON target_agent.id = target.agent_id
           AND target_agent.id = target_agent.root_agent_id AND target_agent.session_id = task.session_id
           AND target.agent_id = task.agent_id
         JOIN sessions target_session ON target_session.id = task.session_id
           AND target_session.user_id = task.user_id
         JOIN agent_nodes owner_agent ON owner_agent.id = team.root_agent_id AND owner_agent.id = owner_agent.root_agent_id
         JOIN team_members lead ON lead.team_id = team.id AND lead.agent_id = team.lead_agent_id
         JOIN agent_nodes lead_agent ON lead_agent.id = lead.agent_id AND lead_agent.id = lead_agent.root_agent_id
         WHERE task.id = ? AND task.user_id = ? AND task.version = ?
           AND task.kind = 'team_turn' AND task.status = 'queued'
           AND work.status = 'queued' AND work.deadline_at > ?
           AND (
             SELECT COUNT(*) FROM team_mail_claims attempts WHERE attempts.mail_id = work.id
           ) < ?
           AND team.status = 'active' AND source.status = 'active' AND target.status = 'active'
           AND lead.status = 'active'
           AND source.session_id = task.owner_session_id AND target.session_id = task.session_id
           AND source_agent.status <> 'closed' AND target_agent.status <> 'closed'
           AND owner_agent.status <> 'closed' AND lead_agent.status <> 'closed'
           AND target_session.status NOT IN ('running','closed')
           AND NOT EXISTS (
             SELECT 1 FROM agent_turns live_turn
             WHERE live_turn.session_id = task.session_id AND live_turn.status = 'in_progress'
           )
           AND NOT EXISTS (
             SELECT 1 FROM runtime_tasks active INDEXED BY idx_runtime_tasks_agent_open
             WHERE active.agent_id = task.agent_id AND active.id <> task.id
               AND active.status IN (${OPEN_TASK_STATUS_SQL})
               AND active.status IN ('starting','running','waiting','cancel_requested')
           )
           AND NOT EXISTS (
             SELECT 1 FROM runtime_tasks earlier INDEXED BY idx_runtime_tasks_agent_open
             WHERE earlier.agent_id = task.agent_id AND earlier.agent_ord < task.agent_ord
               AND earlier.status IN (${OPEN_TASK_STATUS_SQL})
           )
           AND (
             task.cancel_policy <> 'linked'
             OR EXISTS (
               SELECT 1 FROM agent_turns owner_turn
               WHERE owner_turn.session_id = task.owner_session_id
                 AND owner_turn.id = task.owner_turn_id
                 AND owner_turn.status = 'in_progress'
             )
           )`,
      ).get(
        input.id,
        input.userId,
        input.expectedVersion,
        input.at,
        TEAM_MAIL_MAX_CLAIMS,
      ) as (RuntimeTaskRow & { work_id: string }) | undefined;
      if (!pair) return null;
      const task = db.prepare(
        `UPDATE runtime_tasks SET status = 'starting', lease_generation = lease_generation + 1,
           version = version + 1, updated_at = ?, activity = NULL, wait_reason = NULL,
           settled_at = NULL
         WHERE id = ? AND user_id = ? AND version = ? AND status = 'queued' AND kind = 'team_turn'
         RETURNING *`,
      ).get(input.at, input.id, input.userId, input.expectedVersion) as RuntimeTaskRow | undefined;
      if (!task) return null;
      const mail = db.prepare(
        `UPDATE team_mail SET status = 'claimed', claim_generation = ?, claim_token = ?,
           claimed_at = ?, claim_expires_at = MIN(deadline_at, ?),
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND task_id = ? AND kind = 'work'
           AND status = 'queued' AND deadline_at > ? RETURNING *`,
      ).get(
        task.lease_generation,
        input.claimToken,
        input.at,
        input.at + input.leaseMs,
        input.at,
        pair.work_id,
        input.userId,
        task.id,
        input.at,
      ) as TeamMailRow | undefined;
      if (!mail) throw new Error("Team work mail claim projection was lost");
      db.prepare(
        `INSERT INTO team_mail_claims
           (mail_id, target_session_id, claim_token, claim_generation, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(mail.id, mail.target_session_id, input.claimToken, mail.claim_generation, input.at);
      appendEventEncoded(
        task.id,
        task.version,
        task.lease_generation,
        "claimed:team",
        encodeJson({ mailId: mail.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
        input.at,
      );
      bumpTaskProjections(task, input.at);
      return { task: mapTask(task), mail: mapTeamMail(mail) };
    });
  },

  claim(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    at: number;
    eventPayload?: OrchestrationJson;
  }): RuntimeTask | null {
    const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const workMail = exactTeamWorkMail(input.userId, input.id);
      if (!workMail) return null;
      recoverTeamMailLeases({ userId: input.userId, mailId: workMail.id, at: input.at });
      const row = db.prepare(
        `UPDATE runtime_tasks
         SET status = 'starting', lease_generation = lease_generation + 1,
             version = version + 1, updated_at = ?, activity = NULL,
             wait_reason = NULL, settled_at = NULL
         WHERE id = ? AND user_id = ? AND version = ? AND status = 'queued'
           AND kind = 'team_turn'
           AND EXISTS (
             SELECT 1 FROM team_mail work
             JOIN teams team ON team.id = work.team_id AND team.id = runtime_tasks.team_id
             JOIN team_members source
               ON source.id = work.source_member_id AND source.team_id = team.id
              AND source.session_id = runtime_tasks.owner_session_id
             JOIN team_members target
               ON target.id = work.target_member_id AND target.team_id = team.id
              AND target.session_id = runtime_tasks.session_id
              AND target.agent_id = runtime_tasks.agent_id
             JOIN agent_nodes source_agent
               ON source_agent.id = source.agent_id AND source_agent.id = source_agent.root_agent_id
             JOIN agent_nodes target_agent
               ON target_agent.id = target.agent_id AND target_agent.id = target_agent.root_agent_id
             JOIN agent_nodes owner_agent
               ON owner_agent.id = team.root_agent_id AND owner_agent.id = owner_agent.root_agent_id
             JOIN team_members lead
               ON lead.team_id = team.id AND lead.agent_id = team.lead_agent_id
             JOIN agent_nodes lead_agent
               ON lead_agent.id = lead.agent_id AND lead_agent.id = lead_agent.root_agent_id
             WHERE work.task_id = runtime_tasks.id AND work.kind = 'work'
               AND work.status <> 'cancelled' AND work.deadline_at > ?
               AND team.user_id = runtime_tasks.user_id AND team.status = 'active'
               AND source.status = 'active' AND target.status = 'active' AND lead.status = 'active'
               AND source_agent.status <> 'closed' AND target_agent.status <> 'closed'
               AND owner_agent.status <> 'closed' AND lead_agent.status <> 'closed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM runtime_tasks active INDEXED BY idx_runtime_tasks_agent_open
             WHERE active.agent_id = runtime_tasks.agent_id AND active.id <> runtime_tasks.id
               AND active.status IN (${OPEN_TASK_STATUS_SQL})
               AND active.status IN ('starting','running','waiting','cancel_requested')
           )
           AND NOT EXISTS (
             SELECT 1 FROM runtime_tasks earlier INDEXED BY idx_runtime_tasks_agent_open
             WHERE earlier.agent_id = runtime_tasks.agent_id
               AND earlier.agent_ord < runtime_tasks.agent_ord
               AND earlier.status IN (${OPEN_TASK_STATUS_SQL})
           )
           AND (
             runtime_tasks.cancel_policy <> 'linked'
             OR EXISTS (
               SELECT 1 FROM agent_turns owner_turn
               WHERE owner_turn.session_id = runtime_tasks.owner_session_id
                 AND owner_turn.id = runtime_tasks.owner_turn_id
                 AND owner_turn.status = 'in_progress'
             )
           )
         RETURNING *`,
      ).get(input.at, input.id, input.userId, input.expectedVersion, input.at) as RuntimeTaskRow | undefined;
      if (!row) return null;
      appendEventEncoded(row.id, row.version, row.lease_generation, "claimed:team", event, input.at);
      bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  markRunning(input: {
    userId: string;
    taskId: string;
    expectedTaskVersion: number;
    expectedLeaseGeneration: number;
    at: number;
    eventPayload?: OrchestrationJson;
  }): RuntimeTask | null {
    const event = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE runtime_tasks SET status = 'running', activity = 'handoff',
           version = version + 1, updated_at = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND user_id = ? AND kind = 'team_turn'
           AND version = ? AND lease_generation = ? AND status = 'starting'
         RETURNING *`,
      ).get(
        input.at,
        input.at,
        input.taskId,
        input.userId,
        input.expectedTaskVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!row) return null;
      appendEventEncoded(row.id, row.version, row.lease_generation, "team:turn_started", event, input.at);
      bumpTaskProjections(row, input.at);
      return mapTask(row);
    });
  },

  renewAttempt(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
    leaseMs: number;
  }): TeamMail | null {
    assertMailIdentity(input.claimToken, "Team work claim token");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 300_000) {
      throw new RangeError("Team work lease must be from 1000 to 300000 ms");
    }
    return runInTransaction(() => {
      const row = db.prepare(
        `UPDATE team_mail SET claim_expires_at = MIN(deadline_at, ?),
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND task_id = ? AND kind = 'work'
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ?
           AND deadline_at > ? AND claim_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM runtime_tasks task
             WHERE task.id = team_mail.task_id AND task.user_id = team_mail.user_id
               AND task.kind = 'team_turn' AND task.lease_generation = ?
               AND task.status IN ('starting','running','waiting')
           ) RETURNING *`,
      ).get(
        input.at + input.leaseMs,
        input.at,
        input.mailId,
        input.userId,
        input.taskId,
        input.claimToken,
        input.claimGeneration,
        input.at,
        input.at,
        input.expectedTaskLeaseGeneration,
      ) as TeamMailRow | undefined;
      return row ? mapTeamMail(row) : null;
    });
  },

  releaseBusyAttempt(input: {
    userId: string;
    taskId: string;
    expectedTaskVersion: number;
    expectedLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
    reason: "busy" | "gated" | "draining";
  }): { task: RuntimeTask; mail: TeamMail } | null {
    return runInTransaction(() => {
      const task = db.prepare(
        `UPDATE runtime_tasks SET status = 'queued', activity = NULL, wait_reason = NULL,
           lease_generation = lease_generation + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'team_turn'
           AND version = ? AND lease_generation = ? AND status = 'starting'
         RETURNING *`,
      ).get(
        input.at,
        input.taskId,
        input.userId,
        input.expectedTaskVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!task) return null;
      const mail = db.prepare(
        `UPDATE team_mail SET status = 'queued', claim_token = NULL, claim_expires_at = NULL,
           claimed_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND task_id = ? AND kind = 'work'
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ? RETURNING *`,
      ).get(
        input.at,
        input.mailId,
        input.userId,
        input.taskId,
        input.claimToken,
        input.claimGeneration,
      ) as TeamMailRow | undefined;
      if (!mail) throw new Error("Team work mail busy-release edge was lost");
      db.prepare(
        `DELETE FROM team_mail_claims
         WHERE mail_id = ? AND target_session_id = ? AND claim_token = ? AND claim_generation = ?`,
      ).run(mail.id, mail.target_session_id, input.claimToken, input.claimGeneration);
      appendEventEncoded(
        task.id,
        task.version,
        task.lease_generation,
        `team:parked:${input.reason}`,
        encodeJson({ mailId: mail.id }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
        input.at,
      );
      bumpTaskProjections(task, input.at);
      return { task: mapTask(task), mail: mapTeamMail(mail) };
    });
  },

  fenceAttempt(input: {
    userId: string;
    taskId: string;
    expectedTaskVersion: number;
    expectedLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    resultId: string;
    at: number;
    reason: "deadline" | "lease_lost" | "runtime_lost";
  }): { task: RuntimeTask; mail: TeamMail } | null {
    return runInTransaction(() => {
      const task = db.prepare(
        `UPDATE runtime_tasks SET status = 'interrupted', activity = NULL, wait_reason = NULL,
           lease_generation = lease_generation + 1, version = version + 1,
           updated_at = ?, settled_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'team_turn'
           AND version = ? AND lease_generation = ?
           AND status IN ('starting','running','waiting','cancel_requested') RETURNING *`,
      ).get(
        input.at,
        input.at,
        input.taskId,
        input.userId,
        input.expectedTaskVersion,
        input.expectedLeaseGeneration,
      ) as RuntimeTaskRow | undefined;
      if (!task) return null;
      const mail = db.prepare(
        `UPDATE team_mail SET status = 'cancelled', claim_token = NULL, claim_expires_at = NULL,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND task_id = ? AND kind = 'work'
           AND status = 'claimed' AND claim_token = ? AND claim_generation = ? RETURNING *`,
      ).get(
        input.at,
        input.mailId,
        input.userId,
        input.taskId,
        input.claimToken,
        input.claimGeneration,
      ) as TeamMailRow | undefined;
      if (!mail) throw new Error("Team work mail fence edge was lost");
      const summary = input.reason === "deadline"
        ? "Team Turn deadline reached."
        : input.reason === "lease_lost"
          ? "Team Turn execution lease was lost."
          : "Team Turn runtime was lost.";
      db.prepare(
        `INSERT INTO task_results
           (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, '[]', 1, ?, NULL)`,
      ).run(
        input.resultId,
        task.id,
        summary,
        encodeJson({ reason: input.reason }, TASK_RESULT_BODY_MAX_BYTES, "Task result body").json,
        input.at,
      );
      const versioned = db.prepare(
        `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(input.at, task.id, input.userId, task.version) as RuntimeTaskRow | undefined;
      if (!versioned) throw new Error("Team fence result version edge was lost");
      appendEventEncoded(
        versioned.id,
        versioned.version,
        versioned.lease_generation,
        `team:fenced:${input.reason}`,
        encodeJson(
          {
            mailId: mail.id,
            modelCycles: mail.self_used_model_cycles,
            tokens: mail.self_used_tokens,
          },
          TASK_EVENT_PAYLOAD_MAX_BYTES,
          "Task event payload",
        ),
        input.at,
      );
      bumpTaskProjections(versioned, input.at);
      return { task: mapTask(versioned), mail: mapTeamMail(mail) };
    });
  },

  reserveProviderRequest(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    at: number;
  }): { reservedTokens: number } {
    return runInTransaction(() => {
      const mail = db.prepare(
        `SELECT mail.* FROM team_mail mail
         JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
         WHERE mail.user_id = ? AND mail.task_id = ? AND mail.kind = 'work'
           AND task.kind = 'team_turn' AND task.status = 'running'
           AND task.lease_generation = ?
           AND mail.id = ? AND mail.status = 'claimed'
           AND mail.claim_token = ? AND mail.claim_generation = ?
           AND mail.claim_expires_at > ? AND mail.deadline_at > ?`,
      ).get(
        input.userId,
        input.taskId,
        input.expectedTaskLeaseGeneration,
        input.mailId,
        input.claimToken,
        input.claimGeneration,
        input.at,
        input.at,
      ) as TeamMailRow | undefined;
      if (!mail || !mail.budget_root_mail_id || mail.budget_remaining_turns === null
        || mail.budget_remaining_tokens === null || mail.budget_remaining_turns < 1
        || mail.budget_remaining_tokens < 1) {
        throw new Error("Team route has no remaining provider-request budget");
      }
      const reservedTokens = mail.budget_remaining_tokens;
      const charged = db.prepare(
        `UPDATE team_mail SET budget_remaining_turns = budget_remaining_turns - 1,
           budget_remaining_tokens = 0,
           self_used_model_cycles = self_used_model_cycles + 1,
           self_used_tokens = self_used_tokens + ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND budget_remaining_turns >= 1
           AND budget_remaining_tokens = ? RETURNING id`,
      ).get(reservedTokens, input.at, mail.id, input.userId, reservedTokens);
      if (!charged) throw new Error("Team request budget changed during reservation");
      const isRoot = mail.budget_root_mail_id === mail.id;
      const root = db.prepare(
        `UPDATE team_mail SET
           route_used_turns = route_used_turns + 1,
           route_used_tokens = route_used_tokens + ?,
           route_reserved_turns = route_reserved_turns - ?,
           route_reserved_tokens = route_reserved_tokens - ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'work'
           AND route_reserved_turns >= ? AND route_reserved_tokens >= ?
           AND route_used_turns + route_reserved_turns + ? <= budget_turns
           AND route_used_tokens + route_reserved_tokens + ? <= budget_tokens
         RETURNING id`,
      ).get(
        reservedTokens,
        isRoot ? 0 : 1,
        isRoot ? 0 : reservedTokens,
        input.at,
        mail.budget_root_mail_id,
        input.userId,
        isRoot ? 0 : 1,
        isRoot ? 0 : reservedTokens,
        isRoot ? 1 : 0,
        isRoot ? reservedTokens : 0,
      );
      if (!root) throw new Error("Team aggregate budget cannot reserve another provider request");
      return { reservedTokens };
    });
  },

  cancelProviderReservation(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    reservedTokens: number;
    at: number;
  }): void {
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 1) {
      throw new RangeError("Team request cancellation requires its token reservation");
    }
    runInTransaction(() => {
      const mail = db.prepare(
        `SELECT mail.* FROM team_mail mail
         JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
         WHERE mail.user_id = ? AND mail.task_id = ? AND mail.kind = 'work'
           AND task.lease_generation = ? AND task.status = 'running'
           AND mail.id = ? AND mail.status = 'claimed'
           AND mail.claim_token = ? AND mail.claim_generation = ?`,
      ).get(
        input.userId,
        input.taskId,
        input.expectedTaskLeaseGeneration,
        input.mailId,
        input.claimToken,
        input.claimGeneration,
      ) as TeamMailRow | undefined;
      if (!mail?.budget_root_mail_id) throw new Error("Team work budget ledger was not found");
      db.prepare(
        `UPDATE team_mail SET budget_remaining_turns = budget_remaining_turns + 1,
           budget_remaining_tokens = budget_remaining_tokens + ?,
           self_used_model_cycles = self_used_model_cycles - 1,
           self_used_tokens = self_used_tokens - ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(input.reservedTokens, input.reservedTokens, input.at, mail.id, input.userId);
      const isRoot = mail.budget_root_mail_id === mail.id;
      const root = db.prepare(
        `UPDATE team_mail SET route_used_turns = route_used_turns - 1,
           route_used_tokens = route_used_tokens - ?,
           route_reserved_turns = route_reserved_turns + ?,
           route_reserved_tokens = route_reserved_tokens + ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND route_used_turns >= 1
           AND route_used_tokens >= ? RETURNING id`,
      ).get(
        input.reservedTokens,
        isRoot ? 0 : 1,
        isRoot ? 0 : input.reservedTokens,
        input.at,
        mail.budget_root_mail_id,
        input.userId,
        input.reservedTokens,
      );
      if (!root) throw new Error("Team request cancellation lost its root budget ledger");
    });
  },

  reconcileProviderRequest(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    reservedTokens: number;
    actualTokens: number;
    at: number;
  }): { overBudget: boolean } {
    if (!Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 1
      || !Number.isSafeInteger(input.actualTokens) || input.actualTokens < 0) {
      throw new RangeError("Team provider usage must be a non-negative integer");
    }
    const refund = input.reservedTokens - input.actualTokens;
    return runInTransaction(() => {
      const mail = db.prepare(
        `SELECT mail.* FROM team_mail mail
         JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
         WHERE mail.user_id = ? AND mail.task_id = ? AND mail.kind = 'work'
           AND task.lease_generation = ? AND task.status = 'running'
           AND mail.id = ? AND mail.status = 'claimed'
           AND mail.claim_token = ? AND mail.claim_generation = ?`,
      ).get(
        input.userId,
        input.taskId,
        input.expectedTaskLeaseGeneration,
        input.mailId,
        input.claimToken,
        input.claimGeneration,
      ) as TeamMailRow | undefined;
      if (!mail?.budget_root_mail_id) throw new Error("Team work budget ledger was not found");
      if (refund === 0) return { overBudget: false };
      if (refund < 0) {
        const overage = -refund;
        const charged = db.prepare(
          `UPDATE team_mail SET self_used_tokens = self_used_tokens + ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? RETURNING id`,
        ).get(overage, input.at, mail.id, input.userId);
        if (!charged) throw new Error("Team provider overage lost its Task usage ledger");
        const root = db.prepare(
          `UPDATE team_mail SET route_used_tokens = route_used_tokens + ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? RETURNING id`,
        ).get(overage, input.at, mail.budget_root_mail_id, input.userId);
        if (!root) throw new Error("Team provider overage lost its route usage ledger");
        return { overBudget: true };
      }
      db.prepare(
        `UPDATE team_mail SET budget_remaining_tokens = budget_remaining_tokens + ?,
           self_used_tokens = self_used_tokens - ?,
           version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).run(refund, refund, input.at, mail.id, input.userId);
      const isRoot = mail.budget_root_mail_id === mail.id;
      const root = db.prepare(
        `UPDATE team_mail SET route_used_tokens = route_used_tokens - ?,
           route_reserved_tokens = route_reserved_tokens + ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND route_used_tokens >= ? RETURNING id`,
      ).get(
        refund,
        isRoot ? 0 : refund,
        input.at,
        mail.budget_root_mail_id,
        input.userId,
        refund,
      );
      if (!root) throw new Error("Team provider budget refund lost its root ledger");
      return { overBudget: false };
    });
  },

  consumeRouteBudget(input: {
    userId: string;
    taskId: string;
    modelCycles: number;
    tokens: number;
    at: number;
  }): { remaining: TeamWorkBudget } | null {
    if (!Number.isSafeInteger(input.modelCycles) || input.modelCycles < 0) {
      throw new RangeError("Team model-cycle charge must be a non-negative integer");
    }
    if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) {
      throw new RangeError("Team token charge must be a non-negative integer");
    }
    if (input.modelCycles === 0 && input.tokens === 0) return null;
    return runInTransaction(() => {
      const mail = db.prepare(
        `SELECT mail.* FROM team_mail mail
         JOIN runtime_tasks task ON task.id = mail.task_id AND task.user_id = mail.user_id
         WHERE mail.user_id = ? AND mail.task_id = ? AND mail.kind = 'work'
           AND task.kind = 'team_turn' AND task.status IN ('starting','running','waiting','cancel_requested')`,
      ).get(input.userId, input.taskId) as TeamMailRow | undefined;
      if (!mail || !mail.budget_root_mail_id) return null;
      const charged = db.prepare(
        `UPDATE team_mail SET
           budget_remaining_turns = budget_remaining_turns - ?,
           budget_remaining_tokens = budget_remaining_tokens - ?,
           self_used_model_cycles = self_used_model_cycles + ?,
           self_used_tokens = self_used_tokens + ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'work'
           AND budget_remaining_turns >= ? AND budget_remaining_tokens >= ?
         RETURNING budget_remaining_turns, budget_remaining_tokens`,
      ).get(
        input.modelCycles,
        input.tokens,
        input.modelCycles,
        input.tokens,
        input.at,
        mail.id,
        input.userId,
        input.modelCycles,
        input.tokens,
      ) as { budget_remaining_turns: number; budget_remaining_tokens: number } | undefined;
      if (!charged) throw new Error("Team route execution budget was exhausted");
      const isRoot = mail.budget_root_mail_id === mail.id;
      const root = db.prepare(
        `UPDATE team_mail SET
           route_used_turns = route_used_turns + ?,
           route_used_tokens = route_used_tokens + ?,
           route_reserved_turns = route_reserved_turns - ?,
           route_reserved_tokens = route_reserved_tokens - ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'work'
           AND route_reserved_turns >= ? AND route_reserved_tokens >= ?
           AND route_used_turns + route_reserved_turns + ? <= budget_turns
           AND route_used_tokens + route_reserved_tokens + ? <= budget_tokens
         RETURNING id`,
      ).get(
        input.modelCycles,
        input.tokens,
        isRoot ? 0 : input.modelCycles,
        isRoot ? 0 : input.tokens,
        input.at,
        mail.budget_root_mail_id,
        input.userId,
        isRoot ? 0 : input.modelCycles,
        isRoot ? 0 : input.tokens,
        isRoot ? input.modelCycles : 0,
        isRoot ? input.tokens : 0,
      );
      if (!root) throw new Error("Team aggregate route budget was exhausted");
      return {
        remaining: {
          maxModelCycles: Number(charged.budget_remaining_turns),
          maxTokens: Number(charged.budget_remaining_tokens),
        },
      };
    });
  },

  settleOutcome(input: {
    userId: string;
    taskId: string;
    resultId: string;
    at: number;
  }): { task: RuntimeTask; result: TaskResult; mail: TeamMail } | null {
    return runInTransaction(() => settleTeamOutcomeInTransaction(input));
  },

  settleWithResultAndMail(input: {
    userId: string;
    taskId: string;
    expectedTaskVersion: number;
    expectedLeaseGeneration: number;
    nextStatus: "succeeded" | "failed" | "cancelled" | "interrupted";
    resultId: string;
    summary: string;
    body: OrchestrationJson;
    artifacts: OrchestrationJson;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
    completedAt: number;
    usage: { modelCycles: number; tokens: number };
    at: number;
    eventPayload?: OrchestrationJson;
  }): { task: RuntimeTask; result: TaskResult; mail: TeamMail } | null {
    assertUtf8Bytes(input.summary, TASK_RESULT_SUMMARY_MAX_BYTES, "Task result summary");
    if (!Number.isSafeInteger(input.completedAt) || input.completedAt < 0) {
      throw new RangeError("Team Turn completion time must be a safe integer");
    }
    if (!Number.isSafeInteger(input.usage.modelCycles) || input.usage.modelCycles < 0
      || !Number.isSafeInteger(input.usage.tokens) || input.usage.tokens < 0) {
      throw new RangeError("Team Turn usage must contain non-negative integers");
    }
    const body = encodeJson(input.body, TASK_RESULT_BODY_MAX_BYTES, "Task result body");
    const artifacts = encodeJson(input.artifacts, TASK_RESULT_ARTIFACTS_MAX_BYTES, "Task result artifacts");
    const statusEvent = encodeJson(input.eventPayload ?? {}, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload");
    return runInTransaction(() => {
      const current = db.prepare(
        "SELECT * FROM runtime_tasks WHERE id = ? AND user_id = ? AND kind = 'team_turn'",
      ).get(input.taskId, input.userId) as RuntimeTaskRow | undefined;
      if (
        !current
        || current.version !== input.expectedTaskVersion
        || current.lease_generation !== input.expectedLeaseGeneration
      ) return null;
      if (!TASK_TRANSITIONS[current.status].has(input.nextStatus)) {
        throw new Error(`invalid Team Task settlement: ${current.status} -> ${input.nextStatus}`);
      }
      const mail = db.prepare(
        `SELECT * FROM team_mail
         WHERE id = ? AND user_id = ? AND task_id = ? AND team_id = ? AND kind = 'work'
           AND target_session_id = ? AND status = 'claimed'
           AND claim_token = ? AND claim_generation = ?
           AND deadline_at >= ?`,
      ).get(
        input.mailId,
        input.userId,
        current.id,
        current.team_id,
        current.session_id,
        input.claimToken,
        input.claimGeneration,
        input.completedAt,
      ) as TeamMailRow | undefined;
      if (!mail) return null;
      const terminal = db.prepare(
        `UPDATE runtime_tasks SET status = ?, activity = NULL, wait_reason = NULL,
           version = version + 1, updated_at = ?, settled_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? AND status = ?
         RETURNING *`,
      ).get(
        input.nextStatus,
        input.at,
        input.at,
        current.id,
        input.userId,
        current.version,
        current.lease_generation,
        current.status,
      ) as RuntimeTaskRow | undefined;
      if (!terminal) return null;
      appendEventEncoded(
        terminal.id,
        terminal.version,
        terminal.lease_generation,
        `team:turn_${input.nextStatus}`,
        statusEvent,
        input.at,
      );
      db.prepare(
        `INSERT INTO task_results
           (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      ).run(input.resultId, terminal.id, input.summary, body.json, artifacts.json, input.at);
      const versioned = db.prepare(
        `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ? RETURNING *`,
      ).get(
        input.at,
        terminal.id,
        input.userId,
        terminal.version,
        terminal.lease_generation,
      ) as RuntimeTaskRow | undefined;
      if (!versioned) throw new Error("Team Task result version edge was lost");
      appendEventEncoded(
        versioned.id,
        versioned.version,
        versioned.lease_generation,
        "result:stored",
        encodeJson({ resultId: input.resultId }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
        input.at,
      );
      const acknowledged = db.prepare(
        `UPDATE team_mail SET status = 'acknowledged', acknowledged_at = ?,
           claim_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'claimed'
           AND claim_token = ? AND claim_generation = ? RETURNING *`,
      ).get(
        input.at,
        input.at,
        mail.id,
        input.userId,
        input.claimToken,
        input.claimGeneration,
      ) as TeamMailRow | undefined;
      if (!acknowledged) throw new Error("Team mail acknowledgement edge was lost");
      bumpTaskProjections(versioned, input.at);
      const result = db.prepare("SELECT * FROM task_results WHERE task_id = ?")
        .get(versioned.id) as unknown as TaskResultRow;
      return { task: mapTask(versioned), result: mapResult(result), mail: mapTeamMail(acknowledged) };
    });
  },

  recoverActiveBySession(
    userId: string,
    sessionId: string,
    now: number,
    recoveryId: string,
  ): TaskRecoveryResult {
    assertEventType(recoveryId);
    return runInTransaction(() => {
      const recovered: TaskRecoveryResult = { interrupted: 0, requeued: 0, waiting: 0, cancelled: 0 };
      const rows = db.prepare(
        `SELECT * FROM runtime_tasks
         WHERE user_id = ? AND session_id = ? AND kind = 'team_turn'
           AND status IN ('starting','running','waiting','cancel_requested')
         ORDER BY updated_at ASC, id ASC`,
      ).all(userId, sessionId) as unknown as RuntimeTaskRow[];
      for (const current of rows) {
        if (settleTeamOutcomeInTransaction({
          userId,
          taskId: current.id,
          resultId: deterministicTeamResultId(current.id),
          at: now,
        })) continue;
        const acceptedTurn = db.prepare(
          `SELECT id, session_id, status, started_at FROM agent_turns
           WHERE team_task_id = ? AND source = 'team'`,
        ).get(
          current.id,
        ) as { id: string; session_id: string; status: string; started_at: number } | undefined;
        const wasAccepted = Boolean(acceptedTurn);
        const nextStatus: TaskStatus = !wasAccepted
          ? "queued"
          : current.status === "cancel_requested"
            ? "cancelled"
            : "interrupted";
        const terminal = wasAccepted;
        const row = db.prepare(
          `UPDATE runtime_tasks SET status = ?, activity = NULL,
             wait_reason = CASE WHEN ? = 'waiting' THEN wait_reason ELSE NULL END,
             lease_generation = lease_generation + 1, version = version + 1,
             updated_at = ?, settled_at = ?
           WHERE id = ? AND user_id = ? AND version = ? AND lease_generation = ?
             AND status IN ('starting','running','waiting','cancel_requested') RETURNING *`,
        ).get(
          nextStatus,
          nextStatus,
          now,
          terminal ? now : null,
          current.id,
          userId,
          current.version,
          current.lease_generation,
        ) as RuntimeTaskRow | undefined;
        if (!row) continue;
        db.prepare(
          `UPDATE team_mail SET status = ?, claim_token = NULL, claim_expires_at = NULL,
             claimed_at = CASE WHEN ? = 'queued' THEN NULL ELSE claimed_at END,
             version = version + 1, updated_at = ?
           WHERE task_id = ? AND user_id = ? AND kind = 'work'
             AND status IN ('queued','claimed')`,
        ).run(
          nextStatus === "queued" ? "queued" : "cancelled",
          nextStatus,
          now,
          row.id,
          userId,
        );
        if (!wasAccepted) {
          db.prepare(
            `DELETE FROM team_mail_claims WHERE mail_id IN (
               SELECT id FROM team_mail WHERE user_id = ? AND task_id = ? AND kind = 'work'
             )`,
          ).run(userId, row.id);
        }
        let projected = row;
        if (terminal) {
          if (acceptedTurn?.status === "in_progress") {
            db.prepare(
              `UPDATE agent_turns SET status = 'interrupted', completed_at = ?,
                 duration_ms = MAX(0, ? - started_at)
               WHERE session_id = ? AND id = ? AND status = 'in_progress'`,
            ).run(now, now, acceptedTurn.session_id, acceptedTurn.id);
            db.prepare(
              `UPDATE sessions SET status = 'idle', updated_at = ?
               WHERE id = ? AND status = 'running'
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_turns live
                   WHERE live.session_id = sessions.id AND live.status = 'in_progress'
                 )`,
            ).run(now, acceptedTurn.session_id);
          }
          const resultId = deterministicTeamResultId(row.id);
          db.prepare(
            `INSERT OR IGNORE INTO task_results
               (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
             VALUES (?, ?, ?, ?, '[]', 1, ?, NULL)`,
          ).run(
            resultId,
            row.id,
            nextStatus === "cancelled"
              ? "Team Turn was cancelled during runtime recovery."
              : "Team Turn was interrupted during runtime recovery.",
            encodeJson(
              { recoveryId, previousStatus: current.status },
              TASK_RESULT_BODY_MAX_BYTES,
              "Task result body",
            ).json,
            now,
          );
          const versioned = db.prepare(
            `UPDATE runtime_tasks SET version = version + 1, updated_at = ?
             WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
          ).get(now, row.id, userId, row.version) as RuntimeTaskRow | undefined;
          if (!versioned) throw new Error("Team recovery result version edge was lost");
          projected = versioned;
          appendEventEncoded(
            projected.id,
            projected.version,
            projected.lease_generation,
            "result:stored",
            encodeJson({ resultId }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
            now,
          );
        }
        appendEventEncoded(
          projected.id,
          projected.version,
          projected.lease_generation,
          `team:recovered:${nextStatus}`,
          encodeJson({ recoveryId, previousStatus: current.status }, TASK_EVENT_PAYLOAD_MAX_BYTES, "Task event payload"),
          now,
        );
        bumpTaskProjections(projected, now);
        if (nextStatus === "queued") recovered.requeued += 1;
        else if (nextStatus === "cancelled") recovered.cancelled += 1;
        else recovered.interrupted += 1;
      }
      recoverTeamMailLeases({ userId, targetSessionId: sessionId, at: now });
      return recovered;
    });
  },
};
