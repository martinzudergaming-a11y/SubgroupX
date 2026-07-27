import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../ui/Spinner";
import { Paperclip, ExternalLink, AlertCircle, Ban, EyeOff, Loader2, Link2, Check, ChevronRight, ChevronDown, RotateCw, List } from "lucide-react";
import type { ShareItem, SharePayload } from "@shared/share-protocol";
import { groupConversationTurns } from "@shared/conversation-model";
import MarkdownRenderer from "../conversation/markdown/MarkdownRenderer";
import { ToolStatus } from "../conversation/tools/tool-presentation";
import { toolIcon, toolLabel, formatDuration, type ToolItem } from "../conversation/tools/tool-presentation-helpers";
import { writeClipboard } from "../platform/clipboard";
import { useT, type TFunction } from "../i18n";
import { relativeShareTime } from "./relative-time";
import { useCopyFlag } from "../ui/useCopyFlag";
import { PRODUCT_NAME } from "../platform/brand";

type State = { phase: "loading" } | { phase: "error" } | { phase: "ready"; data: SharePayload };

const TOKEN_RE = /^\/share\/([A-Za-z0-9_-]{16,43})\/?$/;

export function SharedView() {
  const t = useT();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const m = TOKEN_RE.exec(window.location.pathname);
    if (!m) {
      setState({ phase: "error" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    const BACKOFFS_MS = [600, 1200, 2400, 4800];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      fetch(`/api/share/${m[1]}`, { headers: { accept: "application/json" } })
        .then(async (r) => {
          if (!r.ok) {
            const err = new Error(String(r.status)) as Error & { permanent?: boolean };
            err.permanent = r.status >= 400 && r.status < 500;
            throw err;
          }
          return (await r.json()) as SharePayload;
        })
        .then((data) => !cancelled && setState({ phase: "ready", data }))
        .catch((e: Error & { permanent?: boolean }) => {
          if (cancelled) return;
          if (!e.permanent && n < BACKOFFS_MS.length) {
            timer = setTimeout(() => attempt(n + 1), BACKOFFS_MS[n]);
            return;
          }
          setState({ phase: "error" });
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reloadKey]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const title = state.data.title?.trim();
    document.title = title ? `${title} · ${PRODUCT_NAME}` : `Shared transcript · ${PRODUCT_NAME}`;
  }, [state]);

  if (state.phase === "loading") {
    return (
      <CenterCard>
        <Spinner className="w-5 h-5 text-[var(--sh-muted)]" strokeWidth={2} />
        <span className="text-[13px] text-[var(--sh-muted)]">{t("share.loading")}</span>
      </CenterCard>
    );
  }
  if (state.phase === "error") {
    return (
      <CenterCard>
        <Ban className="w-6 h-6 text-[var(--sh-faint)]" />
        <div className="text-[15px] font-medium text-[var(--sh-fg)]">{t("share.unavailableTitle")}</div>
        <div className="text-[13px] text-[var(--sh-muted)]">{t("share.unavailableBody")}</div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex items-center gap-1 text-[12.5px] text-[var(--sh-muted)] hover:text-[var(--sh-fg)] transition-colors"
          >
            <RotateCw className="w-3 h-3" />
            {t("share.retry")}
          </button>
          <OpenAppLink t={t} />
        </div>
      </CenterCard>
    );
  }
  return <Transcript data={state.data} t={t} />;
}

function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-3 px-6 text-center bg-[var(--sh-bg)]">
      {children}
    </div>
  );
}

function OpenAppLink({ t, className }: { t: TFunction; className?: string }) {
  return (
    <a
      href={typeof window !== "undefined" ? window.location.origin : "/"}
      target="_top"
      className={
        className ??
        "inline-flex items-center gap-1 text-[12.5px] text-[var(--sh-muted)] hover:text-[var(--sh-fg)] transition-colors"
      }
    >
      {t("share.openApp")}
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function formatContextWindow(window?: number): string | null {
  if (!window || window <= 0) return null;
  if (window >= 1_000_000 && window % 1_000_000 === 0) return `${window / 1_000_000}M`;
  if (window >= 1000) return `${Math.round(window / 1000)}K`;
  return String(window);
}

function CopyLinkButton({ t }: { t: TFunction }) {
  const { copied, flash } = useCopyFlag(1400);
  const copy = useCallback(async () => {
    const ok = await writeClipboard(window.location.href);
    if (!ok) return;
    flash();
  }, [flash]);
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="share-copy-link"
      className="inline-flex items-center gap-1 text-[12.5px] text-[var(--sh-muted)] hover:text-[var(--sh-fg)] transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-[#177245] dark:text-[#9FE0B9]" /> : <Link2 className="w-3 h-3" />}
      {copied ? t("share.linkCopied") : t("share.copyLink")}
    </button>
  );
}

