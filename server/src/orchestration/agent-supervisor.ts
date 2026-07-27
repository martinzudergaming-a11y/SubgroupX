import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
  AgentNode,
  AgentNodeStatus,
  OrchestrationJson,
  RuntimeTask,
  TaskActivityCode,
  TaskAwaitPolicy,
  TaskCancelPolicy,
} from "../../../shared/src/orchestration.ts";
import type { WireAgentEvent } from "../../../shared/src/protocol.ts";
import {
  agentNodeDao,
  agentTaskDao,
  JoinedProgressInvariantError,
  ORCHESTRATION_QUERY_MAX,
  runtimeTaskDao,
} from "../persistence/orchestration.ts";
import { countText } from "../runtime/token-count.ts";
import { stableAgentAliases } from "./context-digest.ts";
import {
  checkpointOwnedTaskUsage,
  recordOwnedTaskLateUsage,
  settleOwnedTask,
} from "./owned-task-settlement.ts";

const ACTIVE_TASK_STATUSES = new Set(["starting", "running", "waiting", "cancel_requested"]);
const CAPACITY_TASK_STATUSES = new Set(["starting", "running", "cancel_requested"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const AGENT_WORKER_TASK_KINDS = new Set(["delegation", "workflow_node"]);
const TASK_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const TASK_RESULT_SUMMARY_MAX_CTX = 1_000;
const TASK_RESULT_SUMMARY_MAX_BYTES = 4 * 1024;

export interface SupervisedAgentResult {
  summary: string;
  body?: OrchestrationJson;
  artifacts?: OrchestrationJson;
  tokensUsed?: number;
  costUsedMicros?: number;
}

export interface SupervisedAgentRun {
  readonly agent: AgentNode;
  readonly task: RuntimeTask;
  readonly signal: AbortSignal;
  updateActivity(activity: TaskActivityCode): void;
  publishProgress(event: WireAgentEvent): boolean;
  checkpointUsage(tokensUsed: number, costUsedMicros: number): boolean;
}

export interface SupervisedAgentWorker {
  run(input: SupervisedAgentRun): Promise<SupervisedAgentResult>;
  contextSnapshot?(): readonly OrchestrationJson[];
  steer?(message: string): boolean | Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface SupervisedAgentWorkerFactoryInput {
  readonly agent: AgentNode;
  readonly userId: string;
  readonly sessionId: string;
  readonly rootAgentId: string;
  readonly signal: AbortSignal;
}

export type SupervisedAgentWorkerFactory = (
  input: SupervisedAgentWorkerFactoryInput,
) => SupervisedAgentWorker | Promise<SupervisedAgentWorker>;

export interface AgentSupervisorLimits {
  maxActivePerParent: number;
  maxActiveAgents: number;
  maxTreeAgents: number;
  maxDepth: number;
  maxOpenTasks: number;
  maxIdleWorkers: number;
}

export const DEFAULT_AGENT_SUPERVISOR_LIMITS: Readonly<AgentSupervisorLimits> = Object.freeze({
  maxActivePerParent: 4,
  maxActiveAgents: 8,
  maxTreeAgents: 32,
  maxDepth: 2,
  maxOpenTasks: 64,
  maxIdleWorkers: 4,
});

export interface AgentSupervisorOptions {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  workerFactory: SupervisedAgentWorkerFactory;
  limits?: Partial<AgentSupervisorLimits>;
  now?: () => number;
  id?: (kind: "agent" | "task" | "result") => string;
  waitPollMs?: number;
  closeTimeoutMs?: number;
  interruptGraceMs?: number;
  defaultAgentConfig?: Readonly<{
    provider: string;
    model: string;
    thinkingLevel?: AgentNode["thinkingLevel"];
  }>;
  executionGate?: () => string | undefined;
  acquireBackgroundPermit?: (task: RuntimeTask) => (() => void) | undefined;
  rejectBackgroundPermit?: () => void;
  onError?: (error: unknown, context: { phase: string; taskId?: string }) => void;
  onActive?: () => void;
  onRunnableHint?: () => void;
  onIdle?: (outcome: "done" | "error" | "parked") => void;
  onInvalidated?: (change: { sessionId: string; rootAgentId: string; revision: number }) => void;
  onTaskChanged?: (taskId: string) => void;
  onAttemptEnd?: (taskId: string) => void;
  onJoinedProgress?: (input: {
    task: RuntimeTask;
    ownerStepId: string;
    progressSeq: number;
    at: number;
    event: WireAgentEvent;
  }) => boolean;
}

export interface SpawnAgentInput {
  taskName: string;
  message: string;
  context?: "none" | "recent" | "all";
  provider?: string;
  model?: string;
  thinkingLevel?: AgentNode["thinkingLevel"];
  initialMessages: readonly OrchestrationJson[];
  parentAgentId?: string;
  parentTaskId?: string;
  ownerTurnId?: string;
  ownerStepId?: string;
  awaitPolicy?: TaskAwaitPolicy;
  cancelPolicy?: TaskCancelPolicy;
  checkpointSafe?: boolean;
  internalPurpose?: "joined-slot";
}

export interface FollowUpAgentInput {
  target: string;
  message: string;
  parentTaskId?: string;
  ownerTurnId?: string;
  ownerStepId?: string;
  awaitPolicy?: TaskAwaitPolicy;
  cancelPolicy?: TaskCancelPolicy;
  checkpointSafe?: boolean;
  resetContext?: boolean;
  internalAgentConfig?: Readonly<{
    provider: string;
    model: string;
    thinkingLevel?: AgentNode["thinkingLevel"];
  }>;
}

export interface AgentTaskHandle {
  agentId: string;
  taskId: string;
  path: string;
  revision: number;
}

export interface WaitForAgentInput {
  afterRevision?: number;
  targets?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  visibility?: "all" | "addressable";
}

export interface WaitForAgentResult {
  revision: number;
  changed: boolean;
  timedOut: boolean;
  agents: AgentNode[];
}

export interface AgentSupervisorStats {
  activeTasks: number;
  openTasks: number;
  backgroundTasks: number;
  cachedWorkers: number;
}

interface ActiveRun {
  agentId: string;
  abort: AbortController;
  task: RuntimeTask;
  attemptLeaseGeneration: number;
  progressSeq: number;
  worker?: SupervisedAgentWorker;
  done: Promise<void>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  unblockTimer?: ReturnType<typeof setTimeout>;
  forceCancelFailures?: number;
  forced?: boolean;
  releasePermit?: () => void;
  attemptOwnershipEnded?: boolean;
}

interface WorkerEntry {
  promise: Promise<SupervisedAgentWorker>;
  usedAt: number;
  closePromise?: Promise<void>;
}

function checkedInt(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function abortError(message = "Agent operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertMessage(message: string): string {
  const value = String(message).trim();
  if (!value) throw new Error("Agent task message must not be empty");
  if (Buffer.byteLength(value, "utf8") > 60 * 1024) {
    throw new RangeError("Agent task message exceeds 61440 UTF-8 bytes");
  }
  return value;
}

function taskTitle(message: string, fallback: string): string {
  const line = message.split(/\r?\n/, 1)[0]!.trim() || fallback;
  const points = Array.from(line);
  return points.length <= 96 ? points.join("") : `${points.slice(0, 95).join("")}…`;
}

function boundedSummary(value: string): string {
  const source = String(value || "Task completed");
  if (
    Buffer.byteLength(source, "utf8") <= TASK_RESULT_SUMMARY_MAX_BYTES
    && countText(source) <= TASK_RESULT_SUMMARY_MAX_CTX
  ) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = source.slice(0, middle);
    if (
      Buffer.byteLength(candidate, "utf8") <= TASK_RESULT_SUMMARY_MAX_BYTES - 16
      && countText(candidate) <= TASK_RESULT_SUMMARY_MAX_CTX - 8
    ) low = middle;
    else high = middle - 1;
  }
  return `${source.slice(0, low)}\n…[truncated]`;
}

export class AgentSupervisor {
  readonly limits: Readonly<AgentSupervisorLimits>;

  private readonly now: () => number;
  private readonly makeId: (kind: "agent" | "task" | "result") => string;
  private readonly lifecycle = new AbortController();
  private readonly active = new Map<string, ActiveRun>();
  private readonly liveAttempts = new Set<string>();
  private readonly activeByAgent = new Map<string, string>();
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly wakeWaiters = new Set<() => void>();
  private readonly blockedAgents = new Map<string, string>();
  private readonly detachedRuns = new Set<Promise<void>>();
  private readonly waitPollMs: number;
  private readonly closeTimeoutMs: number;
  private readonly interruptGraceMs: number;
  private scheduling = false;
  private scheduleAgain = false;
  private scheduleQueued = false;
  private scheduleRetryTimer?: ReturnType<typeof setTimeout>;
  private scheduleFailures = 0;
  private idleNotifyQueued = false;
  private idleRetryTimer?: ReturnType<typeof setTimeout>;
  private idleFailures = 0;
  private activityNotified = false;
  private quiescentOutcome?: "done" | "error" | "parked";
  private invalidationRevision = 0;
  private closed = false;

  constructor(private readonly options: AgentSupervisorOptions) {
    const root = agentNodeDao.byId(options.userId, options.rootAgentId);
    if (!root || root.rootAgentId !== root.id || root.sessionId !== options.sessionId) {
      throw new Error("AgentSupervisor requires an owned, Session-backed root Agent");
    }
    const merged = { ...DEFAULT_AGENT_SUPERVISOR_LIMITS, ...options.limits };
    this.limits = Object.freeze({
      maxActivePerParent: checkedInt(merged.maxActivePerParent, "maxActivePerParent", 1, 32),
      maxActiveAgents: checkedInt(merged.maxActiveAgents, "maxActiveAgents", 1, 32),
      maxTreeAgents: checkedInt(merged.maxTreeAgents, "maxTreeAgents", 2, ORCHESTRATION_QUERY_MAX),
      maxDepth: checkedInt(merged.maxDepth, "maxDepth", 1, 16),
      maxOpenTasks: checkedInt(merged.maxOpenTasks, "maxOpenTasks", 1, ORCHESTRATION_QUERY_MAX),
      maxIdleWorkers: checkedInt(merged.maxIdleWorkers, "maxIdleWorkers", 0, 32),
    });
    if (this.limits.maxActivePerParent > this.limits.maxActiveAgents) {
      throw new RangeError("maxActivePerParent cannot exceed maxActiveAgents");
    }
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((kind) => `${kind === "agent" ? "agt" : kind === "task" ? "tsk" : "res"}_${randomUUID()}`);
    this.waitPollMs = checkedInt(options.waitPollMs ?? 100, "waitPollMs", 1, 5_000);
    this.closeTimeoutMs = checkedInt(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS, "closeTimeoutMs", 1, 60_000);
    this.interruptGraceMs = checkedInt(options.interruptGraceMs ?? 2_000, "interruptGraceMs", 1, 30_000);
    const takeoverAt = this.now();
    runtimeTaskDao.recoverActiveByRoot(
      options.userId,
      options.rootAgentId,
      takeoverAt,
      `takeover:${randomUUID()}`,
    );
    runtimeTaskDao.cancelOrphanedLinkedByRoot(options.userId, options.rootAgentId, takeoverAt);
    this.invalidationRevision = agentNodeDao.addressableRosterRevision(
      options.userId,
      options.rootAgentId,
    ) ?? 0;
    const resumedRunnable = !this.executionDenial()
      && runtimeTaskDao.countRunnableAgentWorkerByRoot(options.userId, options.rootAgentId) > 0;
    queueMicrotask(() => {
      if (resumedRunnable) this.notifyActive();
      this.requestSchedule();
    });
  }

  roster() {
    const roster = agentNodeDao.roster(this.options.userId, this.options.rootAgentId);
    if (!roster) throw new Error("Agent roster no longer exists");
    return roster;
  }

  modelRoster() {
    const roster = agentNodeDao.roster(this.options.userId, this.options.rootAgentId, { addressableOnly: true });
    if (!roster) throw new Error("Agent roster no longer exists");
    return roster;
  }

  resolveAddressableTarget(target: string): AgentNode {
    this.assertOpen();
    return this.resolveTarget(target, "addressable");
  }

  stats(): AgentSupervisorStats {
    return {
      activeTasks: this.active.size,
      openTasks: runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId),
      backgroundTasks: runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId, "background"),
      cachedWorkers: this.workers.size,
    };
  }

  hasActiveTasks(): boolean {
    return runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId) > 0;
  }

  hasLiveTasks(): boolean {
    return this.liveAttempts.size > 0;
  }

  hasBackgroundTasks(): boolean {
    return !this.executionDenial()
      && runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId, "background") > 0;
  }

  poke(): void {
    this.assertOpen();
    for (const active of this.active.values()) this.observeDurableCancellation(active);
    if (!this.executionDenial()) {
      const runnable = runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId);
      if (runnable > 0 && !this.activityNotified) this.notifyActive();
      else if (runnable === 0 && this.quiescentOutcome === "parked") this.notifyIfIdle();
    }
    this.requestSchedule();
  }

  liveContext(agentId: string): readonly OrchestrationJson[] | undefined {
    const taskId = this.activeByAgent.get(agentId);
    const active = taskId ? this.active.get(taskId) : undefined;
    return active?.worker?.contextSnapshot?.();
  }

  spawn(input: SpawnAgentInput): AgentTaskHandle {
    this.assertOpen();
    this.assertExecutionAllowed();
    if (!TASK_NAME.test(input.taskName)) {
      throw new Error("taskName must use lowercase letters, digits, and underscores");
    }
    if (input.taskName.startsWith("joined_slot_") && input.internalPurpose !== "joined-slot") {
      throw new Error("taskName uses a reserved runtime namespace");
    }
    this.assertJoinedAdmission(input.awaitPolicy, input.ownerTurnId, input.ownerStepId);
    const message = assertMessage(input.message);
    this.assertTaskCapacity();
    const runnableBefore = runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId);
    if (agentNodeDao.countLiveByRoot(this.options.userId, this.options.rootAgentId) >= this.limits.maxTreeAgents) {
      throw new Error(
        `Agent tree limit reached (${this.limits.maxTreeAgents} Agents are running or hold open work). `
        + `Wait for one to finish, or send follow-up work to an existing Agent instead of spawning.`,
      );
    }
    const parent = input.parentAgentId
      ? agentNodeDao.byId(this.options.userId, input.parentAgentId)
      : agentNodeDao.byId(this.options.userId, this.options.rootAgentId);
    if (!parent || parent.rootAgentId !== this.options.rootAgentId || parent.status === "closed") {
      throw new Error("Parent Agent is not available in this tree");
    }
    const depth = this.depthOf(parent) + 1;
    if (depth > this.limits.maxDepth) throw new Error(`Agent depth limit reached (${this.limits.maxDepth})`);
    const path = `${parent.path.replace(/\/$/, "")}/${input.taskName}`;
    if (agentNodeDao.directTargets(this.options.userId, this.options.rootAgentId, path).length > 0) {
      throw new Error(`Agent path already exists: ${path}; use followUp instead`);
    }

    const at = this.now();
    const agentId = this.makeId("agent");
    const taskId = this.makeId("task");
    const provider = input.provider ?? this.options.defaultAgentConfig?.provider;
    const model = input.model ?? this.options.defaultAgentConfig?.model;
    const thinkingLevel = input.thinkingLevel ?? this.options.defaultAgentConfig?.thinkingLevel;
    if (!provider || !model) throw new Error("Child Agent spawn requires pinned provider/model provenance");
    const created = agentTaskDao.create({
      agent: {
        id: agentId,
        userId: this.options.userId,
        sessionId: parent.sessionId ?? this.options.sessionId,
        rootAgentId: this.options.rootAgentId,
        parentAgentId: parent.id,
        path,
        label: input.internalPurpose === "joined-slot" ? "Joined delegation slot" : input.taskName,
        purpose: input.internalPurpose === "joined-slot" ? "joined_slot" : "addressable",
        provider,
        model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        kind: "subagent",
        createdAt: at,
      },
      task: {
        id: taskId,
        userId: this.options.userId,
        sessionId: parent.sessionId ?? this.options.sessionId,
        ownerSessionId: this.options.sessionId,
        ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
        ...(input.ownerStepId ? { ownerStepId: input.ownerStepId } : {}),
        agentId,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        kind: "delegation",
        title: taskTitle(message, input.taskName),
        payload: { message, context: input.context ?? "recent" },
        awaitPolicy: input.awaitPolicy ?? "background",
        cancelPolicy: input.cancelPolicy ?? "detached",
        checkpointSafe: input.checkpointSafe ?? false,
        createdAt: at,
      },
      initialMessages: input.initialMessages,
    });
    if (runnableBefore === 0) this.notifyActive();
    this.notifyRunnableHint();
    this.pulse();
    this.requestSchedule();
    return { agentId, taskId, path, revision: created.revision };
  }

  followUp(input: FollowUpAgentInput): AgentTaskHandle {
    this.assertOpen();
    this.assertExecutionAllowed();
    this.assertJoinedAdmission(input.awaitPolicy, input.ownerTurnId, input.ownerStepId);
    const message = assertMessage(input.message);
    this.assertTaskCapacity();
    const runnableBefore = runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId);
    const agent = this.resolveTarget(input.target);
    if (agent.id === this.options.rootAgentId) {
      throw new Error("The root Session Agent is not a SubAgent follow-up target");
    }
    if (agent.status === "closed") throw new Error("Target Agent is closed");
    if (input.internalAgentConfig && agent.purpose !== "joined_slot") {
      throw new Error("Agent reconfiguration is restricted to joined delegation slots");
    }
    if (input.internalAgentConfig && (!input.internalAgentConfig.provider || !input.internalAgentConfig.model)) {
      throw new Error("Joined slot reconfiguration requires provider and model");
    }
    const targetHadOpenTask = runtimeTaskDao.countOpenByAgent(this.options.userId, agent.id) > 0;
    const at = this.now();
    const taskId = this.makeId("task");
    const created = runtimeTaskDao.createWithRosterRevision({
      id: taskId,
      userId: this.options.userId,
      sessionId: agent.sessionId ?? this.options.sessionId,
      ownerSessionId: this.options.sessionId,
      ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
      ...(input.ownerStepId ? { ownerStepId: input.ownerStepId } : {}),
      agentId: agent.id,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      kind: "delegation",
      title: taskTitle(message, `Follow-up for ${agent.label ?? agent.path}`),
      payload: {
        message,
        context: "none",
        ...(input.resetContext ? { resetContext: true } : {}),
        ...(input.internalAgentConfig ? { internalAgentConfig: input.internalAgentConfig } : {}),
      },
      awaitPolicy: input.awaitPolicy ?? "background",
      cancelPolicy: input.cancelPolicy ?? "detached",
      checkpointSafe: input.checkpointSafe ?? false,
      createdAt: at,
    });
    if (runnableBefore === 0 && !targetHadOpenTask) this.notifyActive();
    if (!targetHadOpenTask) this.notifyRunnableHint();
    this.pulse();
    this.requestSchedule();
    return { agentId: agent.id, taskId, path: agent.path, revision: created.revision };
  }

  private assertJoinedAdmission(
    awaitPolicy: TaskAwaitPolicy | undefined,
    ownerTurnId: string | undefined,
    ownerStepId: string | undefined,
  ): void {
    if ((awaitPolicy ?? "background") !== "join") return;
    if (!this.options.onJoinedProgress) {
      throw new Error("Joined Task requires a durable Child progress sink");
    }
    if (!ownerTurnId || !ownerStepId) {
      throw new Error("Joined Task requires owner Turn and Step provenance");
    }
  }

  async send(target: string, message: string): Promise<void> {
    this.assertOpen();
    this.assertExecutionAllowed();
    const value = assertMessage(message);
    const agent = this.resolveTarget(target);
    const taskId = this.activeByAgent.get(agent.id);
    const active = taskId ? this.active.get(taskId) : undefined;
    if (!active?.worker || active.task.status !== "running" || !active.worker.steer) {
      throw new Error("Target Agent has no active worker that accepts steering");
    }
    if (runtimeTaskDao.byId(this.options.userId, active.task.id)?.status !== "running") {
      throw new Error("Target Agent is no longer in a steerable Task");
    }
    if (await active.worker.steer(value) !== true) {
      throw new Error("Target Agent rejected the steering message");
    }
  }

  interrupt(target: string): boolean {
    this.assertOpen();
    const agent = this.resolveTarget(target);
    const taskId = this.activeByAgent.get(agent.id);
    const active = taskId ? this.active.get(taskId) : undefined;
    const durable = runtimeTaskDao.listOpenByAgent(
      this.options.userId,
      agent.id,
      this.limits.maxOpenTasks,
    ).find((task) => task.kind !== "team_turn" && ACTIVE_TASK_STATUSES.has(task.status));
    const current = active
      ? runtimeTaskDao.byId(this.options.userId, active.task.id)
      : durable;
    return current ? this.cancelExactTask(current, active) : false;
  }

  interruptTask(taskId: string, expectedLeaseGeneration?: number): boolean {
    this.assertOpen();
    const current = runtimeTaskDao.byId(this.options.userId, taskId);
    if (!current || !AGENT_WORKER_TASK_KINDS.has(current.kind)) return false;
    if (
      expectedLeaseGeneration !== undefined
      && current.leaseGeneration !== expectedLeaseGeneration
    ) return false;
    const agent = agentNodeDao.byId(this.options.userId, current.agentId);
    if (!agent || agent.rootAgentId !== this.options.rootAgentId) return false;
    return this.cancelExactTask(current, this.active.get(taskId));
  }

  interruptExternallySettledTask(taskId: string): boolean {
    this.assertOpen();
    const active = this.active.get(taskId);
    const current = runtimeTaskDao.byId(this.options.userId, taskId);
    if (current && !TERMINAL_TASK_STATUSES.has(current.status)) {
      const agent = agentNodeDao.byId(this.options.userId, current.agentId);
      if (!agent || agent.rootAgentId !== this.options.rootAgentId) return false;
      return this.cancelExactTask(current, active);
    }
    if (!active) return false;
    if (current) active.task = current;
    this.armCancellation(active);
    this.pulse();
    return true;
  }

  private cancelExactTask(current: RuntimeTask, active: ActiveRun | undefined): boolean {
    if (TERMINAL_TASK_STATUSES.has(current.status)) return false;
    if (current.status === "cancel_requested" && active) {
      this.armCancellation(active);
      return true;
    }
    if (current.status === "cancel_requested" && !active) {
      const cancelled = runtimeTaskDao.transition({
        id: current.id,
        userId: this.options.userId,
        expectedVersion: current.version,
        expectedLeaseGeneration: current.leaseGeneration,
        nextStatus: "cancelled",
        at: this.now(),
        eventType: "cancel:completed",
        eventPayload: { source: "durable" },
      });
      if (cancelled) {
        this.notifyTaskChanged(cancelled.id);
        this.pulse();
      }
      if (cancelled) this.notifyIfIdle();
      return Boolean(cancelled);
    }
    const cancelling = runtimeTaskDao.transition({
      id: current.id,
      userId: this.options.userId,
      expectedVersion: current.version,
      expectedLeaseGeneration: current.leaseGeneration,
      nextStatus: "cancel_requested",
      at: this.now(),
      eventType: "cancel:requested",
      eventPayload: { source: "user" },
    });
    if (!cancelling) return false;
    if (!active) {
      const cancelled = runtimeTaskDao.transition({
        id: cancelling.id,
        userId: this.options.userId,
        expectedVersion: cancelling.version,
        expectedLeaseGeneration: cancelling.leaseGeneration,
        nextStatus: "cancelled",
        at: this.now(),
        eventType: "cancel:completed",
        eventPayload: { source: "durable" },
      });
      if (cancelled) {
        this.notifyTaskChanged(cancelled.id);
        this.pulse();
      }
      if (cancelled) this.notifyIfIdle();
      this.requestSchedule();
      return Boolean(cancelled);
    }
    active.task = cancelling;
    this.notifyTaskChanged(cancelling.id);
    this.pulse();
    this.armCancellation(active);
    return true;
  }

  releaseWaiting(target: string): boolean {
    this.assertOpen();
    this.assertExecutionAllowed();
    const agent = this.resolveTarget(target);
    const waiting = runtimeTaskDao.listOpenByAgent(
      this.options.userId,
      agent.id,
      this.limits.maxOpenTasks,
    ).find((task) => task.kind !== "team_turn" && task.status === "waiting");
    if (!waiting) return false;
    const wasQuiescent = runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId) === 0;
    const queued = runtimeTaskDao.transition({
      id: waiting.id,
      userId: this.options.userId,
      expectedVersion: waiting.version,
      expectedLeaseGeneration: waiting.leaseGeneration,
      nextStatus: "queued",
      at: this.now(),
      eventType: "wait:released",
      eventPayload: {},
    });
    if (!queued) return false;
    this.notifyTaskChanged(queued.id);
    if (wasQuiescent) this.notifyActive();
    this.notifyRunnableHint();
    this.pulse();
    this.requestSchedule();
    return true;
  }

  async waitForChange(input: WaitForAgentInput = {}): Promise<WaitForAgentResult> {
    this.assertOpen();
    if (input.signal?.aborted) throw input.signal.reason ?? abortError();
    const timeoutMs = Math.max(1, Math.min(30_000, Math.trunc(input.timeoutMs ?? 10_000)));
    const deadline = Date.now() + timeoutMs;
    const addressableOnly = input.visibility === "addressable";
    const readRoster = () => addressableOnly ? this.modelRoster() : this.roster();
    const readRevision = () => addressableOnly
      ? agentNodeDao.addressableRosterRevision(this.options.userId, this.options.rootAgentId)
      : agentNodeDao.rosterRevision(this.options.userId, this.options.rootAgentId);
    let snapshot = readRoster();
    let observedRevision = input.afterRevision ?? snapshot.revision;
    const targets = (input.targets ?? []).slice(0, 16).map((target) =>
      this.resolveTarget(target, addressableOnly ? "addressable" : "all").id
    );
    const fingerprintFor = (id: string, node: AgentNode | undefined) =>
      `${node?.version ?? 0}:${node?.status ?? "missing"}|${runtimeTaskDao.stateFingerprintByAgent(this.options.userId, id)}`;
    const fingerprints = new Map(targets.map((id) => [
      id,
      fingerprintFor(id, agentNodeDao.byId(this.options.userId, id)),
    ]));

    if (input.afterRevision === undefined && targets.some((id) => this.targetAlreadySettled(id))) {
      return this.waitResult(snapshot, targets, true, false);
    }

    if (snapshot.revision > observedRevision) {
      return this.waitResult(snapshot, targets, true, false);
    }

    while (Date.now() < deadline) {
      await this.waitForPulse(Math.min(this.waitPollMs, deadline - Date.now()), input.signal);
      if (this.closed) throw abortError("AgentSupervisor closed");
      const revision = readRevision();
      if (revision === undefined) throw new Error("Agent roster no longer exists");
      if (revision <= observedRevision) continue;
      snapshot = readRoster();
      if (targets.length === 0) return this.waitResult(snapshot, targets, true, false);
      const changed = targets.some((id) => fingerprintFor(
        id,
        agentNodeDao.byId(this.options.userId, id),
      ) !== fingerprints.get(id));
      if (changed) return this.waitResult(snapshot, targets, true, false);
      observedRevision = snapshot.revision;
    }
    snapshot = readRoster();
    return this.waitResult(snapshot, targets, false, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const deadline = Date.now() + this.closeTimeoutMs;
    if (this.scheduleRetryTimer) {
      clearTimeout(this.scheduleRetryTimer);
      this.scheduleRetryTimer = undefined;
    }
    if (this.idleRetryTimer) {
      clearTimeout(this.idleRetryTimer);
      this.idleRetryTimer = undefined;
    }
    this.lifecycle.abort(abortError("AgentSupervisor closed"));
    const fences: Promise<void>[] = [];
    for (const active of this.active.values()) {
      if (active.cancelTimer) {
        clearTimeout(active.cancelTimer);
        active.cancelTimer = undefined;
      }
      try {
        active.abort.abort(abortError("AgentSupervisor closed"));
      } catch (error) {
        this.reportFault(error, active.task.id, "close_abort");
      }
      fences.push(this.fenceActiveForClose(active, deadline));
    }
    this.pulse();
    const workers = [...this.workers.values()];
    this.workers.clear();
    const runs = [
      ...[...this.active.values()].map((active) => active.done),
      ...this.detachedRuns,
    ];
    const cleanup = Promise.allSettled([
      ...fences,
      ...workers.map((entry) => this.closeWorkerEntry(entry)),
      ...runs,
    ]);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      void cleanup.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async fenceActiveForClose(active: ActiveRun, deadline: number): Promise<void> {
    let taskFenced = false;
    while (Date.now() < deadline && !taskFenced) {
      if (!taskFenced) {
        try {
          const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
          if (
            current
            && current.leaseGeneration === active.attemptLeaseGeneration
            && !TERMINAL_TASK_STATUSES.has(current.status)
          ) {
            const retired = runtimeTaskDao.retireLease({
              id: current.id,
              userId: this.options.userId,
              expectedVersion: current.version,
              expectedLeaseGeneration: current.leaseGeneration,
              at: this.now(),
            });
            if (retired) {
              active.task = retired;
              taskFenced = true;
            }
          } else {
            taskFenced = true;
          }
        } catch (error) {
          this.reportFault(error, active.task.id, "close_task_fence");
        }
      }
      if (!taskFenced) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
    }
    if (taskFenced) this.endAttemptOwnership(active);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AgentSupervisor is closed");
  }

  private executionDenial(): string | undefined {
    try {
      return this.options.executionGate?.();
    } catch (error) {
      this.reportFault(error, undefined, "execution_gate");
      return "Execution admission is temporarily unavailable";
    }
  }

  private assertExecutionAllowed(): void {
    const denial = this.executionDenial();
    if (denial) throw new Error(denial);
  }

  private assertTaskCapacity(): number {
    const open = runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId);
    if (open >= this.limits.maxOpenTasks) throw new Error(`Open Task limit reached (${this.limits.maxOpenTasks})`);
    return open;
  }

  private depthOf(agent: AgentNode): number {
    let current: AgentNode | undefined = agent;
    let depth = 0;
    const seen = new Set<string>();
    while (current?.parentAgentId) {
      if (seen.has(current.id)) throw new Error("Agent tree contains a cycle");
      seen.add(current.id);
      depth += 1;
      if (depth > this.limits.maxTreeAgents) throw new Error("Agent tree contains an invalid parent chain");
      current = agentNodeDao.byId(this.options.userId, current.parentAgentId);
      if (current?.rootAgentId !== this.options.rootAgentId) current = undefined;
    }
    if (current?.id !== this.options.rootAgentId) throw new Error("Agent is detached from this root");
    return depth;
  }

  private resolveTarget(target: string, visibility: "all" | "addressable" = "all"): AgentNode {
    const addressableOnly = visibility === "addressable";
    const options = addressableOnly ? { addressableOnly: true } as const : {};
    const exact = agentNodeDao.directTargets(this.options.userId, this.options.rootAgentId, target, options);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) throw new Error(`Ambiguous Agent target: ${target}`);
    const roster = addressableOnly ? this.modelRoster() : this.roster();
    const nodes = roster.nodes;
    const tasks = roster.tasks;
    const aliases = stableAgentAliases(nodes, tasks.map((task) => task.agentId));
    const byAlias = nodes.filter((node) => aliases.get(node.id) === target);
    if (byAlias.length === 1) return byAlias[0]!;
    if (byAlias.length > 1) throw new Error(`Ambiguous Agent target: ${target}`);
    const byLabel = agentNodeDao.labelTargets(this.options.userId, this.options.rootAgentId, target, options);
    if (byLabel.length === 1) return byLabel[0]!;
    if (byLabel.length > 1) throw new Error(`Ambiguous Agent target: ${target}`);
    throw new Error(`Agent target not found: ${target}`);
  }

  private requestSchedule(): void {
    if (this.closed) return;
    if (this.scheduleRetryTimer) {
      clearTimeout(this.scheduleRetryTimer);
      this.scheduleRetryTimer = undefined;
    }
    if (this.scheduling) {
      this.scheduleAgain = true;
      return;
    }
    if (this.scheduleQueued) return;
    this.scheduleQueued = true;
    queueMicrotask(() => {
      this.scheduleQueued = false;
      if (this.closed) return;
      try {
        this.schedule();
        this.scheduleFailures = 0;
      } catch (error) {
        this.rejectBackgroundPermit();
        this.reportFault(error, undefined, "schedule");
        let rootMissing = false;
        try {
          rootMissing = agentNodeDao.rosterRevision(this.options.userId, this.options.rootAgentId) === undefined;
        } catch (healthError) {
          this.reportFault(healthError, undefined, "schedule_health");
        }
        if (rootMissing) {
          void this.close();
        } else {
          this.retrySchedule();
        }
      }
    });
  }

  private schedule(): void {
    if (this.closed || this.scheduling) return;
    this.scheduling = true;
    try {
      do {
        this.scheduleAgain = false;
        while (!this.closed) {
          if (agentNodeDao.rosterRevision(this.options.userId, this.options.rootAgentId) === undefined) {
            throw new Error("Agent roster no longer exists");
          }
          if (this.executionDenial()) {
            this.rejectBackgroundPermit();
            this.notifyIfIdle();
            break;
          }
          const open = runtimeTaskDao.listSchedulingAgentWorkerByRoot(
            this.options.userId,
            this.options.rootAgentId,
            this.limits.maxOpenTasks,
          );
          const nodes = new Map(agentNodeDao.listOwnedByIds(
            this.options.userId,
            this.options.rootAgentId,
            open.map((task) => task.agentId),
          ).map((node) => [node.id, node]));
          const activeTasks = open.filter((task) => CAPACITY_TASK_STATUSES.has(task.status));
          const activeAgents = new Set(activeTasks.map((task) => task.agentId));
          if (activeAgents.size >= this.limits.maxActiveAgents || this.active.size >= this.limits.maxActiveAgents) {
            this.rejectBackgroundPermit();
            break;
          }
          const runnable = open.filter((task) => {
            if (
              task.status !== "queued"
              || activeAgents.has(task.agentId)
              || this.activeByAgent.has(task.agentId)
              || this.blockedAgents.has(task.agentId)
            ) return false;
            if (open.some((earlier) =>
              earlier.agentId === task.agentId
              && earlier.agentOrd < task.agentOrd
              && !TERMINAL_TASK_STATUSES.has(earlier.status)
            )) return false;
            const node = nodes.get(task.agentId);
            if (
              !node
              || node.kind !== "subagent"
              || node.status === "closed"
              || !AGENT_WORKER_TASK_KINDS.has(task.kind)
            ) return false;
            const parentId = node.parentAgentId ?? this.options.rootAgentId;
            const siblings = new Set(activeTasks
              .map((active) => nodes.get(active.agentId))
              .filter((activeNode) => (activeNode?.parentAgentId ?? this.options.rootAgentId) === parentId)
              .map((activeNode) => activeNode!.id));
            return siblings.size < this.limits.maxActivePerParent;
          });
          let candidate: RuntimeTask | undefined;
          let releasePermit: (() => void) | undefined;
          for (const task of runnable) {
            if (task.awaitPolicy === "background" && this.options.acquireBackgroundPermit) {
              const acquired = this.options.acquireBackgroundPermit(task);
              if (!acquired) continue;
              releasePermit = acquired;
            }
            candidate = task;
            break;
          }
          if (!candidate) {
            this.rejectBackgroundPermit();
            if (
              runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId) > 0
              && runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId) === 0
            ) this.notifyIfIdle();
            break;
          }
          let permitTransferred = false;
          try {
            const claimed = runtimeTaskDao.claim({
              id: candidate.id,
              userId: this.options.userId,
              expectedVersion: candidate.version,
              at: this.now(),
              eventPayload: { scheduler: "agent_supervisor" },
            });
            if (!claimed) {
              const cancelled = runtimeTaskDao.cancelOrphanedLinkedByRoot(
                this.options.userId,
                this.options.rootAgentId,
                this.now(),
              );
              if (cancelled > 0) {
                this.pulse();
                continue;
              }
              this.retrySchedule();
              break;
            }
            const active: ActiveRun = {
              agentId: claimed.agentId,
              abort: new AbortController(),
              task: claimed,
              attemptLeaseGeneration: claimed.leaseGeneration,
              progressSeq: 0,
              done: Promise.resolve(),
              ...(releasePermit ? { releasePermit } : {}),
            };
            this.active.set(claimed.id, active);
            this.activeByAgent.set(claimed.agentId, claimed.id);
            this.liveAttempts.add(claimed.id);
            permitTransferred = true;
            this.notifyTaskChanged(claimed.id);
            this.pulse();
            active.done = this.execute(active).catch((error) =>
              this.handleUnexpectedRunFault(active, error)
            ).finally(() => {
              if (active.cancelTimer) clearTimeout(active.cancelTimer);
              if (active.unblockTimer) clearTimeout(active.unblockTimer);
              if (this.active.get(claimed.id) === active) this.active.delete(claimed.id);
              if (this.activeByAgent.get(claimed.agentId) === claimed.id) this.activeByAgent.delete(claimed.agentId);
              if (this.blockedAgents.get(claimed.agentId) === claimed.id) {
                this.blockedAgents.delete(claimed.agentId);
              }
              this.endAttemptOwnership(active);
              try {
                this.trimWorkers();
              } catch (error) {
                this.reportFault(error, claimed.id, "worker_cache_trim");
              } finally {
                this.requestSchedule();
              }
            });
          } finally {
            if (!permitTransferred) releasePermit?.();
          }
        }
      } while (this.scheduleAgain && !this.closed);
    } finally {
      this.scheduling = false;
    }
  }

  private reportFault(error: unknown, taskId: string | undefined, phase: string): void {
    try {
      this.options.onError?.(error, { phase, ...(taskId ? { taskId } : {}) });
    } catch {
    }
    const message = error instanceof Error ? error.message : String(error ?? "unknown failure");
    console.error(`[agent-supervisor] ${phase}${taskId ? ` (${taskId})` : ""}: ${message.slice(0, 500)}`);
  }

  private rejectBackgroundPermit(): void {
    try {
      this.options.rejectBackgroundPermit?.();
    } catch (error) {
      this.reportFault(error, undefined, "permit_reject");
    }
  }

  private async handleUnexpectedRunFault(active: ActiveRun, error: unknown): Promise<void> {
    this.reportFault(error, active.task.id, "run_settle");
    let failures = 0;
    while (!this.closed && !active.forced) {
      try {
        await this.settle(active, "failed", undefined, error);
        return;
      } catch (settleError) {
        this.reportFault(settleError, active.task.id, "fault_terminalize");
        failures += 1;
        await this.waitForRetry(Math.min(1_000, 25 * (2 ** Math.min(5, failures - 1))));
      }
    }
  }

  private forceCancel(active: ActiveRun): void {
    if (active.forced || this.closed) return;
    try {
      this.forceCancelNow(active);
      active.forceCancelFailures = 0;
    } catch (error) {
      this.reportFault(error, active.task.id, "force_cancel");
      if (active.forced || this.closed) return;
      active.forceCancelFailures = (active.forceCancelFailures ?? 0) + 1;
      const delay = Math.min(1_000, 25 * (2 ** Math.min(5, active.forceCancelFailures - 1)));
      active.cancelTimer = setTimeout(() => this.forceCancel(active), delay);
      active.cancelTimer.unref?.();
    }
  }

  private forceCancelNow(active: ActiveRun): void {
    if (active.cancelTimer) {
      clearTimeout(active.cancelTimer);
      active.cancelTimer = undefined;
    }
    const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
    const ownsLease = !current || current.leaseGeneration === active.attemptLeaseGeneration;
    if (ownsLease && current?.status === "cancel_requested") {
      const cancelled = settleOwnedTask({
        task: current,
        userId: this.options.userId,
        resultId: this.makeId("result"),
        outcome: "cancelled",
        summary: "Agent Task was force-cancelled",
        body: { status: "cancelled", forced: true },
        artifacts: [],
        at: this.now(),
        eventType: "cancel:forced",
        eventPayload: {},
      });
      if (cancelled) active.task = cancelled.task;
    }
    active.forced = true;
    if (this.active.get(active.task.id) === active) this.active.delete(active.task.id);
    if (this.activeByAgent.get(active.agentId) === active.task.id) this.activeByAgent.delete(active.agentId);
    this.endAttemptOwnership(active);
    this.blockedAgents.set(active.agentId, active.task.id);
    let unblocked = false;
    let closingRun: Promise<void> | undefined;
    let detachedRun: Promise<void> | undefined;
    const unblock = () => {
      if (unblocked) return;
      unblocked = true;
      if (closingRun) this.detachedRuns.delete(closingRun);
      if (detachedRun) this.detachedRuns.delete(detachedRun);
      if (active.unblockTimer) {
        clearTimeout(active.unblockTimer);
        active.unblockTimer = undefined;
      }
      if (this.blockedAgents.get(active.agentId) === active.task.id) {
        this.blockedAgents.delete(active.agentId);
        this.requestSchedule();
      }
    };
    active.unblockTimer = setTimeout(unblock, Math.min(this.closeTimeoutMs, 2_000));
    active.unblockTimer.unref?.();
    const entry = this.workers.get(active.agentId);
    if (entry && this.workers.delete(active.agentId)) {
      closingRun = this.closeWorkerEntry(entry)
        .catch((error) => this.reportFault(error, active.task.id, "forced_worker_close"))
        .finally(() => {
          if (closingRun) this.detachedRuns.delete(closingRun);
          unblock();
        });
      this.detachedRuns.add(closingRun);
    } else unblock();
    if (ownsLease) {
      try {
        const agent = agentNodeDao.byId(this.options.userId, active.agentId);
        if (agent?.status === "running") {
          agentNodeDao.transitionStatus({
            id: agent.id,
            userId: this.options.userId,
            expectedVersion: agent.version,
            nextStatus: "interrupted",
            at: this.now(),
          });
        }
      } catch (error) {
        this.reportFault(error, active.task.id, "force_cancel_agent");
      }
    }
    detachedRun = active.done.finally(() => {
      if (detachedRun) this.detachedRuns.delete(detachedRun);
      unblock();
    });
    if (!unblocked) this.detachedRuns.add(detachedRun);
    this.pulse();
    this.notifyIfIdle();
    this.requestSchedule();
  }

  private endAttemptOwnership(active: ActiveRun): void {
    if (active.attemptOwnershipEnded) return;
    active.attemptOwnershipEnded = true;
    this.liveAttempts.delete(active.task.id);
    try {
      active.releasePermit?.();
    } catch (error) {
      this.reportFault(error, active.task.id, "permit_release");
    }
    active.releasePermit = undefined;
    try {
      this.options.onAttemptEnd?.(active.task.id);
    } catch (error) {
      this.reportFault(error, active.task.id, "attempt_end_callback");
    }
  }

  private notifyTaskChanged(taskId: string): void {
    try {
      this.options.onTaskChanged?.(taskId);
    } catch (error) {
      this.reportFault(error, taskId, "task_change_callback");
    }
  }

  private armCancellation(active: ActiveRun): void {
    active.abort.abort(abortError("Agent interrupted"));
    if (active.cancelTimer) return;
    active.cancelTimer = setTimeout(() => this.forceCancel(active), this.interruptGraceMs);
    active.cancelTimer.unref?.();
  }

  private observeDurableCancellation(active: ActiveRun): void {
    if (this.closed || active.forced || active.abort.signal.aborted) return;
    try {
      const task = runtimeTaskDao.byId(this.options.userId, active.task.id);
      if (!task || task.leaseGeneration !== active.attemptLeaseGeneration) {
        this.armCancellation(active);
        return;
      }
      active.task = task;
      if (task.status === "cancel_requested" || TERMINAL_TASK_STATUSES.has(task.status)) {
        this.armCancellation(active);
      }
    } catch (error) {
      this.reportFault(error, active.task.id, "cancel_observe");
    }
  }

  private async execute(active: ActiveRun): Promise<void> {
    let outcome: "succeeded" | "failed" | "cancelled" | "interrupted" = "failed";
    let result: SupervisedAgentResult | undefined;
    let failure: unknown;
    try {
      this.reconfigureJoinedSlotForTask(active);
      const runningAgent = this.markAgentRunning(active.agentId);
      const worker = await this.workerFor(runningAgent);
      active.worker = worker;
      let current = runtimeTaskDao.byId(this.options.userId, active.task.id);
      if (!current || current.leaseGeneration !== active.attemptLeaseGeneration || current.status === "interrupted") {
        outcome = "interrupted";
        return;
      }
      if (current.status === "cancel_requested") {
        outcome = "cancelled";
        return;
      }
      const running = runtimeTaskDao.transition({
        id: current.id,
        userId: this.options.userId,
        expectedVersion: current.version,
        expectedLeaseGeneration: current.leaseGeneration,
        nextStatus: "running",
        activity: "model",
        at: this.now(),
        eventType: "worker:started",
        eventPayload: {},
      });
      if (!running) throw new Error("Task changed before worker start");
      active.task = running;
      this.notifyTaskChanged(running.id);
      this.pulse();
      result = await worker.run({
        agent: runningAgent,
        task: running,
        signal: active.abort.signal,
        updateActivity: (activity) => this.updateActivity(active, activity),
        publishProgress: (event) => this.publishProgress(active, event),
        checkpointUsage: (tokensUsed, costUsedMicros) =>
          this.checkpointUsage(active, tokensUsed, costUsedMicros),
      });
      outcome = "succeeded";
    } catch (error) {
      failure = error;
      const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
      outcome = current?.status === "cancel_requested"
        ? "cancelled"
        : current?.status === "interrupted" || (this.closed && active.abort.signal.aborted)
          ? "interrupted"
          : "failed";
    } finally {
      await this.settle(active, outcome, result, failure);
    }
  }

  private reconfigureJoinedSlotForTask(active: ActiveRun): void {
    const payload = active.task.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const config = payload.internalAgentConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const provider = config.provider;
    const model = config.model;
    const thinkingLevel = config.thinkingLevel;
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
      throw new Error("Joined slot Task contains invalid model provenance");
    }
    if (
      thinkingLevel !== undefined
      && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinkingLevel))
    ) throw new Error("Joined slot Task contains invalid thinking level");
    const agent = agentNodeDao.byId(this.options.userId, active.agentId);
    if (!agent || agent.purpose !== "joined_slot") {
      throw new Error("Joined slot Task does not target a reserved Agent");
    }
    if (agent.provider === provider && agent.model === model && agent.thinkingLevel === thinkingLevel) return;
    const oldWorker = this.workers.get(agent.id);
    if (oldWorker && this.workers.delete(agent.id)) {
      void this.closeWorkerEntry(oldWorker).catch((error) =>
        this.reportFault(error, active.task.id, "joined_slot_worker_close")
      );
    }
    const changed = agentNodeDao.reconfigureJoinedSlot({
      id: agent.id,
      userId: this.options.userId,
      expectedVersion: agent.version,
      taskId: active.task.id,
      taskLeaseGeneration: active.attemptLeaseGeneration,
      provider,
      model,
      ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as AgentNode["thinkingLevel"] }),
      at: this.now(),
    });
    if (!changed) throw new Error("Joined delegation slot changed before model reconfiguration");
    this.pulse();
  }

  private markAgentRunning(agentId: string): AgentNode {
    let agent = agentNodeDao.byId(this.options.userId, agentId);
    if (!agent) throw new Error("Task Agent no longer exists");
    if (agent.status === "closed") throw new Error("Task Agent is closed");
    if (agent.status === "interrupted" || agent.status === "error") {
      const idle = agentNodeDao.transitionStatus({
        id: agent.id,
        userId: this.options.userId,
        expectedVersion: agent.version,
        nextStatus: "idle",
        at: this.now(),
      });
      if (!idle) throw new Error("Task Agent changed while being resumed");
      agent = idle;
      this.pulse();
    }
    if (agent.status === "idle" || agent.status === "initializing") {
      const running = agentNodeDao.transitionStatus({
        id: agent.id,
        userId: this.options.userId,
        expectedVersion: agent.version,
        nextStatus: "running",
        at: this.now(),
      });
      if (!running) throw new Error("Task Agent changed before execution");
      agent = running;
      this.pulse();
    }
    if (agent.status !== "running") throw new Error(`Task Agent cannot run from ${agent.status}`);
    return agent;
  }

  private async workerFor(agent: AgentNode): Promise<SupervisedAgentWorker> {
    if (this.closed || this.lifecycle.signal.aborted) throw abortError("AgentSupervisor closed");
    const existing = this.workers.get(agent.id);
    if (existing) {
      existing.usedAt = this.now();
      return existing.promise;
    }
    const entry: WorkerEntry = {
      usedAt: this.now(),
      promise: Promise.resolve(this.options.workerFactory({
        agent,
        userId: this.options.userId,
        sessionId: agent.sessionId ?? this.options.sessionId,
        rootAgentId: this.options.rootAgentId,
        signal: this.lifecycle.signal,
      })),
    };
    this.workers.set(agent.id, entry);
    try {
      this.trimWorkers();
    } catch (error) {
      this.reportFault(error, undefined, "worker_cache_trim");
    }
    try {
      const worker = await entry.promise;
      if (this.closed || this.lifecycle.signal.aborted) {
        if (this.workers.get(agent.id) === entry) this.workers.delete(agent.id);
        await this.closeWorkerEntry(entry);
        throw abortError("AgentSupervisor closed");
      }
      return worker;
    } catch (error) {
      if (this.workers.get(agent.id) === entry) this.workers.delete(agent.id);
      throw error;
    }
  }

  private trimWorkers(): void {
    const closedAgents = new Set(agentNodeDao.listOwnedByIds(
      this.options.userId,
      this.options.rootAgentId,
      [...this.workers.keys()],
    ).filter((agent) => agent.status === "closed").map((agent) => agent.id));
    for (const [agentId, entry] of this.workers) {
      if (!closedAgents.has(agentId) || this.activeByAgent.has(agentId)) continue;
      if (!this.workers.delete(agentId)) continue;
      void this.closeWorkerEntry(entry).catch(() => {});
    }
    const queuedAgents = new Set(runtimeTaskDao
      .listOpenByRoot(this.options.userId, this.options.rootAgentId, this.limits.maxOpenTasks)
      .filter((task) => task.status === "queued")
      .map((task) => task.agentId));
    const idle = [...this.workers.entries()]
      .filter(([agentId]) => !this.activeByAgent.has(agentId))
      .sort((left, right) => {
        const queuedOrder = Number(queuedAgents.has(left[0])) - Number(queuedAgents.has(right[0]));
        return queuedOrder || left[1].usedAt - right[1].usedAt;
      });
    while (idle.length > this.limits.maxIdleWorkers) {
      const [agentId, entry] = idle.shift()!;
      if (!this.workers.delete(agentId)) continue;
      void this.closeWorkerEntry(entry).catch(() => {});
    }
  }

  private closeWorkerEntry(entry: WorkerEntry): Promise<void> {
    entry.closePromise ??= entry.promise.then(async (worker) => {
      await worker.close?.();
    });
    return entry.closePromise;
  }

  private updateActivity(active: ActiveRun, activity: TaskActivityCode): void {
    const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
    if (
      !current
      || current.leaseGeneration !== active.attemptLeaseGeneration
      || (current.status !== "starting" && current.status !== "running")
    ) return;
    const updated = runtimeTaskDao.updateActivity({
      id: current.id,
      userId: this.options.userId,
      expectedVersion: current.version,
      expectedLeaseGeneration: current.leaseGeneration,
      activity,
      at: this.now(),
    });
    if (updated) {
      active.task = updated;
      this.pulse();
    }
  }

  private publishProgress(active: ActiveRun, event: WireAgentEvent): boolean {
    if (active.forced || this.active.get(active.task.id) !== active) return false;
    const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
    if (
      !current
      || current.leaseGeneration !== active.attemptLeaseGeneration
      || (current.status !== "running" && current.status !== "cancel_requested")
      || current.awaitPolicy !== "join"
      || !current.ownerStepId
    ) return false;
    const sink = this.options.onJoinedProgress;
    if (!sink) return false;
    const progressSeq = active.progressSeq + 1;
    const committed = sink({
      task: current,
      ownerStepId: current.ownerStepId,
      progressSeq,
      at: this.now(),
      event,
    });
    if (committed) active.progressSeq = progressSeq;
    return committed;
  }

  private checkpointUsage(active: ActiveRun, tokensUsed: number, costUsedMicros: number): boolean {
    const current = runtimeTaskDao.byId(this.options.userId, active.task.id);
    if (!current || current.leaseGeneration !== active.attemptLeaseGeneration) {
      this.armCancellation(active);
      return false;
    }
    active.task = current;
    if (TERMINAL_TASK_STATUSES.has(current.status) || current.status === "cancel_requested") {
      this.armCancellation(active);
      return false;
    }
    const recorded = checkpointOwnedTaskUsage({
      task: current,
      userId: this.options.userId,
      tokensUsed,
      costUsedMicros,
      at: this.now(),
    });
    const latest = runtimeTaskDao.byId(this.options.userId, current.id);
    if (!recorded || !latest || latest.leaseGeneration !== active.attemptLeaseGeneration) {
      this.armCancellation(active);
      return false;
    }
    active.task = latest;
    this.notifyTaskChanged(latest.id);
    if (latest.status === "cancel_requested" || TERMINAL_TASK_STATUSES.has(latest.status)) {
      this.armCancellation(active);
      return false;
    }
    return true;
  }

  private async settle(
    active: ActiveRun,
    outcome: "succeeded" | "failed" | "cancelled" | "interrupted",
    result: SupervisedAgentResult | undefined,
    failure: unknown,
  ): Promise<void> {
    let current = await this.readAttemptTask(active, "settle_read");
    if (current && current.leaseGeneration !== active.attemptLeaseGeneration) return;
    const completionEvidence = (
      status: "succeeded" | "failed" | "cancelled" | "interrupted",
    ): SupervisedAgentResult => {
      if (result) return result;
      const errorText = failure instanceof Error ? failure.message : String(failure ?? "Agent worker failed");
      const failureUsage = failure !== null && typeof failure === "object"
        ? failure as { tokensUsed?: unknown; costUsedMicros?: unknown }
        : undefined;
      return {
        summary: status === "failed"
          ? `Agent failed: ${errorText}`
          : status === "cancelled"
            ? "Agent Task was cancelled"
            : status === "interrupted" ? "Agent Task was interrupted" : "Task completed",
        body: status === "failed" ? { error: errorText } : { status },
        artifacts: [],
        ...(typeof failureUsage?.tokensUsed === "number" ? { tokensUsed: failureUsage.tokensUsed } : {}),
        ...(typeof failureUsage?.costUsedMicros === "number"
          ? { costUsedMicros: failureUsage.costUsedMicros }
          : {}),
      };
    };
    const preservedByClose = this.closed && (current?.status === "queued" || current?.status === "waiting");
    if (current && !TERMINAL_TASK_STATUSES.has(current.status) && !preservedByClose) {
      const nextStatus = current.status === "cancel_requested" ? "cancelled" : outcome;
      const stored = completionEvidence(nextStatus);
      if (nextStatus === "succeeded" || nextStatus === "failed") {
        let value = stored;
        let resultStatus: "succeeded" | "failed" = nextStatus;
        let settleFailures = 0;
        while (
          current
          && current.leaseGeneration === active.attemptLeaseGeneration
          && !TERMINAL_TASK_STATUSES.has(current.status)
          && current.status !== "cancel_requested"
          && !this.closed
          && !active.forced
        ) {
          try {
            const settled = settleOwnedTask({
              task: current,
              userId: this.options.userId,
              resultId: this.makeId("result"),
              outcome: resultStatus,
              summary: boundedSummary(value.summary),
              body: value.body ?? {},
              artifacts: value.artifacts ?? [],
              ...(value.tokensUsed === undefined ? {} : { tokensUsed: value.tokensUsed }),
              ...(value.costUsedMicros === undefined ? {} : { costUsedMicros: value.costUsedMicros }),
              eventType: `worker:${resultStatus}`,
              eventPayload: {},
              at: this.now(),
            });
            if (settled) {
              current = settled.task;
              active.task = settled.task;
              this.pulse();
              break;
            }
          } catch (storeError) {
            this.reportFault(storeError, active.task.id, "result_settle");
            if (resultStatus === "succeeded" && storeError instanceof JoinedProgressInvariantError) {
              const reason = storeError.message;
              resultStatus = "failed";
              value = {
                summary: boundedSummary(`Agent failed: ${reason}`),
                body: { error: reason },
                artifacts: [],
              };
              settleFailures = 0;
              continue;
            }
            if (
              current?.status !== "cancel_requested"
              && value === stored
              && (storeError instanceof TypeError || storeError instanceof RangeError)
            ) {
              const reason = storeError instanceof Error ? storeError.message : "invalid result payload";
              value = {
                summary: boundedSummary(`${stored.summary}\nResult detail was omitted: ${reason}`),
                body: { omitted: true },
                artifacts: [],
                ...(stored.tokensUsed === undefined ? {} : { tokensUsed: stored.tokensUsed }),
                ...(stored.costUsedMicros === undefined ? {} : { costUsedMicros: stored.costUsedMicros }),
              };
            }
          }
          if (
            !current
            || current.leaseGeneration !== active.attemptLeaseGeneration
            || TERMINAL_TASK_STATUSES.has(current.status)
            || this.closed
            || active.forced
          ) break;
          settleFailures += 1;
          await this.waitForRetry(Math.min(1_000, 25 * (2 ** Math.min(5, settleFailures - 1))));
          current = await this.readAttemptTask(active, "result_settle_read");
        }
      } else {
        let transitionFailures = 0;
        while (
          current
          && current.leaseGeneration === active.attemptLeaseGeneration
          && !TERMINAL_TASK_STATUSES.has(current.status)
          && !this.closed
          && !active.forced
        ) {
          try {
            const desiredStatus = current.status === "cancel_requested" ? "cancelled" : nextStatus;
            const terminalEvidence = desiredStatus === nextStatus
              ? stored
              : completionEvidence(desiredStatus);
            const terminal = settleOwnedTask({
              task: current,
              userId: this.options.userId,
              resultId: this.makeId("result"),
              outcome: desiredStatus,
              summary: boundedSummary(terminalEvidence.summary),
              body: terminalEvidence.body ?? {},
              artifacts: terminalEvidence.artifacts ?? [],
              ...(terminalEvidence.tokensUsed === undefined ? {} : { tokensUsed: terminalEvidence.tokensUsed }),
              ...(terminalEvidence.costUsedMicros === undefined
                ? {}
                : { costUsedMicros: terminalEvidence.costUsedMicros }),
              at: this.now(),
              eventType: `worker:${desiredStatus}`,
              eventPayload: {},
            });
            if (terminal) {
              current = terminal.task;
              active.task = terminal.task;
              this.pulse();
              break;
            }
          } catch (transitionError) {
            this.reportFault(transitionError, active.task.id, "terminal_settle");
          }
          transitionFailures += 1;
          await this.waitForRetry(Math.min(1_000, 25 * (2 ** Math.min(5, transitionFailures - 1))));
          current = await this.readAttemptTask(active, "terminal_settle_read");
        }
      }
    }
    if (
      current?.status === "cancel_requested"
      && current.leaseGeneration === active.attemptLeaseGeneration
      && !this.closed
      && !active.forced
    ) {
      const stored = completionEvidence("cancelled");
      const cancelled = settleOwnedTask({
        task: current,
        userId: this.options.userId,
        resultId: this.makeId("result"),
        outcome: "cancelled",
        summary: boundedSummary(stored.summary),
        body: stored.body ?? {},
        artifacts: stored.artifacts ?? [],
        ...(stored.tokensUsed === undefined ? {} : { tokensUsed: stored.tokensUsed }),
        ...(stored.costUsedMicros === undefined ? {} : { costUsedMicros: stored.costUsedMicros }),
        at: this.now(),
        eventType: "worker:cancelled",
        eventPayload: {},
      });
      if (cancelled) {
        current = cancelled.task;
        active.task = cancelled.task;
        this.pulse();
      }
    }
    if (active.forced) {
      const late = result ?? completionEvidence(outcome);
      if (late.tokensUsed !== undefined || late.costUsedMicros !== undefined) {
        const recorded = recordOwnedTaskLateUsage({
          task: active.task,
          userId: this.options.userId,
          tokensUsed: late.tokensUsed ?? 0,
          costUsedMicros: late.costUsedMicros ?? 0,
          at: this.now(),
        });
        if (recorded) this.notifyTaskChanged(active.task.id);
      }
      return;
    }
    if (
      current
      && current.leaseGeneration === active.attemptLeaseGeneration
      && !TERMINAL_TASK_STATUSES.has(current.status)
      && !this.closed
    ) {
      throw new Error(`Task ${current.id} remained ${current.status} after worker settlement`);
    }
    try {
      const agent = agentNodeDao.byId(this.options.userId, active.agentId);
      if (agent?.status === "running") {
        const nextStatus: AgentNodeStatus = current?.status === "succeeded"
          ? "idle"
          : current?.status === "failed"
            ? "error"
            : "interrupted";
        const changed = agentNodeDao.transitionStatus({
          id: agent.id,
          userId: this.options.userId,
          expectedVersion: agent.version,
          nextStatus,
          at: this.now(),
        });
        if (changed) this.pulse();
      }
    } catch (agentError) {
      this.reportFault(agentError, active.task.id, "agent_settle_projection");
    }
    this.notifyIfIdle();
  }

  private waitResult(
    snapshot: ReturnType<AgentSupervisor["roster"]>,
    targets: readonly string[],
    changed: boolean,
    timedOut: boolean,
  ): WaitForAgentResult {
    const wanted = new Set(targets);
    return {
      revision: snapshot.revision,
      changed,
      timedOut,
      agents: targets.length === 0
        ? snapshot.nodes
        : agentNodeDao.listOwnedByIds(this.options.userId, this.options.rootAgentId, [...wanted]),
    };
  }

  private targetAlreadySettled(agentId: string): boolean {
    const node = agentNodeDao.byId(this.options.userId, agentId);
    if (runtimeTaskDao.countOpenByAgent(this.options.userId, agentId) > 0) return false;
    return Boolean(node && !["initializing", "running"].includes(node.status));
  }

  private notifyIfIdle(): void {
    if (this.closed || this.idleNotifyQueued) return;
    this.idleNotifyQueued = true;
    queueMicrotask(() => {
      this.idleNotifyQueued = false;
      if (this.closed) return;
      try {
        const denied = this.executionDenial();
        if (!denied && runtimeTaskDao.countRunnableAgentWorkerByRoot(this.options.userId, this.options.rootAgentId) !== 0) return;
        let outcome: "done" | "error" | "parked";
        if (denied || runtimeTaskDao.countOpenByRoot(this.options.userId, this.options.rootAgentId) > 0) {
          outcome = "parked";
        } else {
          const terminal = runtimeTaskDao.terminalOutcomeByRoot(this.options.userId, this.options.rootAgentId);
          outcome = terminal.unreadFailure
            || terminal.latestStatus === "failed"
            || terminal.latestStatus === "interrupted"
            ? "error"
            : "done";
        }
        if (this.quiescentOutcome === outcome) return;
        this.options.onIdle?.(outcome);
        this.quiescentOutcome = outcome;
        this.activityNotified = false;
        this.idleFailures = 0;
      } catch (error) {
        this.reportFault(error, undefined, "idle_callback");
        this.retryIdleNotification();
      }
    });
  }

  private notifyActive(): void {
    if (this.activityNotified) return;
    this.activityNotified = true;
    this.quiescentOutcome = undefined;
    queueMicrotask(() => {
      if (this.closed) return;
      try {
        if (this.executionDenial()) {
          this.notifyIfIdle();
          return;
        }
        this.options.onActive?.();
      } catch (error) {
        this.activityNotified = false;
        this.reportFault(error, undefined, "active_callback");
      }
    });
  }

  private notifyRunnableHint(): void {
    try {
      this.options.onRunnableHint?.();
    } catch (error) {
      this.reportFault(error, undefined, "runnable_hint");
    }
  }

  private retrySchedule(): void {
    if (this.closed || this.scheduleRetryTimer) return;
    this.scheduleFailures += 1;
    const delay = Math.min(1_000, 25 * (2 ** Math.min(5, this.scheduleFailures - 1)));
    this.scheduleRetryTimer = setTimeout(() => {
      this.scheduleRetryTimer = undefined;
      this.requestSchedule();
    }, delay);
    this.scheduleRetryTimer.unref?.();
  }

  private retryIdleNotification(): void {
    if (this.closed || this.idleRetryTimer) return;
    this.idleFailures += 1;
    const delay = Math.min(1_000, 25 * (2 ** Math.min(5, this.idleFailures - 1)));
    this.idleRetryTimer = setTimeout(() => {
      this.idleRetryTimer = undefined;
      this.notifyIfIdle();
    }, delay);
    this.idleRetryTimer.unref?.();
  }

  private async readAttemptTask(active: ActiveRun, phase: string): Promise<RuntimeTask | undefined> {
    let failures = 0;
    while (!this.closed && !active.forced) {
      try {
        return runtimeTaskDao.byId(this.options.userId, active.task.id);
      } catch (error) {
        this.reportFault(error, active.task.id, phase);
        failures += 1;
        await this.waitForRetry(Math.min(1_000, 25 * (2 ** Math.min(5, failures - 1))));
      }
    }
    return undefined;
  }

  private waitForRetry(timeoutMs: number): Promise<void> {
    if (this.closed || this.lifecycle.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lifecycle.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.lifecycle.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private pulse(): void {
    try {
      const revision = agentNodeDao.addressableRosterRevision(
        this.options.userId,
        this.options.rootAgentId,
      );
      if (revision !== undefined && revision > this.invalidationRevision) {
        this.invalidationRevision = revision;
        this.options.onInvalidated?.({
          sessionId: this.options.sessionId,
          rootAgentId: this.options.rootAgentId,
          revision,
        });
      }
    } catch (error) {
      this.reportFault(error, undefined, "invalidation");
    }
    const waiters = [...this.wakeWaiters];
    this.wakeWaiters.clear();
    for (const wake of waiters) wake();
  }

  private waitForPulse(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        signal?.removeEventListener("abort", aborted);
        reject(signal?.reason ?? abortError());
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wakeWaiters.add(finish);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}
