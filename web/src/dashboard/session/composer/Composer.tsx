import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Spinner } from "../../../ui/Spinner";
import { Paperclip, SlidersHorizontal, ArrowUp, X, Square, Pencil, CornerDownRight, ArrowLeftRight, ChevronDown, Maximize2 } from 'lucide-react';
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'motion/react';
import { ApprovalSwitcher } from './ApprovalSwitcher';
import { ThinkingLevelSwitcher } from './ThinkingLevelSwitcher';
import { ModelSwitcher } from './ModelSwitcher';
import { ComposerActionButton, ComposerControlLabel, ComposerIconButton } from './composer-controls';
import { ComposerOverflowMenu, ContextUsageRing, CacheRateChip, type ContextUsage } from './composer-widgets';
import { type SlashCommand } from '../../../conversation/slash-commands';
import { useT } from '../../../i18n';
import { showToast } from '../../../platform/toast';
import { nextReq } from '../req-id';
import { pendingOrderWithKindSlots } from './pending-order';
import { IS_STANDALONE } from '../../../platform/pwa';
import type { WsClient } from '../../../platform/ws';
import type { ApprovalPolicy, ModelInfo, PendingMessage, SessionInfo, SessionStatus, ThinkingLevel, TimelineItem } from '@shared/protocol';
import { ComposerAttachmentCard, type Attachment } from './ComposerAttachmentCard';
import { ComposerDraftEditor } from './ComposerDraftEditor';
import { shouldPromotePastedText } from './pasted-text';
import { AgentActivityOrb } from './AgentActivityOrb';

export type { Attachment } from './ComposerAttachmentCard';

const FINE_POINTER = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;

const PENDING_ROW_H = 30;
const PENDING_ROW_GAP = 4;
const PENDING_PEEK = 7;
const PENDING_MAX_EXPANDED = 5;

type SatelliteVariant = 'ghost' | 'duo' | 'inset' | 'capsule';
const SATELLITE_VARIANT: SatelliteVariant = (() => {
  try {
    const v = localStorage.getItem('oiia.satelliteVariant');
    return v === 'duo' || v === 'inset' || v === 'capsule' ? v : 'ghost';
  } catch {
    return 'ghost';
  }
})();
const SATELLITE_SPLIT = SATELLITE_VARIANT !== 'inset';
const SATELLITE_CHROME = SATELLITE_VARIANT === 'capsule'
  ? ' @5xl:rounded-full @5xl:border @5xl:border-[#E1E5DC] @5xl:bg-[var(--app-surface)] @5xl:px-1.5 @5xl:shadow-[0_2px_8px_-7px_rgba(0,0,0,.16)] @5xl:dark:border-[#3A3C38] @5xl:dark:bg-[#292A27] @5xl:dark:shadow-[0_2px_8px_-7px_rgba(0,0,0,.72)]'
  : ' @5xl:gap-x-1';
const FIELD_ALIGN_GRID =
  ' @5xl:grid @5xl:grid-cols-[minmax(0,1fr)_minmax(20rem,var(--composer-w))_minmax(0,1fr)]';
const STRIP_ALIGN = SATELLITE_SPLIT ? FIELD_ALIGN_GRID : ' @5xl:max-w-[var(--composer-w)] @5xl:mx-auto @5xl:w-full';
const STRIP_INNER = SATELLITE_SPLIT ? ' @5xl:col-start-2 @5xl:min-w-0' : '';

const FIELD_CARD_CHROME =
  ' @5xl:rounded-[24px] @5xl:border @5xl:border-[#DDE2D8] @5xl:bg-[var(--app-surface)] @5xl:shadow-[0_2px_8px_-6px_rgba(0,0,0,.16),0_1px_2px_rgba(0,0,0,.025)] @5xl:dark:border-[#3A3C38] @5xl:dark:bg-[#292A27] @5xl:dark:shadow-[0_2px_8px_-6px_rgba(0,0,0,.72),0_1px_2px_rgba(0,0,0,.22)]';

