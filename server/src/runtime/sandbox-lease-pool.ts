export interface ClosableLeaseValue {
  close?: () => void | Promise<void>;
}

export interface WarmLease<T> {
  value: T;
  release(): void;
}

export interface WarmLeaseSpec<T> {
  key: string;
  owner: string;
  fingerprint: string;
  create(): T;
}

interface Entry<T> {
  key: string;
  owner: string;
  fingerprint: string;
  value: T;
  refs: number;
  lastUsed: number;
  retired: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface WarmLeasePoolOptions {
  warmMs: number;
  maxEntries: number;
  maxEntriesPerOwner: number;
}

export class WarmLeasePool<T extends ClosableLeaseValue> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly allEntries = new Set<Entry<T>>();
  private clock = 0;

  constructor(private readonly options: WarmLeasePoolOptions) {}

  acquire(spec: WarmLeaseSpec<T>): WarmLease<T> {
    let entry = this.entries.get(spec.key);
    if (entry && entry.fingerprint !== spec.fingerprint) {
      this.retire(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        key: spec.key,
        owner: spec.owner,
        fingerprint: spec.fingerprint,
        value: spec.create(),
        refs: 0,
        lastUsed: ++this.clock,
        retired: false,
        closed: false,
        timer: null,
      };
      this.entries.set(spec.key, entry);
      this.allEntries.add(entry);
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.refs++;
    entry.lastUsed = ++this.clock;
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.enforceBounds(spec.owner);

    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry!.refs = Math.max(0, entry!.refs - 1);
        entry!.lastUsed = ++this.clock;
        if (entry!.refs !== 0) return;
        if (entry!.retired || this.options.warmMs <= 0) {
          this.closeEntry(entry!);
          return;
        }
        entry!.timer = setTimeout(() => {
          entry!.timer = null;
          if (entry!.refs === 0) this.closeEntry(entry!);
        }, this.options.warmMs);
        entry!.timer.unref?.();
        this.enforceBounds(entry!.owner);
      },
    };
  }

  invalidate(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.retire(entry);
    return true;
  }

  invalidateOwner(owner: string): number {
    let invalidated = 0;
    for (const entry of [...this.allEntries]) {
      if (entry.owner !== owner || entry.retired) continue;
      this.retire(entry);
      invalidated++;
    }
    return invalidated;
  }

  closeAll(): void {
    for (const entry of [...this.allEntries]) this.retire(entry);
  }

  stats(): { entries: number; active: number; warm: number } {
    let active = 0;
    for (const entry of this.allEntries) if (entry.refs > 0) active++;
    return { entries: this.allEntries.size, active, warm: this.allEntries.size - active };
  }

  private retire(entry: Entry<T>): void {
    entry.retired = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.refs === 0) this.closeEntry(entry);
  }

  private closeEntry(entry: Entry<T>): void {
    if (entry.closed || entry.refs > 0) return;
    entry.closed = true;
    this.allEntries.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    try {
      const result = entry.value.close?.();
      if (result && typeof result.then === "function") void result.catch(() => {});
    } catch {
    }
  }

  private enforceBounds(owner: string): void {
    const inactive = [...this.entries.values()]
      .filter((entry) => entry.refs === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    let ownerCount = [...this.entries.values()].filter((entry) => entry.owner === owner).length;
    while (ownerCount > this.options.maxEntriesPerOwner) {
      const victim = inactive.find((entry) => !entry.closed && entry.owner === owner);
      if (!victim) break;
      this.closeEntry(victim);
      ownerCount--;
    }

    while (this.entries.size > this.options.maxEntries) {
      const victim = inactive.find((entry) => !entry.closed);
      if (!victim) break;
      this.closeEntry(victim);
    }
  }
}
