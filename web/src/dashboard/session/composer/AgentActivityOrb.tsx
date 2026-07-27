import { toolPhase } from '../../../conversation/tools/tool-presentation-helpers';
import { useT } from '../../../i18n';
import { AgentActivityGlyph } from '../../../orchestration/AgentActivityGlyph';
import { sessionActivityMotion } from './agent-activity-motion';
import type { TimelineItem } from '@shared/protocol';

type RetryProgress = { attempt: number; limit: number } | null;

export function AgentActivityOrb({
  items,
  retryProgress,
  awaitingApproval,
}: {
  items: TimelineItem[];
  retryProgress: RetryProgress;
  awaitingApproval: boolean;
}) {
  const t = useT();
  const last = items[items.length - 1];
  const visibleRetry = awaitingApproval ? null : retryProgress;
  let label = t('chat.actWorking');

  if (awaitingApproval) {
    label = t('chat.actWaitingApproval');
  } else if (visibleRetry) {
    label = t('chat.actRetryingModel', visibleRetry);
  } else if (last?.kind === 'tool' && toolPhase(last.status) !== 'done') {
    const phase = toolPhase(last.status);
    const kind = last.toolKind;
    label = phase === 'committing'
      ? t(kind === 'shell' ? 'chat.actCommandWaitingModelCommit' : 'chat.actWaitingModelCommit')
      : phase === 'waiting'
        ? t(kind === 'shell' ? 'chat.actQueuedCommand' : 'chat.actQueuedTool')
        : phase === 'writing'
          ? (kind === 'shell' ? t('chat.actComposingCmd') : t('chat.actComposingTool'))
          : kind === 'read' ? t('chat.actReading')
            : kind === 'write' || kind === 'edit' ? t('chat.actWriting')
            : kind === 'search' ? t('chat.actSearching')
              : t('chat.actRunning', { name: kind === 'shell' ? 'bash' : last.name });
  } else if (last?.kind === 'assistant' && last.streaming) {
    const hasText = last.blocks?.some((block) => block.type === 'text' && block.text.trim());
    label = hasText ? t('chat.actWorking') : t('chat.actThinking');
  }
  const motion = sessionActivityMotion({
    modelRetrying: Boolean(retryProgress),
    awaitingApproval,
    last,
  });

  return (
    <div
      data-testid="agent-activity-orb"
      data-orb-state={motion.state}
      data-orb-paused={motion.paused ? 'true' : 'false'}
      data-retry-progress={visibleRetry ? `${visibleRetry.attempt}/${visibleRetry.limit}` : undefined}
      className="relative flex size-8 shrink-0 items-center justify-center text-[#565650] dark:text-[#D5D3CC]"
      title={label}
    >
      <AgentActivityGlyph state={motion.state} paused={motion.paused} />
      {visibleRetry && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 min-w-3 rounded-full bg-[var(--app-frame)] px-0.5 text-center text-[8px] font-semibold leading-3 tabular-nums text-[#817C72] dark:text-[#B8B2A7]"
        >
          {visibleRetry.attempt}
        </span>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{label}</span>
    </div>
  );
}