function Transcript({ data, t }: { data: SharePayload; t: TFunction }) {
  const title = data.title?.trim() || t("share.untitled");
  const modelLabel = [data.meta.provider, data.meta.model].filter(Boolean).join("/");
  const contextWindow = formatContextWindow(data.meta.contextWindow);
  const metaBits: string[] = [];
  if (modelLabel) metaBits.push(modelLabel);
  if (contextWindow) metaBits.push(t("share.contextWindow", { window: contextWindow }));
  if (data.meta.reasoning) metaBits.push(t("share.extendedThinking"));
  metaBits.push(relativeShareTime(data.createdAt, t));
  return (
    <div className="min-h-[100dvh] bg-[var(--sh-bg)] text-[var(--sh-fg)]">

      <div className="border-b border-[var(--sh-line)]">
        <div className="mx-auto max-w-[768px] px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-semibold tracking-tight text-[15px]">{PRODUCT_NAME}</span>
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-[var(--sh-line-strong)] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--sh-muted)]">
              <EyeOff className="w-2.5 h-2.5" />
              {t("share.badge")}
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <CopyLinkButton t={t} />
            <OpenAppLink t={t} />
          </div>
        </div>
      </div>

      <header className="mx-auto max-w-[768px] px-5 pt-12 sm:pt-16 pb-9 text-center">
        <h1 className="text-[25px] sm:text-[31px] font-semibold tracking-[-0.02em] leading-[1.18] text-[var(--sh-title)] text-balance">
          {title}
        </h1>
        <div
          className="mt-3.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px] text-[var(--sh-muted)]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {metaBits.map((bit, i) => (
            <span key={i} className="inline-flex items-center gap-2">
              {i > 0 && <span className="text-[var(--sh-faint)]">·</span>}
              {bit}
            </span>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-[768px] px-5 pb-20 space-y-6">

        {data.meta.scope === "selected" ? (
          data.truncated ? (
            <div className="rounded-md bg-amber-50 dark:bg-amber-900/15 border border-amber-200/60 dark:border-amber-800/40 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
              {t("share.scope.selectedBanner", { n: data.items.length })}
            </div>
          ) : (
            <div className="rounded-md bg-blue-50 dark:bg-blue-900/15 border border-blue-200/60 dark:border-blue-800/40 px-3 py-2 text-[12px] text-blue-800 dark:text-blue-300">
              {t("share.scope.selectedBanner", { n: data.items.length })}
            </div>
          )
        ) : (
          data.truncated && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-900/15 border border-amber-200/60 dark:border-amber-800/40 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
              {t("share.truncated", { shown: data.items.length, total: data.originalCount })}
            </div>
          )
        )}
        {data.items.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-[var(--sh-muted)]">{t("share.empty")}</div>
        ) : (
          buildSharedRenderItems(data.items).map((ri) => (
            <div key={ri.id} id={`sh-${ri.id}`} className="scroll-mt-6">
              {ri.kind === "toolGroup" ? <ToolGroup group={ri} t={t} /> : <ShareItemView item={ri} t={t} />}
            </div>
          ))
        )}
        <footer className="mt-12 pt-6 border-t border-[var(--sh-line)] flex items-center justify-center gap-2 text-[12px] text-[var(--sh-muted)]">
          <span>{t("share.footer")}</span>
          <span className="text-[var(--sh-faint)]">·</span>
          <OpenAppLink t={t} className="inline-flex items-center gap-1 text-[12px] text-[var(--sh-muted)] hover:text-[var(--sh-fg)] transition-colors" />
        </footer>
      </main>

      <ShareOutline
        entries={groupConversationTurns(data.items).flatMap((turn) => {
          const user = turn.items.find((item): item is Extract<ShareItem, { kind: "user" }> => item.kind === "user");
          return user ? [{ id: user.id, text: user.text }] : [];
        })}
        t={t}
      />
    </div>
  );
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? text).trim();
}

