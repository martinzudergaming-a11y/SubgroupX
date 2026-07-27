import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Spinner } from "../../../ui/Spinner";
import { ChevronDown, ChevronRight, PanelRight, XCircle } from 'lucide-react';
import MarkdownRenderer from '../../../conversation/markdown/MarkdownRenderer';
import CodeBlock from '../../../conversation/markdown/CodeBlock';
import { ShellCommand } from '../../../conversation/markdown/ShellCommand';
import { ShellOutput } from './ShellOutput';
import { useT } from '../../../i18n';
import type { TimelineItem } from '@shared/protocol';
import { DiffView, ExaResults, StreamingCodeBlock, ToolStatus } from '../../../conversation/tools/tool-presentation';
import { FileContentView } from '../../../files/FileContentView';
import { detectLanguage } from '../../../files/languages';
import { TOOL_STATUS_ICON } from '../../../ui/status-colors';
import { safeGet, safeSet } from '../../../platform/storage';
import { useToolElapsed } from './tool-running-clock';
import { shellDetailSurface } from './shell-inspector-state';
import {
  formatDuration,
  isExaSearch,
  toolIcon,
  toolLabel,
  toolPhase,
  toolResultPlaceholderKey,
  type ToolItem,
} from '../../../conversation/tools/tool-presentation-helpers';

const TOOL_RESULT_CAP = 500_000;
const SHELL_RESULT_CAP = 64_000;
const SHELL_SPLIT_KEY = 'oiia.shellInspectorOverflowSplit';
const DEFAULT_SHELL_SPLIT = 0.4;
const MIN_SHELL_SPLIT = 0.24;
const MAX_SHELL_SPLIT = 0.78;

type EditPair = { oldText: string; newText: string };

function editPairs(args: Record<string, unknown>): EditPair[] {
  const raw = args.edits;
  if (Array.isArray(raw)) {
    const pairs = raw.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const edit = entry as Record<string, unknown>;
      return typeof edit.oldText === 'string' && typeof edit.newText === 'string'
        ? [{ oldText: edit.oldText, newText: edit.newText }]
        : [];
    });
    if (pairs.length > 0) return pairs;
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  if (typeof args.old === 'string' && typeof args.new === 'string') {
    return [{ oldText: args.old, newText: args.new }];
  }
  return [];
}

function clampShellSplit(value: number): number {
  return Math.min(MAX_SHELL_SPLIT, Math.max(MIN_SHELL_SPLIT, value));
}

function initialShellSplit(): number {
  const raw = safeGet(SHELL_SPLIT_KEY);
  if (raw === null) return DEFAULT_SHELL_SPLIT;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampShellSplit(stored) : DEFAULT_SHELL_SPLIT;
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      data-testid="tool-detail-section"
      className="space-y-2 border-b border-[#ECE9E1] pb-4 last:border-b-0 last:pb-0 dark:border-[#302E29]"
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#98958B] dark:text-[#908B81]">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function ToolLifecycleStatus({ sessionId, item }: { sessionId: string; item: ToolItem }) {
  const t = useT();
  const elapsedMs = useToolElapsed(sessionId, item);
  const { Icon, cls, spin, pulse } = TOOL_STATUS_ICON[item.status] ?? TOOL_STATUS_ICON.pending;
  if (item.termination === 'cancelled') {
    return (
      <span data-testid="tool-lifecycle" className="inline-flex max-w-[60%] shrink-0 items-center gap-1.5 text-[11px] font-medium text-[#77746C] dark:text-[#AAA59A]">
        <XCircle className="size-[13px] shrink-0 text-[#969991] dark:text-[#777A73]" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{t('tool.phaseCancelled')}</span>
        {elapsedMs != null && (
          <>
            <span aria-hidden="true">·</span>
            <span data-testid="tool-elapsed" className="shrink-0 font-mono tabular-nums">{formatDuration(elapsedMs)}</span>
          </>
        )}
      </span>
    );
  }
  const label = (() => {
    switch (item.status) {
      case 'streaming_args': return t('tool.phaseComposing');
      case 'ready': return t('tool.phaseReady');
      case 'pending': return t('tool.phaseWaiting');
      case 'approved': return t('tool.phaseApproved');
      case 'running': return t('tool.phaseRunning');
      case 'success': return t('tool.phaseSuccess');
      case 'error': return t('tool.phaseError');
      case 'denied': return t('tool.phaseDenied');
    }
  })();
  return (
    <span data-testid="tool-lifecycle" className="inline-flex max-w-[60%] shrink-0 items-center gap-1.5 text-[11px] font-medium text-[#77746C] dark:text-[#AAA59A]">
      <Icon className={`size-[13px] shrink-0 ${cls} ${spin ? 'animate-spin' : ''} ${pulse ? 'animate-pulse' : ''} motion-reduce:animate-none`} strokeWidth={2} aria-hidden="true" />
      <span className="truncate">{label}</span>
      {elapsedMs != null && (
        <>
          <span aria-hidden="true">·</span>
          <span data-testid="tool-elapsed" className="shrink-0 font-mono tabular-nums">{formatDuration(elapsedMs)}</span>
        </>
      )}
    </span>
  );
}

