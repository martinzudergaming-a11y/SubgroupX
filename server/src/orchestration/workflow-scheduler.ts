import type { Workflow } from "../../../shared/src/orchestration.ts";
import {
  workflowDao,
  type WorkflowCancellationTarget,
  type WorkflowSchedulerCursor,
} from "../persistence/workflow.ts";
import { WorkflowCoordinator } from "./workflow-engine.ts";

const DEFAULT_TRUTH_SCAN_MS = 1_000;
const DEFAULT_PAGE_SIZE = 16;
const DEFAULT_PAGES_PER_PUMP = 1;

export interface WorkflowSchedulerControl {
  hint(userId?: string, workflowId?: string): void;
  stopClaiming(): void;
}

export interface WorkflowSchedulerHost {
  isDraining(): boolean;
  attachWorkflowScheduler(control: WorkflowSchedulerControl): () => void;
  notifyWorkflowChanged(workflow: Workflow): void;
  hintRuntimeTasks(userId: string): void;
  interruptWorkflowTask(target: WorkflowCancellationTarget): boolean;
}

export interface WorkflowSchedulerOptions {
  truthScanMs?: number;
  pageSize?: number;
  pagesPerPump?: number;
  dispatchPerWorkflow?: number;
  onError?: (error: unknown, context: { phase: "scan" | "pump" | "interrupt"; workflowId?: string }) => void;
}

