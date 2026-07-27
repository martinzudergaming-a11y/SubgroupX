import type { PendingMessage, TimelineItem } from "@shared/protocol";

export interface SessionTimelineSnapshot {
  sessionId: string;
  epoch: string;
  version: number;
  items: TimelineItem[];
  pending: PendingMessage[];
  approxChars: number;
  pendingApproxChars?: number;
}

export const SESSION_TIMELINE_CACHE_MAX_SESSIONS = 3;
export const SESSION_TIMELINE_CACHE_MAX_ITEMS = 6_000;
export const SESSION_TIMELINE_CACHE_MAX_ITEMS_PER_SESSION = 3_000;
export const SESSION_TIMELINE_CACHE_MAX_CHARS = 48 * 1024 * 1024;
export const SESSION_TIMELINE_CACHE_MAX_CHARS_PER_SESSION = 24 * 1024 * 1024;

const isLocalId = (id: string): boolean => id.startsWith("local_");

function pendingApproxChars(pending: PendingMessage[]): number {
  return pending.reduce((sum, item) => sum + item.id.length + item.text.length + item.kind.length + 64, 0);
}

export class SessionTimelineCache {
  private entries = new Map<string, SessionTimelineSnapshot>();
  private itemCount = 0;
  private charCount = 0;

  read(sessionId: string): SessionTimelineSnapshot | null {
    const snapshot = this.entries.get(sessionId);
    if (!snapshot) return null;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, snapshot);
    return snapshot;
  }

  write(snapshot: SessionTimelineSnapshot): boolean {
    if (!snapshot.epoch || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0) return false;

    const isTransient = (item: TimelineItem): boolean => isLocalId(item.id) || item.kind === "compaction_pending";
    const items = snapshot.items.some(isTransient)
      ? snapshot.items.filter((item) => !isTransient(item))
      : snapshot.items;
    const pending = snapshot.pending.some((item) => isLocalId(item.id))
      ? snapshot.pending.filter((item) => !isLocalId(item.id))
      : snapshot.pending;
    const weight = items.length + pending.length;
    const pendingChars = pendingApproxChars(pending);
    const retainedChars = snapshot.approxChars + pendingChars;

    this.delete(snapshot.sessionId);
    if (
      weight > SESSION_TIMELINE_CACHE_MAX_ITEMS_PER_SESSION
      || retainedChars > SESSION_TIMELINE_CACHE_MAX_CHARS_PER_SESSION
    ) return false;

    const stable = items === snapshot.items && pending === snapshot.pending && pendingChars === (snapshot.pendingApproxChars ?? 0)
      ? snapshot
      : { ...snapshot, items, pending, pendingApproxChars: pendingChars };
    this.entries.set(snapshot.sessionId, stable);
    this.itemCount += weight;
    this.charCount += retainedChars;
    this.trim();
    return this.entries.has(snapshot.sessionId);
  }

  delete(sessionId: string): void {
    const previous = this.entries.get(sessionId);
    if (!previous) return;
    this.itemCount -= previous.items.length + previous.pending.length;
    this.charCount -= previous.approxChars + (previous.pendingApproxChars ?? 0);
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
    this.itemCount = 0;
    this.charCount = 0;
  }

  stats(): { sessions: number; items: number; chars: number; ids: string[] } {
    return { sessions: this.entries.size, items: this.itemCount, chars: this.charCount, ids: [...this.entries.keys()] };
  }

  private trim(): void {
    while (
      this.entries.size > SESSION_TIMELINE_CACHE_MAX_SESSIONS
      || this.itemCount > SESSION_TIMELINE_CACHE_MAX_ITEMS
      || this.charCount > SESSION_TIMELINE_CACHE_MAX_CHARS
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
    }
  }
}
