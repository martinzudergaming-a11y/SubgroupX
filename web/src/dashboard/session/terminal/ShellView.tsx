import { useEffect, useState } from 'react';
import { PanelLeft, TerminalSquare } from 'lucide-react';
import type { SessionInfo } from '@shared/protocol';
import { useT } from '../../../i18n';
import type { PtyState } from './pty-terminal';
import { TerminalPanel, PTY_STATE_DOT, ptyStateLabel, backendLabel } from './TerminalPanel';
import { StatusDot } from '../../../ui/StatusDot';

export function ShellView({
  sessions,
  initialSessionId,
  isLeftSidebarOpen,
  onOpenLeftSidebar,
}: {
  sessions: SessionInfo[];
  initialSessionId?: string | null;
  isLeftSidebarOpen: boolean;
  onOpenLeftSidebar: () => void;
}) {
  const t = useT();
  const [targetId, setTargetId] = useState<string>(() => initialSessionId ?? sessions[0]?.id ?? '');
  useEffect(() => {
    if (!sessions.some((s) => s.id === targetId) && sessions[0]) setTargetId(sessions[0].id);
  }, [sessions, targetId]);
  const target = sessions.find((s) => s.id === targetId) ?? sessions[0];
  const [state, setState] = useState<PtyState>('connecting');
  const stateLabel = ptyStateLabel(state, t);

  return (
    <div className="flex flex-col flex-1 min-w-0 bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <div className="flex items-center gap-2 px-4 h-[52px] border-b border-[#E5E5E5] dark:border-[#333] shrink-0">
        {!isLeftSidebarOpen && (
          <button type="button"
            onClick={onOpenLeftSidebar}
            className="p-1 -ml-1 text-[#666] dark:text-[#999] hover:text-[#333] dark:hover:text-[#E0E0E0]"
            aria-label="Open sidebar"
          >
            <PanelLeft className="size-[18px]" strokeWidth={1.5} />
          </button>
        )}
        <TerminalSquare className="size-[17px] text-[#666] dark:text-[#999]" strokeWidth={1.5} />
        <div className="text-[14px] font-medium text-[#333] dark:text-[#E0E0E0] leading-tight">{t('shell.title')}</div>

        {target && (
          <select
            data-testid="shell-target"
            aria-label={t('shell.targetLabel')}
            value={target.id}
            onChange={(e) => setTargetId(e.target.value)}
            className="ml-2 min-w-0 max-w-[300px] truncate rounded-md border border-[#E1E4DC] bg-[#FCFDF9] px-2 py-1 text-[12px] text-[#4E4D47] outline-none transition-colors hover:border-[#CDD1C7] focus:border-[#B89A70] dark:border-[#3C3B36] dark:bg-[#22221F] dark:text-[#C5C1B7]"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.title || t('session.untitled'))} · {backendLabel(s.sandboxKind, t)}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-[#8A8A8A] dark:text-[#999]">
            <StatusDot tone={PTY_STATE_DOT[state].tone} pulse={PTY_STATE_DOT[state].pulse} />
            {stateLabel}
          </span>
        </div>
      </div>

      {target && <TerminalPanel key={target.id} session={target} onStateChange={setState} />}
    </div>
  );
}
