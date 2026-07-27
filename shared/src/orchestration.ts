export type OrchestrationJson =
  | null
  | boolean
  | number
  | string
  | OrchestrationJson[]
  | { [key: string]: OrchestrationJson };

export type AgentNodeKind = "session" | "subagent";
export type AgentNodePurpose = "addressable" | "joined_slot";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentNodeStatus =
  | "initializing"
  | "idle"
  | "running"
  | "interrupted"
  | "error"
  | "closed";

export interface AgentNode {
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
  purpose: AgentNodePurpose;
  status: AgentNodeStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskKind = "delegation" | "workflow_node" | "team_turn";
export type TaskAwaitPolicy = "join" | "background";
export type TaskCancelPolicy = "linked" | "detached";
export type TaskWaitReasonCode = "approval" | "dependency" | "resource" | "rate" | "signal" | "other";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskActivityCode =
  | "model"
  | "approval"
  | "handoff"
  | "tool:shell"
  | "tool:read"
  | "tool:write"
  | "tool:search"
  | "tool:browser"
  | "tool:other";

export interface RuntimeTask {
  id: string;
  userId: string;
  sessionId: string;
  ownerSessionId: string;
  ownerTurnId?: string;
  ownerStepId?: string;
  agentId: string;
  agentOrd: number;
  parentTaskId?: string;
  workflowId?: string;
  teamId?: string;
  kind: TaskKind;
  title: string;
  payload: OrchestrationJson;
  status: TaskStatus;
  awaitPolicy: TaskAwaitPolicy;
  cancelPolicy: TaskCancelPolicy;
  checkpointSafe: boolean;
  capabilityContractVersion: number;
  providerTokensUsed: number;
  providerCostUsedMicros: number;
  activity?: TaskActivityCode;
  waitReason?: TaskWaitReasonCode;
  leaseGeneration: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  settledAt?: number;
}

export interface TaskDigest {
  id: string;
  agentId: string;
  parentTaskId?: string;
  title: string;
  status: TaskStatus;
  awaitPolicy: TaskAwaitPolicy;
  activity?: TaskActivityCode;
  waitReason?: TaskWaitReasonCode;
  version: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  resultId?: string;
  unreadResult: boolean;
}

export interface AgentRosterCounts {
  tasks: number;
  activeAgents: number;
  background: number;
  queued: number;
  waiting: number;
  unread: number;
}

export interface TaskEvent {
  taskId: string;
  seq: number;
  taskVersion: number;
  leaseGeneration: number;
  type: string;
  payload: OrchestrationJson;
  createdAt: number;
}

export interface TaskResult {
  id: string;
  taskId: string;
  summary: string;
  body: OrchestrationJson;
  artifacts: OrchestrationJson;
  version: number;
  createdAt: number;
  acknowledgedAt?: number;
}

export type OrchestrationPageCursor = string;

export interface OrchestrationPage<T> {
  items: T[];
  nextCursor?: OrchestrationPageCursor;
}

export interface AgentListItem {
  id: string;
  sessionId?: string;
  rootAgentId: string;
  parentAgentId?: string;
  label?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  kind: AgentNodeKind;
  status: AgentNodeStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentReadDetail extends AgentListItem {
  path: string;
}

export interface TaskResultListItem {
  id: string;
  taskId: string;
  summary: string;
  summaryTruncated?: true;
  version: number;
  createdAt: number;
  acknowledgedAt?: number;
}

export interface RuntimeTaskListItem {
  id: string;
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
  status: TaskStatus;
  awaitPolicy: TaskAwaitPolicy;
  cancelPolicy: TaskCancelPolicy;
  checkpointSafe: boolean;
  activity?: TaskActivityCode;
  waitReason?: TaskWaitReasonCode;
  version: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  settledAt?: number;
  result?: TaskResultListItem;
}

export interface RuntimeTaskReadDetail extends RuntimeTaskListItem {
  payload: OrchestrationJson;
  agentOrd: number;
  leaseGeneration: number;
}

export type TaskResultReadDetail = TaskResult;

export interface OrchestrationActivityItem {
  task: RuntimeTaskListItem;
  agent: Pick<AgentListItem, "id" | "label" | "status">;
}

export interface OrchestrationActivityPage extends OrchestrationPage<OrchestrationActivityItem> {
  revision: number;
  sessions: Array<{ id: string; title: string }>;
}

export interface SessionRunSnapshot {
  sessionId: string;
  rootAgentId?: string;
  revision: number;
  counts: AgentRosterCounts;
  agents: OrchestrationPage<AgentListItem>;
  tasks: OrchestrationPage<RuntimeTaskListItem>;
  latestTeamTask?: RuntimeTaskListItem;
  linkedWorkflows: BoundedOrchestrationItems<WorkflowListItem>;
  teamMemberships: BoundedOrchestrationItems<TeamMembershipListItem>;
}

export type TaskResultAcknowledgeOutcome =
  | {
      ok: true;
      result: TaskResultListItem;
      sessionId: string;
      revision: number;
      activityRevision: number;
    }
  | { ok: false; reason: "not_found" | "version_conflict" };

export type OrchestrationInvalidation =
  | { resource: "activity"; revision: number }
  | { resource: "session_run"; sessionId: string; revision: number }
  | { resource: "workflow"; workflowId: string; version: number }
  | { resource: "team"; teamId: string; version: number };

export interface OrchestrationInvalidationSnapshot {
  stale: true;
  activityRevision: number;
  sessionRuns: Array<{ sessionId: string; revision: number }>;
  truncated: boolean;
}

export type WorkflowStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type WorkflowNodeKind = "work" | "join" | "gate" | "controller";
export type WorkflowNodeStatus =
  | "blocked"
  | "ready"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "cancelling"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";
export type WorkflowEdgeCondition = "success" | "settled";
export type WorkflowEffect =
  | "pure_readonly"
  | "workspace_read"
  | "workspace_write"
  | "network"
  | "unknown";
export type WorkflowCachePolicy = "none" | "evidence";
export type WorkflowAttemptStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type WorkflowAttemptSource = "execution" | "cache";

export interface WorkflowBudget {
  maxNodes: number;
  maxEdges: number;
  maxDepth: number;
  maxAttempts: number;
  maxRuntimeMs: number;
  maxTokens: number;
  maxCostMicros: number;
}

export interface WorkflowNodeDefinition {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  payload: OrchestrationJson;
  effect: WorkflowEffect;
  cachePolicy: WorkflowCachePolicy;
  maxAttempts: number;
  executorAgentId?: string;
  signal?: string;
}

export interface WorkflowEdgeDefinition {
  from: string;
  to: string;
  condition: WorkflowEdgeCondition;
}

export interface Workflow {
  id: string;
  userId: string;
  ownerSessionId: string;
  controllerAgentId?: string;
  name: string;
  status: WorkflowStatus;
  definitionVersion: number;
  graphRevision: number;
  graphSealed: boolean;
  runRevision: number;
  rootAgentId: string;
  budget: WorkflowBudget;
  attemptsUsed: number;
  tokensUsed: number;
  tokensReserved: number;
  costUsedMicros: number;
  costReservedMicros: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  settledAt?: number;
}

export interface WorkflowNode {
  workflowId: string;
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  payload: OrchestrationJson;
  effect: WorkflowEffect;
  cachePolicy: WorkflowCachePolicy;
  status: WorkflowNodeStatus;
  executorAgentId?: string;
  signal?: string;
  depth: number;
  maxAttempts: number;
  attemptCount: number;
  expandedByNodeId?: string;
  outputDigest?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
}

export interface WorkflowEdge extends WorkflowEdgeDefinition {
  workflowId: string;
  createdAt: number;
}

export interface WorkflowAttempt {
  workflowId: string;
  nodeId: string;
  attempt: number;
  taskId: string;
  status: WorkflowAttemptStatus;
  source: WorkflowAttemptSource;
  cacheKey?: string;
  sourceTaskId?: string;
  sourceResultId?: string;
  evidence: OrchestrationJson;
  tokensUsed: number;
  tokensReserved: number;
  costUsedMicros: number;
  costReservedMicros: number;
  deadlineAt?: number;
  createdAt: number;
  settledAt?: number;
}

export interface WorkflowEvent {
  workflowId: string;
  seq: number;
  workflowVersion: number;
  graphRevision: number;
  runRevision: number;
  type: string;
  mutationId?: string;
  requestDigest?: string;
  payload: OrchestrationJson;
  createdAt: number;
}

export type TeamStatus = "active" | "paused" | "closed";

export interface Team {
  id: string;
  userId: string;
  ownerSessionId: string;
  rootAgentId: string;
  ownerAvailable: boolean;
  leadAgentId?: string;
  name: string;
  status: TeamStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type TeamMemberStatus = "active" | "paused" | "removed";

export interface TeamMember {
  id: string;
  teamId: string;
  sessionId: string;
  agentId: string;
  role: string;
  status: TeamMemberStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type TeamMailKind = "note" | "work" | "result" | "ack";
export type TeamMailDeliveryStatus = "queued" | "claimed" | "acknowledged" | "cancelled";

export const TEAM_PROVIDER_MIN_OUTPUT_TOKENS = 16;

export interface TeamWorkBudget {
  maxModelCycles: number;
  maxTokens: number;
}

export interface TeamMail {
  id: string;
  teamId: string;
  seq: number;
  sourceMemberId: string;
  sourceSessionId: string;
  targetMemberId: string;
  targetSessionId: string;
  kind: TeamMailKind;
  subject: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  taskId?: string;
  hop: number;
  deadlineAt: number;
  budget?: TeamWorkBudget;
  childBudgetReserved?: TeamWorkBudget;
  status: TeamMailDeliveryStatus;
  claimGeneration: number;
  claimToken?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  claimExpiresAt?: number;
  acknowledgedAt?: number;
}

export type TeamMailDigest = Omit<TeamMail, "payload"> & { payloadBytes: number };

export interface TeamSnapshot {
  team: Team;
  members: TeamMember[];
  queuedMail: number;
  claimedMail: number;
  openWork: number;
}

export interface BoundedOrchestrationItems<T> {
  items: T[];
  partial: boolean;
}

export interface WorkflowListItem {
  id: string;
  ownerSessionId: string;
  name: string;
  status: WorkflowStatus;
  definitionVersion: number;
  graphRevision: number;
  graphSealed: boolean;
  runRevision: number;
  nodeCount: number;
  completedNodeCount: number;
  activeNodeCount: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  settledAt?: number;
}

export interface WorkflowListPage extends OrchestrationPage<WorkflowListItem> {
  sessions: Array<{ id: string; title: string }>;
}

export interface WorkflowNodeListItem {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  effect: WorkflowEffect;
  cachePolicy: WorkflowCachePolicy;
  status: WorkflowNodeStatus;
  executorAgentId?: string;
  depth: number;
  maxAttempts: number;
  attemptCount: number;
  expandedByNodeId?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
}

export interface WorkflowEdgeListItem {
  from: string;
  to: string;
  condition: WorkflowEdgeCondition;
}

export interface WorkflowReadDetail extends WorkflowListItem {
  controllerAgentId?: string;
  budget: WorkflowBudget;
  attemptsUsed: number;
  tokensUsed: number;
  tokensReserved: number;
  costUsedMicros: number;
  costReservedMicros: number;
  nodes: WorkflowNodeListItem[];
  edges: WorkflowEdgeListItem[];
  nodesPartial: boolean;
  edgesPartial: boolean;
}

export interface TeamListItem {
  id: string;
  ownerSessionId?: string;
  ownerAvailable: boolean;
  name: string;
  status: TeamStatus;
  memberCount: number;
  activeMemberCount: number;
  queuedMail: number;
  claimedMail: number;
  openWork: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamListPage extends OrchestrationPage<TeamListItem> {
  sessions: Array<{ id: string; title: string }>;
}

export interface TeamMemberListItem {
  id: string;
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  role: string;
  status: TeamMemberStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamReadDetail extends TeamListItem {
  leadAgentId?: string;
  members: TeamMemberListItem[];
  membersPartial: boolean;
}

export interface TeamMembershipListItem {
  teamId: string;
  name: string;
  teamStatus: TeamStatus;
  memberId: string;
  role: string;
  memberStatus: TeamMemberStatus;
  memberCount: number;
  unreadMail: number;
  version: number;
  updatedAt: number;
}

export interface TeamMailListItem {
  id: string;
  teamId: string;
  seq: number;
  sourceMemberId: string;
  sourceSessionId: string;
  targetMemberId: string;
  targetSessionId: string;
  kind: TeamMailKind;
  subject: string;
  parentMailId?: string;
  taskId?: string;
  status: TeamMailDeliveryStatus;
  payloadBytes: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  acknowledgedAt?: number;
}

export interface TeamMailReadDetail extends TeamMailListItem {
  payload: OrchestrationJson;
}
