import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffLines, diffWordsWithSpace } from 'diff';
import { ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { TOOL_STATUS_ICON } from '../../ui/status-colors';
import MarkdownRenderer from '../markdown/MarkdownRenderer';
import CodeBlock from '../markdown/CodeBlock';
import { useT } from '../../i18n';
import type { ToolCallStatus } from '@shared/protocol';

export function ToolStatus({ status, termination }: { status: ToolCallStatus; termination?: 'cancelled' }) {
  const t = useT();
  if (termination === 'cancelled') {
    const label = t('tool.phaseCancelled');
    return (
      <span data-testid="tool-status" className="ml-2 shrink-0 inline-flex items-center" title={label}>
        <XCircle className="size-[15px] text-[#969991] dark:text-[#777A73]" strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  const { Icon, cls, spin, pulse } = TOOL_STATUS_ICON[status] ?? TOOL_STATUS_ICON.pending;
  return (
    <span data-testid="tool-status" className="ml-2 shrink-0 inline-flex items-center" title={status}>
      <Icon
        className={`size-[15px] ${cls} ${spin ? 'animate-spin' : ''} ${pulse ? 'animate-pulse' : ''}`}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span className="sr-only">{status}</span>
    </span>
  );
}

const STREAM_PREVIEW_CAP = 20_000;

export function StreamingCodeBlock({
  code,
  language,
  streaming,
  output,
}: {
  code: string;
  language: string;
  streaming?: boolean;
  output?: string;
}) {
  const t = useT();
  const body = code.length > STREAM_PREVIEW_CAP ? code.slice(0, STREAM_PREVIEW_CAP) + '\n…' : code;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) { setOverflowing(false); return; }
    const sync = () => {
      setOverflowing(el.scrollHeight > el.clientHeight + 2);
      if (streaming) el.scrollTop = el.scrollHeight;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [streaming, body, output]);
  const showMasks = streaming && overflowing;
  return (
    <div data-testid="streaming-args-preview" className="mt-1">

      <div className="markdown-theme relative rounded-xl ring-1 ring-black/[0.05] dark:ring-white/[0.06]" style={{ background: 'var(--cb-bg-base)' }}>
        <div ref={scrollRef} className="max-h-64 overflow-auto rounded-xl [scrollbar-width:thin]">
          <CodeBlock code={body} language={language} hideHeader lineNumbers />
          {output && (
            <div className="mx-3 mb-2 border-t border-black/[0.06] dark:border-white/[0.08] pt-1.5">
              <pre
                className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-[#6E6E6E] dark:text-[#9A9A9A] [scrollbar-width:thin]"
                style={{ fontFamily: 'var(--font-code)' }}
                data-testid="tool-output-preview"
              >
                {output}
              </pre>
            </div>
          )}
        </div>

        {showMasks && (
          <div className="pointer-events-none absolute inset-x-1 top-0 h-6 rounded-t-xl"
               style={{ background: 'linear-gradient(to bottom, var(--cb-bg-base), transparent)' }} />
        )}
        {showMasks && (
          <div className="pointer-events-none absolute inset-x-1 bottom-0 h-9 rounded-b-xl flex items-end justify-end px-2.5 pb-1.5"
               style={{ background: 'linear-gradient(to top, var(--cb-bg-base) 35%, transparent)' }}>
            <span className="flex items-center gap-1 text-[10px] tracking-tight text-[#8A8F98]">
              <span className="inline-block size-1 rounded-full bg-current animate-pulse" />
              {t('tool.stillWriting')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

type Seg = { text: string; hl: boolean };
type DiffLine = { t: 'ctx' | 'add' | 'del'; oldLn: number | null; newLn: number | null; text: string; segs?: Seg[]; key: string };
type DiffRow = DiffLine | { t: 'fold'; count: number; hidden: DiffLine[]; key: string };

function wordSegments(oldLine: string, newLine: string): { del: Seg[]; add: Seg[] } {
  const del: Seg[] = [], add: Seg[] = [];
  for (const p of diffWordsWithSpace(oldLine, newLine)) {
    if (p.added) add.push({ text: p.value, hl: true });
    else if (p.removed) del.push({ text: p.value, hl: true });
    else { del.push({ text: p.value, hl: false }); add.push({ text: p.value, hl: false }); }
  }
  return { del, add };
}

export function DiffView({ oldText, newText, path }: { oldText: string; newText: string; path?: string }) {
  const t = useT();
  const { rows, added, removed } = useMemo(() => {
    const parts = diffLines(oldText, newText);
    const rows: DiffRow[] = [];
    let oldLn = 1, newLn = 1, seq = 0, added = 0, removed = 0;
    const k = () => String(seq++);
    const splitLines = (v: string) => v.replace(/\n$/, '').split('\n');
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      const lines = splitLines(part.value);
      if (part.removed) {
        const next = parts[pi + 1];
        const addLines = next?.added ? splitLines(next.value) : null;
        const pairCount = addLines ? Math.min(lines.length, addLines.length) : 0;
        lines.forEach((text, i) => {
          const segs = i < pairCount ? wordSegments(text, addLines![i]).del : undefined;
          rows.push({ t: 'del', oldLn, newLn: null, text, segs, key: k() }); oldLn++; removed++;
        });
        if (addLines) {
          addLines.forEach((text, i) => {
            const segs = i < pairCount ? wordSegments(lines[i], text).add : undefined;
            rows.push({ t: 'add', oldLn: null, newLn, text, segs, key: k() }); newLn++; added++;
          });
          pi++;
        }
      } else if (part.added) {
        for (const text of lines) { rows.push({ t: 'add', oldLn: null, newLn, text, key: k() }); newLn++; added++; }
      } else if (lines.length > 6) {
        const emitCtx = (text: string): DiffLine => {
          const row = { t: 'ctx' as const, oldLn, newLn, text, key: k() };
          oldLn++; newLn++;
          return row;
        };
        lines.slice(0, 3).forEach((l) => rows.push(emitCtx(l)));
        const hidden = lines.slice(3, -3).map(emitCtx);
        rows.push({ t: 'fold', count: hidden.length, hidden, key: k() });
        lines.slice(-3).forEach((l) => rows.push(emitCtx(l)));
      } else {
        for (const text of lines) { rows.push({ t: 'ctx', oldLn, newLn, text, key: k() }); oldLn++; newLn++; }
      }
    }
    return { rows, added, removed };
  }, [oldText, newText]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const renderLine = (r: DiffLine) => {
    const bg = r.t === 'add' ? 'var(--diff-add-bg)' : r.t === 'del' ? 'var(--diff-del-bg)' : 'transparent';
    const gutterBg = r.t === 'add' ? 'var(--diff-add-gutter)' : r.t === 'del' ? 'var(--diff-del-gutter)' : 'transparent';
    const fg = r.t === 'add' ? 'var(--diff-add-fg)' : r.t === 'del' ? 'var(--diff-del-fg)' : undefined;
    const sign = r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' ';
    return (
      <div key={r.key} className="flex min-w-max" style={{ background: bg }}>
        <span className="shrink-0 w-9 px-1 text-right select-none tabular-nums" style={{ color: 'var(--diff-gutter-fg)', background: gutterBg }}>{r.oldLn ?? ''}</span>
        <span className="shrink-0 w-9 px-1 text-right select-none tabular-nums border-r border-black/[0.05] dark:border-white/[0.06]" style={{ color: 'var(--diff-gutter-fg)', background: gutterBg }}>{r.newLn ?? ''}</span>
        <span className="shrink-0 w-4 text-center select-none" style={{ color: fg ?? 'var(--diff-gutter-fg)' }}>{sign}</span>
        <span className="whitespace-pre pr-3" style={{ color: fg ?? 'var(--cb-fg-muted, #777)' }}>
          {r.segs && r.segs.length > 0
            ? r.segs.map((s, i) =>
                s.hl ? (
                  <span key={i} className="rounded-[2px]" style={{ background: r.t === 'add' ? 'var(--diff-add-word)' : 'var(--diff-del-word)' }}>{s.text}</span>
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )
            : r.text || ' '}
        </span>
      </div>
    );
  };

  return (
    <div
      data-testid="diff-view"
      className="mt-1 rounded-lg border border-[#ECECEC] dark:border-[#2C2C2C] overflow-hidden"
      style={{ fontFamily: 'var(--font-code)' }}
    >
      {path && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[#ECECEC] dark:border-[#2C2C2C] bg-[#FAFAFA] dark:bg-[#1A1A1A]">
          <span className="truncate text-[12px] text-[#555] dark:text-[#BBB]" title={path}>{path}</span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[11px] font-medium tabular-nums">
            {added > 0 && <span style={{ color: 'var(--diff-add-fg)' }}>+{added}</span>}
            {removed > 0 && <span style={{ color: 'var(--diff-del-fg)' }}>-{removed}</span>}
          </span>
        </div>
      )}
      <div className="overflow-x-auto text-[12.5px] leading-[1.55] max-h-[460px] overflow-y-auto [scrollbar-width:thin]">
        {rows.map((r) => {
          if (r.t === 'fold') {
            const open = expanded.has(r.key);
            return (
              <div key={r.key}>
                <button
                  type="button"
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}
                  className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05] transition-colors"
                  style={{ color: 'var(--diff-meta-fg)' }}
                >
                  <span className="shrink-0 w-[72px]" />
                  {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                  <span className="text-[11.5px]">{t('tool.diffElision', { count: r.count })}</span>
                </button>
                {open && r.hidden.map(renderLine)}
              </div>
            );
          }
          return renderLine(r);
        })}
      </div>
    </div>
  );
}

function safeHttpUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

interface ExaResult {
  title: string;
  url?: string;
  published?: string;
  author?: string;
  highlights?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatExaDate(raw?: string): string {
  if (!raw || raw === 'N/A') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function parseExaResults(text: string): ExaResult[] {
  if (!text) return [];
  const blocks = text.split(/^\s*-{3,}\s*$/m).filter((b) => b.trim());
  const out: ExaResult[] = [];
  let failed = false;
  for (const block of blocks) {
    const title = /^\s*Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (!title) {
      if (/^\s*(URL|Published|Author|Highlights):/m.test(block)) failed = true;
      continue;
    }
    const url = /^\s*URL:\s*(\S.*)$/m.exec(block)?.[1]?.trim();
    const published = /^\s*Published:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const author = /^\s*Author:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const hi = /^\s*Highlights:\s*([\s\S]*)$/m.exec(block)?.[1];
    const highlights = hi
      ?.replace(/^\s*\[\.{2,}\]\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out.push({
      title,
      url,
      published: published && published !== 'N/A' ? published : undefined,
      author: author && author !== 'N/A' ? author : undefined,
      highlights: highlights || undefined,
    });
  }
  return failed ? [] : out;
}

function ExaResultRow({ result }: { result: ExaResult }) {
  const [open, setOpen] = useState(false);
  const href = safeHttpUrl(result.url);
  const host = href ? hostOf(href) : '';
  const date = formatExaDate(result.published);
  return (
    <div className="py-1.5 border-b border-[#F0F0F0] dark:border-[#2A2A2A] last:border-b-0">
      <div className="flex items-baseline gap-2 min-w-0">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-[13px] text-[#0066CC] dark:text-[#4da6ff] hover:underline truncate min-w-0"
            title={href}
          >
            {result.title}
          </a>
        ) : (
          <span className="text-[13px] text-[#444] dark:text-[#CCC] truncate min-w-0">{result.title}</span>
        )}
        {host && <span className="shrink-0 text-[11.5px] text-[#A0A0A0] dark:text-[#777] tabular-nums">{host}</span>}
        {date && <span className="shrink-0 text-[11.5px] text-[#B8B8B8] dark:text-[#666] tabular-nums">{date}</span>}
        {result.highlights && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto shrink-0 text-[#B0B0B0] dark:text-[#777] hover:text-[#666] dark:hover:text-[#AAA] transition-colors"
            aria-label="toggle highlights"
          >
            {open ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
          </button>
        )}
      </div>
      {open && result.highlights && (
        <div className="mt-1 text-[12.5px] leading-[1.55] text-[#777] dark:text-[#999] whitespace-pre-wrap">
          {result.highlights}
        </div>
      )}
    </div>
  );
}

export function ExaResults({ text }: { text: string }) {
  const results = useMemo(() => parseExaResults(text), [text]);
  if (results.length === 0) return <MarkdownRenderer>{text}</MarkdownRenderer>;
  return (
    <div data-testid="exa-results">
      {results.map((r) => (
        <ExaResultRow key={`${r.url ?? ''}|${r.title}`} result={r} />
      ))}
    </div>
  );
}
