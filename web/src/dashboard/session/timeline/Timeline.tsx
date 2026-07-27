import { Fragment, type CSSProperties, type RefObject } from 'react';
import { useT } from '../../../i18n';
import { TimelineBlock, ToolGroupRow } from './TimelineBlock';
import { PermissionPrompt } from './PermissionPrompt';
import { groupTimelineUnits, type ToolFoldMode } from './timeline-helpers';
import { TeamSessionContext } from '../team/TeamSessionContext';
import type {
  PermissionDecision,
  PermissionRequestPayload,
  SessionStatus,
  TimelineItem,
} from '@shared/protocol';

type TurnUsage = { input: number; output: number; total: number; costUsd: number };

export function Timeline(props: {
  chatScale: number;
  status: SessionStatus;
  sessionLoading: boolean;
  teamMemberSession?: boolean;
  items: TimelineItem[];
  maxVisible: number;
  showEarlier: () => void;
  toolFold: ToolFoldMode;
  sessionId: string;
  onOpenTool?: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenCompaction?: (id: string) => void;
  activeToolId?: string | null;
  activeCompactionId?: string | null;
  handleResume: (text: string) => void;
  handleRetry?: () => void;
  beginEdit: (item: Extract<TimelineItem, { kind: 'user' }>) => void;
  canEdit: boolean;
  onFork?: (fromSeq: number) => void;
  canFork: boolean;
  compactionFloorSeq: number;
  rewindableUserIds: Set<string>;
  turnUsageById: Map<string, TurnUsage>;
  turnCopyById: Map<string, string>;
  streamCompensatorRef: RefObject<HTMLDivElement | null>;
  perm: PermissionRequestPayload | null;
  respond: (decision: PermissionDecision) => void;
}) {
  const {
    chatScale, status, sessionLoading, teamMemberSession, items, maxVisible, showEarlier, toolFold,
    sessionId, onOpenTool, onOpenFile, onOpenCompaction, activeToolId, activeCompactionId,
    handleResume, handleRetry, beginEdit, canEdit, onFork, canFork, compactionFloorSeq, rewindableUserIds,
    turnCopyById,
    turnUsageById, streamCompensatorRef, perm, respond,
  } = props;
  const t = useT();

  return (
        <div
          className={`max-w-[var(--reader-w)] mx-auto${chatScale <= 0.9 ? " chat-density-compact" : ""}`}
          style={chatScale !== 1 ? ({ zoom: chatScale, "--canvas-unzoom": 1 / chatScale, "--chat-scale": chatScale } as CSSProperties) : undefined}
        >
          <span data-testid="session-status" className="sr-only">{status}</span>

          {teamMemberSession && <TeamSessionContext sessionId={sessionId} />}

          {!sessionLoading && !teamMemberSession && items.length === 0 && (
            <div className="flex justify-center mt-24 text-[14px] text-[#888] dark:text-[#888]">
              {t('chat.start')}
            </div>
          )}

          {items.length > maxVisible && (
            <div className="flex justify-center mb-5">
              <button
                type="button"
                data-testid="show-earlier"
                onClick={showEarlier}
                className="text-[12.5px] text-[#666] dark:text-[#999] bg-[#F4F4F5] dark:bg-[#2A2A2A] hover:bg-[#EAEAEA] dark:hover:bg-[#333] px-3 py-1.5 rounded-full transition-colors"
              >
                {t(items.length - maxVisible === 1 ? 'chat.showEarlier.one' : 'chat.showEarlier.other', { count: items.length - maxVisible })}
              </button>
            </div>
          )}

          {(() => {
            const lastItem = items[items.length - 1];
            const lastErrorId = lastItem?.kind === 'error' ? lastItem.id : undefined;
            const sliced = items.slice(Math.max(0, items.length - maxVisible));
            const units = groupTimelineUnits(sliced, toolFold);
            const renderBlock = (item: TimelineItem) => (
              <TimelineBlock key={item.id} item={item} sessionId={sessionId} onOpenTool={onOpenTool} onOpenFile={onOpenFile} onOpenCompaction={onOpenCompaction} activeToolId={activeToolId} activeCompactionId={activeCompactionId} onResume={handleResume} onRetry={item.id === lastErrorId ? handleRetry : undefined} retrying={status === 'running' && item.id === lastErrorId} onEditMessage={beginEdit} canEdit={canEdit} onFork={onFork} canFork={canFork} compactionFloorSeq={compactionFloorSeq} turnRootUser={item.kind === 'user' && rewindableUserIds.has(item.id)} turnUsage={turnUsageById.get(item.id)} copyText={turnCopyById.get(item.id)} />
            );
            return units.map((unit) => {
              if (unit.tools) {
                return (
                  <ToolGroupRow
                    key={`grp-${unit.tools[0].id}`}
                    tools={unit.tools}
                    run={unit.run}
                    renderItem={renderBlock}
                    activeToolId={activeToolId}
                  />
                );
              }
              const item = unit.item;
              return <Fragment key={item.id}>{renderBlock(item)}</Fragment>;
          });
          })()}

          {perm && <PermissionPrompt request={perm} onRespond={respond} />}

          <div ref={streamCompensatorRef} data-testid="stream-height-compensator" aria-hidden="true" />
        </div>
  );
}
