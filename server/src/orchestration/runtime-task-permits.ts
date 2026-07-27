const DEFAULT_RUNTIME_TASK_CONCURRENCY = 8;
const MAX_RUNTIME_TASK_CONCURRENCY = 32;

function boundedConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUNTIME_TASK_CONCURRENCY) {
    throw new RangeError(`Runtime Task concurrency must be from 1 to ${MAX_RUNTIME_TASK_CONCURRENCY}`);
  }
  return value;
}

export function configuredRuntimeTaskConcurrency(): number {
  const raw = Number(process.env.AGENT_WEB_RUNTIME_TASK_CONCURRENCY ?? DEFAULT_RUNTIME_TASK_CONCURRENCY);
  return boundedConcurrency(Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_RUNTIME_TASK_CONCURRENCY);
}

export interface RuntimeTaskPermitPoolStats {
  limit: number;
  active: number;
  offered: number;
}

export type RuntimeTaskPermitPoolSignal = "offer-consumed" | "active-released";

export class RuntimeTaskPermitPool {
  readonly limit: number;

  private readonly offeredRoots = new Set<string>();
  private readonly activeByRoot = new Map<string, number>();
  private activeCount = 0;
  private onCapacity: ((signal: RuntimeTaskPermitPoolSignal) => void) | undefined;

  constructor(limit = configuredRuntimeTaskConcurrency()) {
    this.limit = boundedConcurrency(limit);
  }

  setCapacityListener(listener: ((signal: RuntimeTaskPermitPoolSignal) => void) | undefined): void {
    this.onCapacity = listener;
  }

  availableOfferSlots(): number {
    return Math.max(0, this.limit - this.activeCount - this.offeredRoots.size);
  }

  offer(rootAgentId: string): boolean {
    if (
      !rootAgentId
      || this.availableOfferSlots() === 0
      || this.offeredRoots.has(rootAgentId)
    ) return false;
    this.offeredRoots.add(rootAgentId);
    return true;
  }

  acquire(rootAgentId: string): (() => void) | undefined {
    if (!this.offeredRoots.delete(rootAgentId)) return undefined;
    if (this.activeCount >= this.limit) {
      return undefined;
    }
    this.activeCount += 1;
    this.activeByRoot.set(rootAgentId, (this.activeByRoot.get(rootAgentId) ?? 0) + 1);
    this.signalCapacity("offer-consumed");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const rootActive = this.activeByRoot.get(rootAgentId) ?? 0;
      if (rootActive <= 0) return;
      this.activeCount -= 1;
      if (rootActive === 1) this.activeByRoot.delete(rootAgentId);
      else this.activeByRoot.set(rootAgentId, rootActive - 1);
      this.signalCapacity("active-released");
    };
  }

  revoke(rootAgentId: string): boolean {
    return this.offeredRoots.delete(rootAgentId);
  }

  clearOffers(): number {
    const count = this.offeredRoots.size;
    this.offeredRoots.clear();
    return count;
  }

  hasActive(rootAgentId: string): boolean {
    return (this.activeByRoot.get(rootAgentId) ?? 0) > 0;
  }

  hasOffer(rootAgentId: string): boolean {
    return this.offeredRoots.has(rootAgentId);
  }

  stats(): RuntimeTaskPermitPoolStats {
    return {
      limit: this.limit,
      active: this.activeCount,
      offered: this.offeredRoots.size,
    };
  }

  private signalCapacity(signal: RuntimeTaskPermitPoolSignal): void {
    try {
      this.onCapacity?.(signal);
    } catch {
    }
  }
}

export const runtimeTaskPermitPool = new RuntimeTaskPermitPool();
