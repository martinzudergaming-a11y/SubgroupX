import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, GitBranch, Pencil, RotateCcw, DatabaseZap } from 'lucide-react';
import { LazyMotion, m, domAnimation, AnimatePresence, useReducedMotion } from 'motion/react';
import MarkdownRenderer from '../../../conversation/markdown/MarkdownRenderer';
import { MessageAttachments } from '../../../files/MessageAttachments';
import { parseMessageAttachments } from '../../../files/MessageAttachments-helpers';
import { ToolStatus, StreamingCodeBlock } from '../../../conversation/tools/tool-presentation';
import { CanvasCard } from './CanvasCard';
import { detectLanguage } from '../../../files/languages';
import { toolIcon, toolLabel, toolPhase, formatDuration, isExaSearch } from '../../../conversation/tools/tool-presentation-helpers';
import { useFormattedBash } from '../../../conversation/markdown/bash-format';
import { useT } from '../../../i18n';
import { StatusDot } from '../../../ui/StatusDot';
import { Link } from '../../../platform/router';
import { formatUsage, latestThinkingPreview, type ThinkingPreview } from './timeline-format';
import { summarizeToolRun } from './timeline-helpers';
import type { TimelineItem } from '@shared/protocol';

const ThinkingPreviewLabel = memo(function ThinkingPreviewLabel({ preview }: { preview: ThinkingPreview }) {
  const reduceMotion = useReducedMotion();
  return (
    <span
      data-thinking-preview-mode={preview.mode}
      className="relative inline-block h-[1.25em] leading-[1.25] max-w-[min(60vw,360px)] overflow-hidden"
    >
      {preview.mode === 'heading' ? (
        <LazyMotion features={domAnimation}>
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={preview.text}
              initial={{ transform: reduceMotion ? 'none' : 'translateY(110%)', opacity: 0 }}
              animate={{ transform: 'translateY(0%)', opacity: 1 }}
              exit={{ transform: reduceMotion ? 'none' : 'translateY(-110%)', opacity: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="thinking-headline-motion block truncate leading-[1.25] font-normal text-[#9A9A9A] dark:text-[#777]"
            >
              {preview.text}
            </m.span>
          </AnimatePresence>
        </LazyMotion>
      ) : (
        <span className="block truncate leading-[1.25] font-normal text-[#9A9A9A] dark:text-[#777]">
          {preview.text}
        </span>
      )}
    </span>
  );
}, (previous, next) => (
  previous.preview.mode === next.preview.mode && previous.preview.text === next.preview.text
));

function ErrorRow({ item, onRetry, retrying }: {
  item: Extract<import('@shared/protocol').TimelineItem, { kind: 'error' }>;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useT();

  const payloadStart = item.message.search(/[{[]"/);
  let humanText = payloadStart > 0 ? item.message.slice(0, payloadStart).replace(/[([:,·\s]+$/, '') : item.message;
  const rawPayload = payloadStart > 0 ? item.message.slice(payloadStart) : null;
  if (rawPayload) {
    try {
      const parsed = JSON.parse(rawPayload) as { message?: unknown; error?: { message?: unknown } };
      const inner = typeof parsed?.message === 'string' ? parsed.message
        : typeof parsed?.error?.message === 'string' ? parsed.error.message : null;
      if (inner) humanText = `${humanText}: ${inner}`;
    } catch {  }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-[#F0CFCF] bg-[#FFF4F4] px-4 py-3 text-[14px] text-[#A33] dark:border-[#5A2A2A] dark:bg-[#2F1D1D] dark:text-[#F2B0B0]">
      <span className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">{humanText}</span>
      {item.retryable && onRetry && (
        <button
          type="button"
          data-testid="error-retry"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#A33] px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70 dark:bg-[#C55]"
        >
          <RotateCcw className="size-3" strokeWidth={2.5} />
          {t('chat.retry')}
        </button>
      )}
      {rawPayload && (
        <details className="w-full basis-full">
          <summary className="cursor-pointer select-none text-[12px] opacity-70 hover:opacity-100">{t('chat.errorRawDetails')}</summary>
          <pre className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-[#A33]/5 p-2.5 font-mono text-[11.5px] leading-[1.55] dark:bg-black/20">{rawPayload}</pre>
        </details>
      )}
    </div>
  );
}

export const TimelineBlock = memo(function TimelineBlock({
  item,
  sessionId,
  onOpenTool,
  onOpenFile,
  onOpenCompaction,
  activeToolId,
  activeCompactionId,
  onResume,
  onRetry,
  retrying,
  onEditMessage,
  canEdit,
  onFork,
  canFork,
  compactionFloorSeq,
  turnRootUser,
  turnUsage,
  copyText,
}: {
  item: TimelineItem;
  sessionId: string;
  onOpenTool?: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenCompaction?: (id: string) => void;
  activeToolId?: string | null;
  activeCompactionId?: string | null;
  onResume?: (text: string) => void;
  onRetry?: () => void;
  retrying?: boolean;
  onEditMessage?: (item: Extract<TimelineItem, { kind: 'user' }>) => void;
  canEdit?: boolean;
  onFork?: (fromSeq: number) => void;
  canFork?: boolean;
  compactionFloorSeq?: number;
  turnRootUser: boolean;
  turnUsage?: { input: number; output: number; total: number; costUsd: number };
  copyText?: string;
}) {
  const t = useT();
  const [thinkingOpen, setThinkingOpen] = useState(false);
  if (item.kind === 'user') {
    const { cleanText, files } = parseMessageAttachments(item.text);
    const aboveFloor = turnRootUser && item.seq > (compactionFloorSeq ?? -1) && !item.id.startsWith('local_u_');
    const showEdit = Boolean(canEdit && onEditMessage && cleanText) && aboveFloor;
    const showFork = Boolean(canFork && onFork && cleanText) && aboveFloor;
    return (
      <div id={`toc-${item.id}`} className="group flex items-end justify-end gap-1.5 mb-5 mt-1 scroll-mt-4">
        {(showEdit || showFork) && (
          <div className="flex items-end gap-0.5 mb-1">
            {showEdit && (
              <button
                type="button"
                data-testid="edit-message"
                onClick={() => onEditMessage!(item as Extract<TimelineItem, { kind: 'user' }>)}
                title={t('chat.editMessage')}
                aria-label={t('chat.editMessage')}
                className="p-1.5 rounded-md text-[#999] hover:text-[#333] hover:bg-[#F0F0F0]
                           dark:text-[#777] dark:hover:text-[#E0E0E0] dark:hover:bg-[#333]
                           opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                           [@media(hover:none)]:opacity-100 transition-opacity"
              >
                <Pencil className="size-3.5" strokeWidth={2} />
              </button>
            )}
            {showFork && (
              <button
                type="button"
                data-testid="fork-message"
                onClick={() => onFork!(item.seq)}
                title={t('fork.action')}
                aria-label={t('fork.action')}
                className="p-1.5 rounded-md text-[#999] hover:text-[#333] hover:bg-[#F0F0F0]
                           dark:text-[#777] dark:hover:text-[#E0E0E0] dark:hover:bg-[#333]
                           opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                           [@media(hover:none)]:opacity-100 transition-opacity"
              >
                <GitBranch className="size-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        <div className="flex flex-col items-end min-w-0 max-w-[85%]">
          {cleanText && (
            <div
              data-testid="msg-user"
              className="bg-[#F4F4F5] dark:bg-[#2F2F2F] text-[#242424] dark:text-[#E0E0E0] px-4 py-2 rounded-[20px] max-w-full text-[14px] leading-[1.65] whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-[family-name:var(--font-reader)]"
            >
              {cleanText}
            </div>
          )}
          <MessageAttachments sessionId={sessionId} files={files} onOpenFile={onOpenFile} />
        </div>
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="w-full max-w-[var(--reader-w)] mx-auto px-2">
        <ErrorRow item={item} onRetry={onRetry} retrying={retrying} />
      </div>
    );
  }

  if (item.kind === 'team_assignment') {
    return (
      <div data-testid="team-assignment" className="mb-4 w-full max-w-[var(--reader-w)] mx-auto px-2">
        <div className="flex min-h-11 items-center gap-2.5 border-y border-[#E8EBE3] py-2 text-[#555A53] dark:border-[#343632] dark:text-[#B7BBB3]">
          <GitBranch className="size-[14px] shrink-0" strokeWidth={1.55} />
          <span className="min-w-0 flex-1">
            <span className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#8F938C]">{t('chat.teamAssignmentLabel')}</span>
            <span className="block truncate text-[12.5px] font-medium text-[#343733] dark:text-[#E0E2DE]">{item.title}</span>
          </span>
          <Link
            to={`/agents/activity/${encodeURIComponent(item.taskId)}`}
            aria-label={t('chat.viewTeamTask')}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[#777B75] transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-black/[0.035] hover:text-[#343733] active:scale-[.96] dark:text-[#989C95] dark:hover:bg-white/[0.05] dark:hover:text-[#E0E2DE]"
          >
            <ArrowUpRight className="size-3.5" strokeWidth={1.6} />
          </Link>
        </div>
      </div>
    );
  }

  if (item.kind === 'recap') {
    return (
      <div data-testid="recap-message" className="mb-5 w-full max-w-[var(--reader-w)] mx-auto px-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#BDBBB2] dark:text-[#66645C]">
          <StatusDot tone="info" />
          {t('chat.recapLabel')}
        </div>
        <div className="text-[13.5px] leading-[1.65] text-[#9A988F] dark:text-[#75736B] whitespace-pre-wrap">{item.text}</div>
      </div>
    );
  }

  if (item.kind === 'interrupted') {
    return (
      <div
        data-testid="interrupted-notice"
        className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-[#E6D9B8] bg-[#FBF6E9] px-4 py-3 text-[13.5px] text-[#8A6D2F] dark:border-[#4A4326] dark:bg-[#2A2616] dark:text-[#D8C285]"
      >
        <StatusDot tone="working" />
        <span>{t('chat.interrupted')}</span>
        {item.resumeText && onResume && (
          <button
            type="button"
            data-testid="interrupted-resume"
            onClick={() => onResume(item.resumeText!)}
            className="ml-auto rounded-full bg-[#C77D2E] px-3 py-1 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            {t('chat.interruptedResume')}
          </button>
        )}
      </div>
    );
  }

  if (item.kind === 'tool') {
    return (
      <div className="mb-2 w-full max-w-[var(--reader-w)] mx-auto px-2">
        <ToolRow item={item} onOpenTool={onOpenTool} active={activeToolId === item.id} />
      </div>
    );
  }

  if (item.kind === 'compaction_pending') {
    return <CompactionPendingMarker summarizedCount={item.summarizedCount} />;
  }

  if (item.kind === 'compaction') {
    return <CompactionMarker item={item} onOpen={onOpenCompaction} active={activeCompactionId === item.compactionId} />;
  }

  const textBlocks = item.blocks.filter((block) => block.type === 'text');
  const thinkingBlocks = item.blocks.filter((block) => block.type === 'thinking');
  const hasTrace = thinkingBlocks.length > 0;
  let thinkingPreview: ThinkingPreview | null = null;
  for (let i = thinkingBlocks.length - 1; i >= 0; i--) {
    const block = thinkingBlocks[i];
    if (block.type === 'thinking') {
      thinkingPreview = latestThinkingPreview(block.thinking, item.streaming);
      if (thinkingPreview) break;
    }
  }
  const assistantText = textBlocks.map((b) => b.text).join('\n\n');
  const isEmpty = assistantText.length === 0 && !hasTrace;

  if (isEmpty && !item.streaming) return null;

  return (
    <div data-testid="msg-assistant" className="group/turn mb-5 w-full max-w-[var(--reader-w)] mx-auto px-2">
      {hasTrace && (
        <div className="font-sans text-[14.5px] leading-[1.7] mt-2 tracking-[0.01em] text-[#222] dark:text-white">
          <button
            type="button"
            data-testid="thinking-toggle"
            onClick={() => setThinkingOpen((v) => !v)}
            className={`flex items-center text-[13.5px] text-[#888] dark:text-[#888] ${thinkingOpen || textBlocks.length > 0 ? 'mb-3' : 'mb-1'} select-none w-fit hover:text-[#555] dark:hover:text-[#bbb] transition-colors font-medium cursor-pointer -ml-[var(--reader-gutter)]`}
          >

            <span className="w-[var(--reader-gutter)] shrink-0 flex items-center">
              {thinkingOpen ? <ChevronDown className="size-[14px] opacity-70" /> : <ChevronRight className="size-[14px] opacity-70" />}
            </span>
            <span className="shrink-0">{t('chat.thinking')}</span>

            {!thinkingOpen && (
              <>
                {thinkingPreview && (
                  <>

                    <span className="shrink-0 mx-1.5 text-[#CCC] dark:text-[#444]">·</span>
                    <ThinkingPreviewLabel preview={thinkingPreview} />
                  </>
                )}
                {item.streaming && <StatusDot tone="working" ping className="ml-1.5" />}
              </>
            )}
          </button>

          {thinkingOpen &&
            thinkingBlocks.map((block, idx) => (
              <div key={idx} className="[&_.markdown-body>p]:mb-0 [&_.markdown-body_p]:!text-[14px] [&_.markdown-body_p]:!leading-[1.7] text-[#666] dark:text-[#A8A8A8] mb-3 pl-[18px] border-l-2 border-[#EEE] dark:border-[#333]">
                <MarkdownRenderer streaming={item.streaming}>{block.thinking}</MarkdownRenderer>
              </div>
            ))}
        </div>
      )}

      {assistantText && (
        <MarkdownRenderer streaming={item.streaming}>
          {assistantText}
        </MarkdownRenderer>
      )}

      {item.streaming && isEmpty && <div className="h-[1.2em]" aria-hidden="true" />}

      {!item.streaming && !isEmpty && (turnUsage || copyText) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[#B0B0B0] dark:text-[#666] select-none">
          {turnUsage && <span data-testid="msg-usage">{formatUsage(turnUsage)}</span>}
          {copyText && <TurnCopyButton text={copyText} />}
        </div>
      )}
    </div>
  );
});

function TurnCopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return (
    <button
      type="button"
      data-testid="turn-copy"
      aria-label={t('chat.copyTurn')}
      title={t('chat.copyTurn')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="flex size-6 items-center justify-center rounded-md text-[#B0B0B0] dark:text-[#666] opacity-0 transition-[opacity,color,background-color] group-hover/turn:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-[#F0F0EC] hover:text-[#666] dark:hover:bg-[#2A2A28] dark:hover:text-[#AAA]"
    >
      {copied ? <Check className="size-3.5 text-[#4E9A5E]" strokeWidth={2.2} /> : <Copy className="size-3.5" strokeWidth={1.8} />}
    </button>
  );
}

const CompactionPendingMarker = memo(function CompactionPendingMarker({ summarizedCount }: { summarizedCount: number }) {
  const t = useT();
  return (
    <div data-testid="compaction-pending" className="my-5 w-full">
      <div className="flex items-center gap-3 text-[#B8B8B8] dark:text-[#5A5A5A]">
        <div className="h-px flex-1 bg-current opacity-30" />
        <span className="flex items-center gap-1.5 rounded-full border border-[#E5E5E5] dark:border-[#3A3A3A] bg-white dark:bg-[#1F1F1F] px-3 py-1 text-[12px] text-[#888] dark:text-[#999] select-none">
          <StatusDot tone="working" ping />
          <span>{t('compaction.compacting', { n: summarizedCount })}</span>
        </span>
        <div className="h-px flex-1 bg-current opacity-30" />
      </div>
    </div>
  );
});

const CompactionMarker = memo(function CompactionMarker({
  item,
  onOpen,
  active,
}: {
  item: Extract<TimelineItem, { kind: 'compaction' }>;
  onOpen?: (id: string) => void;
  active?: boolean;
}) {
  const t = useT();
  return (
    <div data-testid="compaction-marker" className="my-5 w-full">

      <div className="flex items-center gap-3 text-[#B8B8B8] dark:text-[#5A5A5A]">
        <div className="h-px flex-1 bg-current opacity-30" />
        <button
          type="button"
          data-testid="compaction-pill"
          onClick={() => onOpen?.(item.compactionId)}
          aria-pressed={active}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors select-none ${
            active
              ? 'border-[#C9D6F0] dark:border-[#34507F] bg-[#F0F4FF] dark:bg-[#1B2742] text-[#3A5F9E] dark:text-[#9FBDF0]'
              : 'border-[#E5E5E5] dark:border-[#3A3A3A] bg-white dark:bg-[#1F1F1F] text-[#888] dark:text-[#999] hover:text-[#555] dark:hover:text-[#BBB]'
          }`}
        >
          <DatabaseZap className="size-[13px] opacity-70" />
          <span>{t('compaction.pill', { n: item.summarizedCount })}</span>
          <span className="text-[#CCC] dark:text-[#444]">·</span>
          <span className="font-medium">{t('compaction.view')}</span>
        </button>
        <div className="h-px flex-1 bg-current opacity-30" />
      </div>
    </div>
  );
});

const ToolRow = memo(function ToolRow({
  item,
  onOpenTool,
  active,
}: {
  item: Extract<TimelineItem, { kind: 'tool' }>;
  onOpenTool?: (id: string) => void;
  active?: boolean;
}) {
  const t = useT();
  const isExa = isExaSearch(item);
  const errorPreview =
    item.isError && item.resultText
      ? item.resultText.replace(/\s+/g, ' ').trim().slice(0, 160)
      : '';
  const rawArg = (() => {
    const a = (item.arguments ?? {}) as Record<string, unknown>;
    for (const k of ['content', 'command', 'new', 'code', 'input']) {
      if (typeof a[k] === 'string' && a[k]) return a[k] as string;
    }
    return '';
  })();
  const maxArgRef = useRef('');
  if (rawArg.length >= maxArgRef.current.length) maxArgRef.current = rawArg;
  const displayArg = maxArgRef.current;
  const liveRef = useRef(false);
  const phase = toolPhase(item.status);
  if (phase !== 'done') liveRef.current = true;
  const streamingArgs = phase === 'writing';
  const terminal = phase === 'done';
  const outputText = (() => {
    if (!terminal || item.isError) return '';
    const sh = item.shell;
    const raw = sh ? [sh.stdout, sh.stderr].filter(Boolean).join('\n') : (item.resultText ?? '');
    const tail = raw.trimEnd();
    return tail.length > 2000 ? '…' + tail.slice(-2000) : tail;
  })();
  const [collapsed, setCollapsed] = useState(false);
  const hasOutput = outputText !== '';
  useEffect(() => {
    if (!terminal) { setCollapsed(false); return; }
    const id = setTimeout(() => setCollapsed(true), hasOutput ? 4500 : 3000);
    return () => clearTimeout(id);
  }, [terminal, hasOutput]);
  const showPreview = Boolean(displayArg) && liveRef.current && !collapsed;
  const streamingLang = item.toolKind === 'shell' ? 'bash' : detectLanguage(item.path ?? '', displayArg);
  const prettyCmd = useFormattedBash(displayArg, showPreview && item.toolKind === 'shell' && (phase === 'running' || phase === 'done'));

  if (item.toolKind === 'canvas') {
    const a = (item.arguments ?? {}) as { title?: unknown; html?: unknown; height?: unknown; theme?: unknown };
    return (
      <CanvasCard
        canvasId={item.id}
        title={typeof a.title === 'string' ? a.title : ''}
        html={typeof a.html === 'string' ? a.html : ''}
        height={typeof a.height === 'number' ? a.height : undefined}
        theme={typeof a.theme === 'string' ? a.theme : undefined}
        status={item.status}
        onExpand={onOpenTool ? () => onOpenTool(item.id) : undefined}
      />
    );
  }

  return (
    <div data-testid={`tool-${item.name}`} className="mt-3 mb-4">

      <div
        className={`group/step flex items-center text-[13.5px] w-fit max-w-full rounded-md -ml-[var(--reader-gutter)] pr-2 transition-colors ${
          active
            ? 'bg-black/[0.06] dark:bg-white/[0.09] text-[#333] dark:text-[#E5E5E5]'
            : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05] text-[#666] dark:text-[#999]'
        }`}
      >
        <button
          type="button"
          data-testid="tool-open"
          aria-label={t('tool.openDetail')}
          onClick={() => onOpenTool?.(item.id)}
          className="flex items-center hover:text-[#333] dark:hover:text-[#E0E0E0] cursor-pointer select-none transition-colors min-w-0"
        >

          <span className="w-[var(--reader-gutter)] shrink-0 flex items-center">
            {isExa ? toolIcon('external') : toolIcon(item.toolKind)}
          </span>
          <span className="truncate">{toolLabel(item, t)}</span>

          {item.path && (item.toolKind === 'read' || item.toolKind === 'write' || item.toolKind === 'edit') && (
            <span
              className="ml-2 truncate text-[12.5px] text-[#999] dark:text-[#777] min-w-0"
              style={{ fontFamily: 'var(--font-code)' }}
              title={item.path}
            >
              {item.path}
            </span>
          )}
          <ChevronRight className="size-[14px] ml-1 shrink-0 opacity-40 transition-[opacity,transform] duration-150 ease-[cubic-bezier(.23,1,.32,1)] group-hover/step:translate-x-[2px] group-hover/step:opacity-100 group-focus-visible/step:translate-x-[2px] group-focus-visible/step:opacity-100 motion-reduce:transform-none motion-reduce:transition-none" />
        </button>
        {item.durationMs != null && (
          <span className="ml-2 shrink-0 text-[11px] tabular-nums text-[#A0A0A0] dark:text-[#777]" title={`${item.durationMs} ms`}>
            {formatDuration(item.durationMs)}
          </span>
        )}
        <ToolStatus status={item.status} termination={item.termination} />
      </div>

      {showPreview && (
        <StreamingCodeBlock code={prettyCmd ?? displayArg} language={streamingLang} streaming={streamingArgs} output={terminal ? outputText : undefined} />
      )}

      {errorPreview && (
        <button
          type="button"
          onClick={() => onOpenTool?.(item.id)}
          data-testid="tool-error-preview"
          className="mt-1 flex items-start gap-1 text-left w-full text-[12.5px] text-[#A33] dark:text-[#E08C8C] hover:underline"
        >
          <span className="opacity-60 select-none font-mono shrink-0">↳</span>
          <span className="truncate">{errorPreview}</span>
        </button>
      )}
    </div>
  );
});

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
type TranslationKeyLike = Parameters<ReturnType<typeof useT>>[0];

function runSummaryLabel(tools: ToolItem[], t: ReturnType<typeof useT>): string {
  const parts = summarizeToolRun(tools).map((p) => {
    if (p.kind === 'other') return t('tool.sum.named', { name: p.name ?? '?', count: p.count });
    const key = `tool.sum.${p.kind}.${p.count === 1 ? 'one' : 'other'}` as TranslationKeyLike;
    return t(key, { count: p.count });
  });
  const joined = parts.join(t('tool.sum.join'));
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export const ToolGroupRow = memo(function ToolGroupRow({
  tools,
  run,
  renderItem,
  activeToolId,
}: {
  tools: ToolItem[];
  run: TimelineItem[];
  renderItem: (item: TimelineItem) => ReactNode;
  activeToolId?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = runSummaryLabel(tools, t);
  const hasActive = activeToolId != null && tools.some((x) => x.id === activeToolId);
  const expanded = open || hasActive;

  if (expanded) {
    return (
      <>
        <div className="w-full max-w-[var(--reader-w)] mx-auto px-2 mt-1">
          <button
            type="button"
            data-testid="tool-group-collapse"
            onClick={() => setOpen(false)}
            className="flex items-center text-[12.5px] text-[#888] dark:text-[#888] hover:text-[#555] dark:hover:text-[#BBB] transition-colors mb-1 -ml-[var(--reader-gutter)]"
          >
            <span className="w-[var(--reader-gutter)] shrink-0 flex items-center">
              <ChevronDown className="size-[13px]" />
            </span>
            <span>{label}</span>
          </button>
        </div>
        {run.map((item) => renderItem(item))}
      </>
    );
  }
  return (
    <div className="w-full max-w-[var(--reader-w)] mx-auto px-2">
      <button
        type="button"
        data-testid="tool-group"
        onClick={() => setOpen(true)}
        className="mt-2 mb-3 flex items-center text-[13px] text-[#888] dark:text-[#8A8A8A] hover:text-[#555] dark:hover:text-[#BBB] transition-colors -ml-[var(--reader-gutter)]"
      >
        <span className="w-[var(--reader-gutter)] shrink-0 flex items-center">
          <ChevronRight className="size-[13px]" />
        </span>
        <span>{label}</span>
      </button>
    </div>
  );
});
