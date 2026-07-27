import type {
  OrchestrationJson,
  RuntimeTask,
  TaskResult,
} from "../../../shared/src/orchestration.ts";
import { runtimeTaskDao, taskResultDao } from "../persistence/orchestration.ts";
import { workflowDao } from "../persistence/workflow.ts";
import { WorkflowCoordinator } from "./workflow-engine.ts";

export interface OwnedTaskSettlementInput {
  task: RuntimeTask;
  userId: string;
  resultId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted";
  summary: string;
  body: OrchestrationJson;
  artifacts: OrchestrationJson;
  tokensUsed?: number;
  costUsedMicros?: number;
  eventType: string;
  eventPayload: OrchestrationJson;
  at: number;
}

export interface OwnedTaskSettlement {
  task: RuntimeTask;
  result?: TaskResult;
}

export function checkpointOwnedTaskUsage(input: {
  task: RuntimeTask;
  userId: string;
  tokensUsed: number;
  costUsedMicros: number;
  at: number;
}): boolean {
  switch (input.task.kind) {
    case "delegation":
      return true;
    case "workflow_node":
      return Boolean(new WorkflowCoordinator({ userId: input.userId, now: () => input.at }).recordTaskUsage({
        taskId: input.task.id,
        expectedTaskLeaseGeneration: input.task.leaseGeneration,
        tokensUsed: input.tokensUsed,
        costUsedMicros: input.costUsedMicros,
      }));
    case "team_turn":
      throw new Error("team_turn usage requires its trusted Team owner");
  }
}

export function recordOwnedTaskLateUsage(input: {
  task: RuntimeTask;
  userId: string;
  tokensUsed: number;
  costUsedMicros: number;
  at: number;
}): boolean {
  if (input.task.kind === "delegation") return true;
  if (input.task.kind === "team_turn") {
    throw new Error("team_turn late usage requires its trusted Team owner");
  }
  return Boolean(workflowDao.recordLateUsage({
    userId: input.userId,
    taskId: input.task.id,
    expectedTaskLeaseGeneration: input.task.leaseGeneration,
    tokensUsed: input.tokensUsed,
    costUsedMicros: input.costUsedMicros,
    at: input.at,
  }));
}

export function settleOwnedTask(
  input: OwnedTaskSettlementInput,
): OwnedTaskSettlement | null {
  const resultBase = {
    id: input.resultId,
    taskId: input.task.id,
    userId: input.userId,
    summary: input.summary,
    body: input.body,
    artifacts: input.artifacts,
    expectedTaskVersion: input.task.version,
    expectedLeaseGeneration: input.task.leaseGeneration,
    eventType: input.eventType,
    eventPayload: input.eventPayload,
    createdAt: input.at,
  } as const;
  switch (input.task.kind) {
    case "delegation": {
      if (input.outcome === "succeeded" || input.outcome === "failed") {
        return taskResultDao.settle({ ...resultBase, nextStatus: input.outcome });
      }
      const task = runtimeTaskDao.transition({
        id: input.task.id,
        userId: input.userId,
        expectedVersion: input.task.version,
        expectedLeaseGeneration: input.task.leaseGeneration,
        nextStatus: input.outcome,
        at: input.at,
        eventType: input.eventType,
        eventPayload: input.eventPayload,
      });
      return task ? { task } : null;
    }
    case "workflow_node":
      if (input.outcome === "succeeded" || input.outcome === "failed") {
        return workflowDao.settleExecution({
          ...resultBase,
          nextStatus: input.outcome,
          ...(input.tokensUsed === undefined ? {} : { tokensUsed: input.tokensUsed }),
          ...(input.costUsedMicros === undefined ? {} : { costUsedMicros: input.costUsedMicros }),
        });
      }
      return workflowDao.settleExecutionWithoutResult({
        id: input.task.id,
        userId: input.userId,
        expectedVersion: input.task.version,
        expectedLeaseGeneration: input.task.leaseGeneration,
        nextStatus: input.outcome,
        at: input.at,
        eventType: input.eventType,
        eventPayload: input.eventPayload,
        ...(input.tokensUsed === undefined ? {} : { tokensUsed: input.tokensUsed }),
        ...(input.costUsedMicros === undefined ? {} : { costUsedMicros: input.costUsedMicros }),
      });
    case "team_turn":
      throw new Error("team_turn Task settlement requires its trusted Team owner");
  }
}
