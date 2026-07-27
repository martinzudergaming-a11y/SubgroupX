import { randomUUID } from "node:crypto";
import type {
  Workflow,
  WorkflowBudget,
  WorkflowEdgeDefinition,
  WorkflowEvent,
  WorkflowNodeDefinition,
} from "../../../shared/src/orchestration.ts";
import {
  workflowDao,
  type ClaimWorkflowNodeInput,
  type ExpandWorkflowInput,
  type NewWorkflowInput,
  type RecordWorkflowAttemptUsageInput,
  type ReviseWorkflowInput,
  type SealWorkflowInput,
  type SettleWorkflowAttemptInput,
  type SettleWorkflowExecutionInput,
  type WorkflowCacheEvidence,
  type WorkflowCacheHit,
  type WorkflowDispatch,
  type WorkflowExecutionSettlement,
  type WorkflowCoordinatorCursor,
  type WorkflowRecoveryResult,
  type WorkflowSnapshot,
  WorkflowDispatchUnavailableError,
} from "../persistence/workflow.ts";
import { OrchestrationTaskCapacityError } from "../persistence/orchestration.ts";

export interface WorkflowEngineOptions {
  userId: string;
  now?: () => number;
  id?: (kind: "workflow" | "task" | "result" | "mutation") => string;
}

export interface CreateWorkflowInput {
  id?: string;
  ownerSessionId: string;
  rootAgentId: string;
  controllerAgentId?: string;
  name: string;
  nodes: readonly WorkflowNodeDefinition[];
  edges: readonly WorkflowEdgeDefinition[];
  budget?: Partial<WorkflowBudget>;
  graphSealed?: boolean;
}

export interface ClaimReadyWorkflowNodeInput {
  workflowId: string;
  nodeId: string;
  expectedVersion: number;
  cacheEvidence?: WorkflowCacheEvidence;
  cacheHit?: WorkflowCacheHit;
}

