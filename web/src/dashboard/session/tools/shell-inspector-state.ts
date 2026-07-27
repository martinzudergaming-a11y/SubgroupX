import type { TimelineItem } from '@shared/protocol';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export type ShellDetailSurface = 'command' | 'details' | 'output';

export function shellDetailSurface(item: ToolItem): ShellDetailSurface {
  const executionStarted = item.status === 'running' || item.status === 'success'
    || item.durationMs != null || item.runningElapsedMs != null || item.shell != null;
  if (executionStarted) return 'output';
  if (item.status === 'error' && Boolean(item.resultText)) return 'details';
  return 'command';
}