export function Composer(props: {
  composerWrapRef: RefObject<HTMLDivElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  composingRef: RefObject<boolean>;
  ws: WsClient;
  session: SessionInfo;
  status: SessionStatus;
  items: TimelineItem[];
  retryProgress: { attempt: number; limit: number } | null;
  awaitingApproval: boolean;
  slashList: SlashCommand[] | null;
  slashActive: number;
  setSlashActive: Dispatch<SetStateAction<number>>;
  setSlashDismissedFor: Dispatch<SetStateAction<string | null>>;
  applySlash: (cmd: SlashCommand) => void;
  pending: PendingMessage[];
  setPending: Dispatch<SetStateAction<PendingMessage[]>>;
  editing: { seq: number; original: string } | null;
  cancelEdit: () => void;
  attachments: Attachment[];
  attachError: string;
  addFiles: (list: FileList | null) => void;
  addPastedText: (text: string) => void;
  removeAttachment: (i: number) => void;
  updatePastedText: (i: number, text: string) => string | null;
  uploading: boolean;
  uploadProgress: number;
  inputValue: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  isImeComposing: (e: ReactKeyboardEvent) => boolean;
  recallHistory: (dir: 'prev' | 'next') => boolean;
  send: (mode?: 'steer' | 'queue') => void;
  draftOverflow?: boolean;
  setDraft?: (text: string) => void;
  firstTaskSuggestion?: string;
  onAcceptSuggestion?: () => void;
  contextUsage: ContextUsage | null;
  onSetThinkingLevel?: (id: string, level: ThinkingLevel) => void;
  onSetApprovalPolicy?: (id: string, policy: ApprovalPolicy) => void;
  models?: ModelInfo[];
  onSetModel?: (id: string, provider: string, model: string) => void;
}) {
  const {
    composerWrapRef, fileInputRef, textareaRef, composingRef, ws, session, status, items, retryProgress, awaitingApproval,
    slashList, slashActive, setSlashActive, setSlashDismissedFor, applySlash,
    pending, setPending, editing, cancelEdit, attachments, attachError, addFiles, addPastedText, removeAttachment, updatePastedText,
    uploading, uploadProgress, inputValue, handleInputChange, isImeComposing, recallHistory, send,
    contextUsage, onSetThinkingLevel, onSetApprovalPolicy, models, onSetModel,
    draftOverflow = false, setDraft, firstTaskSuggestion, onAcceptSuggestion,
  } = props;
  const t = useT();
  const reduceMotion = useReducedMotion();
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [pendingHover, setPendingHover] = useState(false);
  const pendingCollapsible = pending.length > 2;
  const pendingHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHoverEnter = () => {
    if (pendingHoverTimer.current) { clearTimeout(pendingHoverTimer.current); pendingHoverTimer.current = null; }
    if (FINE_POINTER && pendingCollapsible) setPendingHover(true);
  };
  const pendingHoverLeave = () => {
    if (pendingHoverTimer.current) clearTimeout(pendingHoverTimer.current);
    pendingHoverTimer.current = setTimeout(() => {
      pendingHoverTimer.current = null;
      setPendingHover(false);
    }, 120);
  };
  useEffect(() => () => { if (pendingHoverTimer.current) clearTimeout(pendingHoverTimer.current); }, []);
  useEffect(() => {
    if (!pendingCollapsible) {
      setPendingExpanded(false);
      setPendingHover(false);
    }
  }, [pendingCollapsible]);
  const [pendingEdit, setPendingEdit] = useState<{ id: string; text: string } | null>(null);
  const [pendingDrag, setPendingDrag] = useState<{ id: string; dy: number } | null>(null);
  const pendingDragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);
  const commitPendingEdit = () => {
    setPendingEdit((edit) => {
      if (!edit) return null;
      const trimmed = edit.text.trim();
      setPending((cur) => {
        const row = cur.find((c) => c.id === edit.id);
        if (!row || !trimmed || trimmed === row.text) return cur;
        ws.send({ type: 'set_pending_text', sessionId: session.id, pendingId: edit.id, text: trimmed, reqId: nextReq() });
        return cur.map((c) => (c.id === edit.id ? { ...c, text: trimmed } : c));
      });
      return null;
    });
  };
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const suggesting = Boolean(firstTaskSuggestion) && status !== 'running' && inputValue.length === 0;
  const hasDraft = inputValue.trim().length > 0 || attachments.length > 0;
  const modelThinkingLevels = models?.find((m) => m.provider === session.provider && m.id === session.model)?.thinkingLevels;
  const showMidTurnActions = status === 'running' && hasDraft && !uploading;
  const primaryDisabled = status !== 'running'
    && (editing ? !inputValue.trim() || uploading : !hasDraft || uploading);
  const primaryActive = status === 'running' || hasDraft || uploading;
  const primaryIconKey = status === 'running' ? 'stop' : uploading ? 'upload' : 'send';

  return (
      <div ref={composerWrapRef} className="oiia-composer-wrap absolute bottom-0 left-0 right-0 z-30 flex justify-center px-4 sm:px-6 pt-2 [--composer-surface:var(--app-surface)] dark:[--composer-surface:#1A1A1A] bg-[var(--composer-surface)]" style={{ paddingBottom: `var(--composer-pb, ${IS_STANDALONE ? 'calc(env(safe-area-inset-bottom, 0px) + 2.25rem)' : '0.75rem'})` }}>

        <div
          data-testid="composer-scroll-edge"
          className="absolute bottom-full left-0 right-0 h-5 pointer-events-none"
          style={{ background: 'linear-gradient(to top, var(--composer-surface) 0%, color-mix(in srgb, var(--composer-surface) 24%, transparent) 45%, transparent 100%)' }}
        />
        <div className="@container relative z-10 w-full max-w-[var(--composer-dock-w)]">

        <div
          data-testid="composer-shell"
          className="mx-auto w-full max-w-[var(--composer-stack-w)] bg-[var(--app-surface)] dark:bg-[#2A2A2A] border border-[#E8EBE3] dark:border-[#333] rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] dark:shadow-black/20 flex flex-col transition-colors relative @5xl:max-w-none @5xl:border-transparent @5xl:bg-transparent @5xl:shadow-none @5xl:dark:border-transparent @5xl:dark:bg-transparent @5xl:dark:shadow-none"
        >

          {slashList && (
            <div
              data-testid="slash-menu"
              className="absolute bottom-full left-0 mb-2 w-[min(380px,100%)] rounded-xl border border-[#E4E4E7] dark:border-[#3A3A3A] bg-[var(--app-surface)] dark:bg-[#222] oiia-shadow-pop p-1.5 z-50 @5xl:left-1/2 @5xl:-translate-x-1/2"
              style={{ animation: 'oiia-fade-in .1s ease-out' }}
            >
              <div className="px-2 pt-0.5 pb-1 text-[10.5px] uppercase tracking-wide text-[#B0AEA2] dark:text-[#6A6A60]">{t('slash.title')}</div>
              {slashList.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  data-active={i === slashActive}
                  onMouseMove={() => setSlashActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); applySlash(c); }}
                  className={`w-full flex items-baseline gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${i === slashActive ? 'bg-[#F1ECE1] dark:bg-[#2C2A22]' : 'hover:bg-[#F5F1E8] dark:hover:bg-[#262421]'}`}
                >
                  <span className="shrink-0 font-medium text-[13px] text-[#333] dark:text-[#E0E0E0] tabular-nums">/{c.name}</span>
                  <span className="min-w-0 truncate text-[12px] text-[#999] dark:text-[#777]">{c.hint}</span>
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />

          {pending.length > 0 && (() => {
            const sorted = [...pending].sort((a, b) =>
              a.kind === b.kind ? a.ord - b.ord : a.kind === 'steer' ? -1 : 1,
            );
            const shown = sorted.slice(0, PENDING_MAX_EXPANDED);
            const overflow = sorted.length - shown.length;
            const queueItems = sorted.filter((q) => q.kind === 'queue');
            const expanded = !pendingCollapsible || pendingExpanded || pendingHover;
            const listH = shown.length * PENDING_ROW_H + (shown.length - 1) * PENDING_ROW_GAP;
            const stackH = PENDING_ROW_H + PENDING_PEEK * Math.min(shown.length - 1, 2);
            const flowH = pendingCollapsible ? stackH : listH;
            return (
              <div
                data-testid="pending-region"
                aria-label={t('chat.pendingRegion')}
                onMouseEnter={pendingHoverEnter}
                onMouseLeave={pendingHoverLeave}
                className={`px-3 pt-1.5 pb-1 @5xl:px-0 @5xl:pt-0 @5xl:pb-1.5 @5xl:w-full${STRIP_ALIGN}`}
              >

                <div className={`relative${STRIP_INNER}`} data-pending-expanded={pendingCollapsible && expanded ? '' : undefined} style={{ height: flowH }}>
                  {(() => {
                    const rowH = PENDING_ROW_H + PENDING_ROW_GAP;
                    const targetFor = (index: number, dy: number) => {
                      const kind = shown[index].kind;
                      let lo = 0; while (lo < shown.length && shown[lo].kind !== kind) lo++;
                      let hi = shown.length - 1; while (hi >= 0 && shown[hi].kind !== kind) hi--;
                      return Math.min(hi, Math.max(lo, index - Math.round(dy / rowH)));
                    };
                    const dragIndex = pendingDrag ? shown.findIndex((s) => s.id === pendingDrag.id) : -1;
                    const previewTarget = dragIndex >= 0 ? targetFor(dragIndex, pendingDrag!.dy) : -1;
                    const previewIndexOf = (idx: number) => {
                      if (dragIndex < 0 || idx === dragIndex) return idx;
                      if (dragIndex < previewTarget && idx > dragIndex && idx <= previewTarget) return idx - 1;
                      if (dragIndex > previewTarget && idx >= previewTarget && idx < dragIndex) return idx + 1;
                      return idx;
                    };
                    const commitDrag = (index: number, dy: number) => {
                      const target = targetFor(index, dy);
                      if (target === index) return;
                      const arr = [...sorted];
                      const [moved] = arr.splice(index, 1);
                      arr.splice(target, 0, moved);
                      const kindIds = arr.filter((row) => row.kind === moved.kind).map((row) => row.id);
                      const order = pendingOrderWithKindSlots(pending, moved.kind, kindIds);
                      const at = new Map(order.map((id, idx) => [id, idx]));
                      setPending((cur) => cur.map((c) => ({ ...c, ord: at.get(c.id) ?? c.ord })));
                      ws.send({ type: 'reorder_pending', sessionId: session.id, order, reqId: nextReq() });
                    };
                    return shown.map((p, i) => {
                    const queueIndex = p.kind === 'queue' ? queueItems.findIndex((q) => q.id === p.id) + 1 : 0;
                    const hiddenInStack = !expanded && i > 2;
                    const isDragged = pendingDrag?.id === p.id;
                    const offset = expanded
                      ? (isDragged ? i : previewIndexOf(i)) * rowH
                      : Math.min(i, 2) * PENDING_PEEK;
                    const scale = expanded ? 1 : 1 - Math.min(i, 2) * 0.04;
                    return (
                      <div
                        key={p.id}
                        data-testid={p.kind === 'steer' ? 'pending-steer' : 'pending-queue'}
                        data-pending-kind={p.kind}
                        aria-hidden={!expanded && i > 0 ? true : undefined}
                        onClick={pendingCollapsible && !expanded ? () => setPendingExpanded(true) : undefined}
                        style={{
                          height: PENDING_ROW_H,
                          transform: `translateY(${-offset + (isDragged ? pendingDrag!.dy : 0)}px) scale(${scale})`,
                          transformOrigin: 'center bottom',
                          zIndex: isDragged ? 99 : shown.length - i,
                          opacity: hiddenInStack ? 0 : 1,
                          pointerEvents: hiddenInStack ? 'none' : undefined,
                          boxShadow: isDragged ? '0 6px 18px -8px rgba(0,0,0,.28)' : undefined,
                          transition: isDragged || reduceMotion ? 'none' : 'transform .22s cubic-bezier(.16,1,.3,1), opacity .18s ease-out',
                          animation: reduceMotion ? undefined : 'oiia-fade-in .18s ease-out',
                        }}
                        className={`group/chip absolute left-0 right-0 bottom-0 flex items-center gap-2 rounded-xl bg-[#F1EFE7] dark:bg-[#242320] pl-2.5 pr-1 shadow-[0_2px_8px_-6px_rgba(0,0,0,.14)] @5xl:left-2 @5xl:right-2 @5xl:pl-2 @5xl:pr-1.5 @5xl:border @5xl:border-[#E3E6DD] @5xl:bg-[var(--app-surface)] dark:shadow-[0_2px_8px_-6px_rgba(0,0,0,.6)] @5xl:dark:border-[#37383390] @5xl:dark:bg-[#292A27]${pendingCollapsible && !expanded ? ' cursor-pointer' : ''}`}
                        title={p.kind === 'steer' ? t('chat.pendingSteer') : t('chat.pendingQueued', { n: queueIndex })}
                      >

                        <button
                          type="button"
                          data-testid="pending-swap"
                          tabIndex={!expanded && i > 0 ? -1 : 0}
                          title={p.kind === 'steer' ? t('chat.toQueue') : t('chat.toSteer')}
                          aria-label={p.kind === 'steer' ? t('chat.toQueue') : t('chat.toSteer')}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (pendingCollapsible && !expanded) { setPendingExpanded(true); return; }
                            const next = p.kind === 'steer' ? 'queue' : 'steer';
                            setPending((cur) => cur.map((c) => (c.id === p.id ? { ...c, kind: next } : c)));
                            ws.send({ type: 'set_pending_kind', sessionId: session.id, pendingId: p.id, kind: next, reqId: nextReq() });
                          }}
                          className="group/swap flex h-[22px] shrink-0 items-center gap-1.5 rounded-full pl-0.5 pr-1.5 -ml-0.5 outline-none transition-colors duration-100 hover:bg-black/[.05] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 dark:hover:bg-white/[.06]"
                        >
                          <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden>
                            <span className="flex items-center justify-center transition-opacity duration-100 group-hover/swap:opacity-0 group-focus-visible/swap:opacity-0">
                              {p.kind === 'steer' ? (
                                <CornerDownRight className="size-3.5 text-[var(--status-working)]" strokeWidth={2.2} />
                              ) : (
                                <span data-testid="pending-ord" className="flex size-4 items-center justify-center rounded-full bg-[#E7E4D8] dark:bg-[#35342E] text-[10px] font-semibold leading-none tabular-nums text-[#77736A] dark:text-[#A19C91]">
                                  {queueIndex}
                                </span>
                              )}
                            </span>
                            <ArrowLeftRight className="absolute size-3.5 text-[#77736A] opacity-0 transition-opacity duration-100 group-hover/swap:opacity-100 group-focus-visible/swap:opacity-100 dark:text-[#A19C91]" strokeWidth={2.2} />
                          </span>
                          <span className="shrink-0 text-[11px] font-medium text-[#8D8B82] dark:text-[#858178]">
                            {p.kind === 'steer' ? t('chat.steer') : t('chat.queue')}
                          </span>
                        </button>
                        {pendingEdit?.id === p.id ? (
                          <input
                            data-testid="pending-edit-input"
                            autoFocus
                            value={pendingEdit.text}
                            onChange={(e) => setPendingEdit({ id: p.id, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (isImeComposing(e)) return;
                              if (e.key === 'Enter') { e.preventDefault(); commitPendingEdit(); }
                              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPendingEdit(null); }
                            }}
                            onBlur={commitPendingEdit}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="min-w-0 flex-1 bg-transparent text-[12px] leading-5 text-[#33312B] outline-none dark:text-[#E4E2D8]"
                          />
                        ) : (
                          <span
                            className={`min-w-0 flex-1 truncate text-[12px] leading-5 text-[#4A493F] dark:text-[#C9C7BE]${expanded && shown.length > 1 ? ' cursor-grab select-none [touch-action:none] active:cursor-grabbing' : ''}`}
                            onPointerDown={(e) => {
                              if (!expanded || pendingEdit || shown.length < 2) return;
                              pendingDragRef.current = { id: p.id, startY: e.clientY, moved: false };
                              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                            }}
                            onPointerMove={(e) => {
                              const d = pendingDragRef.current;
                              if (!d || d.id !== p.id) return;
                              const dy = e.clientY - d.startY;
                              if (!d.moved && Math.abs(dy) < 5) return;
                              d.moved = true;
                              setPendingDrag({ id: p.id, dy });
                            }}
                            onPointerUp={(e) => {
                              const d = pendingDragRef.current;
                              pendingDragRef.current = null;
                              if (d?.moved) commitDrag(i, e.clientY - d.startY);
                              setPendingDrag(null);
                            }}
                            onPointerCancel={() => { pendingDragRef.current = null; setPendingDrag(null); }}
                          >
                            {p.text}
                          </span>
                        )}

                        {pendingEdit?.id !== p.id && (
                          <button
                            type="button"
                            data-testid="pending-edit"
                            aria-label={t('chat.editPending')}
                            title={t('chat.editPending')}
                            tabIndex={!expanded && i > 0 ? -1 : 0}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (pendingCollapsible && !expanded) { setPendingExpanded(true); return; }
                              setPendingEdit({ id: p.id, text: p.text });
                            }}
                            className="shrink-0 rounded-full p-1 text-[#B0AEA2] opacity-0 transition-[opacity,color,background-color] duration-100 hover:bg-black/[.05] hover:text-[#55534B] hover:opacity-100 focus-visible:opacity-100 group-hover/chip:opacity-90 [@media(hover:none)]:opacity-60 dark:text-[#6E6C64] dark:hover:bg-white/[.06] dark:hover:text-[#CFCDC4]"
                          >
                            <Pencil className="size-3" strokeWidth={2.2} />
                          </button>
                        )}
                        {pendingCollapsible && i === 0 && (
                          <button
                            type="button"
                            data-testid="pending-stack-toggle"
                            aria-expanded={expanded}
                            aria-label={t('chat.pendingMore', { n: sorted.length - 1 })}
                            onClick={(e) => { e.stopPropagation(); setPendingExpanded(!expanded); }}
                            className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#E7E4D8] px-1 text-[10px] font-medium leading-none tabular-nums text-[#77736A] transition-colors duration-100 hover:bg-[#DCD8C8] hover:text-[#55534B] dark:bg-[#35342E] dark:text-[#A19C91] dark:hover:bg-[#403E36] dark:hover:text-[#CFCDC4]"
                          >
                            {expanded ? <ChevronDown className="size-3" strokeWidth={2.2} /> : `+${sorted.length - 1}`}
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Remove"
                          data-testid="pending-delete"
                          tabIndex={!expanded && i > 0 ? -1 : 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPending((cur) => cur.filter((c) => c.id !== p.id));
                            ws.send({ type: 'clear_pending', sessionId: session.id, pendingId: p.id, reqId: nextReq() });
                          }}
                          className="shrink-0 rounded-full p-1 text-[#B0AEA2] opacity-60 transition-[opacity,color,background-color] duration-100 hover:bg-black/[.05] hover:text-[#55534B] hover:opacity-100 focus-visible:opacity-100 group-hover/chip:opacity-90 dark:text-[#6E6C64] dark:hover:bg-white/[.06] dark:hover:text-[#CFCDC4]"
                        >
                          <X className="size-3" strokeWidth={2.5} />
                        </button>
                      </div>
                    );
                    });
                  })()}
                  {expanded && overflow > 0 && (
                    <span
                      className="absolute inset-x-0 bottom-0 flex h-[18px] items-center pl-2.5 text-[11px] tracking-tight text-[#999] dark:text-[#666]"
                      style={{ transform: `translateY(${-(listH + PENDING_ROW_GAP)}px)` }}
                    >
                      {t('chat.pendingMore', { n: overflow })}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
          {editing && (
            <div
              data-testid="editing-banner"
              className={`px-4 pt-2.5 pb-1 text-[12.5px] text-[#888] dark:text-[#999] @5xl:w-full${STRIP_ALIGN}`}
            >
              <div className={`flex items-center justify-between${STRIP_INNER}`}>
                <span className="flex items-center gap-1.5">
                  <Pencil className="size-3.5" strokeWidth={2} /> {t('chat.editingMessage')}
                </span>
                <button
                  type="button"
                  data-testid="cancel-edit"
                  onClick={cancelEdit}
                  className="font-medium hover:text-[#333] dark:hover:text-[#E0E0E0] transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
          {!editing && (attachments.length > 0 || attachError) && (
            <div className={`px-3 pt-3 @5xl:w-full${STRIP_ALIGN}`} data-testid="attachments">
              <div className={`flex flex-wrap gap-2${STRIP_INNER}`}>
                {attachments.map((a, i) => (
                  <ComposerAttachmentCard
                    key={`${a.name}-${i}`}
                    attachment={a}
                    index={i}
                    onRemove={removeAttachment}
                    onUpdatePastedText={updatePastedText}
                  />
                ))}
                {attachError && <span className="self-center text-[12px] text-[#C0392B] dark:text-[#E89B9B]">{attachError}</span>}
              </div>
            </div>
          )}
          <div
            data-testid="composer-row"
            className={SATELLITE_SPLIT
              ? "flex w-full flex-col @5xl:grid @5xl:grid-cols-[minmax(0,1fr)_minmax(20rem,var(--composer-w))_minmax(0,1fr)] @5xl:items-end"
              : `flex w-full flex-col @5xl:mx-auto @5xl:max-w-[var(--composer-w)] @5xl:focus-within:border-[#AEB4AA] @5xl:dark:focus-within:border-[#555751]${FIELD_CARD_CHROME}`}
          >

          <div className="relative flex-shrink-0 @5xl:col-start-2 @5xl:row-start-1 @5xl:min-w-0">
          <textarea
            ref={textareaRef}
            data-testid="composer"
            value={inputValue}
            rows={1}
            onChange={handleInputChange}
            aria-label={t('chat.replyPlaceholder')}
            placeholder={suggesting
              ? firstTaskSuggestion
              : status === 'running' ? t('chat.steerPlaceholder') : t('chat.replyPlaceholder')}
            className={`block w-full min-h-12 resize-none outline-none px-4 pt-3 pb-2 text-[14.5px] leading-5 text-gray-800 dark:text-[#E0E0E0] bg-transparent placeholder-[#A1A1AA] dark:placeholder-[#666]${SATELLITE_SPLIT ? ` @5xl:pr-12 @5xl:focus-visible:border-[#AEB4AA] @5xl:focus-visible:ring-1 @5xl:focus-visible:ring-black/[0.10] @5xl:dark:focus-visible:border-[#555751] @5xl:dark:focus-visible:ring-white/[0.08]${FIELD_CARD_CHROME}` : ''}`}
            style={{ maxHeight: '140px' }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onFocus={() => setFieldFocused(true)}
            onBlur={() => { composingRef.current = false; setFieldFocused(false); }}
            onPaste={(e) => {
              const cd = e.clipboardData;
              const dt = new DataTransfer();
              if (cd?.files?.length) {
                for (const f of Array.from(cd.files)) dt.items.add(f);
              } else if (cd?.items) {
                for (const it of Array.from(cd.items)) {
                  if (it.kind === 'file') { const f = it.getAsFile(); if (f) dt.items.add(f); }
                }
              }
              if (dt.files.length) {
                e.preventDefault();
                addFiles(dt.files);
                return;
              }
              const pastedText = cd?.getData('text/plain') ?? '';
              if (!editing && shouldPromotePastedText(pastedText)) {
                e.preventDefault();
                addPastedText(pastedText);
              }
            }}
            onKeyDown={(e) => {
              if (slashList && !isImeComposing(e)) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive((a) => Math.min(slashList.length - 1, a + 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive((a) => Math.max(0, a - 1)); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySlash(slashList[Math.min(slashActive, slashList.length - 1)]); return; }
                if (e.key === 'Escape') { e.preventDefault(); setSlashDismissedFor(inputValue); return; }
              }
              if (e.key === 'Escape') {
                if (isImeComposing(e)) return;
                if (editing) { e.preventDefault(); cancelEdit(); return; }
                if (status === 'running') {
                  e.preventDefault();
                  ws.send({ type: 'interrupt', sessionId: session.id, reqId: nextReq() });
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                if (isImeComposing(e)) return;
                e.preventDefault();
                send(status === 'running' ? 'steer' : undefined);
                return;
              }
              if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                if (isImeComposing(e)) return;
                if (status === 'running' && (inputValue.trim() || attachments.length > 0) && !uploading) {
                  e.preventDefault();
                  void send('queue');
                  return;
                }
                if (suggesting && onAcceptSuggestion) {
                  e.preventDefault();
                  onAcceptSuggestion();
                }
                return;
              }
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
                if (isImeComposing(e)) return;
                const el = e.currentTarget;
                if (el.selectionStart !== el.selectionEnd) return;
                const value = el.value;
                const pos = el.selectionStart;
                if (e.key === 'ArrowUp') {
                  if (value.slice(0, pos).includes('\n')) return;
                  if (recallHistory('prev')) e.preventDefault();
                } else {
                  if (value.slice(pos).includes('\n')) return;
                  if (recallHistory('next')) e.preventDefault();
                }
              }
            }}
          />

          {suggesting && fieldFocused && onAcceptSuggestion && (
            <button
              type="button"
              data-testid="accept-suggestion"
              aria-label={t('chat.acceptSuggestion')}
              title={t('chat.acceptSuggestion')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onAcceptSuggestion}
              style={reduceMotion ? undefined : { animation: 'oiia-fade-in .15s ease-out' }}
              className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-[5px] border border-[#E3E6DD] bg-[var(--app-surface)] px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-[#9A978E] outline-none transition-colors hover:border-[#CDD1C7] hover:text-[#5F5E57] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 dark:border-[#3A3C38] dark:bg-[#292A27] dark:text-[#77746C] dark:hover:border-[#4B4D48] dark:hover:text-[#B3B0A6] [@media(hover:hover)_and_(pointer:fine)]:block"
            >
              Tab
            </button>
          )}

          {setDraft && (draftOverflow || draftEditorOpen) && (
            <button
              type="button"
              data-testid="draft-expand"
              title={t('composer.expandDraft')}
              aria-label={t('composer.expandDraft')}
              onClick={() => setDraftEditorOpen(true)}
              style={reduceMotion ? undefined : { animation: 'oiia-fade-in .15s ease-out' }}
              className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full border border-[#E3E6DD] bg-[var(--app-surface)]/90 text-[#77736A] shadow-[0_2px_8px_-6px_rgba(0,0,0,.2)] backdrop-blur-[2px] outline-none transition-[background-color,color,transform] duration-100 hover:bg-[#F1EFE8] hover:text-[#33312B] active:scale-[.96] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 motion-reduce:transform-none dark:border-[#3A3C38] dark:bg-[#292A27]/90 dark:text-[#A19C91] dark:hover:bg-[#2D2B25] dark:hover:text-[#ECE8DD]"
            >
              <Maximize2 className="size-3.5" strokeWidth={1.8} />
            </button>
          )}
          </div>
          <div className={`flex items-center justify-between px-3 pb-2.5 gap-x-2${SATELLITE_SPLIT ? ' @5xl:contents' : ''}`}>

            <div className={`flex items-center gap-x-1.5 min-w-0${SATELLITE_SPLIT ? ` @5xl:col-start-1 @5xl:row-start-1 @5xl:mr-2 @5xl:mb-1 @5xl:h-10 @5xl:min-w-0 @5xl:max-w-[calc(100%-0.5rem)] @5xl:justify-self-end${SATELLITE_CHROME}` : ''}`}>

              {!editing && (
                <ComposerIconButton iconOnly data-testid="attach" onClick={() => fileInputRef.current?.click()} title={t('chat.attachFiles')}>
                  <Paperclip strokeWidth={2} className="size-4" />
                </ComposerIconButton>
              )}

              {status === 'running' ? (
                <AgentActivityOrb items={items} retryProgress={retryProgress} awaitingApproval={awaitingApproval} />
              ) : (
                <div className={SATELLITE_VARIANT === 'duo' ? '@5xl:hidden' : 'contents'}>
                  <ContextUsageRing usage={contextUsage} />
                </div>
              )}

              {onSetModel && models && session.provider !== 'mock' && (
                <div className={SATELLITE_VARIANT === 'capsule' ? 'hidden min-w-0 @[72rem]:block' : 'hidden min-w-0 @5xl:block'}>
                  <ModelSwitcher
                    session={session}
                    models={models}
                    onChange={(p, m) => onSetModel(session.id, p, m)}
                    condenseLabel={SATELLITE_VARIANT !== 'capsule'}
                  />
                </div>
              )}

              <div className="hidden @3xl:flex @5xl:hidden items-center gap-x-1.5 min-w-0">
                {onSetModel && models && session.provider !== 'mock' && (
                  <ModelSwitcher session={session} models={models} onChange={(p, m) => onSetModel(session.id, p, m)} />
                )}
                {onSetThinkingLevel && session.provider !== 'mock' ? (
                  <ThinkingLevelSwitcher level={session.thinkingLevel} levels={modelThinkingLevels} onChange={(l) => onSetThinkingLevel(session.id, l)} />
                ) : (
                  <ComposerIconButton iconOnly onClick={() => showToast(t('common.comingSoon'))} title={t('think.title')}>
                    <SlidersHorizontal strokeWidth={2} className="size-4" />
                  </ComposerIconButton>
                )}
                {onSetApprovalPolicy && (
                  <ApprovalSwitcher policy={session.approvalPolicy} onChange={(p) => onSetApprovalPolicy(session.id, p)} />
                )}
                <CacheRateChip items={items} />
              </div>

              <div className="@3xl:hidden @5xl:block">
                <ComposerOverflowMenu
                  settings={[
                    onSetModel && models && session.provider !== 'mock'
                      ? <ModelSwitcher key="model" session={session} models={models} onChange={(p, m) => onSetModel(session.id, p, m)} showCategory popoverGroup="composer-overflow" />
                      : null,
                    onSetThinkingLevel && session.provider !== 'mock'
                      ? <ThinkingLevelSwitcher key="thinking" level={session.thinkingLevel} levels={modelThinkingLevels} onChange={(l) => onSetThinkingLevel(session.id, l)} showCategory popoverGroup="composer-overflow" />
                      : <ComposerIconButton key="thinking-placeholder" layout="overflow" onClick={() => showToast(t('common.comingSoon'))} title={t('think.title')}>
                          <SlidersHorizontal strokeWidth={2} className="size-4" />
                          <ComposerControlLabel category={t('think.title')} value={t('common.comingSoon')} showCategory />
                        </ComposerIconButton>,
                    onSetApprovalPolicy
                      ? <ApprovalSwitcher key="approval" policy={session.approvalPolicy} onChange={(p) => onSetApprovalPolicy(session.id, p)} showCategory popoverGroup="composer-overflow" />
                      : null,
                  ]}
                  status={[
                    SATELLITE_VARIANT === 'duo' || status === 'running'
                      ? <div key="context" className={SATELLITE_VARIANT === 'duo' && status !== 'running' ? 'hidden @5xl:block' : undefined}>
                          <ContextUsageRing usage={contextUsage} showCategory popoverGroup="composer-overflow" />
                        </div>
                      : null,
                    <CacheRateChip key="cache" items={items} showCategory popoverGroup="composer-overflow" />,
                  ]}
                />
              </div>
            </div>

            <LazyMotion features={domAnimation}>
            <div className={`flex items-center shrink-0${SATELLITE_SPLIT ? ' @5xl:contents' : ''}`}>

              <AnimatePresence initial={false}>
                {showMidTurnActions && (
                  <m.div
                    key="mid-turn-actions"
                    initial={{ opacity: 0, x: reduceMotion ? 0 : 4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: reduceMotion ? 0 : 3 }}
                    transition={{ duration: reduceMotion ? 0 : 0.12, ease: [0.16, 1, 0.3, 1] }}
                    className={`flex items-center gap-x-2 pr-2${SATELLITE_SPLIT ? ' @5xl:col-start-3 @5xl:row-start-1 @5xl:ml-2 @5xl:h-12 @5xl:justify-self-start @5xl:pr-0' : ''}`}
                  >
                    <ComposerActionButton data-testid="queue" onClick={() => void send('queue')} title={t('chat.queueHint')} tone="quiet" hint="⇥">
                      {t('chat.queue')}
                    </ComposerActionButton>
                    <ComposerActionButton data-testid="steer" onClick={() => void send('steer')} title={t('chat.steerHint')} tone="strong" hint="↵">
                      {t('chat.steer')}
                    </ComposerActionButton>
                  </m.div>
                )}
              </AnimatePresence>

              <button
                type="button"
                data-testid={status === 'running' ? 'interrupt' : editing ? 'resend' : 'send'}
                onClick={() => {
                  if (status === 'running') ws.send({ type: 'interrupt', sessionId: session.id, reqId: nextReq() });
                  else void send();
                }}
                disabled={primaryDisabled}
                title={status === 'running' ? `${t('chat.stop')} (Esc)` : editing ? t('chat.resend') : undefined}
                aria-label={status === 'running' ? t('chat.stop') : editing ? t('chat.resend') : undefined}
                className={`relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full outline-none transition-[background-color,color,box-shadow,opacity,transform] duration-100 active:scale-[.96] motion-reduce:transform-none focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35${SATELLITE_SPLIT ? ' @5xl:col-start-2 @5xl:row-start-1 @5xl:mr-2 @5xl:mb-2 @5xl:justify-self-end @5xl:self-end' : ''} ${
                  primaryActive
                    ? 'bg-[#222] dark:bg-[#E0E0E0] text-white dark:text-[#222] shadow-sm hover:opacity-90'
                    : 'bg-[#F4F4F1] dark:bg-[#3A3935] text-[#D0CFC8] dark:text-[#6A6861]'
                }`}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <m.span
                    key={primaryIconKey}
                    className="absolute inset-0 flex items-center justify-center"
                    initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.9 }}
                    transition={{ duration: reduceMotion ? 0 : 0.14, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {status === 'running' ? (
                      <Square className="size-3" fill="currentColor" strokeWidth={0} />
                    ) : uploading ? (
                      uploadProgress > 0 ? (
                        <svg className="size-4 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
                          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
                          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={2 * Math.PI * 8} strokeDashoffset={2 * Math.PI * 8 * (1 - uploadProgress)} />
                        </svg>
                      ) : (
                        <Spinner className="size-3" strokeWidth={4} />
                      )
                    ) : (
                      <ArrowUp strokeWidth={2.5} className="size-4" />
                    )}
                  </m.span>
                </AnimatePresence>
              </button>
            </div>
            </LazyMotion>
          </div>
          </div>

          {setDraft && (
            <ComposerDraftEditor
              open={draftEditorOpen}
              onOpenChange={(open) => {
                setDraftEditorOpen(open);
                if (!open) requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
              }}
              text={inputValue}
              onChangeText={setDraft}
              status={status}
              uploading={uploading}
              onSend={(mode) => void send(mode)}
            />
          )}
        </div>
        </div>
      </div>
  );
}