export class WorkflowEngine {
  private readonly now: () => number;
  private readonly makeId: (kind: "workflow" | "task" | "result" | "mutation") => string;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((kind) => `${kind === "workflow" ? "wfl" : kind === "mutation" ? "mut" : kind === "result" ? "res" : "tsk"}_${randomUUID()}`);
  }

  create(input: CreateWorkflowInput): WorkflowSnapshot {
    const value: NewWorkflowInput = {
      id: input.id ?? this.makeId("workflow"),
      userId: this.options.userId,
      ownerSessionId: input.ownerSessionId,
      rootAgentId: input.rootAgentId,
      ...(input.controllerAgentId === undefined ? {} : { controllerAgentId: input.controllerAgentId }),
      name: input.name,
      nodes: input.nodes,
      edges: input.edges,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.graphSealed === undefined ? {} : { graphSealed: input.graphSealed }),
      createdAt: this.now(),
    };
    return workflowDao.create(value);
  }

  snapshot(workflowId: string): WorkflowSnapshot | undefined {
    return workflowDao.snapshot(this.options.userId, workflowId);
  }

  reviseDefinition(input: Omit<ReviseWorkflowInput, "userId" | "at">): WorkflowSnapshot | null {
    return workflowDao.reviseDefinition({ ...input, userId: this.options.userId, at: this.now() });
  }

  start(workflowId: string, expectedVersion: number): WorkflowSnapshot | null {
    return workflowDao.start(this.options.userId, workflowId, expectedVersion, this.now());
  }

  tick(workflowId: string, expectedVersion: number): WorkflowSnapshot | null {
    return workflowDao.tick(this.options.userId, workflowId, expectedVersion, this.now());
  }

  expand(input: Omit<ExpandWorkflowInput, "userId" | "at">): WorkflowSnapshot | null {
    return workflowDao.expand({ ...input, userId: this.options.userId, at: this.now() });
  }

  sealGraph(input: Omit<SealWorkflowInput, "userId" | "at" | "mutationId"> & { mutationId?: string }): WorkflowSnapshot | null {
    return workflowDao.sealGraph({
      ...input,
      userId: this.options.userId,
      at: this.now(),
    });
  }

  signal(workflowId: string, signalName: string, expectedVersion: number) {
    return workflowDao.signal(this.options.userId, workflowId, signalName, expectedVersion, this.now());
  }

  claimReadyNode(input: ClaimReadyWorkflowNodeInput): WorkflowDispatch | null {
    const value: ClaimWorkflowNodeInput = {
      ...input,
      userId: this.options.userId,
      taskId: this.makeId("task"),
      ...(input.cacheHit === undefined ? {} : { resultId: this.makeId("result") }),
      at: this.now(),
    };
    return workflowDao.claim(value);
  }

  claimNextReady(
    workflowId: string,
    expectedVersion: number,
    cache?: { evidence?: WorkflowCacheEvidence; hit?: WorkflowCacheHit },
  ): WorkflowDispatch | null {
    const snapshot = this.snapshot(workflowId);
    if (!snapshot || snapshot.workflow.version !== expectedVersion) return null;
    const node = snapshot.nodes.find((candidate) => candidate.status === "ready");
    if (!node) return null;
    return this.claimReadyNode({
      workflowId,
      nodeId: node.id,
      expectedVersion,
      ...(cache?.evidence === undefined ? {} : { cacheEvidence: cache.evidence }),
      ...(cache?.hit === undefined ? {} : { cacheHit: cache.hit }),
    });
  }

  settle(input: Omit<SettleWorkflowAttemptInput, "userId" | "at">): WorkflowSnapshot | null {
    return workflowDao.settle({ ...input, userId: this.options.userId, at: this.now() });
  }

  recordUsage(input: Omit<RecordWorkflowAttemptUsageInput, "userId" | "at">): WorkflowSnapshot | null {
    return workflowDao.recordUsage({ ...input, userId: this.options.userId, at: this.now() });
  }

  cancel(workflowId: string, expectedVersion: number): WorkflowSnapshot | null {
    return workflowDao.cancel(this.options.userId, workflowId, expectedVersion, this.now());
  }

  recover(workflowId: string): WorkflowRecoveryResult | null {
    return workflowDao.recover(this.options.userId, workflowId, this.now());
  }

  events(workflowId: string, afterSeq = 0, limit = 100): WorkflowEvent[] {
    return workflowDao.listEvents(this.options.userId, workflowId, afterSeq, limit);
  }
}

export interface WorkflowCoordinatorOptions extends WorkflowEngineOptions {
  maxDispatchPerPump?: number;
}

export interface WorkflowPumpResult {
  snapshot?: WorkflowSnapshot;
  dispatches: WorkflowDispatch[];
  recovery?: WorkflowRecoveryResult;
}

export interface WorkflowCoordinatorPage {
  workflows: Workflow[];
  next?: WorkflowCoordinatorCursor;
}

export class WorkflowCoordinator {
  private readonly engine: WorkflowEngine;
  private readonly maxDispatchPerPump: number;
  private readonly now: () => number;

  constructor(private readonly options: WorkflowCoordinatorOptions) {
    this.engine = new WorkflowEngine(options);
    this.now = options.now ?? Date.now;
    this.maxDispatchPerPump = Math.max(1, Math.min(64, Math.trunc(options.maxDispatchPerPump ?? 16)));
  }

  create(input: CreateWorkflowInput): WorkflowSnapshot {
    return this.engine.create(input);
  }

  start(workflowId: string, expectedVersion: number): WorkflowSnapshot | null {
    return this.engine.start(workflowId, expectedVersion);
  }