function ToolResult({ item, fullShellOutput = false }: { item: ToolItem; fullShellOutput?: boolean }) {
  const t = useT();
  const text = item.resultText ?? '';
  if (!text) {
    const phase = toolPhase(item.status);
    return (
      <div data-testid="tool-result" className="text-[12.5px] text-[#999] dark:text-[#777] leading-[1.6]">
        {phase !== 'done' ? (
          <span className="inline-flex items-center gap-1.5">
            {phase === 'running' ? (
              <Spinner className="size-3" strokeWidth={4} />
            ) : (
              <span className="inline-block size-1.5 rounded-full bg-current animate-pulse" />
            )}
            {t(toolResultPlaceholderKey(phase))}
          </span>
        ) : (
          <span className="italic">{t('tool.noOutput')}</span>
        )}
      </div>
    );
  }
  const resultCap = item.toolKind === 'shell' ? SHELL_RESULT_CAP : TOOL_RESULT_CAP;
  const body = text.length > resultCap ? text.slice(0, resultCap) + '\n\n…(truncated)' : text;
  return (
    <div
      data-testid="tool-result"
      className="text-[13px] text-[#666] dark:text-[#999] leading-[1.6] [&_.markdown-body>p]:mb-0 [&_.markdown-body_p]:!text-[13px] [&_.markdown-body_p]:!leading-[1.6]"
    >
      {item.toolKind === 'shell'
        ? <ShellOutput shell={item.shell} text={body} collapse={!fullShellOutput} />
        : isExaSearch(item)
          ? <ExaResults text={body} />
          : <MarkdownRenderer>{body}</MarkdownRenderer>}
    </div>
  );
}