function ShareOutline({ entries, t }: { entries: { id: string; text: string }[]; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const update = () => {
      rafRef.current = null;
      const centre = window.innerHeight / 2;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const e of entries) {
        const el = document.getElementById(`sh-${e.id}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - centre);
        if (d < bestDist) { bestDist = d; best = e.id; }
      }
      if (best) setActiveId(best);
    };
    const onScroll = () => { if (rafRef.current == null) rafRef.current = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [entries]);
  if (entries.length <= 1) return null;
  const jump = (id: string) => {
    document.getElementById(`sh-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  };
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 pointer-events-none">
      {open && (
        <>
          <button type="button" aria-label={t("common.close")} className="fixed inset-0 z-40 cursor-default pointer-events-auto" onClick={() => setOpen(false)} />
          <nav
            aria-label={t("share.outline")}
            className="pointer-events-auto z-50 w-[min(22rem,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--sh-line-strong)] bg-[var(--sh-surface)] shadow-lg p-1 origin-bottom-right"
          >
            <div className="px-2.5 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--sh-muted)] select-none">{t("share.outline")}</div>
            {entries.map((e, i) => (
              <button
                key={e.id}
                type="button"
                aria-current={activeId === e.id ? "location" : undefined}
                onClick={() => jump(e.id)}
                title={firstLine(e.text)}
                className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  activeId === e.id
                    ? "bg-black/[0.05] dark:bg-white/[0.07] text-[var(--sh-fg)]"
                    : "text-[var(--sh-muted)] hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
                }`}
              >
                <span className="shrink-0 w-4 text-right text-[11px] tabular-nums text-[var(--sh-faint)]">{i + 1}</span>
                <span className="truncate text-[13px] leading-5">{firstLine(e.text)}</span>
              </button>
            ))}
          </nav>
        </>
      )}
      <button
        type="button"
        aria-label={t("share.outline")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto flex size-10 items-center justify-center rounded-full border border-[var(--sh-line-strong)] bg-[var(--sh-surface)]/95 backdrop-blur shadow-md text-[var(--sh-muted)] hover:text-[var(--sh-fg)] transition-colors"
      >
        <List className="size-[18px]" strokeWidth={1.75} />
      </button>
    </div>
  );
}

type ToolShareItem = Extract<ShareItem, { kind: "tool" }>;
type SharedRenderItem = ShareItem | { kind: "toolGroup"; id: string; tools: ToolShareItem[] };

function assistantHasVisibleText(item: Extract<ShareItem, { kind: "assistant" }>): boolean {
  return item.blocks.some((b) => b.type === "text" && b.text.trim().length > 0);
}

function buildSharedRenderItems(items: ShareItem[]): SharedRenderItem[] {
  const result: SharedRenderItem[] = [];
  let runItems: ShareItem[] = [];
  let runTools: ToolShareItem[] = [];
  const flush = () => {
    if (runTools.length >= 2) {
      result.push({ kind: "toolGroup", id: `tg-${runTools[0].id}-${runTools[runTools.length - 1].id}`, tools: runTools });
    } else {
      result.push(...runItems);
    }
    runItems = [];
    runTools = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      runItems.push(item);
      runTools.push(item);
      continue;
    }
    if (item.kind === "assistant" && !assistantHasVisibleText(item)) {
      runItems.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

function ToolGroup({ group, t }: { group: { id: string; tools: ToolShareItem[] }; t: TFunction }) {
  const [collapsed, setCollapsed] = useState(true);
  const n = group.tools.length;
  const failed = group.tools.filter(
    (x) => x.status === "error" || (x.outcome != null && ((x.outcome.exitCode != null && x.outcome.exitCode !== 0) || x.outcome.timedOut)),
  ).length;
  const running = group.tools.filter((x) => x.displayState === "runningAtShare").length;
  const durations = group.tools.map((x) => x.durationMs).filter((d): d is number => d != null);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  return (
    <div className="rounded-lg border border-[var(--sh-line)]">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-controls={`${group.id}-tools`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--sh-tool-label)] hover:bg-[var(--sh-hover)] rounded-lg transition-colors"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-60" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />}
        <span className="font-medium">{t(collapsed ? "share.toolGroup.show" : "share.toolGroup.hide", { n })}</span>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-[#9A3333] dark:text-[#E89B9B]">
            <AlertCircle className="w-3 h-3" />
            {t("share.toolGroup.failed", { n: failed })}
          </span>
        )}
        {running > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--sh-muted)]">
            <Loader2 className="w-3 h-3" />
            {t("share.toolGroup.running", { n: running })}
          </span>
        )}
        {durations.length > 0 && (
          <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-[var(--sh-faint)]">{formatDuration(totalMs)}</span>
        )}
      </button>
      {!collapsed && (
        <div id={`${group.id}-tools`} className="px-2 pb-2 space-y-2">
          {group.tools.map((tool) => (
            <ToolRow key={tool.id} item={tool} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ShareItemView({ item, t }: { item: ShareItem; t: TFunction }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="rounded-xl bg-[var(--sh-surface-2)] border border-[var(--sh-surface-border)] px-4 py-3">
          <div className="prose-chat text-[14.5px] leading-relaxed">
            <MarkdownRenderer>{item.text}</MarkdownRenderer>
          </div>
          {item.attachments && item.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.attachments.map((a, i) => (
                <span
                  key={`${a.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--sh-surface)] px-1.5 py-0.5 text-[11.5px] text-[var(--sh-muted)]"
                >
                  <Paperclip className="w-3 h-3" />
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      );

    case "assistant":
      return (
        <div className="prose-chat text-[14px] leading-relaxed">
          {item.blocks.map((b, i) =>
            b.type === "text" ? (
              <MarkdownRenderer key={i}>{b.text}</MarkdownRenderer>
            ) : b.type === "thinking" ? (
              <div key={i} className="my-1.5 border-l-2 border-[var(--sh-line)] pl-3 text-[12.5px] italic text-[var(--sh-muted)] whitespace-pre-wrap break-words">
                {b.text}
              </div>
            ) : null,
          )}
        </div>
      );

    case "tool":
      return <ToolRow item={item} t={t} />;

    case "error":
      return (
        <div className="flex items-start gap-2 rounded-md border border-red-200/60 dark:border-red-900/40 bg-red-50 dark:bg-red-900/15 px-3 py-2 text-[13px] text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{item.message}</span>
        </div>
      );

    case "interrupted":
      return (
        <div className="text-center text-[11.5px] text-[var(--sh-muted)] py-1">— interrupted —</div>
      );

    case "compaction":
      return (
        <div
          className="flex items-center gap-3 py-1.5 text-[11.5px] text-[var(--sh-muted)] select-none"
          aria-label={t("share.compacted", { n: item.summarizedCount })}
        >
          <span className="h-px flex-1 bg-[var(--sh-surface-border)]" />
          <span className="shrink-0">{t("share.compacted", { n: item.summarizedCount })}</span>
          <span className="h-px flex-1 bg-[var(--sh-surface-border)]" />
        </div>
      );

    default: {
      const _never: never = item;
      void _never;
      return null;
    }
  }
}

function ToolRow({ item, t }: { item: Extract<ShareItem, { kind: "tool" }>; t: TFunction }) {
  const label = toolLabel(item as unknown as ToolItem, t);
  const [showOut, setShowOut] = useState(false);
  const hasOutput = typeof item.resultText === "string" && item.resultText.length > 0;
  return (
    <div className="rounded-lg bg-[var(--sh-surface)] px-3 py-2">
      <div className="flex items-center text-[13px] text-[var(--sh-tool-label)]">
        {toolIcon(item.toolKind)}
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        {item.outcome && (
          <span className="ml-2 shrink-0 text-[11.5px] tabular-nums text-[var(--sh-muted)]">
            exit {item.outcome.exitCode}
            {item.outcome.timedOut ? " · timed out" : ""}
            {item.outcome.truncated ? " · truncated" : ""}
          </span>
        )}
        {item.durationMs != null && (
          <span className="ml-2 shrink-0 text-[11.5px] tabular-nums text-[var(--sh-faint)]">
            {formatDuration(item.durationMs)}
          </span>
        )}
        <ToolStatus status={item.status} termination={item.termination} />
      </div>

      {hasOutput ? (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowOut((v) => !v)}
            aria-expanded={showOut}
            className="flex items-center gap-1 text-[11.5px] text-[var(--sh-muted)] hover:text-[var(--sh-tool-label)] transition-colors"
          >
            {showOut ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t(showOut ? "share.hideOutput" : "share.showOutput")}
          </button>
          {showOut && (
            <pre className="mt-1 max-h-[420px] overflow-auto rounded-md bg-[var(--sh-code-bg,rgba(0,0,0,0.04))] px-2.5 py-2 text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-[var(--sh-tool-label)]">
              {item.resultText}
            </pre>
          )}
        </div>
      ) : item.displayState === "completedOutputHidden" ? (
        <div className="mt-1 flex items-center gap-1 text-[11.5px] text-[var(--sh-muted)]">
          <EyeOff className="w-3 h-3" />
          {t("share.outputHidden")}
        </div>
      ) : null}
      {item.displayState === "runningAtShare" && (
        <div className="mt-1 flex items-center gap-1 text-[11.5px] text-[var(--sh-muted)]">
          <Loader2 className="w-3 h-3" />
          {t("share.runningAtShare")}
        </div>
      )}

      {item.children && item.children.length > 0 && (
        <div className="mt-2 space-y-2 border-l-2 border-[var(--sh-line)] pl-3">
          {item.children.map((c) => (
            <ShareItemView key={c.id} item={c} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
