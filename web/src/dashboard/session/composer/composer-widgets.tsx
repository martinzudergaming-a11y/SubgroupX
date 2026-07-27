import { Children, Fragment, useEffect, useMemo, type ReactNode } from 'react';
import { MoreHorizontal, DatabaseZap } from 'lucide-react';
import { ComposerControlLabel, ComposerIconButton, ComposerMenu, COMPOSER_ICON_SIZE } from './composer-controls';
import { closeComposerPopoverGroup, useComposerPopover, type ComposerPopoverGroup } from './useHoverPopover';
import { formatTokens, collectCacheModelRounds } from '../timeline/timeline-format';
import { useT } from '../../../i18n';
import type { ContextParts, TimelineItem } from '@shared/protocol';

export type ContextUsage = { used: number; measured: number; pending: number; total: number; compactAt: number; parts?: ContextParts };
const CONTEXT_PARTS: { key: keyof ContextParts; color: string; labelKey: 'context.part.system' | 'context.part.tools' | 'context.part.user' | 'context.part.assistant' | 'context.part.toolResults' }[] = [
  { key: 'system', color: '#64748B', labelKey: 'context.part.system' },
  { key: 'tools', color: '#3B82F6', labelKey: 'context.part.tools' },
  { key: 'user', color: '#22A06B', labelKey: 'context.part.user' },
  { key: 'assistant', color: '#9B5BBD', labelKey: 'context.part.assistant' },
  { key: 'toolResults', color: '#C77D2E', labelKey: 'context.part.toolResults' },
];