  pump(workflowId: string, dispatchLimit = this.maxDispatchPerPump): WorkflowPumpResult {
    const recovery = this.engine.recover(workflowId) ?? undefined;
    let snapshot = this.engine.snapshot(workflowId);
    if (!snapshot) return { dispatches: [], ...(recovery ? { recovery } : {}) };
    if (["draft", "cancelling", "succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.workflow.status)) {
      return { snapshot, dispatches: [], ...(recovery ? { recovery } : {}) };
    }
    snapshot = this.engine.tick(workflowId, snapshot.workflow.version) ?? this.engine.snapshot(workflowId);
    if (!snapshot) return { dispatches: [], ...(recovery ? { recovery } : {}) };
    const dispatches: WorkflowDispatch[] = [];
    const bound = Math.max(1, Math.min(64, Math.trunc(dispatchLimit)));
    let conflicts = 0;
    while (dispatches.length < bound) {
      if (
        snapshot.workflow.attemptsUsed >= snapshot.workflow.budget.maxAttempts
        || snapshot.workflow.tokensUsed + snapshot.workflow.tokensReserved >= snapshot.workflow.budget.maxTokens
        || snapshot.workflow.costUsedMicros + snapshot.workflow.costReservedMicros
          >= snapshot.workflow.budget.maxCostMicros
        || (snapshot.workflow.startedAt !== undefined
          && this.now() - snapshot.workflow.startedAt > snapshot.workflow.budget.maxRuntimeMs)
      ) break;
      const ready = snapshot.nodes.find((node) => node.status === "ready");
      if (!ready) break;
      let dispatch: WorkflowDispatch | null;
      try {
        dispatch = this.engine.claimReadyNode({
          workflowId,
          nodeId: ready.id,
          expectedVersion: snapshot.workflow.version,
        });
      } catch (error) {
        if (
          error instanceof OrchestrationTaskCapacityError
          || error instanceof WorkflowDispatchUnavailableError
        ) break;
        throw error;
      }
      if (!dispatch) {
        conflicts += 1;
        if (conflicts >= 4) break;
        const refreshed = this.engine.snapshot(workflowId);
        if (!refreshed) break;
        snapshot = refreshed;
        continue;
      }
      conflicts = 0;
      dispatches.push(dispatch);
      const refreshed = this.engine.snapshot(workflowId);
      if (!refreshed) break;
      snapshot = refreshed;
    }
    return { snapshot, dispatches, ...(recovery ? { recovery } : {}) };
  }

  settleExecution(
    input: Omit<SettleWorkflowExecutionInput, "userId">,
  ): WorkflowExecutionSettlement | null {
    return workflowDao.settleExecution({ ...input, userId: this.options.userId });
  }

  recordTaskUsage(input: {
    taskId: string;
    expectedTaskLeaseGeneration: number;
    tokensUsed: number;
    costUsedMicros: number;
  }): WorkflowSnapshot | null {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const target = workflowDao.attemptTarget(this.options.userId, input.taskId);
      if (!target) return null;
      if (target.taskLeaseGeneration !== input.expectedTaskLeaseGeneration) return null;
      const value = this.engine.recordUsage({
        workflowId: target.workflowId,
        nodeId: target.nodeId,
        taskId: input.taskId,
        expectedTaskLeaseGeneration: input.expectedTaskLeaseGeneration,
        expectedVersion: target.workflowVersion,
        tokensUsed: input.tokensUsed,
        costUsedMicros: input.costUsedMicros,
      });
      if (value) return value;
      if (!["starting", "running", "waiting", "cancel_requested"].includes(target.taskStatus)) return null;
    }
    return null;
  }

  candidates(limit = 50, after?: WorkflowCoordinatorCursor): WorkflowCoordinatorPage {
    const workflows = workflowDao.listCoordinatorCandidates(this.options.userId, {
      limit,
      ...(after === undefined ? {} : { after }),
    });
    const last = workflows.at(-1);
    return {
      workflows,
      ...(last === undefined ? {} : { next: { id: last.id } }),
    };
  }

  cancel(workflowId: string): WorkflowSnapshot | null {
    const snapshot = this.engine.snapshot(workflowId);
    if (!snapshot) return null;
    return this.engine.cancel(workflowId, snapshot.workflow.version);
  }

}