function ShellToolInspector({ item }: { item: ToolItem }) {
  const t = useT();
  const phase = toolPhase(item.status);
  const command = String((item.arguments as Record<string, unknown>).command ?? '');
  const detailSurface = shellDetailSurface(item);
  const showOutput = detailSurface === 'output';
  const showDiagnostic = detailSurface === 'details';
  const hasSecondary = showOutput || showDiagnostic;
  const rootRef = useRef<HTMLDivElement>(null);
  const commandPaneRef = useRef<HTMLElement>(null);
  const commandContentRef = useRef<HTMLDivElement>(null);
  const outputPaneRef = useRef<HTMLElement>(null);
  const outputContentRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<number | null>(null);
  const [split, setSplit] = useState(initialShellSplit);
  const [resizable, setResizable] = useState(false);
  const followOutputRef = useRef(true);
  const ignoreProgrammaticScrollUntilRef = useRef(0);

  useLayoutEffect(() => {
    if (!showOutput || resizable) return;
    const commandPane = commandPaneRef.current;
    const outputPane = outputPaneRef.current;
    if (!commandPane || !outputPane) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const commandClipped = commandPane.scrollHeight > commandPane.clientHeight + 1;
      const outputClipped = outputPane.scrollHeight > outputPane.clientHeight + 1;
      if (commandClipped && outputClipped) setResizable(true);
    };
    const scheduleCheck = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const observer = new ResizeObserver(scheduleCheck);
    observer.observe(commandPane);
    observer.observe(outputPane);
    if (commandContentRef.current) observer.observe(commandContentRef.current);
    if (outputContentRef.current) observer.observe(outputContentRef.current);
    scheduleCheck();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [showOutput, resizable]);

  useLayoutEffect(() => {
    const pane = outputPaneRef.current;
    if (!showOutput || !pane || !followOutputRef.current) return;
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 100;
    pane.scrollTop = pane.scrollHeight;
    followOutputRef.current = true;
  }, [showOutput, resizable, split, item.resultText, item.shell, item.status]);

  const splitFromClientY = (clientY: number): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return split;
    return clampShellSplit((clientY - rect.top) / rect.height);
  };
  const commitSplit = (next: number) => {
    const value = clampShellSplit(next);
    setSplit(value);
    safeSet(SHELL_SPLIT_KEY, value.toFixed(4));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    draggingRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSplit(splitFromClientY(event.clientY));
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current !== event.pointerId) return;
    setSplit(splitFromClientY(event.clientY));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current !== event.pointerId) return;
    draggingRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    commitSplit(splitFromClientY(event.clientY));
  };
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.shiftKey ? 0.1 : 0.04;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = split - delta;
    else if (event.key === 'ArrowDown') next = split + delta;
    else if (event.key === 'Home') next = MIN_SHELL_SPLIT;
    else if (event.key === 'End') next = MAX_SHELL_SPLIT;
    if (next === null) return;
    event.preventDefault();
    commitSplit(next);
  };

  const commandPane = (
    <section
      ref={commandPaneRef}
      data-testid="tool-command-pane"
      aria-labelledby={`tool-command-label-${item.id}`}
      tabIndex={0}
      className={`${resizable ? 'min-h-0' : `shrink-0 ${hasSecondary ? 'max-h-[40%]' : 'max-h-full'}`} overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C77D2E]/25`}
    >
      <div ref={commandContentRef}>
        <div id={`tool-command-label-${item.id}`} className="sticky top-0 z-[1] select-none bg-[var(--app-surface)] px-4 pb-2.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#98958B] dark:bg-[#1A1A1A] dark:text-[#908B81]">
          {t('tool.detailCommand')}
        </div>
        <div className="px-4 pb-3.5">
          {command && <ShellCommand command={command} format={phase === 'running' || phase === 'done'} />}
        </div>
      </div>
    </section>
  );

  if (!showOutput && !showDiagnostic) {
    return <div data-testid="shell-tool-inspector" data-layout="natural" className="min-h-0 flex-1 overflow-hidden select-text">{commandPane}</div>;
  }

  return (
    <div
      ref={rootRef}
      data-testid="shell-tool-inspector"
      data-layout={resizable ? 'split' : 'natural'}
      className={`${resizable ? 'grid' : 'flex flex-col'} min-h-0 flex-1 overflow-hidden select-text`}
      style={resizable ? { gridTemplateRows: `minmax(0, ${split}fr) 11px minmax(0, ${1 - split}fr)` } : undefined}
    >
      {commandPane}
      {resizable && (
        <div
          role="separator"
          aria-label={t('tool.resizeCommandOutput')}
          aria-orientation="horizontal"
          aria-valuemin={Math.round(MIN_SHELL_SPLIT * 100)}
          aria-valuemax={Math.round(MAX_SHELL_SPLIT * 100)}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={0}
          data-testid="tool-shell-splitter"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={() => commitSplit(DEFAULT_SHELL_SPLIT)}
          onKeyDown={onSeparatorKeyDown}
          className="group relative z-[1] cursor-row-resize touch-none outline-none"
        >
          <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#E6E3DA] transition-colors duration-150 group-hover:bg-[#C8C3B7] group-focus-visible:bg-[#C77D2E] motion-reduce:transition-none dark:bg-[#34312B] dark:group-hover:bg-[#514C42] dark:group-focus-visible:bg-[#D99A5C]" />
          <span aria-hidden="true" className="absolute left-1/2 top-1/2 h-[3px] w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-[#AAA59A] group-focus-visible:bg-[#C77D2E] motion-reduce:transition-none dark:group-hover:bg-[#6F695E] dark:group-focus-visible:bg-[#D99A5C]" />
        </div>
      )}
      <section
        ref={outputPaneRef}
        data-testid={showOutput ? 'tool-output-pane' : 'tool-diagnostic-pane'}
        aria-labelledby={`tool-${showOutput ? 'output' : 'details'}-label-${item.id}`}
        tabIndex={0}
        onWheel={() => { ignoreProgrammaticScrollUntilRef.current = 0; }}
        onPointerDown={() => { ignoreProgrammaticScrollUntilRef.current = 0; }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
            ignoreProgrammaticScrollUntilRef.current = 0;
          }
        }}
        onScroll={() => {
          const pane = outputPaneRef.current;
          if (pane && performance.now() >= ignoreProgrammaticScrollUntilRef.current) {
            followOutputRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32;
          }
        }}
        className={`${showOutput ? 'min-h-0 flex-1 overflow-auto bg-[#F7F6F1] dark:bg-[#171716]' : 'shrink-0 overflow-visible'} ${resizable ? 'border-t-0' : 'border-t border-[#E6E3DA] dark:border-[#34312B]'} outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C77D2E]/25`}
      >
        <div ref={outputContentRef}>
          <div id={`tool-${showOutput ? 'output' : 'details'}-label-${item.id}`} className={`sticky top-0 z-[1] select-none px-4 pb-2.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#98958B] dark:text-[#908B81] ${showOutput ? 'bg-[#F7F6F1] dark:bg-[#171716]' : 'bg-[var(--app-surface)] dark:bg-[#1A1A1A]'}`}>
            {t(showOutput ? 'tool.detailOutput' : 'tool.detailDetails')}
          </div>
          <div className="px-4 pb-3.5">
            <ToolResult item={item} fullShellOutput={showOutput} />
          </div>
        </div>
      </section>
    </div>
  );
}

