import {
  ORCHESTRATION_QUERY_MAX,
  runtimeTaskDao,
  teamTaskDao,
  type RunnableBackgroundRoot,
} from "../persistence/orchestration.ts";
import type {
  RuntimeTaskDispatchControl,
  RuntimeTaskRootActivation,
} from "../runtime/manager.ts";
import type { RuntimeTaskPermitPoolStats } from "./runtime-task-permits.ts";

const DEFAULT_TRUTH_SCAN_MS = 1_000;
const DEFAULT_SCAN_PAGES_PER_PUMP = 16;

export interface RuntimeTaskDispatchHost {
  isDraining(): boolean;
  attachRuntimeTaskDispatcher(control: RuntimeTaskDispatchControl): () => void;
  runtimeTaskDispatchCapacity(): RuntimeTaskPermitPoolStats;
  activateRuntimeTaskRoot(candidate: RunnableBackgroundRoot): RuntimeTaskRootActivation;
  reconcileTeamProvisioning?(maxProvision?: number): unknown;
}

export interface RuntimeTaskDispatcherOptions {
  truthScanMs?: number;
  scanPageSize?: number;
  scanPagesPerPump?: number;
  onError?: (error: unknown, phase: "scan" | "activate" | "reconcile") => void;
}

export interface RuntimeTaskDispatcherStats {
  running: boolean;
  cursor: string;
  pumpQueued: boolean;
  hintedUsers: number;
  scannedRoots: number;
  activatedRoots: number;
  rejectedRoots: number;
  permits: RuntimeTaskPermitPoolStats;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be from ${min} to ${max}`);
  }
  return value;
}

export class RuntimeTaskDispatcher implements RuntimeTaskDispatchControl {
  private readonly truthScanMs: number;
  private readonly scanPageSize: number;
  private readonly scanPagesPerPump: number;
  private detachHost: (() => void) | undefined;
  private truthTimer: ReturnType<typeof setInterval> | undefined;
  private cursor = "";
  private hintedUserId: string | null | undefined;
  private pumpQueued = false;
  private repumpRequested = false;
  private pumping = false;
  private running = false;
  private readonly rejectedRoots = new Set<string>();
  private scannedRoots = 0;
  private activatedRoots = 0;

  constructor(
    private readonly host: RuntimeTaskDispatchHost,
    private readonly options: RuntimeTaskDispatcherOptions = {},
  ) {
    this.truthScanMs = boundedInteger(
      Math.trunc(options.truthScanMs ?? DEFAULT_TRUTH_SCAN_MS),
      "truthScanMs",
      10,
      60_000,
    );
    this.scanPageSize = boundedInteger(
      Math.trunc(options.scanPageSize ?? ORCHESTRATION_QUERY_MAX),
      "scanPageSize",
      1,
      ORCHESTRATION_QUERY_MAX,
    );
    this.scanPagesPerPump = boundedInteger(
      Math.trunc(options.scanPagesPerPump ?? DEFAULT_SCAN_PAGES_PER_PUMP),
      "scanPagesPerPump",
      1,
      32,
    );
  }

  start(): this {
    if (this.running) return this;
    if (this.host.isDraining()) return this;
    this.running = true;
    this.detachHost = this.host.attachRuntimeTaskDispatcher(this);
    this.truthTimer = setInterval(() => this.hint(), this.truthScanMs);
    this.truthTimer.unref?.();
    this.hint();
    return this;
  }

  hint(userId?: string): void {
    if (!this.running || this.host.isDraining()) return;
    this.rejectedRoots.clear();
    if (userId) {
      if (this.hintedUserId === undefined) this.hintedUserId = userId;
      else if (this.hintedUserId !== userId) this.hintedUserId = null;
    } else {
      this.hintedUserId = null;
    }
    this.requestPump();
  }

  continueScan(): void {
    if (!this.running || this.host.isDraining()) return;
    this.requestPump();
  }

  reject(rootAgentId: string): void {
    if (!this.running || this.host.isDraining() || !rootAgentId) return;
    const limit = this.scanPageSize * this.scanPagesPerPump;
    if (this.rejectedRoots.has(rootAgentId)) return;
    if (this.rejectedRoots.size >= limit) return;
    this.rejectedRoots.add(rootAgentId);
    this.requestPump();
  }

  private requestPump(): void {
    if (this.pumping) {
      this.repumpRequested = true;
      return;
    }
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      if (!this.running || this.host.isDraining()) return;
      this.pump();
    });
  }

  stopClaiming(): void {
    if (!this.running) return;
    this.running = false;
    this.pumpQueued = false;
    this.repumpRequested = false;
    this.hintedUserId = undefined;
    this.rejectedRoots.clear();
    if (this.truthTimer) {
      clearInterval(this.truthTimer);
      this.truthTimer = undefined;
    }
    const detach = this.detachHost;
    this.detachHost = undefined;
    detach?.();
  }

  stats(): RuntimeTaskDispatcherStats {
    return {
      running: this.running,
      cursor: this.cursor,
      pumpQueued: this.pumpQueued,
      hintedUsers: this.hintedUserId && this.hintedUserId.length > 0 ? 1 : 0,
      scannedRoots: this.scannedRoots,
      activatedRoots: this.activatedRoots,
      rejectedRoots: this.rejectedRoots.size,
      permits: this.host.runtimeTaskDispatchCapacity(),
    };
  }

  private pump(): void {
    if (this.pumping || !this.running || this.host.isDraining()) return;
    this.pumping = true;
    try {
      try {
        this.host.reconcileTeamProvisioning?.(this.scanPageSize);
      } catch (error) {
        this.report(error, "reconcile");
      }
      for (let page = 0; page < this.scanPagesPerPump; page += 1) {
        if (teamTaskDao.sweepBlockedAttempts(Date.now(), this.scanPageSize) < this.scanPageSize) break;
      }
      for (let page = 0; page < this.scanPagesPerPump; page += 1) {
        if (runtimeTaskDao.cancelOrphanedLinked(Date.now(), this.scanPageSize) < this.scanPageSize) break;
      }
      const hint = this.hintedUserId;
      this.hintedUserId = undefined;
      if (hint) this.scanHintedUser(hint);
      this.scanFairCursor();
    } catch (error) {
      this.report(error, "scan");
    } finally {
      this.pumping = false;
      const repump = this.repumpRequested || this.hintedUserId !== undefined;
      this.repumpRequested = false;
      if (repump && this.running) this.requestPump();
    }
  }

  private scanHintedUser(userId: string): void {
    if (this.availableSlots() === 0) return;
    let cursor = "";
    for (let page = 0; page < this.scanPagesPerPump && this.availableSlots() > 0; page += 1) {
      const scanned = runtimeTaskDao.scanRunnableBackgroundRoots({
        userId,
        afterRootAgentId: cursor,
        limit: this.scanPageSize,
      });
      if (!scanned.scannedThrough) return;
      for (const root of scanned.roots) {
        if (this.rejectedRoots.has(root.rootAgentId)) continue;
        if (!this.activate(root)) return;
        return;
      }
      cursor = scanned.scannedThrough;
      if (scanned.exhausted) return;
    }
  }

  private scanFairCursor(): void {
    if (this.availableSlots() === 0) return;
    let wrapped = false;
    for (let page = 0; page < this.scanPagesPerPump && this.availableSlots() > 0; page += 1) {
      const scanned = runtimeTaskDao.scanRunnableBackgroundRoots({
        afterRootAgentId: this.cursor,
        limit: this.scanPageSize,
      });
      if (!scanned.scannedThrough) {
        if (wrapped || this.cursor === "") return;
        this.cursor = "";
        wrapped = true;
        page -= 1;
        continue;
      }
      for (const root of scanned.roots) {
        if (this.rejectedRoots.has(root.rootAgentId)) {
          this.cursor = root.rootAgentId;
          continue;
        }
        if (!this.activate(root)) return;
        this.cursor = root.rootAgentId;
        if (this.availableSlots() === 0) return;
      }
      this.cursor = scanned.scannedThrough;
      if (scanned.exhausted) {
        if (wrapped) return;
        this.cursor = "";
        wrapped = true;
      }
    }
  }

  private activate(root: RunnableBackgroundRoot): boolean {
    this.scannedRoots += 1;
    try {
      const result = this.host.activateRuntimeTaskRoot(root);
      if (result === "activated") this.activatedRoots += 1;
      return result !== "no-capacity" && result !== "draining";
    } catch (error) {
      this.reject(root.rootAgentId);
      this.report(error, "activate");
      return true;
    }
  }

  private availableSlots(): number {
    const permit = this.host.runtimeTaskDispatchCapacity();
    return Math.max(0, permit.limit - permit.active - permit.offered);
  }

  private report(error: unknown, phase: "scan" | "activate" | "reconcile"): void {
    try {
      this.options.onError?.(error, phase);
    } catch {
    }
    const message = error instanceof Error ? error.message : String(error ?? "unknown failure");
    console.error(`[runtime-task-dispatcher] ${phase}: ${message.slice(0, 500)}`);
  }
}

let runtimeOwnedDispatcher: RuntimeTaskDispatcher | undefined;

export function startRuntimeTaskDispatcher(host: RuntimeTaskDispatchHost): RuntimeTaskDispatcher {
  if (!runtimeOwnedDispatcher) runtimeOwnedDispatcher = new RuntimeTaskDispatcher(host).start();
  return runtimeOwnedDispatcher;
}
