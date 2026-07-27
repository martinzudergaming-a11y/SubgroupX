import { useEffect, useState } from 'react';
import type { TimelineItem, WireAgentEvent } from '@shared/protocol';
import type { ToolItem } from '../../../conversation/tools/tool-presentation-helpers';

type Anchor = { baseMs: number; observedAt: number };

const MAX_ANCHORS = 256;
const anchors = new Map<string, Anchor>();
const clockNow = (): number => globalThis.performance?.now?.() ?? Date.now();
const clockKey = (sessionId: string, toolId: string): string => `${sessionId}\0${toolId}`;

function boundedBase(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function current(anchor: Anchor, now = clockNow()): number {
  return anchor.baseMs + Math.max(0, now - anchor.observedAt);
}

function remember(key: string, baseMs: number): void {
  const now = clockNow();
  const existing = anchors.get(key);
  const base = existing ? Math.max(current(existing, now), boundedBase(baseMs)) : boundedBase(baseMs);
  anchors.delete(key);
  anchors.set(key, { baseMs: base, observedAt: now });
  while (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value!);
}

function forget(sessionId: string, toolId: string): void {
  anchors.delete(clockKey(sessionId, toolId));
}

export function observeToolTimingEvent(sessionId: string, event: WireAgentEvent): void {
  if (event.t === 'subagent_event') {
    observeToolTimingEvent(sessionId, event.event);
    return;
  }
  if (event.t === 'tool_status') {
    if (event.status === 'running') remember(clockKey(sessionId, event.id), event.runningElapsedMs ?? 0);
    else forget(sessionId, event.id);
  } else if (event.t === 'tool_end') {
    forget(sessionId, event.id);
  }
}

export function observeTimelineToolTiming(sessionId: string, items: TimelineItem[]): void {
  const running = new Map<string, number>();
  const walk = (rows: TimelineItem[]): void => {
    for (const row of rows) {
      if (row.kind !== 'tool') continue;
      if (row.status === 'running') running.set(row.id, row.runningElapsedMs ?? 0);
      if (row.children) walk(row.children);
    }
  };
  walk(items);

  const prefix = `${sessionId}\0`;
  for (const key of anchors.keys()) {
    if (key.startsWith(prefix) && !running.has(key.slice(prefix.length))) anchors.delete(key);
  }
  for (const [toolId, elapsedMs] of running) remember(clockKey(sessionId, toolId), elapsedMs);
}

export function useToolElapsed(sessionId: string, item: ToolItem): number | null {
  const running = item.status === 'running';
  const [elapsed, setElapsed] = useState<number | null>(() => {
    if (!running) return item.durationMs ?? null;
    const key = clockKey(sessionId, item.id);
    if (!anchors.has(key)) remember(key, item.runningElapsedMs ?? 0);
    return current(anchors.get(key)!);
  });

  useEffect(() => {
    if (!running) {
      forget(sessionId, item.id);
      setElapsed(item.durationMs ?? null);
      return;
    }
    const key = clockKey(sessionId, item.id);
    remember(key, item.runningElapsedMs ?? 0);
    const update = () => setElapsed(current(anchors.get(key) ?? { baseMs: item.runningElapsedMs ?? 0, observedAt: clockNow() }));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [sessionId, item.id, item.status, item.runningElapsedMs, item.durationMs, running]);

  return running ? elapsed : (item.durationMs ?? null);
}