export interface WorkflowSchedulerStats {
  running: boolean;
  cursor: WorkflowSchedulerCursor | undefined;
  pumpQueued: boolean;
  hintedWorkflow: string | undefined;
  scanned: number;
  materializedTasks: number;
  cancellationWakes: number;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be from ${min} to ${max}`);
  }
  return value;
}

export class WorkflowScheduler implements WorkflowSchedulerControl {
  private readonly truthScanMs: number;
  private readonly pageSize: number;
  private readonly pagesPerPump: number;
  private readonly dispatchPerWorkflow: number;
  private detachHost: (() => void) | undefined;
  private truthTimer: ReturnType<typeof setInterval> | undefined;
  private cursor: WorkflowSchedulerCursor | undefined;
  private hinted: { userId: string; workflowId: string } | null | undefined;
  private pumpQueued = false;
  private repumpRequested = false;
  private pumping = false;
  private running = false;
  private scanned = 0;
  private materializedTasks = 0;
  private cancellationWakes = 0;

  constructor(
    private readonly host: WorkflowSchedulerHost,
    private readonly options: WorkflowSchedulerOptions = {},
  ) {
    this.truthScanMs = boundedInteger(
      Math.trunc(options.truthScanMs ?? DEFAULT_TRUTH_SCAN_MS),
      "truthScanMs",
      10,
      60_000,
    );
    this.pageSize = boundedInteger(
      Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE),
      "pageSize",
      1,
      200,
    );
    this.pagesPerPump = boundedInteger(
      Math.trunc(options.pagesPerPump ?? DEFAULT_PAGES_PER_PUMP),
      "pagesPerPump",
      1,
      32,
    );
    this.dispatchPerWorkflow = boundedInteger(
      Math.trunc(options.dispatchPerWorkflow ?? 16),
      "dispatchPerWorkflow",
      1,
      64,
    );
  }

  start(): this {
    if (this.running || this.host.isDraining()) return this;
    this.running = true;
    this.detachHost = this.host.attachWorkflowScheduler(this);
    this.truthTimer = setInterval(() => this.hint(), this.truthScanMs);
    this.truthTimer.unref?.();
    this.hint();
    return this;
  }

  hint(userId?: string, workflowId?: string): void {
    if (!this.running || this.host.isDraining()) return;
    if (userId && workflowId) {
      if (this.hinted === undefined) this.hinted = { userId, workflowId };
      else if (!this.hinted || this.hinted.userId !== userId || this.hinted.workflowId !== workflowId) {
        this.hinted = null;
      }
    } else {
      this.hinted = null;
    }
    this.requestPump();
  }

  stopClaiming(): void {
    if (!this.running) return;
    this.running = false;
    this.pumpQueued = false;
    this.repumpRequested = false;
    this.hinted = undefined;
    if (this.truthTimer) {
      clearInterval(this.truthTimer);
      this.truthTimer = undefined;
    }
    const detach = this.detachHost;
    this.detachHost = undefined;
    detach?.();
  }

  stats(): WorkflowSchedulerStats {
    return {
      running: this.running,
      cursor: this.cursor,
      pumpQueued: this.pumpQueued,
      hintedWorkflow: this.hinted ? this.hinted.workflowId : undefined,
      scanned: this.scanned,
      materializedTasks: this.materializedTasks,
      cancellationWakes: this.cancellationWakes,
    };
  }

  private requestPump(): void {
    if (this.pumping) {
      this.repumpRequested = true;
      return;
    }
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    setImmediate(() => {
      this.pumpQueued = false;
      if (!this.running || this.host.isDraining()) return;
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping || !this.running || this.host.isDraining()) return;
    this.pumping = true;
    try {
      const hinted = this.hinted;
      this.hinted = undefined;
      if (hinted) {
        const workflow = workflowDao.snapshot(hinted.userId, hinted.workflowId)?.workflow;
        if (workflow) this.process(workflow);
      }
      this.scanTruth();
    } catch (error) {
      this.report(error, { phase: "scan" });
    } finally {
      this.pumping = false;
      const repump = this.repumpRequested || this.hinted !== undefined;
      this.repumpRequested = false;
      if (repump && this.running) this.requestPump();
    }
  }

  private scanTruth(): void {
    for (let page = 0; page < this.pagesPerPump; page += 1) {
      const candidates = workflowDao.listSchedulerCandidates({
        limit: this.pageSize,
        ...(this.cursor === undefined ? {} : { after: this.cursor }),
      });
      if (candidates.length === 0) {
        this.cursor = undefined;
        return;
      }
      for (const workflow of candidates) {
        this.cursor = { userId: workflow.userId, id: workflow.id };
        this.process(workflow);
      }
      if (candidates.length < this.pageSize) {
        this.cursor = undefined;
        return;
      }
      if (page === this.pagesPerPump - 1) this.repumpRequested = true;
    }
  }

  private process(workflow: Workflow): void {
    this.scanned += 1;
    try {
      const coordinator = new WorkflowCoordinator({
        userId: workflow.userId,
        maxDispatchPerPump: this.dispatchPerWorkflow,
      });
      const result = coordinator.pump(workflow.id, this.dispatchPerWorkflow);
      const current = result.snapshot?.workflow ?? workflowDao.snapshot(workflow.userId, workflow.id)?.workflow;
      if (current && current.version > workflow.version) {
        this.host.notifyWorkflowChanged(current);
      }
      if (result.dispatches.length > 0) {
        this.materializedTasks += result.dispatches.length;
        this.host.hintRuntimeTasks(workflow.userId);
      }
      if (current?.status === "cancelling") this.wakeCancellation(current.userId, current.id);
    } catch (error) {
      this.report(error, { phase: "pump", workflowId: workflow.id });
    }
  }

  private wakeCancellation(userId: string, workflowId: string): void {
    for (const target of workflowDao.listCancellationTargets(userId, workflowId)) {
      try {
        if (this.host.interruptWorkflowTask(target)) this.cancellationWakes += 1;
      } catch (error) {
        this.report(error, { phase: "interrupt", workflowId });
      }
    }
  }

  private report(
    error: unknown,
    context: { phase: "scan" | "pump" | "interrupt"; workflowId?: string },
  ): void {
    try {
      this.options.onError?.(error, context);
    } catch {
    }
    const message = error instanceof Error ? error.message : String(error ?? "unknown failure");
    console.error(`[workflow-scheduler] ${context.phase}: ${message.slice(0, 500)}`);
  }
}

let runtimeOwnedScheduler: WorkflowScheduler | undefined;

export function startWorkflowScheduler(host: WorkflowSchedulerHost): WorkflowScheduler {
  if (!runtimeOwnedScheduler || !runtimeOwnedScheduler.stats().running) {
    runtimeOwnedScheduler = new WorkflowScheduler(host).start();
  }
  return runtimeOwnedScheduler;
}
