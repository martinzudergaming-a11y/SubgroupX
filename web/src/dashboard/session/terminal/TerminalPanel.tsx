import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCw, TerminalSquare, MailWarning, Plus } from 'lucide-react';
import type { SandboxKind, SessionInfo } from '@shared/protocol';
import { useT } from '../../../i18n';
import { PtyController, type PtyState } from './pty-terminal';
import type { StatusTone } from '../../../ui/StatusDot';
import type { TranslationKey } from '../../../i18n/en';

export const PTY_STATE_DOT: Record<PtyState, { tone: StatusTone; pulse?: boolean }> = {
  open: { tone: 'live' },
  connecting: { tone: 'working', pulse: true },
  idle: { tone: 'idle' },
  ended: { tone: 'muted' },
  verification_required: { tone: 'working' },
};

export function backendLabel(kind: SandboxKind | undefined, t: (k: TranslationKey) => string): string {
  const key: TranslationKey =
    kind === 'e2b' ? 'backend.e2b' : kind === 'ssh' ? 'backend.ssh' : kind === 'connector' ? 'backend.connector' : 'backend.local';
  return t(key);
}

export function ptyStateLabel(state: PtyState, t: (k: TranslationKey) => string): string {
  return state === 'connecting'
    ? t('shell.connecting')
    : state === 'ended'
      ? t('shell.ended')
      : state === 'idle'
        ? t('shell.idle')
        : state === 'verification_required'
          ? t('shell.verifyRequired')
          : t('ws.open');
}

function StatePanel({
  testid,
  icon,
  title,
  hint,
  compact,
  children,
}: {
  testid: string;
  icon: ReactNode;
  title: string;
  hint: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      className={`shell-panel-in absolute inset-0 z-10 flex flex-col items-center justify-center bg-[var(--app-surface)] dark:bg-[#1A1A1A] text-center ${compact ? 'gap-2.5 px-4' : 'gap-4 px-6'}`}
    >
      <div className={`flex items-center justify-center rounded-2xl border border-[#E8EBE3] dark:border-[#333] bg-[#F6F7F2] dark:bg-[#242424] text-[#8F8F8F] dark:text-[#888] ${compact ? 'size-10' : 'size-12'}`}>
        {icon}
      </div>
      <div className="space-y-1">
        <div className="text-[14px] font-medium text-[#333] dark:text-[#DDD]">{title}</div>
        {!compact && <div className="mx-auto max-w-[300px] text-[12.5px] leading-relaxed text-[#8A8A8A] dark:text-[#888]">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function TerminalPanel({
  session,
  compact = false,
  onStateChange,
}: {
  session: SessionInfo;
  compact?: boolean;
  onStateChange?: (state: PtyState) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PtyState>('connecting');
  const [restartKey, setRestartKey] = useState(0);
  const spawnRef = useRef(false);

  const spawnTerminal = () => {
    spawnRef.current = true;
    setRestartKey((k) => k + 1);
  };

  useEffect(() => {
    onStateChange?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!containerRef.current) return;
    const controller = new PtyController({
      container: containerRef.current,
      sessionId: session.id,
      remote: session.sandboxKind === 'e2b' || session.sandboxKind === 'ssh' || session.sandboxKind === 'connector',
      spawn: spawnRef.current,
      onState: setState,
    });
    spawnRef.current = false;
    return () => controller.dispose();
  }, [session.id, session.sandboxKind, restartKey]);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <div ref={containerRef} data-testid="shell-terminal" data-state={state} className={`relative size-full outline-none ${compact ? 'p-2' : 'p-3'}`} />
        {state === 'idle' && (
          <StatePanel
            testid="shell-empty"
            icon={<TerminalSquare className="size-5" strokeWidth={1.5} />}
            title={t('shell.emptyTitle')}
            hint={t('shell.emptyHint')}
            compact={compact}
          >
            <button type="button"
              data-testid="shell-new"
              onClick={spawnTerminal}
              className="flex items-center gap-1.5 rounded-lg bg-[#222] dark:bg-[#E0E0E0] px-3.5 py-2 text-[13px] font-medium text-white dark:text-[#222] transition-[opacity,transform] hover:opacity-90 active:scale-[0.98]"
            >
              <Plus className="size-[15px]" strokeWidth={2} />
              {t('shell.newTerminal')}
            </button>
          </StatePanel>
        )}
        {state === 'verification_required' && (
          <StatePanel
            testid="shell-verify-required"
            icon={<MailWarning className="size-5" strokeWidth={1.5} />}
            title={t('shell.verifyRequired')}
            hint={t('shell.verifyRequiredHint')}
            compact={compact}
          />
        )}
        {state === 'ended' && (
          <div className="shell-panel-in pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-[var(--app-surface)] via-[var(--app-surface)]/70 to-transparent pb-4 pt-10 dark:from-[#1A1A1A] dark:via-[#1A1A1A]/70">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[#E5E5E5] dark:border-[#3A3A3A] bg-white/95 dark:bg-[#242424]/95 py-1.5 pl-3.5 pr-1.5 shadow-lg shadow-black/5 backdrop-blur">
              {!compact && <span className="text-[12px] text-[#777] dark:text-[#999]">{t('shell.endedHint')}</span>}
              <button type="button"
                data-testid="shell-restart"
                onClick={spawnTerminal}
                className="flex items-center gap-1 rounded-full bg-[#222] dark:bg-[#E0E0E0] px-3 py-1 text-[12px] font-medium text-white dark:text-[#222] transition-opacity hover:opacity-90"
              >
                <RotateCw className="size-[12px]" strokeWidth={2} />
                {t('shell.restart')}
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
