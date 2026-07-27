import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  OrchestrationJson,
  RuntimeTask,
  TaskResult,
  Workflow,
  WorkflowAttempt,
  WorkflowAttemptStatus,
  WorkflowBudget,
  WorkflowCachePolicy,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowEdgeDefinition,
  WorkflowEffect,
  WorkflowEvent,
  WorkflowNode,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
  WorkflowNodeStatus,
  WorkflowStatus,
} from "../../../shared/src/orchestration.ts";
import { db, runInTransaction } from "./core.ts";
import {
  cancelRuntimeTaskInTransaction,
  closeWorkflowExecutorAgentInTransaction,
  completeCachedWorkflowTaskInTransaction,
  createWorkflowRuntimeTaskInTransaction,
  insertWorkflowExecutorAgentsInTransaction,
  settleWorkflowRuntimeTaskResultInTransaction,
  settleWorkflowRuntimeTaskWithoutResultInTransaction,
  taskResultDao,
  type NewAgentNode,
  type SettleRuntimeTaskResultInput,
  type SettleRuntimeTaskWithoutResultInput,
} from "./orchestration.ts";

export const WORKFLOW_NODE_HARD_LIMIT = 64;
export const WORKFLOW_EDGE_HARD_LIMIT = 256;
export const WORKFLOW_DEPTH_HARD_LIMIT = 16;
export const WORKFLOW_ATTEMPT_HARD_LIMIT = 256;
export const WORKFLOW_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
export const WORKFLOW_DEFINITION_MAX_BYTES = 256 * 1024;
export const WORKFLOW_DEFINITION_VERSION_LIMIT = 64;
export const WORKFLOW_NODE_PAYLOAD_MAX_BYTES = 60 * 1024;
export const WORKFLOW_ASSIGNMENT_MAX_BYTES = 32 * 1024;
export const WORKFLOW_DEPENDENCY_HANDLE_LIMIT = 16;
export const WORKFLOW_DEPENDENCY_SUMMARY_MAX_BYTES = 8 * 1024;
export const WORKFLOW_CACHE_CONTRACT_VERSION = 1;
export const WORKFLOW_CACHE_MAX_ENTRIES_PER_USER = 256;
export const WORKFLOW_CAPABILITY_CONTRACT_VERSION = 1;
export const WORKFLOW_ATTEMPT_TOKEN_RESERVATION = 256_000;
export const WORKFLOW_ATTEMPT_COST_RESERVATION_MICROS = 50_000_000;
export const WORKFLOW_EXECUTION_CACHE_ENABLED = false;

export class WorkflowDispatchUnavailableError extends Error {
  override name = "WorkflowDispatchUnavailableError";

  constructor(readonly reason: "node_attempts" | "attempts" | "tokens" | "cost" | "deadline") {
    super(`Workflow dispatch unavailable: ${reason}`);
  }
}

export const DEFAULT_WORKFLOW_BUDGET: Readonly<WorkflowBudget> = Object.freeze({
  maxNodes: 64,
  maxEdges: 256,
  maxDepth: 8,
  maxAttempts: 128,
  maxRuntimeMs: 24 * 60 * 60 * 1_000,
  maxTokens: 2_000_000,
  maxCostMicros: 1_000_000_000,
});

const TERMINAL_NODE_STATUSES = new Set<WorkflowNodeStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

interface WorkflowRow {
  id: string;
  user_id: string;
  owner_session_id: string;
  root_agent_id: string | null;
  controller_agent_id: string | null;
  name: string;
  status: WorkflowStatus;
  definition_version: number;
  graph_revision: number;
  graph_sealed: number;
  run_revision: number;
  max_nodes: number;
  max_edges: number;
  max_depth: number;
  max_attempts: number;
  max_runtime_ms: number;
  max_tokens: number;
  max_cost_micros: number;
  attempts_used: number;
  tokens_used: number;
  tokens_reserved: number;
  cost_used_micros: number;
  cost_reserved_micros: number;
  version: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  settled_at: number | null;
  cancellation_pending: number;
  terminal_intent: "cancelled" | "failed" | null;
}

type WorkflowNodeControlStatus = "blocked" | "ready" | "running" | "waiting"
  | "succeeded" | "failed" | "cancelled";
type WorkflowAttemptControlStatus = "running" | "cancel_requested"
  | "succeeded" | "failed" | "cancelled" | "interrupted";

interface WorkflowNodeRow {
  workflow_id: string;
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  payload_json: string;
  effect: WorkflowEffect;
  cache_policy: WorkflowCachePolicy;
  status: WorkflowNodeControlStatus;
  execution_phase: RuntimeTask["status"] | null;
  executor_agent_id: string | null;
  signal_name: string | null;
  depth: number;
  max_attempts: number;
  attempt_count: number;
  expanded_by_node_id: string | null;
  output_digest: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

interface WorkflowEdgeRow {
  workflow_id: string;
  from_node_id: string;
  to_node_id: string;
  condition: WorkflowEdgeCondition;
  created_at: number;
}

interface WorkflowAttemptRow {
  workflow_id: string;
  node_id: string;
  attempt_no: number;
  task_id: string;
  status: WorkflowAttemptControlStatus;
  execution_phase: RuntimeTask["status"];
  source: "execution" | "cache";
  cache_key: string | null;
  source_task_id: string | null;
  source_result_id: string | null;
  evidence_json: string;
  tokens_used: number;
  tokens_reserved: number;
  cost_used_micros: number;
  cost_reserved_micros: number;
  deadline_at: number | null;
  created_at: number;
  settled_at: number | null;
}

interface WorkflowEventRow {
  workflow_id: string;
  seq: number;
  workflow_version: number;
  graph_revision: number;
  run_revision: number;
  type: string;
  mutation_id: string | null;
  request_digest: string | null;
  payload_json: string;
  created_at: number;
}

interface CacheRow {
  user_id: string;
  cache_key: string;
  contract_version: number;
  summary: string;
  body_json: string;
  artifacts_json: string;
  output_digest: string;
  source_task_id: string;
  created_at: number;
  last_used_at: number;
  hit_count: number;
}

export interface WorkflowSnapshot {
  workflow: Workflow;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  attempts: WorkflowAttempt[];
}

export interface NewWorkflowInput {
  id: string;
  userId: string;
  ownerSessionId: string;
  rootAgentId: string;
  controllerAgentId?: string;
  name: string;
  nodes: readonly WorkflowNodeDefinition[];
  edges: readonly WorkflowEdgeDefinition[];
  budget?: Partial<WorkflowBudget>;
  graphSealed?: boolean;
  createdAt: number;
}

export interface LaunchWorkflowInput extends NewWorkflowInput {
  executors: readonly NewAgentNode[];
  maxTreeAgents: number;
}

export interface ReviseWorkflowInput {
  workflowId: string;
  userId: string;
  expectedVersion: number;
  expectedDefinitionVersion: number;
  nodes: readonly WorkflowNodeDefinition[];
  edges: readonly WorkflowEdgeDefinition[];
  graphSealed?: boolean;
  mutationId?: string;
  at: number;
}

export interface ExpandWorkflowInput {
  workflowId: string;
  userId: string;
  controllerNodeId: string;
  actorTaskId: string;
  actorLeaseGeneration: number;
  expectedGraphRevision: number;
  nodes: readonly WorkflowNodeDefinition[];
  edges: readonly WorkflowEdgeDefinition[];
  executors?: readonly NewAgentNode[];
  maxTreeAgents?: number;
  mutationId?: string;
  at: number;
}

export interface WorkflowCacheEvidence {
  contractVersion?: number;
  nodeSpecDigest: string;
  inputDigest: string;
  dependencyOutputDigests: Readonly<Record<string, string>>;
  executorDigest: string;
}

export interface SealWorkflowInput {
  workflowId: string;
  userId: string;
  controllerNodeId: string;
  actorTaskId: string;
  actorLeaseGeneration: number;
  expectedGraphRevision: number;
  mutationId?: string;
  at: number;
}

export interface WorkflowCacheHit {
  key: string;
  evidence: WorkflowCacheEvidence;
}

export interface WorkflowCacheAttestation {
  pureReadOnly: true;
  observedEffects: "read_only";
  toolContractDigest: string;
}

export interface ClaimWorkflowNodeInput {
  workflowId: string;
  userId: string;
  nodeId: string;
  taskId: string;
  resultId?: string;
  expectedVersion: number;
  cacheEvidence?: WorkflowCacheEvidence;
  cacheHit?: WorkflowCacheHit;
  at: number;
}

export interface WorkflowDispatch {
  workflow: Workflow;
  node: WorkflowNode;
  attempt: WorkflowAttempt;
  task: RuntimeTask;
  result?: TaskResult;
}

export interface WorkflowExecutionSettlement {
  task: RuntimeTask;
  result: TaskResult;
  snapshot: WorkflowSnapshot;
}

export interface WorkflowExecutionTerminalSettlement {
  task: RuntimeTask;
  snapshot: WorkflowSnapshot;
}

export interface SettleWorkflowAttemptInput {
  workflowId: string;
  userId: string;
  nodeId: string;
  taskId: string;
  expectedTaskLeaseGeneration: number;
  expectedVersion: number;
  tokensUsed?: number;
  costUsedMicros?: number;
  cacheAttestation?: WorkflowCacheAttestation;
  recoverMissingResult?: boolean;
  at: number;
}

export interface RecordWorkflowAttemptUsageInput {
  workflowId: string;
  userId: string;
  nodeId: string;
  taskId: string;
  expectedTaskLeaseGeneration: number;
  expectedVersion: number;
  tokensUsed: number;
  costUsedMicros: number;
  at: number;
}

export interface ReadWorkflowDependencyResultInput {
  workflowId: string;
  userId: string;
  actorTaskId: string;
  actorLeaseGeneration: number;
  resultId: string;
}

export interface SettleWorkflowExecutionInput extends Omit<SettleRuntimeTaskResultInput, "userId"> {
  userId: string;
  tokensUsed?: number;
  costUsedMicros?: number;
  cacheAttestation?: WorkflowCacheAttestation;
}

export interface SettleWorkflowExecutionWithoutResultInput
  extends Omit<SettleRuntimeTaskWithoutResultInput, "userId"> {
  userId: string;
  tokensUsed?: number;
  costUsedMicros?: number;
}

export interface WorkflowRecoveryResult {
  unchanged: number;
  reconciled: number;
  retried: number;
  failed: number;
}

export interface WorkflowCoordinatorCursor {
  id: string;
}

export interface WorkflowSchedulerCursor {
  userId: string;
  id: string;
}

export interface WorkflowCancellationTarget {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  workflowId: string;
  taskId: string;
  expectedTaskLeaseGeneration: number;
}

export interface WorkflowAttemptTarget {
  workflowId: string;
  nodeId: string;
  taskId: string;
  taskLeaseGeneration: number;
  taskStatus: RuntimeTask["status"];
  workflowVersion: number;
}

function mapWorkflow(row: WorkflowRow): Workflow {
  if (row.root_agent_id === null) throw new Error("Workflow has no root Agent binding");
  return {
    id: row.id,
    userId: row.user_id,
    ownerSessionId: row.owner_session_id,
    ...(row.controller_agent_id === null ? {} : { controllerAgentId: row.controller_agent_id }),
    name: row.name,
    status: row.cancellation_pending === 1 ? "cancelling" : row.status,
    definitionVersion: Number(row.definition_version),
    graphRevision: Number(row.graph_revision),
    graphSealed: row.graph_sealed === 1,
    runRevision: Number(row.run_revision),
    rootAgentId: row.root_agent_id,
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
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapNode(row: WorkflowNodeRow): WorkflowNode {
  const phaseStatus: WorkflowNodeStatus | undefined = row.status === "running"
    && row.execution_phase !== null
    ? row.execution_phase === "cancel_requested" ? "cancelling" : row.execution_phase
    : undefined;
  return {
    workflowId: row.workflow_id,
    id: row.id,
    name: row.name,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as OrchestrationJson,
    effect: row.effect,
    cachePolicy: row.cache_policy,
    status: phaseStatus ?? row.status,
    ...(row.executor_agent_id === null ? {} : { executorAgentId: row.executor_agent_id }),
    ...(row.signal_name === null ? {} : { signal: row.signal_name }),
    depth: Number(row.depth),
    maxAttempts: Number(row.max_attempts),
    attemptCount: Number(row.attempt_count),
    ...(row.expanded_by_node_id === null ? {} : { expandedByNodeId: row.expanded_by_node_id }),
    ...(row.output_digest === null ? {} : { outputDigest: row.output_digest }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapEdge(row: WorkflowEdgeRow): WorkflowEdge {
  return {
    workflowId: row.workflow_id,
    from: row.from_node_id,
    to: row.to_node_id,
    condition: row.condition,
    createdAt: Number(row.created_at),
  };
}

function mapAttempt(row: WorkflowAttemptRow): WorkflowAttempt {
  return {
    workflowId: row.workflow_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt_no),
    taskId: row.task_id,
    status: row.execution_phase,
    source: row.source,
    ...(row.cache_key === null ? {} : { cacheKey: row.cache_key }),
    ...(row.source_task_id === null ? {} : { sourceTaskId: row.source_task_id }),
    ...(row.source_result_id === null ? {} : { sourceResultId: row.source_result_id }),
    evidence: JSON.parse(row.evidence_json) as OrchestrationJson,
    tokensUsed: Number(row.tokens_used),
    tokensReserved: Number(row.tokens_reserved),
    costUsedMicros: Number(row.cost_used_micros),
    costReservedMicros: Number(row.cost_reserved_micros),
    ...(row.deadline_at === null ? {} : { deadlineAt: Number(row.deadline_at) }),
    createdAt: Number(row.created_at),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
  };
}

function mapEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    workflowId: row.workflow_id,
    seq: Number(row.seq),
    workflowVersion: Number(row.workflow_version),
    graphRevision: Number(row.graph_revision),
    runRevision: Number(row.run_revision),
    type: row.type,
    ...(row.mutation_id === null ? {} : { mutationId: row.mutation_id }),
    ...(row.request_digest === null ? {} : { requestDigest: row.request_digest }),
    payload: JSON.parse(row.payload_json) as OrchestrationJson,
    createdAt: Number(row.created_at),
  };
}

function encodeJson(value: OrchestrationJson, maxBytes: number, field: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable`, { cause: error });
  }
  if (json === undefined) throw new TypeError(`${field} must be JSON serializable`);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return json;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) throw new RangeError(`${field} must be a stable 1 to 128 byte identifier`);
}

function assertName(value: string, field: string, max = 256): void {
  if (!String(value).trim() || Buffer.byteLength(value, "utf8") > max) {
    throw new RangeError(`${field} must contain 1 to ${max} UTF-8 bytes`);
  }
}

function int(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizeBudget(input: Partial<WorkflowBudget> | undefined): WorkflowBudget {
  const budget = { ...DEFAULT_WORKFLOW_BUDGET, ...input };
  return {
    maxNodes: int(budget.maxNodes, "maxNodes", 1, WORKFLOW_NODE_HARD_LIMIT),
    maxEdges: int(budget.maxEdges, "maxEdges", 0, WORKFLOW_EDGE_HARD_LIMIT),
    maxDepth: int(budget.maxDepth, "maxDepth", 0, WORKFLOW_DEPTH_HARD_LIMIT),
    maxAttempts: int(budget.maxAttempts, "maxAttempts", 1, WORKFLOW_ATTEMPT_HARD_LIMIT),
    maxRuntimeMs: int(budget.maxRuntimeMs, "maxRuntimeMs", 1, 7 * 24 * 60 * 60 * 1_000),
    maxTokens: int(budget.maxTokens, "maxTokens", 1, 100_000_000),
    maxCostMicros: int(budget.maxCostMicros, "maxCostMicros", 1, 1_000_000_000_000),
  };
}

function normalizedNode(node: WorkflowNodeDefinition, allowLegacyAssignment = false): WorkflowNodeDefinition {
  assertIdentifier(node.id, "Workflow node id");
  assertName(node.name, "Workflow node name");
  int(node.maxAttempts, "Workflow node maxAttempts", 1, 16);
  encodeJson(node.payload, WORKFLOW_NODE_PAYLOAD_MAX_BYTES, `Workflow node ${node.id} payload`);
  if (node.kind === "gate") {
    if (!node.signal) throw new Error(`Gate node ${node.id} requires a signal`);
    assertIdentifier(node.signal, `Gate node ${node.id} signal`);
  } else if (node.signal !== undefined) {
    throw new Error(`Only gate nodes can declare a signal`);
  }
  if (node.cachePolicy === "evidence" && (node.kind !== "work" || node.effect !== "pure_readonly")) {
    throw new Error("Execution cache requires a pure, read-only work node");
  }
  if (node.cachePolicy === "evidence" && !WORKFLOW_EXECUTION_CACHE_ENABLED) {
    throw new Error("Workflow execution cache requires an isolated trusted executor");
  }
  if ((node.kind === "join" || node.kind === "gate" || node.kind === "controller") && node.cachePolicy !== "none") {
    throw new Error(`${node.kind} nodes cannot use the execution cache`);
  }
  const executable = node.kind === "work" || node.kind === "controller";
  if (executable) {
    if (!node.executorAgentId) throw new Error(`Executable node ${node.id} requires an executor Agent`);
    assertIdentifier(node.executorAgentId, `Workflow node ${node.id} executor Agent`);
    const message = node.payload !== null && !Array.isArray(node.payload) && typeof node.payload === "object"
      ? (node.payload as Record<string, OrchestrationJson>).message
      : undefined;
    const legacyMessage = allowLegacyAssignment
      ? workflowAssignmentMessage(node as WorkflowNode)
      : undefined;
    if ((typeof message !== "string" || !message.trim()) && legacyMessage === undefined) {
      throw new Error(`Executable node ${node.id} requires payload.message`);
    }
    if (
      !allowLegacyAssignment
      && typeof message === "string"
      && Buffer.byteLength(message, "utf8") > WORKFLOW_ASSIGNMENT_MAX_BYTES
    ) {
      throw new RangeError(`Executable node ${node.id} message exceeds ${WORKFLOW_ASSIGNMENT_MAX_BYTES} UTF-8 bytes`);
    }
  } else if (node.executorAgentId !== undefined) {
    throw new Error(`${node.kind} node ${node.id} cannot declare an executor Agent`);
  }
  return {
    ...node,
    name: node.name.trim(),
    ...(node.executorAgentId === undefined ? {} : { executorAgentId: node.executorAgentId }),
    ...(node.signal === undefined ? {} : { signal: node.signal }),
  };
}

function normalizeGraph(
  nodesInput: readonly WorkflowNodeDefinition[],
  edgesInput: readonly WorkflowEdgeDefinition[],
  budget: WorkflowBudget,
  legacyNodeIds: ReadonlySet<string> = new Set(),
): { nodes: WorkflowNodeDefinition[]; edges: WorkflowEdgeDefinition[] } {
  if (nodesInput.length === 0) throw new Error("Workflow graph requires at least one node");
  if (nodesInput.length > budget.maxNodes) throw new RangeError("Workflow node budget exceeded");
  if (edgesInput.length > budget.maxEdges) throw new RangeError("Workflow edge budget exceeded");
  const nodes = nodesInput.map((node) => normalizedNode(node, legacyNodeIds.has(node.id)));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate Workflow node ${node.id}`);
    ids.add(node.id);
  }
  const edgeKeys = new Set<string>();
  const edges = edgesInput.map((edge) => {
    assertIdentifier(edge.from, "Workflow edge source");
    assertIdentifier(edge.to, "Workflow edge target");
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error("Workflow edge endpoint does not exist");
    if (edge.from === edge.to) throw new Error("Workflow graph cannot contain a self edge");
    const key = `${edge.from}\0${edge.to}`;
    if (edgeKeys.has(key)) throw new Error(`Duplicate Workflow edge ${edge.from} -> ${edge.to}`);
    edgeKeys.add(key);
    return { ...edge };
  });
  const depth = graphDepth(ids, edges);
  if (depth > budget.maxDepth) throw new RangeError("Workflow graph depth budget exceeded");
  assertDependencyHandleBudget(nodes, edges, legacyNodeIds);
  return { nodes, edges };
}

function assertDependencyHandleBudget(
  nodes: readonly WorkflowNodeDefinition[],
  edges: readonly WorkflowEdgeDefinition[],
  legacyNodeIds: ReadonlySet<string>,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const values = incoming.get(edge.to) ?? [];
    values.push(edge.from);
    incoming.set(edge.to, values);
  }
  const memo = new Map<string, ReadonlySet<string>>();
  const ancestors = (id: string): ReadonlySet<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const values = new Set<string>();
    for (const parentId of incoming.get(id) ?? []) {
      const parent = byId.get(parentId)!;
      if (parent.kind === "work" || parent.kind === "controller") values.add(parentId);
      for (const ancestor of ancestors(parentId)) values.add(ancestor);
    }
    memo.set(id, values);
    return values;
  };
  for (const node of nodes) {
    if (node.kind !== "work" && node.kind !== "controller") continue;
    if (legacyNodeIds.has(node.id)) continue;
    if (ancestors(node.id).size > WORKFLOW_DEPENDENCY_HANDLE_LIMIT) {
      throw new RangeError(
        `Executable node ${node.id} exceeds the ${WORKFLOW_DEPENDENCY_HANDLE_LIMIT} dependency handle limit`,
      );
    }
  }
}

