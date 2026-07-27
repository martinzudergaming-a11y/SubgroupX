import {
  TerminalSquare,
  PencilLine,
  FileText,
  FilePlus,
  FolderTree,
  Network,
  ExternalLink,
  Wrench,
} from 'lucide-react';
import type { TFunction } from '../../i18n';
import type { TimelineItem, ToolKind, ToolCallStatus } from '@shared/protocol';

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export type ToolPhase = 'writing' | 'committing' | 'waiting' | 'running' | 'done';

export function toolPhase(status: ToolCallStatus): ToolPhase {
  switch (status) {
    case 'streaming_args': return 'writing';
    case 'ready': return 'committing';
    case 'pending':
    case 'approved': return 'waiting';
    case 'running': return 'running';
    case 'success':
    case 'error':
    case 'denied': return 'done';
  }
}

export function toolResultPlaceholderKey(phase: ToolPhase):
  | 'tool.streamingArgs'
  | 'tool.phaseReady'
  | 'tool.waitingRun'
  | 'tool.running'
  | 'tool.noOutput' {
  switch (phase) {
    case 'writing': return 'tool.streamingArgs';
    case 'committing': return 'tool.phaseReady';
    case 'waiting': return 'tool.waitingRun';
    case 'running': return 'tool.running';
    case 'done': return 'tool.noOutput';
  }
}

export function toolIcon(kind: ToolKind) {
  const cls = 'size-[15px] mr-2 opacity-90 stroke-[1.5]';
  switch (kind) {
    case 'shell': return <TerminalSquare className={cls} />;
    case 'read': return <FileText className={cls} />;
    case 'write': return <FilePlus className={cls} />;
    case 'edit': return <PencilLine className={cls} />;
    case 'list': return <FolderTree className={cls} />;
    case 'subagent': return <Network className={cls} />;
    case 'external': return <ExternalLink className={cls} />;
    default: return <Wrench className={cls} />;
  }
}

export function toolLabel(item: ToolItem, t: TFunction): string {
  const phase = toolPhase(item.status);
  const live = phase !== 'done';
  const cancelled = item.termination === 'cancelled';
  const denied = item.status === 'denied' && !cancelled;
  if (phase === 'committing') {
    return item.toolKind === 'shell'
      ? t('tool.readyShell', { command: item.name })
      : t('tool.ready', { name: item.name });
  }
  if (denied && item.path && (item.toolKind === 'read' || item.toolKind === 'write' || item.toolKind === 'edit' || item.toolKind === 'list')) {
    return t('tool.deniedPath', { path: item.path });
  }
  if (cancelled) {
    return item.path
      ? t('tool.cancelledPath', { path: item.path })
      : t('tool.cancelled', { name: item.name });
  }
  if (item.status === 'error') {
    return item.path
      ? t('tool.failedPath', { path: item.path })
      : t('tool.failed', { name: item.name });
  }
  switch (item.toolKind) {
    case 'shell':
      switch (phase) {
        case 'writing': return t('tool.writingShell', { command: item.name });
        case 'waiting': return t('tool.waitingShell', { command: item.name });
        case 'running': return t('tool.runningShell', { command: item.name });
        default: return t(denied ? 'tool.deniedShell' : 'tool.ran', { command: item.name });
      }
    case 'read': return item.path ? t(live ? 'tool.reading' : 'tool.read', { path: item.path }) : t('tool.readWith', { name: item.name });
    case 'write': return item.path ? t(live ? 'tool.writing' : 'tool.wrote', { path: item.path }) : t('tool.wroteWith', { name: item.name });
    case 'edit': return item.path ? t(live ? 'tool.editing' : 'tool.edited', { path: item.path }) : t('tool.editedWith', { name: item.name });
    case 'list': return item.path ? t(live ? 'tool.listing' : 'tool.listed', { path: item.path }) : t('tool.listedWith', { name: item.name });
    case 'subagent': {
      const args = item.arguments as Record<string, unknown>;
      const desc = String(args.description ?? args.task ?? '').split('\n')[0].trim();
      return desc ? t('tool.subagent', { desc: desc.slice(0, 64) }) : t('tool.subagentDelegated');
    }
    case 'external': {
      if (isExaSearch(item)) {
        const q = exaQuery(item);
        return q ? t('tool.searchedWeb', { query: q }) : t('tool.searchedWebNoQuery');
      }
      return t('tool.called', { name: item.name });
    }
    default: return t('tool.used', { name: item.name });
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  let m = Math.floor(ms / 60_000);
  let s = Math.round((ms % 60_000) / 1000);
  if (s === 60) { m += 1; s = 0; }
  return `${m}m ${s}s`;
}

export function isExaSearch(item: ToolItem): boolean {
  return item.toolKind === 'external'
    && /(^|[-_\s])exa($|[-_\s])/i.test(item.name)
    && /(^|[-_\s])(search|fetch)($|[-_\s])/i.test(item.name);
}

export function exaQuery(item: ToolItem): string {
  const a = item.arguments as Record<string, unknown>;
  return String(a.query ?? a.url ?? '').trim();
}