function ComposerOverflowSection({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  if (!rows.length) return null;
  return (
    <section data-testid={testId} aria-label={label}>
      <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#A09C91] dark:text-[#77736A]">
        {label}
      </div>
      <div className="space-y-0.5">
        {rows.map((row, index) => (
          <div
            key={index}
            data-composer-overflow-row
            className="w-full min-w-0 [&>div]:w-full"
          >
            {row}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ComposerOverflowMenu({ settings, status }: { settings: ReactNode; status: ReactNode }) {
  const t = useT();
  const { open, rootRef, triggerRef, scheduleClose, openFromHover, togglePinned } = useComposerPopover();
  useEffect(() => {
    if (!open) closeComposerPopoverGroup('composer-overflow');
  }, [open]);
  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={openFromHover} onMouseLeave={scheduleClose}>
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        iconOnly
        data-testid="composer-overflow"
        aria-label={t('chat.moreControls')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('chat.moreControls')}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
      >
        <MoreHorizontal strokeWidth={2} className="size-4" />
      </ComposerIconButton>
      <ComposerMenu open={open} title={t('chat.moreControls')} width="w-[min(19rem,calc(100vw-2rem))]" testId="composer-overflow-menu" kind="dialog">

        <div className="px-1 pb-1">
          <ComposerOverflowSection label={t('chat.sessionSettings')} testId="composer-overflow-settings">
            {settings}
          </ComposerOverflowSection>
          <div className="mx-2 my-1 border-t border-[#E8E3D7] dark:border-[#39362E]" />
          <ComposerOverflowSection label={t('chat.sessionStatus')} testId="composer-overflow-status">
            {status}
          </ComposerOverflowSection>
        </div>
      </ComposerMenu>
    </div>
  );
}

export function ContextUsageRing({
  usage,
  showCategory = false,
  popoverGroup = 'composer-footer',
}: {
  usage: ContextUsage | null;
  showCategory?: boolean;
  popoverGroup?: ComposerPopoverGroup;
}) {
  const t = useT();
  const { open, rootRef, triggerRef, scheduleClose, openFromHover, togglePinned } = useComposerPopover({ group: popoverGroup });
  if (!usage || usage.total <= 0) {
    return (
      <ComposerIconButton disabled iconOnly={!showCategory} data-testid="context-ring" title={t('context.title')} layout={showCategory ? "overflow" : "compact"}>
        <svg width={COMPOSER_ICON_SIZE} height={COMPOSER_ICON_SIZE} viewBox="0 0 18 18" className="shrink-0">
          <circle cx="9" cy="9" r={7} fill="none" strokeWidth="2.5" className="stroke-[#E4E4E7] dark:stroke-[#3A3A3A]" />
        </svg>
        {showCategory && (
          <ComposerControlLabel category={t('context.title')} value="—" valueStyle={{ fontVariantNumeric: 'tabular-nums' }} showCategory />
        )}
      </ComposerIconButton>
    );
  }
  const { used, measured, pending, total, compactAt, parts } = usage;
  const partSegs = parts
    ?
      CONTEXT_PARTS.flatMap((p) => (parts[p.key] > 0 ? [{ ...p, value: parts[p.key] }] : []))
    : [];
  const partsSum = partSegs.reduce((n, p) => n + p.value, 0) || 1;
  const frac = total > 0 ? Math.min(1, used / total) : 0;
  const pct = Math.round(frac * 100);
  const free = Math.max(0, total - used);
  const warn = compactAt > 0 ? used >= compactAt : frac >= 0.9;
  const near = compactAt > 0 ? used >= compactAt * 0.8 : frac >= 0.75;
  const color = warn ? '#E5484D' : near ? '#C77D2E' : '#71717A';

  const r = 7;
  const C = 2 * Math.PI * r;
  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={openFromHover} onMouseLeave={scheduleClose}>
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        data-testid="context-ring"
        aria-label={t('context.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${pct}% · ${formatTokens(used)} / ${formatTokens(total)}`}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
        layout={showCategory ? "overflow" : "compact"}
        iconOnly={!showCategory && !near}
      >

        <svg width={COMPOSER_ICON_SIZE} height={COMPOSER_ICON_SIZE} viewBox="0 0 18 18" className="-rotate-90 shrink-0">
          <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-[#E4E4E7] dark:stroke-[#3A3A3A]" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            strokeWidth="2.5"
            stroke={color}
            strokeLinecap="round"
            strokeDasharray={`${frac * C} ${C}`}
          />
        </svg>

        {showCategory
          ? <ComposerControlLabel category={t('context.title')} value={`${pct}%`} valueStyle={{ color, fontVariantNumeric: 'tabular-nums' }} showCategory />
          : near
            ? <ComposerControlLabel category={t('context.title')} value={`${pct}%`} valueStyle={{ color, fontVariantNumeric: 'tabular-nums' }} />
            : null}
      </ComposerIconButton>

      <ComposerMenu open={open} title={t('context.title')} titleEnd={`${pct}%`} width="w-60" testId="context-breakdown" kind="dialog">
        <div className="px-2 pb-1 text-[12.5px] text-[#444] dark:text-[#CCC]">
          <div className="tabular-nums mb-2.5 text-[#666] dark:text-[#AAA]">
            {t('context.used', { used: formatTokens(used), total: formatTokens(total) })}
          </div>
          <div className="h-1.5 rounded-full bg-[#F0F0F0] dark:bg-[#333] overflow-hidden mb-2.5">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
          </div>
          <Row label={t('context.measured')} value={formatTokens(measured)} />
          <Row label={t('context.pending')} value={`≈ ${formatTokens(pending)}`} />
          <Row label={t('context.free')} value={formatTokens(free)} />

          {partSegs.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-[#EEE] dark:border-[#333]">
              <div className="mb-1.5 text-[11px] text-[#999] dark:text-[#888]">{t('context.breakdown')}</div>

              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[#F0F0F0] dark:bg-[#333] mb-2">
                {partSegs.map((p) => (
                  <div key={p.key} style={{ width: `${(p.value / partsSum) * 100}%`, backgroundColor: p.color }} title={t(p.labelKey)} />
                ))}
              </div>
              {partSegs.map((p) => (
                <div key={p.key} className="flex items-center justify-between py-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} />
                    <span className="truncate text-[#666] dark:text-[#AAA]">{t(p.labelKey)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[#888]">
                    {formatTokens(p.value)} · {Math.round((p.value / partsSum) * 100)}%
                  </span>
                </div>
              ))}
              <div className="mt-1 text-[10.5px] text-[#AAA] dark:text-[#777]">{t('context.breakdownNote')}</div>
            </div>
          )}
          {compactAt > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-[#EEE] dark:border-[#333] text-[11.5px] text-[#999] dark:text-[#888]">
              {t('context.compactHint', { at: formatTokens(compactAt) })}
            </div>
          )}
        </div>
      </ComposerMenu>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[#888] dark:text-[#999]">{label}</span>
      <span className="tabular-nums text-[#444] dark:text-[#CCC]">{value}</span>
    </div>
  );
}

export function CacheRateChip({
  items,
  showCategory = false,
  popoverGroup = 'composer-footer',
}: {
  items: TimelineItem[];
  showCategory?: boolean;
  popoverGroup?: ComposerPopoverGroup;
}) {
  const t = useT();
  const { open, rootRef, triggerRef, scheduleClose, openFromHover, togglePinned } = useComposerPopover({ group: popoverGroup });
  const rounds = useMemo(() => collectCacheModelRounds(items), [items]);
  const latest = rounds.length > 0 ? rounds[rounds.length - 1] : null;

  if (!latest) {
    return (
      <ComposerIconButton disabled data-testid="cache-rate" title={t('cache.notReported')} layout={showCategory ? "overflow" : "compact"}>
        <DatabaseZap strokeWidth={2} width={COMPOSER_ICON_SIZE} height={COMPOSER_ICON_SIZE} className="shrink-0" />
        <ComposerControlLabel category={t('cache.label')} value="—" showCategory={showCategory} />
      </ComposerIconButton>
    );
  }

  const latestPct = Math.round(latest.rate * 100);
  const sumCache = rounds.reduce((n, x) => n + x.cacheRead, 0);
  const sumDenom = rounds.reduce((n, x) => n + x.cacheRead + x.input, 0) || 1;
  const cumPct = Math.round((sumCache / sumDenom) * 100);
  const recent = [...rounds].reverse().slice(0, 12);

  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={openFromHover} onMouseLeave={scheduleClose}>
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        data-testid="cache-rate"
        aria-label={t('cache.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${t('cache.label')} ${latestPct}%`}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
        layout={showCategory ? "overflow" : "compact"}
      >
        <DatabaseZap strokeWidth={2} width={COMPOSER_ICON_SIZE} height={COMPOSER_ICON_SIZE} className="shrink-0" />

        <ComposerControlLabel category={t('cache.label')} value={`${latestPct}%`} valueStyle={{ fontVariantNumeric: 'tabular-nums' }} showCategory={showCategory} />
      </ComposerIconButton>

      <ComposerMenu open={open} title={t('cache.title')} titleEnd={`${latestPct}%`} width="w-60" testId="cache-breakdown" kind="dialog">
        <div className="px-2 pb-1 text-[12.5px] text-[#444] dark:text-[#CCC]">
          <Row label={t('cache.hitRate')} value={`${latestPct}%`} />
          <Row label={`${t('cache.cumulative')} · ${t('cache.modelCalls', { n: rounds.length })}`} value={`${cumPct}%`} />

          <div className="mt-2.5 pt-2 border-t border-[#EEE] dark:border-[#333]">
            <div className="grid grid-cols-[minmax(34px,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1">
              <span />
              <span className="text-right text-[10.5px] text-[#9A9A92] dark:text-[#84827A]">{t('cache.colCached')}</span>
              <span className="text-right text-[10.5px] text-[#9A9A92] dark:text-[#84827A]">{t('cache.colNew')}</span>
              <span className="text-right text-[10.5px] text-[#9A9A92] dark:text-[#84827A]">%</span>
              {recent.map((x) => (
                <Fragment key={x.seq}>
                  <span className="h-[5px] overflow-hidden rounded-full bg-[#ECECE7] dark:bg-[#33332F]">
                    <span className="block h-full rounded-full bg-[#B9A98C] dark:bg-[#7A6C51]" style={{ width: `${Math.round(x.rate * 100)}%` }} />
                  </span>
                  <span className="text-right tabular-nums text-[#666] dark:text-[#AAA]">{formatTokens(x.cacheRead)}</span>
                  <span className="text-right tabular-nums text-[#8B8B84] dark:text-[#8D8B82]">{formatTokens(x.input)}</span>
                  <span className="text-right tabular-nums text-[#888]">{Math.round(x.rate * 100)}</span>
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </ComposerMenu>
    </div>
  );
}