function assertGraphCanRemainOpen(nodes: readonly WorkflowNodeDefinition[], sealed: boolean): void {
  if (!sealed && !nodes.some((node) => node.kind === "controller")) {
    throw new Error("An open Workflow graph requires a controller node");
  }
}

function graphDepth(ids: ReadonlySet<string>, edges: readonly WorkflowEdgeDefinition[]): number {
  const indegree = new Map<string, number>(Array.from(ids, (id) => [id, 0]));
  const out = new Map<string, string[]>();
  const depth = new Map<string, number>(Array.from(ids, (id) => [id, 0]));
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }
  const queue = Array.from(indegree).filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of out.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1));
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) queue.push(target);
    }
    queue.sort();
  }
  if (visited !== ids.size) throw new Error("Workflow graph must be acyclic");
  return Math.max(0, ...depth.values());
}

function definitionSnapshot(nodes: readonly WorkflowNodeDefinition[], edges: readonly WorkflowEdgeDefinition[]): {
  json: string;
  hash: string;
} {
  const json = stableJson({ nodes, edges });
  if (Buffer.byteLength(json, "utf8") > WORKFLOW_DEFINITION_MAX_BYTES) {
    throw new RangeError(`Workflow definition exceeds ${WORKFLOW_DEFINITION_MAX_BYTES} UTF-8 bytes`);
  }
  return { json, hash: sha256(json) };
}

function ownedWorkflow(userId: string, workflowId: string): WorkflowRow | undefined {
  return db.prepare("SELECT * FROM workflows WHERE id = ? AND user_id = ?").get(
    workflowId,
    userId,
  ) as WorkflowRow | undefined;
}

function snapshotUnsafe(userId: string, workflowId: string): WorkflowSnapshot | undefined {
  const row = ownedWorkflow(userId, workflowId);
  if (!row) return undefined;
  const nodes = (db.prepare(
    "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY created_at, id",
  ).all(workflowId) as unknown as WorkflowNodeRow[]).map(mapNode);
  const edges = (db.prepare(
    "SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY from_node_id, to_node_id",
  ).all(workflowId) as unknown as WorkflowEdgeRow[]).map(mapEdge);
  const attempts = (db.prepare(
    "SELECT * FROM workflow_node_attempts WHERE workflow_id = ? ORDER BY created_at, node_id, attempt_no",
  ).all(workflowId) as unknown as WorkflowAttemptRow[]).map(mapAttempt);
  return { workflow: mapWorkflow(row), nodes, edges, attempts };
}

function nextEventSeq(workflowId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workflow_events WHERE workflow_id = ?",
  ).get(workflowId) as { seq: number };
  return Number(row.seq);
}

function appendEvent(
  workflow: WorkflowRow,
  type: string,
  payload: OrchestrationJson,
  at: number,
  mutationId?: string,
  requestDigest?: string,
): void {
  assertIdentifier(type, "Workflow event type");
  if (mutationId !== undefined) assertIdentifier(mutationId, "Workflow mutation id");
  const json = encodeJson(payload, WORKFLOW_EVENT_PAYLOAD_MAX_BYTES, "Workflow event payload");
  db.prepare(
    `INSERT INTO workflow_events
       (workflow_id, seq, workflow_version, graph_revision, run_revision, type,
        mutation_id, request_digest, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    nextEventSeq(workflow.id),
    workflow.version,
    workflow.graph_revision,
    workflow.run_revision,
    type,
    mutationId ?? null,
    requestDigest ?? null,
    json,
    at,
  );
}

function sameMutation(
  workflowId: string,
  mutationId: string | undefined,
  requestDigest: string,
): boolean {
  if (mutationId === undefined) return false;
  const row = db.prepare(
    "SELECT request_digest FROM workflow_events WHERE workflow_id = ? AND mutation_id = ?",
  ).get(workflowId, mutationId) as { request_digest: string | null } | undefined;
  if (!row) return false;
  if (row.request_digest !== requestDigest) throw new Error("Workflow mutation id was reused with different input");
  return true;
}

function hasOwnedRootAgent(userId: string, rootAgentId: string, ownerSessionId: string): boolean {
  const row = db.prepare(
    `SELECT * FROM agent_nodes
     WHERE id = ? AND user_id = ? AND root_agent_id = id AND session_id = ?
       AND kind = 'session' AND purpose = 'addressable' AND status <> 'closed'`,
  ).get(rootAgentId, userId, ownerSessionId);
  return row !== undefined;
}

function assertAgentInTree(userId: string, agentId: string, rootAgentId: string): {
  sessionId: string;
  status: string;
} {
  const row = db.prepare(
    `SELECT COALESCE(session_id, (SELECT session_id FROM agent_nodes WHERE id = ?)) AS session_id,
            status
     FROM agent_nodes WHERE id = ? AND user_id = ? AND root_agent_id = ?
       AND purpose = 'addressable'
       AND EXISTS (
         SELECT 1 FROM agent_nodes root
         WHERE root.id = ? AND root.user_id = ? AND root.root_agent_id = root.id
           AND root.status <> 'closed'
       )`,
  ).get(rootAgentId, agentId, userId, rootAgentId, rootAgentId, userId) as {
    session_id: string | null;
    status: string;
  } | undefined;
  if (!row?.session_id) throw new Error("Agent is not in the owned Workflow tree");
  if (row.status === "closed") throw new Error("Closed Agent cannot execute a Workflow node");
  return { sessionId: row.session_id, status: row.status };
}

function assertWorkflowExecutor(userId: string, agentId: string, rootAgentId: string): {
  sessionId: string;
  status: string;
} {
  const agent = assertAgentInTree(userId, agentId, rootAgentId);
  const row = db.prepare(
    `SELECT kind, provider, model FROM agent_nodes
     WHERE id = ? AND user_id = ? AND root_agent_id = ? AND purpose = 'addressable'`,
  ).get(agentId, userId, rootAgentId) as {
    kind: string;
    provider: string | null;
    model: string | null;
  } | undefined;
  if (!row || row.kind !== "subagent" || row.provider === null || row.model === null) {
    throw new Error("Workflow execution requires an addressable Child Agent with pinned model provenance");
  }
  return agent;
}

function assertGraphExecutors(
  userId: string,
  rootAgentId: string,
  controllerAgentId: string | null | undefined,
  nodes: readonly WorkflowNodeDefinition[],
): void {
  for (const node of nodes) {
    if (node.kind !== "work" && node.kind !== "controller") continue;
    const executor = node.executorAgentId;
    if (!executor) throw new Error(`Executable node ${node.id} has no executor Agent`);
    assertWorkflowExecutor(userId, executor, rootAgentId);
    if (node.kind === "controller" && executor !== controllerAgentId) {
      throw new Error("A controller node must use the declared Workflow controller Agent");
    }
  }
}

function controllerActor(
  workflowId: string,
  controllerNodeId: string,
  taskId: string,
  leaseGeneration: number,
  allowSettled: boolean,
): WorkflowNodeRow | undefined {
  const allowedTaskStatus = allowSettled ? "('running','succeeded')" : "('running')";
  const row = db.prepare(
    `SELECT n.* FROM workflow_nodes n
     JOIN workflow_node_attempts a
       ON a.workflow_id = n.workflow_id AND a.node_id = n.id AND a.attempt_no = n.attempt_count
     JOIN runtime_tasks t ON t.id = a.task_id
     WHERE n.workflow_id = ? AND n.id = ? AND n.kind = 'controller'
       AND a.task_id = ? AND a.status IN ('running','succeeded')
       AND t.lease_generation = ? AND t.status IN ${allowedTaskStatus}
       AND (t.status <> 'succeeded' OR EXISTS (SELECT 1 FROM task_results r WHERE r.task_id = t.id))`,
  ).get(workflowId, controllerNodeId, taskId, leaseGeneration) as unknown as WorkflowNodeRow | undefined;
  return row;
}

function assertCacheDependencyEvidence(
  workflowId: string,
  nodeId: string,
  evidence: WorkflowCacheEvidence,
): void {
  const dependencies = db.prepare(
    `SELECT n.id, n.status, n.output_digest, e.condition
     FROM workflow_edges e
     JOIN workflow_nodes n ON n.workflow_id = e.workflow_id AND n.id = e.from_node_id
     WHERE e.workflow_id = ? AND e.to_node_id = ?
     ORDER BY n.id`,
  ).all(workflowId, nodeId) as Array<{
    id: string;
    status: WorkflowNodeStatus;
    output_digest: string | null;
    condition: WorkflowEdgeCondition;
  }>;
  const supplied = Object.entries(evidence.dependencyOutputDigests).sort(([a], [b]) => a.localeCompare(b));
  if (supplied.length !== dependencies.length) {
    throw new Error("Workflow cache dependency evidence does not match the graph");
  }
  dependencies.forEach((dependency, index) => {
    const actual = supplied[index];
    const terminal = TERMINAL_NODE_STATUSES.has(dependency.status);
    const conditionSatisfied = dependency.condition === "success"
      ? dependency.status === "succeeded"
      : terminal;
    if (
      !conditionSatisfied
      || dependency.output_digest === null
      || actual?.[0] !== dependency.id
      || actual[1] !== `${dependency.status}:${dependency.output_digest}`
    ) throw new Error("Workflow cache dependency evidence does not match durable results");
  });
}

interface AdvanceChange {
  node: string;
  from: WorkflowNodeStatus;
  to: WorkflowNodeStatus;
}

type WorkflowBudgetReason = "deadline" | "tokens" | "cost" | "attempts";

function setNodeStatus(
  row: WorkflowNodeRow,
  status: WorkflowNodeControlStatus,
  at: number,
  changes: AdvanceChange[],
  outputDigest?: string,
): void {
  if (row.status === status) return;
  const terminal = TERMINAL_NODE_STATUSES.has(status);
  const changed = db.prepare(
    `UPDATE workflow_nodes SET status = ?, execution_phase = NULL, output_digest = ?,
       version = version + 1, updated_at = ?, settled_at = ?
     WHERE workflow_id = ? AND id = ? AND version = ?`,
  ).run(
    status,
    status === "succeeded" ? (outputDigest ?? row.output_digest) : null,
    at,
    terminal ? at : null,
    row.workflow_id,
    row.id,
    row.version,
  ).changes;
  if (changed !== 1) throw new Error("Workflow node changed during atomic advancement");
  changes.push({ node: row.id, from: row.status, to: status });
  row.status = status;
  row.execution_phase = null;
  row.version += 1;
  row.updated_at = at;
  row.settled_at = terminal ? at : null;
  row.output_digest = status === "succeeded" ? (outputDigest ?? row.output_digest) : null;
}

function cancelWorkflowTasks(workflowId: string, userId: string, at: number): {
  total: number;
  pending: number;
} {
  const tasks = db.prepare(
    `SELECT t.id, a.tokens_reserved, a.cost_reserved_micros FROM runtime_tasks t
     JOIN workflow_node_attempts a ON a.task_id = t.id
     WHERE a.workflow_id = ? AND a.status IN ('running','cancel_requested')
       AND t.status IN ('queued','starting','running','waiting','cancel_requested')
     ORDER BY t.created_at, t.id`,
  ).all(workflowId) as Array<{ id: string; tokens_reserved: number; cost_reserved_micros: number }>;
  let pending = 0;
  let tokensReleased = 0;
  let costReleasedMicros = 0;
  for (const task of tasks) {
    const cancelled = cancelRuntimeTaskInTransaction({
      id: task.id,
      userId,
      at,
      eventPayload: { workflowId },
    });
    if (!cancelled) throw new Error("Workflow Task disappeared during cancellation");
    db.prepare(
      `UPDATE workflow_node_attempts SET status = ?, execution_phase = ?, settled_at = ?,
         tokens_reserved = CASE WHEN ? THEN 0 ELSE tokens_reserved END,
         cost_reserved_micros = CASE WHEN ? THEN 0 ELSE cost_reserved_micros END
       WHERE workflow_id = ? AND task_id = ? AND status IN ('running','cancel_requested')`,
    ).run(
      cancelled.status === "cancelled" ? "cancelled" : "cancel_requested",
      cancelled.status,
      cancelled.status === "cancelled" ? at : null,
      cancelled.status === "cancelled" ? 1 : 0,
      cancelled.status === "cancelled" ? 1 : 0,
      workflowId,
      task.id,
    );
    if (cancelled.status === "cancel_requested") pending += 1;
    else {
      tokensReleased += Number(task.tokens_reserved);
      costReleasedMicros += Number(task.cost_reserved_micros);
    }
  }
  if (tokensReleased > 0 || costReleasedMicros > 0) {
    db.prepare(
      `UPDATE workflows SET tokens_reserved = tokens_reserved - ?,
         cost_reserved_micros = cost_reserved_micros - ?
       WHERE id = ? AND user_id = ?`,
    ).run(tokensReleased, costReleasedMicros, workflowId, userId);
  }
  return { total: tasks.length, pending };
}

function cancelNodesWithoutOpenAttempts(
  workflowId: string,
  at: number,
  changes: AdvanceChange[],
): void {
  const rows = db.prepare(
    `SELECT node.* FROM workflow_nodes node
     WHERE node.workflow_id = ?
       AND node.status NOT IN ('succeeded','failed','cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM workflow_node_attempts attempt
         WHERE attempt.workflow_id = node.workflow_id AND attempt.node_id = node.id
           AND attempt.attempt_no = node.attempt_count
           AND attempt.status IN ('running','cancel_requested')
       )
     ORDER BY node.created_at, node.id`,
  ).all(workflowId) as unknown as WorkflowNodeRow[];
  for (const row of rows) setNodeStatus(row, "cancelled", at, changes);
}

function openAttemptCount(workflowId: string): number {
  return Number((db.prepare(
    `SELECT COUNT(*) AS count FROM workflow_node_attempts
     WHERE workflow_id = ? AND status IN ('running','cancel_requested')`,
  ).get(workflowId) as { count: number }).count);
}

function isTerminalWorkflow(row: WorkflowRow): boolean {
  return row.cancellation_pending === 0 && (
    row.status === "succeeded"
    || row.status === "failed"
    || row.status === "cancelled"
    || row.status === "interrupted"
  );
}

function retireManagedWorkflowExecutorsInTransaction(row: WorkflowRow, at: number): number {
  if (!isTerminalWorkflow(row)) return 0;
  const candidates = db.prepare(
    `SELECT managed.agent_id, agent.status
     FROM workflow_managed_executors managed
     JOIN workflows workflow ON workflow.id = managed.workflow_id
     JOIN agent_nodes agent ON agent.id = managed.agent_id
     WHERE managed.workflow_id = ? AND workflow.user_id = ? AND managed.retired_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM workflow_nodes node
         WHERE node.workflow_id = managed.workflow_id
           AND node.executor_agent_id = managed.agent_id
           AND node.status NOT IN ('succeeded','failed','cancelled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM runtime_tasks task
         WHERE task.agent_id = managed.agent_id
           AND task.status IN ('queued','starting','running','waiting','cancel_requested')
       )
     ORDER BY managed.agent_id`,
  ).all(row.id, row.user_id) as unknown as Array<{ agent_id: string; status: string }>;
  let retired = 0;
  for (const candidate of candidates) {
    if (candidate.status !== "closed") {
      const closed = closeWorkflowExecutorAgentInTransaction({
        userId: row.user_id,
        agentId: candidate.agent_id,
        at,
      });
      if (!closed) throw new Error("Managed Workflow executor changed during retirement");
    }
    const updated = db.prepare(
      `UPDATE workflow_managed_executors SET retired_at = ?
       WHERE workflow_id = ? AND agent_id = ? AND retired_at IS NULL`,
    ).run(at, row.id, candidate.agent_id);
    retired += Number(updated.changes);
  }
  return retired;
}

interface WorkflowAdvanceResult {
  row: WorkflowRow;
  changes: AdvanceChange[];
  cancelledTasks: number;
  retiredExecutors: number;
  budgetReason?: WorkflowBudgetReason;
}

function finishWorkflowAdvance(
  row: WorkflowRow,
  changes: AdvanceChange[],
  cancelledTasks: number,
  at: number,
  budgetReason?: WorkflowBudgetReason,
): WorkflowAdvanceResult {
  return {
    row,
    changes,
    cancelledTasks,
    retiredExecutors: retireManagedWorkflowExecutorsInTransaction(row, at),
    ...(budgetReason === undefined ? {} : { budgetReason }),
  };
}

function commitCancellationState(
  row: WorkflowRow,
  finalStatus: "cancelled" | "failed",
  at: number,
  changes: AdvanceChange[],
): { row: WorkflowRow; cancelledTasks: number } {
  const cancellation = cancelWorkflowTasks(row.id, row.user_id, at);
  cancelNodesWithoutOpenAttempts(row.id, at, changes);
  const pending = openAttemptCount(row.id) > 0;
  db.prepare(
    `UPDATE workflows SET status = ?, cancellation_pending = ?, terminal_intent = ?,
       settled_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    pending ? row.status : finalStatus,
    pending ? 1 : 0,
    pending ? finalStatus : null,
    pending ? null : at,
    at,
    row.id,
  );
  row.status = pending ? row.status : finalStatus;
  row.cancellation_pending = pending ? 1 : 0;
  row.terminal_intent = pending ? finalStatus : null;
  row.settled_at = pending ? null : at;
  row.updated_at = at;
  return { row, cancelledTasks: cancellation.total };
}