function ToolDetailBody({ item }: { item: ToolItem }) {
  const t = useT();
  const command = String((item.arguments as Record<string, unknown>).command ?? '');
  const omittedChildren = item.childProgress?.omittedItems ?? 0;
  const hasChildren = (item.children?.length ?? 0) > 0 || omittedChildren > 0;
  const argsObj = item.arguments as Record<string, unknown>;
  const intendedEdits = editPairs(argsObj);
  const phase = toolPhase(item.status);
  const isStreaming = phase === 'writing';
  const streamingWrite = item.toolKind === 'write' && typeof argsObj.content === 'string';
  return (
    <div className="space-y-4">
      {item.toolKind === 'shell' && command && (
        <DetailSection label={t('tool.detailCommand')}>

          <ShellCommand command={command} format={phase === 'running' || phase === 'done'} />
        </DetailSection>
      )}

      {streamingWrite && (
        <DetailSection label={t('tool.detailPreview')}>
          {isStreaming ? (
            <StreamingCodeBlock
              code={String(argsObj.content)}
              language={detectLanguage(item.path ?? '', String(argsObj.content))}
              streaming
            />
          ) : (
            <FileContentView fileName={item.path ?? 'file'} content={String(argsObj.content)} fill={false} />
          )}
        </DetailSection>
      )}

      {item.toolKind === 'edit' && item.edit?.patch && item.status === 'success' ? (
        <DetailSection label={t('tool.detailChanges')}>
          <div data-testid="edit-committed-patch" className="max-h-[60vh] overflow-auto rounded-[4px] border border-[#E8E4D8] dark:border-[#333129]">
            <CodeBlock code={item.edit.patch} language="diff" hideHeader />
          </div>
        </DetailSection>
      ) : item.toolKind === 'edit' && intendedEdits.length > 0 ? (
        <DetailSection label={t('tool.detailChanges')}>
          <div data-testid="edit-intended-changes" className="space-y-3">
            {intendedEdits.map((edit, index) => (
              <div key={`${index}:${edit.oldText.length}:${edit.newText.length}`} className="space-y-1.5">
                {intendedEdits.length > 1 && (
                  <div className="font-mono text-[10px] tabular-nums text-[#98958B] dark:text-[#908B81]">
                    {index + 1} / {intendedEdits.length}
                  </div>
                )}
                <DiffView oldText={edit.oldText} newText={edit.newText} path={item.path} />
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <DetailSection label={t('tool.detailOutput')}>
        <ToolResult item={item} />
      </DetailSection>

      {hasChildren && (
        <div
          data-testid="subagent-timeline"
          className="mt-2 space-y-1 border-t border-[#E8E4D8] pt-3 dark:border-[#333129]"
        >
          {omittedChildren > 0 && (
            <div className="py-1 text-[12px] text-[#8A8D86] dark:text-[#8F918B]">
              {t('tool.childProgressOmitted')} · {omittedChildren}
            </div>
          )}
          {(item.children ?? []).map((child) => (
            <NestedItem key={child.id} item={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function NestedItem({ item }: { item: TimelineItem }) {
  if (item.kind === 'tool') return <NestedToolRow item={item} />;
  if (item.kind === 'error') {
    return (
      <div className="text-[12.5px] text-[#A33] dark:text-[#F2B0B0] leading-[1.5]">{item.message}</div>
    );
  }
  if (item.kind === 'assistant') {
    const text = item.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
    if (!text) return null;
    return (
      <div className="text-[13px] [&_.markdown-body_p]:!text-[13px] [&_.markdown-body_p]:!leading-[1.6]">
        <MarkdownRenderer>{text}</MarkdownRenderer>
      </div>
    );
  }
  if (item.kind === 'user') {
    return <div className="text-[13px] text-[#444] dark:text-[#CCC] whitespace-pre-wrap">{item.text}</div>;
  }
  return null;
}

function NestedToolRow({ item }: { item: ToolItem }) {
  const t = useT();
  const [open, setOpen] = useState(item.status !== 'success');
  const hasBody = Boolean(item.resultText) || (item.children?.length ?? 0) > 0
    || (item.toolKind === 'shell' && item.arguments && 'command' in (item.arguments as object))
    || item.toolKind === 'edit';
  return (
    <div data-testid={`tool-${item.name}`} className="space-y-1">
      <div className="flex items-center text-[13px] text-[#666] dark:text-[#999] w-full">
        <button
          type="button"
          onClick={() => hasBody && setOpen((v) => !v)}
          className={`flex items-center min-w-0 ${hasBody ? 'hover:text-[#333] dark:hover:text-[#E0E0E0] cursor-pointer' : 'cursor-default'} select-none transition-colors`}
        >
          {toolIcon(item.toolKind)}
          <span className="truncate">{toolLabel(item, t)}</span>
          {hasBody && (open
            ? <ChevronDown className="size-[13px] ml-1 opacity-70 shrink-0" />
            : <ChevronRight className="size-[13px] ml-1 opacity-70 shrink-0" />)}
        </button>
        {item.durationMs != null && (
          <span className="ml-2 shrink-0 text-[11px] tabular-nums text-[#A0A0A0] dark:text-[#777]">{formatDuration(item.durationMs)}</span>
        )}
        <ToolStatus status={item.status} termination={item.termination} />
      </div>
      {open && hasBody && (
        <div className="ml-[5px] pl-3 border-l-2 border-[#E5E5E5] dark:border-[#333]">
          <ToolDetailBody item={item} />
        </div>
      )}
    </div>
  );
}

export function ToolDetail({ sessionId, item, onOpenFile }: {
  sessionId: string;
  item: ToolItem;
  onOpenFile?: (path: string) => void;
}) {
  const t = useT();
  const hasFileLink =
    (item.toolKind === 'read' || item.toolKind === 'write' || item.toolKind === 'edit') &&
    !!item.path &&
    toolPhase(item.status) !== 'writing';
  return (
    <div data-testid="tool-detail" className="flex h-full min-h-0 flex-col select-text text-[13.5px] [--cb-surface:var(--app-surface)] dark:[--cb-surface:#1A1A1A]">
      <div className="z-10 flex h-12 shrink-0 min-w-0 select-none items-center gap-2.5 border-b border-[#E9E5DA] bg-[var(--app-surface)] px-4 dark:border-[#302E28] dark:bg-[#1A1A1A]">
        <span className="flex size-5 shrink-0 items-center justify-center text-[#77746C] [&>svg]:mr-0 dark:text-[#AAA59A]">
          {toolIcon(item.toolKind)}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {item.toolKind === 'shell' ? (
            <>
              <div className="truncate text-[13px] font-semibold text-[#3F3D37] dark:text-[#D8D4CA]">{t('tool.detailShell')}</div>
              <span aria-hidden="true" className="text-[#B0ADA4] dark:text-[#66635C]">/</span>
              <div className="truncate font-mono text-[11px] text-[#858178] dark:text-[#918D84]">{item.name}</div>
            </>
          ) : (
            <div className="truncate text-[13px] font-semibold text-[#3F3D37] dark:text-[#D8D4CA]">{toolLabel(item, t)}</div>
          )}
        </div>
        <ToolLifecycleStatus sessionId={sessionId} item={item} />
        {hasFileLink && onOpenFile && (
          <button
            type="button"
            data-testid="tool-file-link"
            onClick={() => onOpenFile(item.path!)}
            aria-label={t('rs.openInPanel')}
            title={t('rs.openInPanel')}
            className="shrink-0 rounded-md p-1.5 text-[#8F8C83] transition-colors hover:bg-[#F0EDE5] hover:text-[#55524B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C77D2E]/30 dark:text-[#77736A] dark:hover:bg-[#292720] dark:hover:text-[#CCC7BC]"
          >
            <PanelRight className="size-[14px]" strokeWidth={1.75} />
          </button>
        )}
      </div>
      {item.toolKind === 'shell' ? (
        <ShellToolInspector item={item} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><ToolDetailBody item={item} /></div>
      )}
    </div>
  );
}