function systemNodeDigest(
  node: WorkflowNodeRow,
  dependencies: readonly WorkflowEdgeRow[],
  byId: ReadonlyMap<string, WorkflowNodeRow>,
): string | undefined {
  const inputs: Array<{ from: string; condition: WorkflowEdgeCondition; status: WorkflowNodeStatus; output: string }> = [];
  for (const edge of dependencies) {
    const source = byId.get(edge.from_node_id);
    if (!source?.output_digest) return undefined;
    inputs.push({
      from: source.id,
      condition: edge.condition,
      status: source.status,
      output: source.output_digest,
    });
  }
  return sha256(stableJson({ kind: node.kind, signal: node.signal_name, inputs }));
}

function advanceWorkflow(row: WorkflowRow, at: number): WorkflowAdvanceResult {
  const changes: AdvanceChange[] = [];
  if (row.cancellation_pending === 1) {
    cancelNodesWithoutOpenAttempts(row.id, at, changes);
    if (openAttemptCount(row.id) > 0) {
      return finishWorkflowAdvance(row, changes, 0, at);
    }
    const finalStatus = row.terminal_intent ?? "cancelled";
    db.prepare(
      `UPDATE workflows SET status = ?, cancellation_pending = 0, terminal_intent = NULL,
         settled_at = ?, updated_at = ? WHERE id = ?`,
    ).run(finalStatus, at, at, row.id);
    row.status = finalStatus;
    row.cancellation_pending = 0;
    row.terminal_intent = null;
    row.settled_at = at;
    row.updated_at = at;
    return finishWorkflowAdvance(row, changes, 0, at);
  }
  if (
    row.status === "draft"
    || row.status === "cancelled"
    || row.status === "succeeded"
    || row.status === "failed"
    || row.status === "interrupted"
  ) {
    return finishWorkflowAdvance(row, changes, 0, at);
  }
  const immediateBudgetReason: WorkflowBudgetReason | undefined = row.tokens_used > row.max_tokens
    ? "tokens"
    : row.cost_used_micros > row.max_cost_micros
      ? "cost"
      : row.attempts_used > row.max_attempts ? "attempts" : undefined;
  if (immediateBudgetReason !== undefined) {
    const cancellation = commitCancellationState(row, "failed", at, changes);
    return finishWorkflowAdvance(
      cancellation.row,
      changes,
      cancellation.cancelledTasks,
      at,
      immediateBudgetReason,
    );
  }

  const nodes = db.prepare(
    "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY created_at, id",
  ).all(row.id) as unknown as WorkflowNodeRow[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = db.prepare(
    "SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY from_node_id, to_node_id",
  ).all(row.id) as unknown as WorkflowEdgeRow[];
  const incoming = new Map<string, WorkflowEdgeRow[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to_node_id) ?? [];
    list.push(edge);
    incoming.set(edge.to_node_id, list);
  }
  const signals = new Set((db.prepare(
    `SELECT signal_name FROM workflow_signals
     WHERE workflow_id = ? AND definition_version = ?`,
  ).all(row.id, row.definition_version) as Array<{ signal_name: string }>).map((signal) => signal.signal_name));

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.status !== "blocked" && node.status !== "ready" && node.status !== "waiting") continue;
      const dependencies = incoming.get(node.id) ?? [];
      let impossible = false;
      let ready = true;
      for (const edge of dependencies) {
        const source = byId.get(edge.from_node_id);
        if (!source) throw new Error("Workflow edge points to a missing source node");
        const terminal = TERMINAL_NODE_STATUSES.has(source.status);
        const satisfied = edge.condition === "success" ? source.status === "succeeded" : terminal;
        if (!satisfied) ready = false;
        if (edge.condition === "success" && terminal && source.status !== "succeeded") impossible = true;
      }
      if (impossible) {
        setNodeStatus(node, "cancelled", at, changes);
        changed = true;
        continue;
      }
      if (!ready) {
        if (node.status !== "blocked") {
          setNodeStatus(node, "blocked", at, changes);
          changed = true;
        }
        continue;
      }
      let next: WorkflowNodeStatus;
      if (node.kind === "join") next = "succeeded";
      else if (node.kind === "gate") next = node.signal_name !== null && signals.has(node.signal_name)
        ? "succeeded"
        : "waiting";
      else next = "ready";
      if (node.status !== next) {
        const outputDigest = next === "succeeded" && (node.kind === "join" || node.kind === "gate")
          ? systemNodeDigest(node, dependencies, byId)
          : undefined;
        setNodeStatus(node, next, at, changes, outputDigest);
        changed = true;
      }
    }
  }

  const needsExecution = nodes.some(
    (node) => (node.kind === "work" || node.kind === "controller")
      && (node.status === "ready" || node.status === "running"),
  );
  const hasRunningExecution = nodes.some(
    (node) => (node.kind === "work" || node.kind === "controller") && node.status === "running",
  );
  const resourceExceeded = row.tokens_used > row.max_tokens || row.cost_used_micros > row.max_cost_micros;
  const resourceAtLimit = row.tokens_used >= row.max_tokens || row.cost_used_micros >= row.max_cost_micros;
  const resourceBudgetStranded = resourceAtLimit && needsExecution && !hasRunningExecution;
  const attemptBudgetStranded = row.attempts_used >= row.max_attempts
    && needsExecution
    && !hasRunningExecution;
  const deadlineExpired = row.started_at !== null && at - row.started_at > row.max_runtime_ms;
  const unreconciledTerminal = Number((db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM workflow_node_attempts attempt
       JOIN runtime_tasks task ON task.id = attempt.task_id
       WHERE attempt.workflow_id = ?
         AND attempt.status IN ('running','cancel_requested')
         AND task.status IN ('succeeded','failed','cancelled','interrupted')
     ) AS value`,
  ).get(row.id) as { value: number }).value) === 1;
  const completedBeforeProjection = row.graph_sealed === 1
    && nodes.every((node) => node.status === "succeeded");
  const exhaustedReason: WorkflowBudgetReason | undefined = deadlineExpired
    && !completedBeforeProjection
    && !unreconciledTerminal
    ? "deadline"
    : (resourceExceeded && needsExecution) || resourceBudgetStranded
      ? row.tokens_used >= row.max_tokens ? "tokens" : "cost"
      : attemptBudgetStranded ? "attempts" : undefined;
  if (exhaustedReason !== undefined) {
    const cancellation = commitCancellationState(row, "failed", at, changes);
    return finishWorkflowAdvance(
      cancellation.row,
      changes,
      cancellation.cancelledTasks,
      at,
      exhaustedReason,
    );
  }

  const statuses = nodes.map((node) => node.status);
  const hasNonTerminal = statuses.some((status) => !TERMINAL_NODE_STATUSES.has(status));
  const hasFailed = statuses.some((status) => status === "failed");
  const hasCancelled = statuses.some((status) => status === "cancelled");
  let status: WorkflowStatus;
  let settledAt: number | null = null;
  if (!hasNonTerminal) {
    if (hasFailed || hasCancelled) {
      status = "failed";
      settledAt = at;
    } else if (!row.graph_sealed) {
      status = "waiting";
    } else {
      status = "succeeded";
      settledAt = at;
    }
  } else if (statuses.some((value) => value === "ready" || value === "running")) {
    status = "running";
  } else {
    status = "waiting";
  }
  if (row.status !== status || row.settled_at !== settledAt) {
    db.prepare("UPDATE workflows SET status = ?, settled_at = ?, updated_at = ? WHERE id = ?")
      .run(status, settledAt, at, row.id);
    row.status = status;
    row.settled_at = settledAt;
    row.updated_at = at;
  }
  return finishWorkflowAdvance(row, changes, 0, at);
}

function graphRows(workflowId: string): { nodes: WorkflowNodeRow[]; edges: WorkflowEdgeDefinition[] } {
  const nodes = db.prepare(
    "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY created_at, id",
  ).all(workflowId) as unknown as WorkflowNodeRow[];
  const edges = (db.prepare(
    "SELECT from_node_id, to_node_id, condition FROM workflow_edges WHERE workflow_id = ?",
  ).all(workflowId) as Array<{ from_node_id: string; to_node_id: string; condition: WorkflowEdgeCondition }>).map(
    (edge) => ({ from: edge.from_node_id, to: edge.to_node_id, condition: edge.condition }),
  );
  return { nodes, edges };
}

function insertNode(
  workflowId: string,
  node: WorkflowNodeDefinition,
  depth: number,
  at: number,
  expandedByNodeId?: string,
): void {
  db.prepare(
    `INSERT INTO workflow_nodes
       (workflow_id, id, name, kind, payload_json, effect, cache_policy, status,
        executor_agent_id, signal_name,
        depth, max_attempts, attempt_count, expanded_by_node_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
  ).run(
    workflowId,
    node.id,
    node.name,
    node.kind,
    encodeJson(node.payload, WORKFLOW_NODE_PAYLOAD_MAX_BYTES, `Workflow node ${node.id} payload`),
    node.effect,
    node.cachePolicy,
    node.executorAgentId ?? null,
    node.signal ?? null,
    depth,
    node.maxAttempts,
    expandedByNodeId ?? null,
    at,
    at,
  );
}

function insertEdges(workflowId: string, edges: readonly WorkflowEdgeDefinition[], at: number): void {
  const insert = db.prepare(
    `INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, condition, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const edge of edges) insert.run(workflowId, edge.from, edge.to, edge.condition, at);
}

function requestDigest(value: unknown): string {
  return sha256(stableJson(value));
}

function workflowAssignmentMessage(node: WorkflowNode): string {
  if (node.payload !== null && !Array.isArray(node.payload) && typeof node.payload === "object") {
    const payload = node.payload as Record<string, OrchestrationJson>;
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
    if (typeof payload.assignment === "string" && payload.assignment.trim()) return payload.assignment.trim();
  }
  const encoded = stableJson(node.payload);
  return encoded === "{}" ? node.name : `${node.name}\n\nInput:\n${encoded}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

export interface WorkflowDependencyHandle {
  nodeId: string;
  status: WorkflowNodeStatus;
  agentId: string;
  taskId: string;
  resultId?: string;
  summary?: string;
}

export interface WorkflowDependencyHandleList {
  handles: WorkflowDependencyHandle[];
  omitted: number;
}

function dependencyHandles(workflowId: string, nodeId: string): WorkflowDependencyHandleList {
  const rows = db.prepare(
    `WITH RECURSIVE upstream(id, distance) AS (
       SELECT edge.from_node_id, 1 FROM workflow_edges edge
       WHERE edge.workflow_id = ? AND edge.to_node_id = ?
       UNION
       SELECT edge.from_node_id, child.distance + 1 FROM workflow_edges edge
       JOIN upstream child ON child.id = edge.to_node_id
       WHERE edge.workflow_id = ?
     )
     SELECT node.id AS node_id, node.status, node.executor_agent_id AS agent_id,
            attempt.task_id, result.id AS result_id, result.summary,
            MIN(upstream.distance) AS distance
     FROM upstream
     JOIN workflow_nodes node ON node.workflow_id = ? AND node.id = upstream.id
     JOIN workflow_node_attempts attempt
       ON attempt.workflow_id = node.workflow_id AND attempt.node_id = node.id
      AND attempt.attempt_no = node.attempt_count
     LEFT JOIN task_results result ON result.task_id = attempt.task_id
     WHERE node.kind IN ('work','controller')
     GROUP BY node.id, node.status, node.executor_agent_id,
              attempt.task_id, result.id, result.summary
     ORDER BY distance ASC, node.id ASC`,
  ).all(workflowId, nodeId, workflowId, workflowId) as unknown as Array<{
    node_id: string;
    status: WorkflowNodeStatus;
    agent_id: string;
    task_id: string;
    result_id: string | null;
    summary: string | null;
  }>;
  let summaryBytes = 0;
  const handles = rows.slice(0, WORKFLOW_DEPENDENCY_HANDLE_LIMIT).map((row) => {
    let summary: string | undefined;
    if (row.summary !== null && summaryBytes < WORKFLOW_DEPENDENCY_SUMMARY_MAX_BYTES) {
      const remaining = WORKFLOW_DEPENDENCY_SUMMARY_MAX_BYTES - summaryBytes;
      summary = truncateUtf8(row.summary, remaining);
      summaryBytes += Buffer.byteLength(summary, "utf8");
    }
    return {
      nodeId: row.node_id,
      status: row.status,
      agentId: row.agent_id,
      taskId: row.task_id,
      ...(row.result_id === null ? {} : { resultId: row.result_id }),
      ...(summary === undefined ? {} : { summary }),
    };
  });
  return { handles, omitted: Math.max(0, rows.length - handles.length) };
}

interface WorkflowCapabilityProfile {
  allowedTools?: string[];
  checkpointSafe: boolean;
}

function workflowCapabilityProfile(node: WorkflowNode): WorkflowCapabilityProfile {
  if (node.kind === "controller") {
    return {
      allowedTools: [
        "workflow_expand",
        "workflow_seal",
        "workflow_list_dependencies",
        "workflow_read_dependency",
        "workflow_signal",
      ],
      checkpointSafe: false,
    };
  }
  if (node.effect === "pure_readonly") {
    return { allowedTools: ["workflow_read_dependency"], checkpointSafe: true };
  }
  if (node.effect === "workspace_read") {
    return {
      allowedTools: ["read_file", "read_image", "list_files", "workflow_read_dependency"],
      checkpointSafe: true,
    };
  }
  if (node.effect === "workspace_write") {
    return {
      allowedTools: [
        "read_file",
        "read_image",
        "list_files",
        "write_file",
        "edit_file",
        "workflow_read_dependency",
      ],
      checkpointSafe: false,
    };
  }
  return { checkpointSafe: false };
}

function workflowTaskPayload(
  workflow: WorkflowRow,
  node: WorkflowNode,
  reservation: Readonly<{ maxTokens: number; maxCostMicros: number; deadlineAt: number }>,
  capability: WorkflowCapabilityProfile,
): OrchestrationJson {
  const dependencies = dependencyHandles(workflow.id, node.id);
  const dependencyPayload = dependencies.handles.map((dependency): OrchestrationJson => ({
    nodeId: dependency.nodeId,
    status: dependency.status,
    agentId: dependency.agentId,
    taskId: dependency.taskId,
    ...(dependency.resultId === undefined ? {} : { resultId: dependency.resultId }),
    ...(dependency.summary === undefined ? {} : { summary: dependency.summary }),
  }));
  const dependencyText = dependencies.handles.length === 0
    ? ""
    : `\n\nUpstream Workflow results:\n${dependencies.handles.map((dependency) => {
      const summary = dependency.summary ? ` — ${dependency.summary.replace(/\s+/g, " ").trim()}` : "";
      return `- ${dependency.nodeId}: agent=${dependency.agentId} task=${dependency.taskId}`
        + `${dependency.resultId ? ` result=${dependency.resultId}` : ""}${summary}`;
    }).join("\n")}${dependencies.omitted > 0 ? `\n- ${dependencies.omitted} more upstream results omitted.` : ""}`;
  const payload: OrchestrationJson = {
    message: `${workflowAssignmentMessage(node)}${dependencyText}`,
    context: "none",
    workflow: {
      workflowId: workflow.id,
      nodeId: node.id,
      dependencies: dependencyPayload,
      omittedDependencies: dependencies.omitted,
      nodeKind: node.kind,
      effect: node.effect,
      capabilityContractVersion: WORKFLOW_CAPABILITY_CONTRACT_VERSION,
      ...(capability.allowedTools === undefined ? {} : { allowedTools: capability.allowedTools }),
      budget: reservation,
    },
  };
  try {
    encodeJson(payload, 64 * 1024, "Workflow Task payload");
    return payload;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const compact: OrchestrationJson = {
      message: workflowAssignmentMessage(node),
      context: "none",
      workflow: {
        workflowId: workflow.id,
        nodeId: node.id,
        dependencies: dependencies.handles.map((dependency): OrchestrationJson => ({
          nodeId: dependency.nodeId,
          status: dependency.status,
          agentId: dependency.agentId,
          taskId: dependency.taskId,
          ...(dependency.resultId === undefined ? {} : { resultId: dependency.resultId }),
        })),
        omittedDependencies: dependencies.omitted,
        nodeKind: node.kind,
        effect: node.effect,
        capabilityContractVersion: WORKFLOW_CAPABILITY_CONTRACT_VERSION,
        ...(capability.allowedTools === undefined ? {} : { allowedTools: capability.allowedTools }),
        budget: reservation,
      },
    };
    encodeJson(compact, 64 * 1024, "Workflow Task payload");
    return compact;
  }
}

function eventPayloadChanges(changes: readonly AdvanceChange[]): OrchestrationJson {
  return changes.map((change) => ({ node: change.node, from: change.from, to: change.to }));
}

function settleWorkflowAttemptInTransaction(input: SettleWorkflowAttemptInput): WorkflowSnapshot | null {
  if (input.cacheAttestation !== undefined && !WORKFLOW_EXECUTION_CACHE_ENABLED) {
    throw new Error("Workflow execution cache requires an isolated trusted executor");
  }
  const inputTokens = input.tokensUsed === undefined
    ? undefined
    : int(input.tokensUsed, "Workflow token usage", 0, 100_000_000);
  const inputCost = input.costUsedMicros === undefined
    ? undefined
    : int(input.costUsedMicros, "Workflow cost usage", 0, 1_000_000_000_000);
  const workflowRow = ownedWorkflow(input.userId, input.workflowId);
  if (!workflowRow || workflowRow.version !== input.expectedVersion) return null;
  const nodeRow = db.prepare(
    "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND id = ?",
  ).get(workflowRow.id, input.nodeId) as WorkflowNodeRow | undefined;
  const attemptRow = db.prepare(
    `SELECT * FROM workflow_node_attempts
     WHERE workflow_id = ? AND node_id = ? AND task_id = ?`,
  ).get(workflowRow.id, input.nodeId, input.taskId) as WorkflowAttemptRow | undefined;
  if (!nodeRow || !attemptRow) return null;
  if (attemptRow.status !== "running" && attemptRow.status !== "cancel_requested") {
    return snapshotUnsafe(input.userId, workflowRow.id)!;
  }
  const task = db.prepare(
    `SELECT * FROM runtime_tasks
     WHERE id = ? AND user_id = ? AND workflow_id = ? AND lease_generation = ?`,
  ).get(
    input.taskId,
    input.userId,
    workflowRow.id,
    input.expectedTaskLeaseGeneration,
  ) as Record<string, unknown> | undefined;
  if (!task) return null;
  const tokens = inputTokens ?? attemptRow.tokens_used;
  const cost = inputCost ?? attemptRow.cost_used_micros;
  if (tokens < attemptRow.tokens_used || cost < attemptRow.cost_used_micros) {
    throw new Error("Workflow attempt usage is cumulative and cannot decrease");
  }
  const tokenDelta = tokens - attemptRow.tokens_used;
  const costDelta = cost - attemptRow.cost_used_micros;
  const taskStatus = String(task.status);
  if (!TERMINAL_TASK_STATUSES.has(taskStatus)) return null;
  const taskSettledAt = task.settled_at === null ? input.at : Number(task.settled_at);
  const taskLate = workflowRow.started_at !== null
    && taskSettledAt - workflowRow.started_at > workflowRow.max_runtime_ms;
  let attemptStatus = taskStatus as WorkflowAttemptStatus;
  const resultRow = db.prepare(
    "SELECT * FROM task_results WHERE task_id = ?",
  ).get(input.taskId) as {
    id: string; summary: string; body_json: string; artifacts_json: string;
  } | undefined;
  if (attemptStatus === "succeeded" && !resultRow) {
    if (!input.recoverMissingResult) return null;
    attemptStatus = "interrupted";
  }
  const outputDigest = resultRow === undefined
    ? null
    : sha256(stableJson({
      summary: resultRow.summary,
      body: JSON.parse(resultRow.body_json),
      artifacts: JSON.parse(resultRow.artifacts_json),
    }));
  db.prepare(
    `UPDATE workflow_node_attempts SET status = ?, execution_phase = ?, source_result_id = ?,
       tokens_used = ?, tokens_reserved = 0, cost_used_micros = ?,
       cost_reserved_micros = 0, settled_at = ?
     WHERE workflow_id = ? AND node_id = ? AND task_id = ?
       AND status IN ('running','cancel_requested')`,
  ).run(
    attemptStatus,
    attemptStatus,
    resultRow?.id ?? null,
    tokens,
    cost,
    input.at,
    workflowRow.id,
    nodeRow.id,
    input.taskId,
  );
  db.prepare(
    `UPDATE runtime_tasks SET provider_tokens_used = ?, provider_cost_used_micros = ?
     WHERE id = ? AND user_id = ? AND workflow_id = ? AND lease_generation = ?`,
  ).run(
    tokens,
    cost,
    input.taskId,
    input.userId,
    workflowRow.id,
    input.expectedTaskLeaseGeneration,
  );

  let nodeStatus: WorkflowNodeStatus;
  let retried = false;
  const workflowWasTerminal = workflowRow.cancellation_pending === 0 && (
    workflowRow.status === "succeeded"
    || workflowRow.status === "failed"
    || workflowRow.status === "cancelled"
    || workflowRow.status === "interrupted"
  );
  if (workflowWasTerminal) {
    nodeStatus = TERMINAL_NODE_STATUSES.has(nodeRow.status)
      ? nodeRow.status
      : workflowRow.status === "cancelled" ? "cancelled" : "failed";
  } else if (attemptStatus === "cancelled" && workflowRow.terminal_intent === "cancelled") {
    nodeStatus = "cancelled";
  } else if (taskLate) nodeStatus = "failed";
  else if (attemptStatus === "succeeded") nodeStatus = "succeeded";
  else if (attemptStatus === "cancelled" || workflowRow.status === "cancelled") nodeStatus = "cancelled";
  else if (
    nodeRow.attempt_count < nodeRow.max_attempts
    && workflowRow.attempts_used < workflowRow.max_attempts
    && (attemptStatus !== "interrupted" || Number(task.checkpoint_safe) === 1)
    && !(taskStatus === "succeeded" && !resultRow && Number(task.checkpoint_safe) !== 1)
  ) {
    nodeStatus = "blocked";
    retried = true;
  } else nodeStatus = "failed";
  db.prepare(
    `UPDATE workflow_nodes SET status = ?, execution_phase = ?, output_digest = ?,
       version = version + 1, updated_at = ?, settled_at = ?
     WHERE workflow_id = ? AND id = ? AND version = ?`,
  ).run(
    nodeStatus,
    nodeStatus === "blocked" ? null : attemptStatus,
    TERMINAL_NODE_STATUSES.has(nodeStatus) ? outputDigest : null,
    input.at,
    TERMINAL_NODE_STATUSES.has(nodeStatus) ? input.at : null,
    workflowRow.id,
    nodeRow.id,
    nodeRow.version,
  );

  let cacheStored = false;
  if (input.cacheAttestation !== undefined) {
    const cacheEvidence = JSON.parse(attemptRow.evidence_json) as {
      executorDigest?: unknown;
    };
    if (
      input.cacheAttestation.pureReadOnly !== true
      || input.cacheAttestation.observedEffects !== "read_only"
      || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(input.cacheAttestation.toolContractDigest)
    ) throw new Error("Invalid Workflow cache execution attestation");
    if (cacheEvidence.executorDigest !== input.cacheAttestation.toolContractDigest) {
      throw new Error("Cache attestation does not match the persisted Tool contract");
    }
    if (attemptRow.cache_key === null || nodeRow.effect !== "pure_readonly" || nodeRow.cache_policy !== "evidence") {
      throw new Error("Cache attestation does not belong to a cacheable Workflow node");
    }
  }
  if (
    !workflowWasTerminal
    && !taskLate
    && attemptStatus === "succeeded"
    && resultRow
    && attemptRow.cache_key !== null
    && input.cacheAttestation !== undefined
  ) {
    if (outputDigest === null) throw new Error("Cacheable Task result has no output digest");
    db.prepare(
      `INSERT INTO workflow_cache_entries
         (user_id, cache_key, contract_version, summary, body_json, artifacts_json,
          output_digest, source_task_id, created_at, last_used_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(user_id, cache_key) DO UPDATE SET
         contract_version = excluded.contract_version,
         summary = excluded.summary,
         body_json = excluded.body_json,
         artifacts_json = excluded.artifacts_json,
         output_digest = excluded.output_digest,
         source_task_id = excluded.source_task_id,
         created_at = excluded.created_at,
         last_used_at = excluded.last_used_at,
         hit_count = 0`,
    ).run(
      input.userId,
      attemptRow.cache_key,
      WORKFLOW_CACHE_CONTRACT_VERSION,
      resultRow.summary,
      resultRow.body_json,
      resultRow.artifacts_json,
      outputDigest,
      input.taskId,
      input.at,
      input.at,
    );
    db.prepare(
      `DELETE FROM workflow_cache_entries
       WHERE user_id = ? AND cache_key IN (
         SELECT cache_key FROM workflow_cache_entries WHERE user_id = ?
         ORDER BY last_used_at DESC, cache_key DESC LIMIT -1 OFFSET ?
       )`,
    ).run(input.userId, input.userId, WORKFLOW_CACHE_MAX_ENTRIES_PER_USER);
    cacheStored = true;
  }

  const next = db.prepare(
    `UPDATE workflows SET tokens_used = tokens_used + ?,
       tokens_reserved = tokens_reserved - ?,
       cost_used_micros = cost_used_micros + ?,
       cost_reserved_micros = cost_reserved_micros - ?,
       run_revision = run_revision + 1, version = version + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
  ).get(
    tokenDelta,
    attemptRow.tokens_reserved,
    costDelta,
    attemptRow.cost_reserved_micros,
    input.at,
    workflowRow.id,
    input.userId,
    input.expectedVersion,
  ) as WorkflowRow | undefined;
  if (!next) throw new Error("Workflow settlement CAS changed inside its transaction");
  const advanced = advanceWorkflow(next, input.at);
  const final = ownedWorkflow(input.userId, workflowRow.id)!;
  appendEvent(
    final,
    advanced.budgetReason !== undefined
      ? "workflow.budget_exhausted"
      : retried ? "workflow.node_retry_ready" : "workflow.node_settled",
    {
    node: nodeRow.id,
    task: input.taskId,
    attempt: attemptRow.attempt_no,
    status: attemptStatus,
    taskLate,
    usage: { tokens, costMicros: cost },
    reservationReleased: {
      tokens: attemptRow.tokens_reserved,
      costMicros: attemptRow.cost_reserved_micros,
    },
    cacheStored,
    cancelledTasks: advanced.cancelledTasks,
    retiredExecutors: advanced.retiredExecutors,
    ...(advanced.budgetReason === undefined ? {} : { budgetReason: advanced.budgetReason }),
    ...(input.cacheAttestation === undefined
      ? {}
      : { toolContract: input.cacheAttestation.toolContractDigest }),
    ...(taskStatus === attemptStatus ? {} : { taskStatus, reason: "result_missing" }),
    changes: eventPayloadChanges(advanced.changes),
    },
    input.at,
  );
  return snapshotUnsafe(input.userId, workflowRow.id)!;
}

interface PreparedWorkflowCreate {
  budget: WorkflowBudget;
  graph: { nodes: WorkflowNodeDefinition[]; edges: WorkflowEdgeDefinition[] };
  definition: { json: string; hash: string };
  graphSealed: boolean;
}

function prepareWorkflowCreate(input: NewWorkflowInput): PreparedWorkflowCreate {
  assertIdentifier(input.id, "Workflow id");
  assertName(input.name, "Workflow name");
  const budget = normalizeBudget(input.budget);
  const graph = normalizeGraph(input.nodes, input.edges, budget);
  const definition = definitionSnapshot(graph.nodes, graph.edges);
  const graphSealed = input.graphSealed ?? !graph.nodes.some((node) => node.kind === "controller");
  assertGraphCanRemainOpen(graph.nodes, graphSealed);
  if (graph.nodes.some((node) => node.kind === "controller") && input.controllerAgentId === undefined) {
    throw new Error("A controller node requires the Workflow controller Agent");
  }
  return { budget, graph, definition, graphSealed };
}

function insertWorkflowDefinitionInTransaction(
  input: NewWorkflowInput,
  prepared: PreparedWorkflowCreate,
): WorkflowRow {
  const { budget, graph, definition, graphSealed } = prepared;
  db.prepare(
    `INSERT INTO workflows
       (id, user_id, owner_session_id, root_agent_id, controller_agent_id, name, status,
        definition_version, graph_revision, graph_sealed, run_revision,
        max_nodes, max_edges, max_depth, max_attempts, max_runtime_ms, max_tokens,
        max_cost_micros, attempts_used, tokens_used, cost_used_micros,
        version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.ownerSessionId,
    input.rootAgentId,
    input.controllerAgentId ?? null,
    input.name.trim(),
    graphSealed ? 1 : 0,
    budget.maxNodes,
    budget.maxEdges,
    budget.maxDepth,
    budget.maxAttempts,
    budget.maxRuntimeMs,
    budget.maxTokens,
    budget.maxCostMicros,
    input.createdAt,
    input.createdAt,
  );
  db.prepare(
    `INSERT INTO workflow_definition_versions
       (workflow_id, version, graph_json, graph_hash, created_at) VALUES (?, 1, ?, ?, ?)`,
  ).run(input.id, definition.json, definition.hash, input.createdAt);
  for (const node of graph.nodes) insertNode(input.id, node, 0, input.createdAt);
  insertEdges(input.id, graph.edges, input.createdAt);
  const row = ownedWorkflow(input.userId, input.id)!;
  appendEvent(row, "workflow.created", {
    definition: definition.hash,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    sealed: graphSealed,
  }, input.createdAt);
  return row;
}

function startWorkflowInTransaction(
  userId: string,
  workflowId: string,
  expectedVersion: number,
  at: number,
): WorkflowSnapshot | null {
  const row = ownedWorkflow(userId, workflowId);
  if (!row || row.version !== expectedVersion) return null;
  if (row.status !== "draft" && row.status !== "queued") throw new Error("Workflow is not startable");
  const next = db.prepare(
    `UPDATE workflows SET status = 'queued', started_at = COALESCE(started_at, ?),
       version = version + 1, run_revision = run_revision + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
  ).get(at, at, workflowId, userId, expectedVersion) as WorkflowRow | undefined;
  if (!next) return null;
  const advanced = advanceWorkflow(next, at);
  const final = ownedWorkflow(userId, workflowId)!;
  appendEvent(final, "workflow.started", {
    changes: eventPayloadChanges(advanced.changes),
    retiredExecutors: advanced.retiredExecutors,
  }, at);
  return snapshotUnsafe(userId, workflowId)!;
}

function assertLaunchExecutorCoverage(
  input: LaunchWorkflowInput,
  prepared: PreparedWorkflowCreate,
): void {
  const executableIds = prepared.graph.nodes.flatMap((node) =>
    node.kind === "work" || node.kind === "controller" ? [node.executorAgentId!] : []);
  const executorIds = new Set(executableIds);
  const provisionedIds = new Set(input.executors.map((agent) => agent.id));
  if (
    executableIds.length !== executorIds.size
    || input.executors.length !== provisionedIds.size
    || executorIds.size !== provisionedIds.size
    || [...executorIds].some((id) => !provisionedIds.has(id))
    || input.executors.some((agent) =>
      agent.userId !== input.userId
      || agent.sessionId !== input.ownerSessionId
      || agent.rootAgentId !== input.rootAgentId
      || agent.parentAgentId !== input.rootAgentId)
  ) {
    throw new Error("Workflow executor identities must exactly cover the launched graph");
  }
}

function insertManagedWorkflowExecutorsInTransaction(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  executors: readonly NewAgentNode[],
): void {
  const managedIds = new Set(executors.map((executor) => executor.id));
  const byExecutor = new Map<string, string>();
  for (const node of nodes) {
    if (
      (node.kind !== "work" && node.kind !== "controller")
      || !node.executorAgentId
      || !managedIds.has(node.executorAgentId)
    ) continue;
    if (byExecutor.has(node.executorAgentId)) {
      throw new Error("A managed Workflow executor can own only one launch node");
    }
    byExecutor.set(node.executorAgentId, node.id);
  }
  for (const executor of executors) {
    const nodeId = byExecutor.get(executor.id);
    if (!nodeId) throw new Error("Managed Workflow executor has no launch node");
    db.prepare(
      `INSERT INTO workflow_managed_executors (workflow_id, node_id, agent_id)
       VALUES (?, ?, ?)`,
    ).run(workflowId, nodeId, executor.id);
  }
}

function launchWorkflowInTransaction(
  input: LaunchWorkflowInput,
  prepared: PreparedWorkflowCreate,
): WorkflowSnapshot {
  if (!hasOwnedRootAgent(input.userId, input.rootAgentId, input.ownerSessionId)) {
    throw new Error("Workflow requires an owned Session-backed root Agent");
  }
  const maxTreeAgents = int(input.maxTreeAgents, "maxTreeAgents", 2, 100);
  const count = Number((db.prepare(
    "SELECT COUNT(*) AS count FROM agent_nodes WHERE user_id = ? AND root_agent_id = ? AND status <> 'closed'",
  ).get(input.userId, input.rootAgentId) as { count: number }).count);
  if (count + input.executors.length > maxTreeAgents) {
    throw new RangeError(`Agent tree limit reached (${maxTreeAgents})`);
  }
  insertWorkflowExecutorAgentsInTransaction(input.executors);
  assertGraphExecutors(
    input.userId,
    input.rootAgentId,
    input.controllerAgentId,
    prepared.graph.nodes,
  );
  insertWorkflowDefinitionInTransaction(input, prepared);
  insertManagedWorkflowExecutorsInTransaction(input.id, prepared.graph.nodes, input.executors);
  const started = startWorkflowInTransaction(input.userId, input.id, 1, input.createdAt);
  if (!started) throw new Error("Workflow launch lost its initial version");
  return started;
}

export const workflowDao = {
  create(input: NewWorkflowInput): WorkflowSnapshot {
    const prepared = prepareWorkflowCreate(input);
    return runInTransaction(() => {
      if (!hasOwnedRootAgent(input.userId, input.rootAgentId, input.ownerSessionId)) {
        throw new Error("Workflow requires an owned Session-backed root Agent");
      }
      if (input.controllerAgentId !== undefined) {
        assertAgentInTree(input.userId, input.controllerAgentId, input.rootAgentId);
      }
      assertGraphExecutors(input.userId, input.rootAgentId, input.controllerAgentId, prepared.graph.nodes);
      insertWorkflowDefinitionInTransaction(input, prepared);
      return snapshotUnsafe(input.userId, input.id)!;
    });
  },

  launch(input: LaunchWorkflowInput): WorkflowSnapshot {
    if (input.controllerAgentId !== undefined || input.graphSealed === false) {
      throw new Error("A direct Workflow launch requires a sealed static graph");
    }
    const prepared = prepareWorkflowCreate({ ...input, graphSealed: true });
    assertLaunchExecutorCoverage(input, prepared);
    return runInTransaction(() => launchWorkflowInTransaction(
      { ...input, graphSealed: true },
      prepared,
    ));
  },

  launchDynamic(input: LaunchWorkflowInput): WorkflowSnapshot {
    if (input.controllerAgentId === undefined || input.graphSealed !== false) {
      throw new Error("A dynamic Workflow launch requires one declared controller Agent");
    }
    const prepared = prepareWorkflowCreate(input);
    if (
      prepared.graph.nodes.length !== 1
      || prepared.graph.nodes[0]?.kind !== "controller"
      || prepared.graph.edges.length !== 0
    ) {
      throw new Error("A dynamic Workflow must start with one controller node and no edges");
    }
    assertLaunchExecutorCoverage(input, prepared);
    return runInTransaction(() => launchWorkflowInTransaction(input, prepared));
  },

  snapshot(userId: string, workflowId: string): WorkflowSnapshot | undefined {
    return runInTransaction(() => snapshotUnsafe(userId, workflowId));
  },

  reviseDefinition(input: ReviseWorkflowInput): WorkflowSnapshot | null {
    const current = ownedWorkflow(input.userId, input.workflowId);
    if (!current) return null;
    const budget = mapWorkflow(current).budget;
    const graph = normalizeGraph(input.nodes, input.edges, budget);
    const definition = definitionSnapshot(graph.nodes, graph.edges);
    const graphSealed = input.graphSealed ?? !graph.nodes.some((node) => node.kind === "controller");
    assertGraphCanRemainOpen(graph.nodes, graphSealed);
    if (graph.nodes.some((node) => node.kind === "controller") && current.controller_agent_id === null) {
      throw new Error("A controller node requires the Workflow controller Agent");
    }
    const digest = requestDigest({ graph, graphSealed });
    return runInTransaction(() => {
      const row = ownedWorkflow(input.userId, input.workflowId);
      if (!row) return null;
      if (sameMutation(row.id, input.mutationId, digest)) return snapshotUnsafe(input.userId, row.id)!;
      if (
        row.version !== input.expectedVersion
        || row.definition_version !== input.expectedDefinitionVersion
      ) return null;
      if (row.status !== "draft") throw new Error("Only a draft Workflow definition can be replaced");
      if (row.definition_version >= WORKFLOW_DEFINITION_VERSION_LIMIT) {
        throw new RangeError("Workflow definition version budget exceeded");
      }
      if (row.root_agent_id === null) throw new Error("Legacy Workflow has no root Agent binding");
      assertGraphExecutors(input.userId, row.root_agent_id, row.controller_agent_id, graph.nodes);
      db.prepare("DELETE FROM workflow_signals WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflow_edges WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflow_nodes WHERE workflow_id = ?").run(row.id);
      for (const node of graph.nodes) insertNode(row.id, node, 0, input.at);
      insertEdges(row.id, graph.edges, input.at);
      const next = db.prepare(
        `UPDATE workflows SET definition_version = definition_version + 1,
           graph_revision = graph_revision + 1, graph_sealed = ?, run_revision = run_revision + 1,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? AND definition_version = ? RETURNING *`,
      ).get(
        graphSealed ? 1 : 0,
        input.at,
        row.id,
        input.userId,
        input.expectedVersion,
        input.expectedDefinitionVersion,
      ) as WorkflowRow | undefined;
      if (!next) throw new Error("Workflow definition CAS changed inside its transaction");
      db.prepare(
        `INSERT INTO workflow_definition_versions
           (workflow_id, version, graph_json, graph_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, next.definition_version, definition.json, definition.hash, input.at);
      appendEvent(next, "workflow.definition_revised", {
        definition: definition.hash,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        sealed: graphSealed,
      }, input.at, input.mutationId, digest);
      return snapshotUnsafe(input.userId, row.id)!;
    });
  },

  start(userId: string, workflowId: string, expectedVersion: number, at: number): WorkflowSnapshot | null {
    return runInTransaction(() => startWorkflowInTransaction(userId, workflowId, expectedVersion, at));
  },

  tick(userId: string, workflowId: string, expectedVersion: number, at: number): WorkflowSnapshot | null {
    const before = ownedWorkflow(userId, workflowId);
    if (!before || before.version !== expectedVersion) return null;
    workflowDao.recover(userId, workflowId, at);
    const recovered = ownedWorkflow(userId, workflowId);
    if (!recovered) return null;
    return runInTransaction(() => {
      const row = ownedWorkflow(userId, workflowId);
      if (!row || row.version !== recovered.version) return null;
      const previousStatus = mapWorkflow(row).status;
      const previousCancellationPending = row.cancellation_pending;
      const previousTerminalIntent = row.terminal_intent;
      const advanced = advanceWorkflow(row, at);
      let current = ownedWorkflow(userId, workflowId)!;
      if (
        advanced.changes.length === 0
        && advanced.retiredExecutors === 0
        && mapWorkflow(current).status === previousStatus
        && current.cancellation_pending === previousCancellationPending
        && current.terminal_intent === previousTerminalIntent
      ) {
        return snapshotUnsafe(userId, workflowId)!;
      }
      if (current.version === recovered.version) {
        const bumped = db.prepare(
          `UPDATE workflows SET run_revision = run_revision + 1, version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
        ).get(at, workflowId, userId, recovered.version) as WorkflowRow | undefined;
        if (!bumped) throw new Error("Workflow tick CAS changed inside its transaction");
        current = bumped;
      }
      appendEvent(current, "workflow.advanced", {
        from: previousStatus,
        to: mapWorkflow(current).status,
        cancelledTasks: advanced.cancelledTasks,
        retiredExecutors: advanced.retiredExecutors,
        ...(advanced.budgetReason === undefined ? {} : { budgetReason: advanced.budgetReason }),
        changes: eventPayloadChanges(advanced.changes),
      }, at);
      return snapshotUnsafe(userId, workflowId)!;
    });
  },

  expand(input: ExpandWorkflowInput): WorkflowSnapshot | null {
    if (input.nodes.length === 0) throw new Error("A controller expansion must add at least one node");
    const provisionsExecutors = input.executors !== undefined || input.maxTreeAgents !== undefined;
    if (provisionsExecutors && (input.executors === undefined || input.maxTreeAgents === undefined)) {
      throw new Error("Workflow expansion executor admission requires identities and a tree limit");
    }
    const maxTreeAgents = input.maxTreeAgents === undefined
      ? undefined
      : int(input.maxTreeAgents, "maxTreeAgents", 2, 100);
    const digest = requestDigest({ controller: input.controllerNodeId, nodes: input.nodes, edges: input.edges });
    const mutationId = input.mutationId
      ?? `expand:${sha256(`${input.actorTaskId}:${input.actorLeaseGeneration}:${digest}`).slice(0, 64)}`;
    return runInTransaction(() => {
      const row = ownedWorkflow(input.userId, input.workflowId);
      if (!row) return null;
      if (sameMutation(row.id, mutationId, digest)) return snapshotUnsafe(input.userId, row.id)!;
      if (row.graph_revision !== input.expectedGraphRevision) return null;
      if (row.graph_sealed === 1) throw new Error("Workflow graph is sealed");
      if (row.status !== "running" && row.status !== "waiting") throw new Error("Workflow is not running");
      const controller = controllerActor(
        row.id,
        input.controllerNodeId,
        input.actorTaskId,
        input.actorLeaseGeneration,
        false,
      );
      if (!controller) throw new Error("Dynamic expansion requires the current controller Task lease");
      const graph = graphRows(row.id);
      const existingIds = new Set(graph.nodes.map((node) => node.id));
      const newIds = new Set<string>();
      const newNodes = input.nodes.map((node) => normalizedNode(node));
      for (const node of newNodes) {
        if (existingIds.has(node.id) || newIds.has(node.id)) throw new Error(`Duplicate Workflow node ${node.id}`);
        newIds.add(node.id);
      }
      if (row.root_agent_id === null) throw new Error("Workflow has no root Agent binding");
      const depth = controller.depth + 1;
      if (depth > row.max_depth) throw new RangeError("Workflow dynamic depth budget exceeded");
      if (graph.nodes.length + newNodes.length > row.max_nodes) throw new RangeError("Workflow node budget exceeded");
      if (graph.edges.length + input.edges.length > row.max_edges) throw new RangeError("Workflow edge budget exceeded");
      for (const edge of input.edges) {
        if (!newIds.has(edge.to)) {
          throw new Error("A dynamic edge must target a node from the same expansion");
        }
      }
      const allDefinitions: WorkflowNodeDefinition[] = [
        ...graph.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          kind: node.kind,
          payload: JSON.parse(node.payload_json) as OrchestrationJson,
          effect: node.effect,
          cachePolicy: node.cache_policy,
          maxAttempts: node.max_attempts,
          ...(node.executor_agent_id === null ? {} : { executorAgentId: node.executor_agent_id }),
          ...(node.signal_name === null ? {} : { signal: node.signal_name }),
        })),
        ...newNodes,
      ];
      const candidate = normalizeGraph(
        allDefinitions,
        [...graph.edges, ...input.edges],
        mapWorkflow(row).budget,
        new Set(graph.nodes.map((node) => node.id)),
      );
      definitionSnapshot(candidate.nodes, candidate.edges);
      if (provisionsExecutors) {
        const executors = input.executors!;
        const expectedIdList = newNodes.flatMap((node) =>
          node.kind === "work" ? [node.executorAgentId!] : []);
        const expectedIds = new Set(expectedIdList);
        const suppliedIds = new Set(executors.map((agent) => agent.id));
        if (
          expectedIdList.length !== expectedIds.size
          || executors.length !== suppliedIds.size
          || expectedIds.size !== suppliedIds.size
          || [...expectedIds].some((id) => !suppliedIds.has(id))
          || executors.some((agent) =>
            agent.userId !== input.userId
            || agent.sessionId !== row.owner_session_id
            || agent.rootAgentId !== row.root_agent_id
            || agent.parentAgentId !== row.controller_agent_id)
        ) {
          throw new Error("Workflow expansion executors must exactly cover its new work nodes");
        }
        const count = Number((db.prepare(
          "SELECT COUNT(*) AS count FROM agent_nodes WHERE user_id = ? AND root_agent_id = ? AND status <> 'closed'",
        ).get(input.userId, row.root_agent_id) as { count: number }).count);
        if (count + executors.length > maxTreeAgents!) {
          throw new RangeError(`Agent tree limit reached (${maxTreeAgents})`);
        }
        insertWorkflowExecutorAgentsInTransaction(executors);
      }
      assertGraphExecutors(input.userId, row.root_agent_id, row.controller_agent_id, newNodes);
      for (const node of newNodes) insertNode(row.id, node, depth, input.at, controller.id);
      if (provisionsExecutors) {
        insertManagedWorkflowExecutorsInTransaction(row.id, newNodes, input.executors!);
      }
      insertEdges(row.id, input.edges, input.at);
      const next = db.prepare(
        `UPDATE workflows SET graph_revision = graph_revision + 1, run_revision = run_revision + 1,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND graph_revision = ? RETURNING *`,
      ).get(input.at, row.id, input.userId, input.expectedGraphRevision) as WorkflowRow | undefined;
      if (!next) throw new Error("Workflow expansion CAS changed inside its transaction");
      const advanced = advanceWorkflow(next, input.at);
      const final = ownedWorkflow(input.userId, row.id)!;
      appendEvent(final, "workflow.graph_expanded", {
        controller: controller.id,
        actorTask: input.actorTaskId,
        actorLease: input.actorLeaseGeneration,
        nodesAdded: newNodes.length,
        edgesAdded: input.edges.length,
        graphNodes: candidate.nodes.length,
        stateChanges: advanced.changes.length,
        retiredExecutors: advanced.retiredExecutors,
      }, input.at, mutationId, digest);
      return snapshotUnsafe(input.userId, row.id)!;
    });
  },

  sealGraph(input: SealWorkflowInput): WorkflowSnapshot | null {
    const digest = requestDigest({
      controllerNodeId: input.controllerNodeId,
      actorTaskId: input.actorTaskId,
      actorLeaseGeneration: input.actorLeaseGeneration,
      seal: true,
    });
    const mutationId = input.mutationId
      ?? `seal:${sha256(`${input.actorTaskId}:${input.actorLeaseGeneration}:${digest}`).slice(0, 64)}`;
    return runInTransaction(() => {
      const row = ownedWorkflow(input.userId, input.workflowId);
      if (!row) return null;
      if (sameMutation(row.id, mutationId, digest)) return snapshotUnsafe(input.userId, row.id)!;
      if (row.graph_revision !== input.expectedGraphRevision) return null;
      if (row.graph_sealed === 1) return snapshotUnsafe(input.userId, row.id)!;
      if (row.status !== "running" && row.status !== "waiting") {
        throw new Error("Terminal Workflow graph cannot be sealed");
      }
      const controller = controllerActor(
        row.id,
        input.controllerNodeId,
        input.actorTaskId,
        input.actorLeaseGeneration,
        true,
      );
      if (!controller) throw new Error("Graph seal requires the current controller Task lease");
      const next = db.prepare(
        `UPDATE workflows SET graph_sealed = 1, graph_revision = graph_revision + 1,
           run_revision = run_revision + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND graph_revision = ? RETURNING *`,
      ).get(input.at, row.id, input.userId, input.expectedGraphRevision) as WorkflowRow | undefined;
      if (!next) return null;
      const advanced = advanceWorkflow(next, input.at);
      const final = ownedWorkflow(input.userId, row.id)!;
      appendEvent(final, "workflow.graph_sealed", {
        controller: input.controllerNodeId,
        actorTask: input.actorTaskId,
        actorLease: input.actorLeaseGeneration,
        changes: eventPayloadChanges(advanced.changes),
        retiredExecutors: advanced.retiredExecutors,
      }, input.at, mutationId, digest);
      return snapshotUnsafe(input.userId, row.id)!;
    });
  },

  signal(
    userId: string,
    workflowId: string,
    signalName: string,
    expectedVersion: number,
    at: number,
  ): { accepted: boolean; snapshot: WorkflowSnapshot } | null {
    assertIdentifier(signalName, "Workflow signal");
    return runInTransaction(() => {
      const row = ownedWorkflow(userId, workflowId);
      if (!row) return null;
      const existing = db.prepare(
        `SELECT 1 FROM workflow_signals
         WHERE workflow_id = ? AND signal_name = ? AND definition_version = ?`,
      ).get(row.id, signalName, row.definition_version);
      if (existing) return { accepted: false, snapshot: snapshotUnsafe(userId, row.id)! };
      if (row.version !== expectedVersion) return null;
      if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled" || row.status === "interrupted") {
        throw new Error("Terminal Workflow cannot receive a signal");
      }
      const count = db.prepare(
        "SELECT COUNT(*) AS count FROM workflow_signals WHERE workflow_id = ?",
      ).get(row.id) as { count: number };
      if (Number(count.count) >= row.max_nodes) throw new RangeError("Workflow signal budget exceeded");
      db.prepare(
        `INSERT INTO workflow_signals
           (workflow_id, signal_name, definition_version, graph_revision, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, signalName, row.definition_version, row.graph_revision, at);
      const next = db.prepare(
        `UPDATE workflows SET run_revision = run_revision + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(at, row.id, userId, expectedVersion) as WorkflowRow | undefined;
      if (!next) return null;
      const advanced = advanceWorkflow(next, at);
      const final = ownedWorkflow(userId, row.id)!;
      appendEvent(final, "workflow.signal_received", {
        signal: signalName,
        changes: eventPayloadChanges(advanced.changes),
        retiredExecutors: advanced.retiredExecutors,
      }, at);
      return { accepted: true, snapshot: snapshotUnsafe(userId, row.id)! };
    });
  },

  claim(input: ClaimWorkflowNodeInput): WorkflowDispatch | null {
    assertIdentifier(input.taskId, "Workflow Task id");
    if (input.resultId !== undefined) assertIdentifier(input.resultId, "Workflow result id");
    return runInTransaction(() => {
      const workflowRow = ownedWorkflow(input.userId, input.workflowId);
      if (!workflowRow || workflowRow.version !== input.expectedVersion) return null;
      if (workflowRow.status !== "running" && workflowRow.status !== "waiting") {
        throw new Error("Workflow is not dispatchable");
      }
      const nodeRow = db.prepare(
        "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND id = ?",
      ).get(workflowRow.id, input.nodeId) as WorkflowNodeRow | undefined;
      if (!nodeRow || nodeRow.status !== "ready") return null;
      if (nodeRow.kind !== "work" && nodeRow.kind !== "controller") {
        throw new Error("Only work and controller nodes create Runtime Tasks");
      }
      if (nodeRow.attempt_count >= nodeRow.max_attempts) {
        throw new WorkflowDispatchUnavailableError("node_attempts");
      }
      if (workflowRow.attempts_used >= workflowRow.max_attempts) {
        throw new WorkflowDispatchUnavailableError("attempts");
      }
      if (workflowRow.tokens_used + workflowRow.tokens_reserved >= workflowRow.max_tokens) {
        throw new WorkflowDispatchUnavailableError("tokens");
      }
      if (workflowRow.cost_used_micros + workflowRow.cost_reserved_micros >= workflowRow.max_cost_micros) {
        throw new WorkflowDispatchUnavailableError("cost");
      }
      if (workflowRow.started_at !== null && input.at - workflowRow.started_at > workflowRow.max_runtime_ms) {
        throw new WorkflowDispatchUnavailableError("deadline");
      }
      if (workflowRow.root_agent_id === null || nodeRow.executor_agent_id === null) {
        throw new Error("Workflow node lost its durable executor Agent binding");
      }
      if (nodeRow.kind === "controller" && workflowRow.controller_agent_id !== nodeRow.executor_agent_id) {
        throw new Error("Controller nodes require the declared Workflow controller Agent");
      }
      const agent = assertWorkflowExecutor(input.userId, nodeRow.executor_agent_id, workflowRow.root_agent_id);
      const node = mapNode(nodeRow);
      if (node.cachePolicy === "evidence" && !WORKFLOW_EXECUTION_CACHE_ENABLED) {
        throw new Error("Workflow execution cache requires an isolated trusted executor");
      }
      const evidence = input.cacheHit?.evidence ?? input.cacheEvidence;
      let cacheKey: string | undefined;
      let cache: CacheRow | undefined;
      if (node.cachePolicy === "evidence") {
        if (evidence !== undefined) {
          assertCacheDependencyEvidence(workflowRow.id, node.id, evidence);
          cacheKey = workflowCacheKey(node, evidence);
          if (!cacheKey) throw new Error("Workflow node is not eligible for execution cache");
        }
        if (input.cacheHit) {
          if (!evidence || !cacheKey) throw new Error("A Workflow cache hit requires bounded evidence");
          if (input.cacheHit.key !== cacheKey) throw new Error("Workflow cache key does not match its evidence");
          cache = db.prepare(
            `SELECT * FROM workflow_cache_entries
             WHERE user_id = ? AND cache_key = ? AND contract_version = ?`,
          ).get(input.userId, cacheKey, WORKFLOW_CACHE_CONTRACT_VERSION) as CacheRow | undefined;
          if (!cache) return null;
          if (!input.resultId) throw new Error("A cache hit requires a new result id");
        }
      } else if (input.cacheHit || input.cacheEvidence) {
        throw new Error("Workflow node does not allow execution cache");
      }
      const cacheHit = cache !== undefined;
      const tokensAvailable = workflowRow.max_tokens - workflowRow.tokens_used - workflowRow.tokens_reserved;
      const costAvailable = workflowRow.max_cost_micros
        - workflowRow.cost_used_micros
        - workflowRow.cost_reserved_micros;
      const tokensReserved = cacheHit ? 0 : Math.min(tokensAvailable, WORKFLOW_ATTEMPT_TOKEN_RESERVATION);
      const costReservedMicros = cacheHit
        ? 0
        : Math.min(costAvailable, WORKFLOW_ATTEMPT_COST_RESERVATION_MICROS);
      if (!cacheHit && tokensReserved < 1) throw new WorkflowDispatchUnavailableError("tokens");
      if (!cacheHit && costReservedMicros < 1) throw new WorkflowDispatchUnavailableError("cost");
      const deadlineAt = (workflowRow.started_at ?? input.at) + workflowRow.max_runtime_ms;
      const capability = workflowCapabilityProfile(node);
      let task = createWorkflowRuntimeTaskInTransaction({
        id: input.taskId,
        userId: input.userId,
        sessionId: agent.sessionId,
        ownerSessionId: workflowRow.owner_session_id,
        agentId: nodeRow.executor_agent_id,
        workflowId: workflowRow.id,
        workflowNodeId: node.id,
        title: node.name,
        payload: workflowTaskPayload(workflowRow, node, {
          maxTokens: tokensReserved,
          maxCostMicros: costReservedMicros,
          deadlineAt,
        }, capability),
        checkpointSafe: capability.checkpointSafe,
        capabilityContractVersion: WORKFLOW_CAPABILITY_CONTRACT_VERSION,
        createdAt: input.at,
      });
      let result: TaskResult | undefined;
      let sourceResultId: string | null = null;
      if (cache) {
        const sourceResult = db.prepare(
          "SELECT id FROM task_results WHERE task_id = ?",
        ).get(cache.source_task_id) as { id: string } | undefined;
        if (!sourceResult) throw new Error("Workflow cache evidence lost its source result");
        sourceResultId = sourceResult.id;
        const completed = completeCachedWorkflowTaskInTransaction({
          id: input.resultId!,
          taskId: input.taskId,
          userId: input.userId,
          cacheKey: cache.cache_key,
          summary: cache.summary,
          body: JSON.parse(cache.body_json) as OrchestrationJson,
          artifacts: JSON.parse(cache.artifacts_json) as OrchestrationJson,
          createdAt: input.at,
        });
        task = completed.task;
        result = completed.result;
        db.prepare(
          `UPDATE workflow_cache_entries SET last_used_at = ?, hit_count = hit_count + 1
           WHERE user_id = ? AND cache_key = ?`,
        ).run(input.at, input.userId, cache.cache_key);
      }
      const attemptNo = nodeRow.attempt_count + 1;
      const evidenceValue = JSON.parse(stableJson(evidence ?? {})) as OrchestrationJson;
      const evidenceJson = encodeJson(evidenceValue, WORKFLOW_EVENT_PAYLOAD_MAX_BYTES, "Workflow cache evidence");
      db.prepare(
        `INSERT INTO workflow_node_attempts
           (workflow_id, node_id, attempt_no, task_id, status, execution_phase, source, cache_key,
            source_task_id, source_result_id, evidence_json, tokens_used, tokens_reserved,
            cost_used_micros, cost_reserved_micros, deadline_at, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)`,
      ).run(
        workflowRow.id,
        node.id,
        attemptNo,
        input.taskId,
        cacheHit ? "succeeded" : "running",
        cacheHit ? "succeeded" : "queued",
        cacheHit ? "cache" : "execution",
        cacheKey ?? null,
        cache?.source_task_id ?? null,
        sourceResultId,
        evidenceJson,
        tokensReserved,
        costReservedMicros,
        deadlineAt,
        input.at,
        cacheHit ? input.at : null,
      );
      db.prepare(
        `UPDATE workflow_nodes SET status = ?, execution_phase = ?, attempt_count = attempt_count + 1,
           output_digest = ?, version = version + 1, updated_at = ?, settled_at = ?
         WHERE workflow_id = ? AND id = ? AND version = ?`,
      ).run(
        cacheHit ? "succeeded" : "running",
        cacheHit ? "succeeded" : "queued",
        cache?.output_digest ?? null,
        input.at,
        cacheHit ? input.at : null,
        workflowRow.id,
        node.id,
        nodeRow.version,
      );
      const next = db.prepare(
        `UPDATE workflows SET attempts_used = attempts_used + 1,
           tokens_reserved = tokens_reserved + ?,
           cost_reserved_micros = cost_reserved_micros + ?,
           run_revision = run_revision + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(
        tokensReserved,
        costReservedMicros,
        input.at,
        workflowRow.id,
        input.userId,
        input.expectedVersion,
      ) as WorkflowRow | undefined;
      if (!next) throw new Error("Workflow claim CAS changed inside its transaction");
      const advanced = advanceWorkflow(next, input.at);
      const final = ownedWorkflow(input.userId, workflowRow.id)!;
      appendEvent(final, cacheHit ? "workflow.node_cache_hit" : "workflow.node_dispatched", {
        node: node.id,
        attempt: attemptNo,
        task: input.taskId,
        tokensReserved,
        costReservedMicros,
        deadlineAt,
        ...(cacheKey === undefined ? {} : { cacheKey }),
        changes: eventPayloadChanges(advanced.changes),
        retiredExecutors: advanced.retiredExecutors,
      }, input.at);
      const attemptRow = db.prepare(
        "SELECT * FROM workflow_node_attempts WHERE workflow_id = ? AND node_id = ? AND attempt_no = ?",
      ).get(workflowRow.id, node.id, attemptNo) as unknown as WorkflowAttemptRow;
      const currentNode = db.prepare(
        "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND id = ?",
      ).get(workflowRow.id, node.id) as unknown as WorkflowNodeRow;
      return {
        workflow: mapWorkflow(final),
        node: mapNode(currentNode),
        attempt: mapAttempt(attemptRow),
        task,
        ...(result === undefined ? {} : { result }),
      };
    });
  },

  recordUsage(input: RecordWorkflowAttemptUsageInput): WorkflowSnapshot | null {
    const tokens = int(input.tokensUsed, "Workflow token usage", 0, 100_000_000);
    const cost = int(input.costUsedMicros, "Workflow cost usage", 0, 1_000_000_000_000);
    return runInTransaction(() => {
      const workflowRow = ownedWorkflow(input.userId, input.workflowId);
      if (!workflowRow || workflowRow.version !== input.expectedVersion) return null;
      const attempt = db.prepare(
        `SELECT a.* FROM workflow_node_attempts a
         JOIN runtime_tasks t ON t.id = a.task_id
         WHERE a.workflow_id = ? AND a.node_id = ? AND a.task_id = ?
           AND a.status IN ('running','cancel_requested')
           AND t.user_id = ? AND t.workflow_id = ? AND t.lease_generation = ?
           AND t.status IN ('starting','running','waiting','cancel_requested')`,
      ).get(
        input.workflowId,
        input.nodeId,
        input.taskId,
        input.userId,
        input.workflowId,
        input.expectedTaskLeaseGeneration,
      ) as unknown as WorkflowAttemptRow | undefined;
      if (!attempt) return null;
      if (tokens < attempt.tokens_used || cost < attempt.cost_used_micros) {
        throw new Error("Workflow attempt usage is cumulative and cannot decrease");
      }
      const tokenDelta = tokens - attempt.tokens_used;
      const costDelta = cost - attempt.cost_used_micros;
      if (tokenDelta === 0 && costDelta === 0) return snapshotUnsafe(input.userId, input.workflowId)!;
      const tokensReleased = Math.min(tokenDelta, attempt.tokens_reserved);
      const costReleasedMicros = Math.min(costDelta, attempt.cost_reserved_micros);
      db.prepare(
        `UPDATE workflow_node_attempts SET tokens_used = ?, tokens_reserved = tokens_reserved - ?,
           cost_used_micros = ?, cost_reserved_micros = cost_reserved_micros - ?
         WHERE workflow_id = ? AND node_id = ? AND task_id = ?
           AND status IN ('running','cancel_requested')`,
      ).run(
        tokens,
        tokensReleased,
        cost,
        costReleasedMicros,
        input.workflowId,
        input.nodeId,
        input.taskId,
      );
      db.prepare(
        `UPDATE runtime_tasks SET provider_tokens_used = ?, provider_cost_used_micros = ?
         WHERE id = ? AND user_id = ? AND workflow_id = ? AND lease_generation = ?
           AND status IN ('starting','running','waiting','cancel_requested')`,
      ).run(
        tokens,
        cost,
        input.taskId,
        input.userId,
        input.workflowId,
        input.expectedTaskLeaseGeneration,
      );
      const next = db.prepare(
        `UPDATE workflows SET tokens_used = tokens_used + ?,
           tokens_reserved = tokens_reserved - ?,
           cost_used_micros = cost_used_micros + ?,
           cost_reserved_micros = cost_reserved_micros - ?,
           run_revision = run_revision + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(
        tokenDelta,
        tokensReleased,
        costDelta,
        costReleasedMicros,
        input.at,
        input.workflowId,
        input.userId,
        input.expectedVersion,
      ) as WorkflowRow | undefined;
      if (!next) throw new Error("Workflow usage CAS changed inside its transaction");
      const beforeStatus = next.status;
      const advanced = advanceWorkflow(next, input.at);
      const final = ownedWorkflow(input.userId, input.workflowId)!;
      const transitioned = advanced.cancelledTasks > 0
        || advanced.changes.length > 0
        || final.status !== beforeStatus;
      appendEvent(final, transitioned ? "workflow.budget_transition" : "workflow.usage_checkpoint", {
          node: input.nodeId,
          task: input.taskId,
          tokens,
          costMicros: cost,
          reservationReleased: { tokens: tokensReleased, costMicros: costReleasedMicros },
          cancelledTasks: advanced.cancelledTasks,
          retiredExecutors: advanced.retiredExecutors,
          ...(advanced.budgetReason === undefined ? {} : { budgetReason: advanced.budgetReason }),
          changes: eventPayloadChanges(advanced.changes),
      }, input.at);
      return snapshotUnsafe(input.userId, input.workflowId)!;
    });
  },

  recordLateUsage(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
    tokensUsed: number;
    costUsedMicros: number;
    at: number;
  }): WorkflowSnapshot | null {
    const tokens = int(input.tokensUsed, "Workflow late token usage", 0, 100_000_000);
    const cost = int(input.costUsedMicros, "Workflow late cost usage", 0, 1_000_000_000_000);
    return runInTransaction(() => {
      const row = db.prepare(
        `SELECT attempt.*, workflow.user_id, workflow.version AS workflow_version
         FROM workflow_node_attempts attempt
         JOIN workflows workflow ON workflow.id = attempt.workflow_id
         JOIN runtime_tasks task ON task.id = attempt.task_id
         WHERE attempt.task_id = ? AND workflow.user_id = ? AND task.user_id = ?
           AND task.lease_generation = ?
           AND attempt.status IN ('succeeded','failed','cancelled','interrupted')
           AND task.status IN ('succeeded','failed','cancelled','interrupted')`,
      ).get(
        input.taskId,
        input.userId,
        input.userId,
        input.expectedTaskLeaseGeneration,
      ) as unknown as (WorkflowAttemptRow & { workflow_version: number }) | undefined;
      if (!row) return null;
      if (tokens < row.tokens_used || cost < row.cost_used_micros) {
        throw new Error("Workflow late usage is cumulative and cannot decrease");
      }
      const tokenDelta = tokens - row.tokens_used;
      const costDelta = cost - row.cost_used_micros;
      if (tokenDelta === 0 && costDelta === 0) {
        return snapshotUnsafe(input.userId, row.workflow_id)!;
      }
      db.prepare(
        `UPDATE workflow_node_attempts SET tokens_used = ?, cost_used_micros = ?
         WHERE workflow_id = ? AND node_id = ? AND attempt_no = ?
           AND status IN ('succeeded','failed','cancelled','interrupted')`,
      ).run(tokens, cost, row.workflow_id, row.node_id, row.attempt_no);
      db.prepare(
        `UPDATE runtime_tasks SET provider_tokens_used = ?, provider_cost_used_micros = ?
         WHERE id = ? AND user_id = ? AND lease_generation = ?
           AND status IN ('succeeded','failed','cancelled','interrupted')`,
      ).run(tokens, cost, input.taskId, input.userId, input.expectedTaskLeaseGeneration);
      const next = db.prepare(
        `UPDATE workflows SET tokens_used = tokens_used + ?,
           cost_used_micros = cost_used_micros + ?, run_revision = run_revision + 1,
           version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(
        tokenDelta,
        costDelta,
        input.at,
        row.workflow_id,
        input.userId,
        row.workflow_version,
      ) as WorkflowRow | undefined;
      if (!next) throw new Error("Workflow late usage CAS changed inside its transaction");
      const advanced = advanceWorkflow(next, input.at);
      const final = ownedWorkflow(input.userId, row.workflow_id)!;
      appendEvent(final, "workflow.usage_late", {
        node: row.node_id,
        task: input.taskId,
        tokens,
        costMicros: cost,
        delta: { tokens: tokenDelta, costMicros: costDelta },
        cancelledTasks: advanced.cancelledTasks,
        retiredExecutors: advanced.retiredExecutors,
        ...(advanced.budgetReason === undefined ? {} : { budgetReason: advanced.budgetReason }),
      }, input.at);
      return snapshotUnsafe(input.userId, row.workflow_id)!;
    });
  },

  settle(input: SettleWorkflowAttemptInput): WorkflowSnapshot | null {
    return runInTransaction(() => settleWorkflowAttemptInTransaction(input));
  },

  settleExecution(input: SettleWorkflowExecutionInput): WorkflowExecutionSettlement | null {
    return runInTransaction(() => {
      const target = db.prepare(
        `SELECT w.id AS workflow_id, w.version AS workflow_version, a.node_id
         FROM workflow_node_attempts a
         JOIN workflows w ON w.id = a.workflow_id
         JOIN runtime_tasks t ON t.id = a.task_id
         WHERE a.task_id = ? AND a.workflow_id = t.workflow_id
           AND w.user_id = ? AND t.user_id = ?
           AND a.status IN ('running','cancel_requested')`,
      ).get(input.taskId, input.userId, input.userId) as {
        workflow_version: number;
        workflow_id: string;
        node_id: string;
      } | undefined;
      if (!target) return null;
      const settled = settleWorkflowRuntimeTaskResultInTransaction({
        ...input,
        workflowId: target.workflow_id,
        workflowNodeId: target.node_id,
      });
      if (!settled) return null;
      const snapshot = settleWorkflowAttemptInTransaction({
        workflowId: settled.task.workflowId!,
        userId: input.userId,
        nodeId: target.node_id,
        taskId: settled.task.id,
        expectedTaskLeaseGeneration: settled.task.leaseGeneration,
        expectedVersion: Number(target.workflow_version),
        ...(input.tokensUsed === undefined ? {} : { tokensUsed: input.tokensUsed }),
        ...(input.costUsedMicros === undefined ? {} : { costUsedMicros: input.costUsedMicros }),
        ...(input.cacheAttestation === undefined ? {} : { cacheAttestation: input.cacheAttestation }),
        at: input.createdAt,
      });
      if (!snapshot) throw new Error("Workflow projection changed during atomic Task settlement");
      return { ...settled, snapshot };
    });
  },

  settleExecutionWithoutResult(
    input: SettleWorkflowExecutionWithoutResultInput,
  ): WorkflowExecutionTerminalSettlement | null {
    return runInTransaction(() => {
      const target = db.prepare(
        `SELECT workflow.id AS workflow_id, attempt.node_id
         FROM workflow_node_attempts attempt
         JOIN workflows workflow ON workflow.id = attempt.workflow_id
         JOIN runtime_tasks task ON task.id = attempt.task_id
         WHERE attempt.task_id = ? AND workflow.user_id = ? AND task.user_id = ?
           AND attempt.status IN ('running','cancel_requested')`,
      ).get(input.id, input.userId, input.userId) as {
        workflow_id: string;
        node_id: string;
      } | undefined;
      if (!target) return null;
      const task = settleWorkflowRuntimeTaskWithoutResultInTransaction(input);
      if (!task) return null;
      const workflow = ownedWorkflow(input.userId, target.workflow_id);
      if (!workflow) throw new Error("Workflow disappeared during terminal Task settlement");
      const snapshot = settleWorkflowAttemptInTransaction({
        workflowId: target.workflow_id,
        userId: input.userId,
        nodeId: target.node_id,
        taskId: task.id,
        expectedTaskLeaseGeneration: task.leaseGeneration,
        expectedVersion: workflow.version,
        ...(input.tokensUsed === undefined ? {} : { tokensUsed: input.tokensUsed }),
        ...(input.costUsedMicros === undefined ? {} : { costUsedMicros: input.costUsedMicros }),
        at: input.at,
      });
      if (!snapshot) throw new Error("Workflow projection changed during terminal Task settlement");
      return { task, snapshot };
    });
  },

  cancel(
    userId: string,
    workflowId: string,
    expectedVersion: number,
    at: number,
  ): WorkflowSnapshot | null {
    return runInTransaction(() => {
      const row = ownedWorkflow(userId, workflowId);
      if (!row) return null;
      if (row.status === "cancelled") return snapshotUnsafe(userId, row.id)!;
      if (row.cancellation_pending === 1) return snapshotUnsafe(userId, row.id)!;
      if (row.version !== expectedVersion) return null;
      if (row.status === "succeeded" || row.status === "failed" || row.status === "interrupted") {
        throw new Error("Settled Workflow cannot be cancelled");
      }
      const changes: AdvanceChange[] = [];
      const cancellation = cancelWorkflowTasks(row.id, userId, at);
      cancelNodesWithoutOpenAttempts(row.id, at, changes);
      const pending = openAttemptCount(row.id) > 0;
      const projected = ownedWorkflow(userId, row.id)!;
      const next = db.prepare(
        `UPDATE workflows SET status = ?, cancellation_pending = ?, terminal_intent = ?, settled_at = ?,
           run_revision = run_revision + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ? RETURNING *`,
      ).get(
        pending ? projected.status : "cancelled",
        pending ? 1 : 0,
        pending ? "cancelled" : null,
        pending ? null : at,
        at,
        row.id,
        userId,
        projected.version,
      ) as WorkflowRow | undefined;
      if (!next) return null;
      const retiredExecutors = retireManagedWorkflowExecutorsInTransaction(next, at);
      appendEvent(next, pending ? "workflow.cancel_requested" : "workflow.cancelled", {
        tasks: cancellation.total,
        pendingTasks: openAttemptCount(row.id),
        retiredExecutors,
        changes: eventPayloadChanges(changes),
      }, at);
      return snapshotUnsafe(userId, row.id)!;
    });
  },

  recover(userId: string, workflowId: string, at: number): WorkflowRecoveryResult | null {
    if (!ownedWorkflow(userId, workflowId)) return null;
    const result: WorkflowRecoveryResult = { unchanged: 0, reconciled: 0, retried: 0, failed: 0 };
    while (true) {
      const snapshot = snapshotUnsafe(userId, workflowId);
      if (!snapshot) return null;
      const candidate = db.prepare(
        `SELECT a.node_id, a.task_id, t.status, t.lease_generation
         FROM workflow_node_attempts a
         JOIN runtime_tasks t ON t.id = a.task_id
         WHERE a.workflow_id = ? AND a.status IN ('running','cancel_requested')
           AND t.status IN ('succeeded','failed','cancelled','interrupted')
         ORDER BY a.created_at, a.node_id LIMIT 1`,
      ).get(workflowId) as {
        node_id: string;
        task_id: string;
        status: string;
        lease_generation: number;
      } | undefined;
      if (!candidate) {
        const open = db.prepare(
          `SELECT COUNT(*) AS count FROM workflow_node_attempts a
           JOIN runtime_tasks t ON t.id = a.task_id
           WHERE a.workflow_id = ? AND a.status IN ('running','cancel_requested')
             AND t.status NOT IN ('succeeded','failed','cancelled','interrupted')`,
        ).get(workflowId) as { count: number };
        result.unchanged = Number(open.count);
        return result;
      }
      const before = snapshot.nodes.find((node) => node.id === candidate.node_id)!;
      const settled = workflowDao.settle({
        workflowId,
        userId,
        nodeId: candidate.node_id,
        taskId: candidate.task_id,
        expectedTaskLeaseGeneration: Number(candidate.lease_generation),
        expectedVersion: snapshot.workflow.version,
        recoverMissingResult: true,
        at,
      });
      if (!settled) continue;
      result.reconciled += 1;
      const after = settled.nodes.find((node) => node.id === candidate.node_id)!;
      if (after.status === "ready" && before.attemptCount === after.attemptCount) result.retried += 1;
      if (after.status === "failed") result.failed += 1;
    }
  },

  readDependencyResult(input: ReadWorkflowDependencyResultInput): TaskResult | undefined {
    const row = db.prepare(
      `WITH RECURSIVE actor(node_id) AS (
         SELECT attempt.node_id FROM workflow_node_attempts attempt
         JOIN runtime_tasks task ON task.id = attempt.task_id
         JOIN workflows workflow ON workflow.id = attempt.workflow_id
         WHERE attempt.workflow_id = ? AND attempt.task_id = ?
           AND attempt.attempt_no = (
             SELECT node.attempt_count FROM workflow_nodes node
             WHERE node.workflow_id = attempt.workflow_id AND node.id = attempt.node_id
           )
           AND attempt.status IN ('running','cancel_requested')
           AND task.user_id = ? AND task.lease_generation = ?
           AND task.status IN ('starting','running','waiting','cancel_requested')
           AND workflow.user_id = ?
       ), upstream(id) AS (
         SELECT edge.from_node_id FROM workflow_edges edge
         JOIN actor ON actor.node_id = edge.to_node_id
         WHERE edge.workflow_id = ?
         UNION
         SELECT edge.from_node_id FROM workflow_edges edge
         JOIN upstream child ON child.id = edge.to_node_id
         WHERE edge.workflow_id = ?
       )
       SELECT result.task_id FROM upstream
       JOIN workflow_nodes node ON node.workflow_id = ? AND node.id = upstream.id
       JOIN workflow_node_attempts attempt
         ON attempt.workflow_id = node.workflow_id AND attempt.node_id = node.id
        AND attempt.attempt_no = node.attempt_count
       JOIN task_results result ON result.task_id = attempt.task_id
       WHERE result.id = ? LIMIT 1`,
    ).get(
      input.workflowId,
      input.actorTaskId,
      input.userId,
      input.actorLeaseGeneration,
      input.userId,
      input.workflowId,
      input.workflowId,
      input.workflowId,
      input.resultId,
    ) as { task_id: string } | undefined;
    return row ? taskResultDao.byTask(input.userId, row.task_id) : undefined;
  },

  toolActorTarget(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
  }): {
    workflowId: string;
    nodeId: string;
    nodeKind: WorkflowNode["kind"];
    workflowVersion: number;
    graphRevision: number;
    graphSealed: boolean;
    taskStatus: RuntimeTask["status"];
  } | undefined {
    const row = db.prepare(
      `SELECT workflow.id AS workflow_id, workflow.version AS workflow_version,
              workflow.graph_revision, workflow.graph_sealed,
              node.id AS node_id, node.kind AS node_kind, task.status AS task_status
       FROM workflow_node_attempts attempt
       JOIN runtime_tasks task ON task.id = attempt.task_id
       JOIN workflows workflow ON workflow.id = attempt.workflow_id
       JOIN workflow_nodes node
         ON node.workflow_id = attempt.workflow_id AND node.id = attempt.node_id
       WHERE attempt.task_id = ? AND task.user_id = ? AND workflow.user_id = ?
         AND task.lease_generation = ?
         AND attempt.attempt_no = node.attempt_count
         AND attempt.status IN ('running','cancel_requested')
         AND task.status IN ('starting','running','waiting','cancel_requested')`,
    ).get(
      input.taskId,
      input.userId,
      input.userId,
      input.expectedTaskLeaseGeneration,
    ) as {
      workflow_id: string;
      workflow_version: number;
      graph_revision: number;
      graph_sealed: number;
      node_id: string;
      node_kind: WorkflowNode["kind"];
      task_status: RuntimeTask["status"];
    } | undefined;
    return row ? {
      workflowId: row.workflow_id,
      nodeId: row.node_id,
      nodeKind: row.node_kind,
      workflowVersion: Number(row.workflow_version),
      graphRevision: Number(row.graph_revision),
      graphSealed: row.graph_sealed === 1,
      taskStatus: row.task_status,
    } : undefined;
  },

  listDependencyHandlesForActor(input: {
    userId: string;
    taskId: string;
    expectedTaskLeaseGeneration: number;
  }): WorkflowDependencyHandleList | undefined {
    const actor = workflowDao.toolActorTarget(input);
    return actor ? dependencyHandles(actor.workflowId, actor.nodeId) : undefined;
  },

  attemptTarget(userId: string, taskId: string): WorkflowAttemptTarget | undefined {
    const row = db.prepare(
      `SELECT w.id AS workflow_id, w.version AS workflow_version,
              a.node_id, a.task_id, t.lease_generation, t.status
       FROM workflow_node_attempts a
       JOIN workflows w ON w.id = a.workflow_id
       JOIN runtime_tasks t ON t.id = a.task_id
       WHERE w.user_id = ? AND t.user_id = ? AND a.task_id = ?`,
    ).get(userId, userId, taskId) as {
      workflow_id: string;
      workflow_version: number;
      node_id: string;
      task_id: string;
      lease_generation: number;
      status: RuntimeTask["status"];
    } | undefined;
    if (!row) return undefined;
    return {
      workflowId: row.workflow_id,
      nodeId: row.node_id,
      taskId: row.task_id,
      taskLeaseGeneration: Number(row.lease_generation),
      taskStatus: row.status,
      workflowVersion: Number(row.workflow_version),
    };
  },

  listCoordinatorCandidates(
    userId: string,
    options: Readonly<{
      limit?: number;
      after?: WorkflowCoordinatorCursor;
    }> = {},
  ): Workflow[] {
    const limit = int(options.limit ?? 50, "Workflow coordinator limit", 1, 200);
    const after = options.after;
    return (db.prepare(
      `SELECT workflow.* FROM workflows workflow
       JOIN (
         SELECT active.id FROM workflows active
         WHERE active.user_id = ? AND active.root_agent_id IS NOT NULL
           AND (active.status IN ('queued','running','waiting') OR active.cancellation_pending = 1)
           AND (? IS NULL OR active.id > ?)
         UNION
         SELECT dirty.id FROM workflows dirty
         WHERE dirty.user_id = ? AND dirty.root_agent_id IS NOT NULL
           AND (? IS NULL OR dirty.id > ?)
           AND EXISTS (
             SELECT 1 FROM workflow_node_attempts attempt
             JOIN runtime_tasks task ON task.id = attempt.task_id
             WHERE attempt.workflow_id = dirty.id
               AND attempt.status IN ('running','cancel_requested')
               AND task.status IN ('succeeded','failed','cancelled','interrupted')
           )
       ) candidate ON candidate.id = workflow.id
       ORDER BY workflow.id ASC LIMIT ?`,
    ).all(
      userId,
      after?.id ?? null,
      after?.id ?? "",
      userId,
      after?.id ?? null,
      after?.id ?? "",
      limit,
    ) as unknown as WorkflowRow[]).map(mapWorkflow);
  },

  listSchedulerCandidates(
    options: Readonly<{
      limit?: number;
      after?: WorkflowSchedulerCursor;
    }> = {},
  ): Workflow[] {
    const limit = int(options.limit ?? 50, "Workflow scheduler limit", 1, 200);
    const after = options.after;
    return (db.prepare(
      `SELECT workflow.* FROM workflows workflow INDEXED BY idx_workflows_coordinator_active
       WHERE workflow.root_agent_id IS NOT NULL
         AND (workflow.status IN ('queued','running','waiting') OR workflow.cancellation_pending = 1)
         AND (
           ? IS NULL OR workflow.user_id > ?
           OR (workflow.user_id = ? AND workflow.id > ?)
         )
       ORDER BY workflow.user_id ASC, workflow.id ASC LIMIT ?`,
    ).all(
      after?.userId ?? null,
      after?.userId ?? "",
      after?.userId ?? "",
      after?.id ?? "",
      limit,
    ) as unknown as WorkflowRow[]).map(mapWorkflow);
  },

  listCancellationTargets(
    userId: string,
    workflowId: string,
    limit = WORKFLOW_ATTEMPT_HARD_LIMIT,
  ): WorkflowCancellationTarget[] {
    const bounded = int(limit, "Workflow cancellation target limit", 1, WORKFLOW_ATTEMPT_HARD_LIMIT);
    return (db.prepare(
      `SELECT task.user_id, task.session_id, agent.root_agent_id,
              attempt.workflow_id, task.id AS task_id, task.lease_generation
       FROM workflow_node_attempts attempt
       JOIN workflows workflow ON workflow.id = attempt.workflow_id
       JOIN runtime_tasks task ON task.id = attempt.task_id
       JOIN agent_nodes agent ON agent.id = task.agent_id AND agent.user_id = task.user_id
       WHERE workflow.user_id = ? AND workflow.id = ?
         AND workflow.cancellation_pending = 1
         AND attempt.status = 'cancel_requested'
         AND task.status = 'cancel_requested'
       ORDER BY attempt.created_at ASC, task.id ASC LIMIT ?`,
    ).all(userId, workflowId, bounded) as unknown as Array<{
      user_id: string;
      session_id: string;
      root_agent_id: string;
      workflow_id: string;
      task_id: string;
      lease_generation: number;
    }>).map((row) => ({
      userId: row.user_id,
      sessionId: row.session_id,
      rootAgentId: row.root_agent_id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      expectedTaskLeaseGeneration: Number(row.lease_generation),
    }));
  },

  listEvents(userId: string, workflowId: string, afterSeq = 0, limit = 100): WorkflowEvent[] {
    int(afterSeq, "Workflow event cursor", 0, Number.MAX_SAFE_INTEGER);
    const bounded = int(limit, "Workflow event limit", 1, 200);
    if (!ownedWorkflow(userId, workflowId)) return [];
    return (db.prepare(
      `SELECT * FROM workflow_events WHERE workflow_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(workflowId, afterSeq, bounded) as unknown as WorkflowEventRow[]).map(mapEvent);
  },

  cacheEntry(userId: string, key: string): {
    key: string;
    outputDigest: string;
    sourceTaskId: string;
    hitCount: number;
  } | undefined {
    const row = db.prepare(
      `SELECT cache_key, output_digest, source_task_id, hit_count
       FROM workflow_cache_entries WHERE user_id = ? AND cache_key = ?`,
    ).get(userId, key) as {
      cache_key: string; output_digest: string; source_task_id: string; hit_count: number;
    } | undefined;
    if (!row) return undefined;
    return {
      key: row.cache_key,
      outputDigest: row.output_digest,
      sourceTaskId: row.source_task_id,
      hitCount: Number(row.hit_count),
    };
  },
};

export function workflowCacheKey(
  node: Pick<WorkflowNode, "kind" | "effect" | "cachePolicy" | "name" | "payload">,
  evidence: WorkflowCacheEvidence,
): string | undefined {
  if (node.kind !== "work" || node.effect !== "pure_readonly" || node.cachePolicy !== "evidence") {
    return undefined;
  }
  const contractVersion = evidence.contractVersion ?? WORKFLOW_CACHE_CONTRACT_VERSION;
  int(contractVersion, "Workflow cache contract version", 1, 1_000_000);
  if (contractVersion !== WORKFLOW_CACHE_CONTRACT_VERSION) {
    throw new Error("Unsupported Workflow cache contract version");
  }
  for (const [field, value] of Object.entries({
    nodeSpecDigest: evidence.nodeSpecDigest,
    inputDigest: evidence.inputDigest,
    executorDigest: evidence.executorDigest,
  })) {
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(value)) throw new RangeError(`Invalid Workflow cache ${field}`);
  }
  const dependencies = Object.entries(evidence.dependencyOutputDigests).sort(([a], [b]) => a.localeCompare(b));
  if (dependencies.length > WORKFLOW_NODE_HARD_LIMIT) throw new RangeError("Too many Workflow cache dependencies");
  for (const [id, digest] of dependencies) {
    assertIdentifier(id, "Workflow cache dependency id");
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(digest)) throw new RangeError("Invalid Workflow cache dependency digest");
  }
  const canonical = stableJson({
    contractVersion,
    node: { name: node.name, payload: node.payload },
    evidence: {
      nodeSpecDigest: evidence.nodeSpecDigest,
      inputDigest: evidence.inputDigest,
      executorDigest: evidence.executorDigest,
      dependencies,
    },
  });
  return `wf:${contractVersion}:${sha256(canonical)}`;
}
