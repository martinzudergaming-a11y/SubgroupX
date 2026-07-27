import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LazyMotion, domAnimation, m, AnimatePresence } from "motion/react";
import { PanelLeft, PanelRight, Bug, FoldHorizontal, UnfoldHorizontal } from "lucide-react";
import { type WsState } from "../../platform/ws.ts";
import { useT } from "../../i18n";
import { SandboxSwitcher } from "./SandboxSwitcher";
import type { TranslationKey } from "../../i18n/en";
import { AdminDebugger } from "../debug/AdminDebugger";
import type { BackgroundTask } from "../../platform/background-tasks.ts";
import type { SandboxKind, SessionEgress } from "@shared/protocol";
import { useOutsideClose } from "../ui/use-outside-close";
import { StatusDot, type StatusTone } from "../../ui/StatusDot";
import { HoverLabel } from "../ui/HoverLabel";
import { RuntimeTargetMark } from "./RuntimeTargetMark";

const NO_BG_TASKS: BackgroundTask[] = [];

const WS_LABEL_KEY: Record<WsState, TranslationKey> = {
  open: "ws.open",
  connecting: "ws.connecting",
  reconnecting: "ws.reconnecting",
  offline: "ws.offline",
};

const WS_BADGE: Record<WsState, { tone: StatusTone; box: string; pulse: boolean }> = {
  open: { tone: "live", box: "bg-[#EEF8F1] text-[#177245] dark:bg-[#1F3326] dark:text-[#9FE0B9]", pulse: false },
  connecting: { tone: "working", box: "bg-[#FBF3E7] text-[#9A6213] dark:bg-[#33291A] dark:text-[#E0B97F]", pulse: true },
  reconnecting: { tone: "working", box: "bg-[#FBF3E7] text-[#9A6213] dark:bg-[#33291A] dark:text-[#E0B97F]", pulse: true },
  offline: { tone: "muted", box: "bg-[#F5F5F5] text-[#777] dark:bg-[#2A2A2A] dark:text-[#999]", pulse: false },
};

export interface SandboxLoad {
  cpuPct: number;
  memUsed: number;
  memTotal: number;
}

const SPARK_W = 44;
const SPARK_H = 14;
const SPARK_N = 28;

function loadColor(cpuPct: number): string {
  return cpuPct >= 80 ? "#C2410C" : cpuPct >= 50 ? "#C77D2E" : "#22A06B";
}

const EGRESS_UI: Record<SessionEgress["state"], { key: TranslationKey; tone: StatusTone; chip: string }> = {
  direct: { key: "egress.direct", tone: "idle", chip: "text-[#888] dark:text-[#999]" },
  proxy: { key: "egress.proxy", tone: "live", chip: "bg-[#E7F7F0] dark:bg-[#10331F] text-[#0E9F6E] dark:text-[#5FD0A0]" },
  proxy_invalid: { key: "egress.proxyInvalid", tone: "working", chip: "bg-[#FCF3DD] dark:bg-[#3A2E0E] text-[#A77A06] dark:text-[#E0B84A]" },
  jump_only: { key: "egress.jumpOnly", tone: "info", chip: "bg-[#ECF1F8] dark:bg-[#202A3A] text-[#44618F] dark:text-[#93ABD1]" },
};

function LoadIndicator({ load, kind, egress }: { load: SandboxLoad; kind?: SandboxKind; egress?: SessionEgress }) {
  const t = useT();
  const [hist, setHist] = useState<number[]>([load.cpuPct]);
  const [lastLoad, setLastLoad] = useState(load);
  if (load !== lastLoad) {
    setLastLoad(load);
    setHist((h) => [...h, load.cpuPct].slice(-SPARK_N));
  }
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, () => setOpen(false), open);

  const n = hist.length;
  const px = (i: number) => (n <= 1 ? SPARK_W : (i / (n - 1)) * SPARK_W);
  const py = (v: number) => SPARK_H - (Math.min(100, Math.max(0, v)) / 100) * SPARK_H;
  const line = hist.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const color = loadColor(load.cpuPct);
  const memMb = Math.round(load.memUsed / 1048576);
  const memTotalMb = Math.round(load.memTotal / 1048576);
  const memPct = load.memTotal ? Math.round((load.memUsed / load.memTotal) * 100) : 0;
  const envLabel = kind ? t(`sandbox.kind.${kind}`) : t("perf.envLocal");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="sandbox-load"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${t("ws.open")} · ${envLabel} · CPU ${load.cpuPct}% · ${t("perf.memory")} ${memMb}/${memTotalMb} MB`}
        title={`${t("ws.open")} · ${envLabel} · CPU ${load.cpuPct}% · ${t("perf.memory")} ${memMb}/${memTotalMb} MB`}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md font-mono text-[10.5px] tabular-nums text-[#888] dark:text-[#999] select-none transition-colors ${open ? "bg-[#ECECEC] dark:bg-[#333]" : "bg-[#F7F7F7] dark:bg-[#262626] hover:bg-[#EFEFEF] dark:hover:bg-[#2E2E2E]"}`}
      >

        <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} className="hidden sm:block">
          {n > 1 && <polygon points={`0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`} fill={color} fillOpacity="0.14" />}
          {n > 1 && (
            <polyline points={line} fill="none" stroke={color} strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" />
          )}
          <circle cx={px(n - 1)} cy={py(load.cpuPct)} r="1.4" fill={color} />
        </svg>

        <span style={{ color }} className="inline-block min-w-[4ch] text-right">{load.cpuPct}%</span>
        <span className="hidden sm:inline text-[#C4C4C4] dark:text-[#555]">·</span>
        <span className="hidden sm:inline">{memMb}M</span>
        {egress && egress.state !== "direct" && (
          <span className={`ml-0.5 px-1 py-px rounded text-[9.5px] leading-none ${EGRESS_UI[egress.state].chip}`}>
            {t(EGRESS_UI[egress.state].key)}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="absolute right-0 mt-2 w-[252px] z-50 rounded-xl border border-[#ECECEC] dark:border-[#333] bg-white dark:bg-[#1E1E1E] oiia-shadow-pop p-3.5 origin-top-right"
            data-testid="perf-panel"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[12.5px] font-medium text-[#333] dark:text-[#E0E0E0]">{envLabel}</span>
              <span className="size-2 rounded-full" style={{ background: color }} />
            </div>
            <svg width="100%" height="40" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className="block mb-3 rounded">
              {n > 1 && <polygon points={`0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`} fill={color} fillOpacity="0.14" />}
              {n > 1 && (
                <polyline points={line} fill="none" stroke={color} strokeWidth="0.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            <div className="flex items-center justify-between text-[12px] mb-1.5">
              <span className="text-[#888] dark:text-[#999]">CPU</span>
              <span className="font-mono tabular-nums font-medium" style={{ color }}>{load.cpuPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#F0F0F0] dark:bg-[#2A2A2A] overflow-hidden mb-3">
              <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, load.cpuPct)}%`, background: color }} />
            </div>
            <div className="flex items-center justify-between text-[12px] mb-1.5">
              <span className="text-[#888] dark:text-[#999]">{t("perf.memory")}</span>
              <span className="font-mono tabular-nums text-[#555] dark:text-[#BBB]">{memMb} / {memTotalMb} MB</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#F0F0F0] dark:bg-[#2A2A2A] overflow-hidden">
              <div className="h-full rounded-full bg-[#6B8AFD] transition-[width] duration-300" style={{ width: `${memPct}%` }} />
            </div>
            {egress && (
              <div className="mt-3 pt-3 border-t border-[#F0F0F0] dark:border-[#2E2E2E]">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-[#888] dark:text-[#999]">{t("egress.title")}</span>
                  <span className="flex items-center gap-1.5 font-medium text-[#555] dark:text-[#BBB]">
                    <StatusDot tone={EGRESS_UI[egress.state].tone} />
                    {t(EGRESS_UI[egress.state].key)}
                  </span>
                </div>
                {egress.detail && (
                  <div className="mt-1 font-mono text-[11px] text-[#999] dark:text-[#777] truncate" title={egress.detail}>
                    {egress.detail}
                  </div>
                )}
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BackgroundTasksIndicator({ tasks, onSelect }: { tasks: BackgroundTask[]; onSelect?: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, () => setOpen(false), open);

  if (tasks.length === 0) {
    if (open) setOpen(false);
    return null;
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="bg-tasks"
        onClick={() => setOpen((o) => !o)}
        title={t("bg.title")}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] tabular-nums select-none transition-colors text-[#44618F] dark:text-[#93ABD1] ${open ? "bg-[#E7EDF6] dark:bg-[#202A3A]" : "bg-[#ECF1F8] dark:bg-[#1B2433] hover:bg-[#E3EAF4] dark:hover:bg-[#202A3A]"}`}
      >
        <StatusDot tone="info" ping />
        {t("bg.running", { count: tasks.length })}
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="absolute right-0 mt-2 w-[248px] z-50 rounded-xl border border-[#ECECEC] dark:border-[#333] bg-white dark:bg-[#1E1E1E] oiia-shadow-pop p-1.5 origin-top-right"
            data-testid="bg-tasks-panel"
          >
            <div className="px-2 py-1.5 text-[11px] font-medium text-[#999] dark:text-[#777]">{t("bg.title")}</div>
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => {
                  onSelect?.(task.id);
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] transition-colors"
              >
                <StatusDot tone="info" ping />
                <span className="min-w-0 truncate text-[12.5px] text-[#333] dark:text-[#E0E0E0]">{task.title}</span>
              </button>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OverflowMenu({ isAdmin, activeSessionId, sandboxKind, sandboxHost, sessionRunning, onSetSandbox }: {
  isAdmin?: boolean;
  activeSessionId?: string | null;
  sandboxKind?: SandboxKind;
  sandboxHost?: string | null;
  sessionRunning?: boolean;
  onSetSandbox?: (kind: SandboxKind, targetId: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, () => setOpen(false), open);

  const canInspect = Boolean(isAdmin && activeSessionId);
  const canSwitch = Boolean(activeSessionId && sandboxKind && onSetSandbox);
  const hasMenu = canInspect || canSwitch;
  const menuLabel = canSwitch ? "nav.runtimeTarget" : "nav.moreOptions";

  useEffect(() => {
    setOpen(false);
    setInspectorOpen(false);
  }, [activeSessionId]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)
          ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  if (!hasMenu) return null;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="overflow-menu"
        aria-label={t(menuLabel)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="top-header-overflow-panel"
        onClick={() => setOpen((o) => !o)}
        className="group/hoverlabel relative p-2.5 md:p-1.5 min-h-10 min-w-10 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] cursor-pointer text-[#777] dark:text-[#A0A0A0] transition-colors"
      >
        <RuntimeTargetMark className="size-[15px]" />
        <HoverLabel label={t(menuLabel)} />
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            ref={panelRef}
            id="top-header-overflow-panel"
            role="dialog"
            aria-label={t(menuLabel)}
            onKeyDown={moveFocus}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="absolute right-0 mt-2 w-[232px] z-50 rounded-xl border border-[#ECECEC] dark:border-[#333] bg-white dark:bg-[#1E1E1E] oiia-shadow-pop p-1.5 origin-top-right"
            data-testid="overflow-menu-panel"
          >
            {canSwitch && sandboxKind && onSetSandbox && (
              <SandboxSwitcher
                currentKind={sandboxKind}
                currentTargetId={sandboxHost}
                disabled={sessionRunning}
                onSwitch={(kind, targetId) => { setOpen(false); onSetSandbox(kind, targetId); }}
              />
            )}
            {canInspect && (
              <>
                {canSwitch && <div className="my-1 h-px bg-[#EEE] dark:bg-[#2C2C2C]" />}
                <div className="px-2 py-1.5 text-[11px] font-medium text-[#999] dark:text-[#777]">{t("admin.menu.title")}</div>
                <button
                  type="button"
                  data-testid="admin-inspector-open"
                  onClick={() => {
                    triggerRef.current?.focus({ preventScroll: true });
                    setOpen(false);
                    setInspectorOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] transition-colors text-[12.5px] text-[#333] dark:text-[#E0E0E0]"
                >
                  <Bug strokeWidth={1.5} className="size-[14px] text-[#777] dark:text-[#A0A0A0]" />
                  {t("admin.menu.inspector")}
                </button>
              </>
            )}
          </m.div>
        )}
      </AnimatePresence>

      {inspectorOpen && activeSessionId && (
        <AdminDebugger sessionId={activeSessionId} onClose={() => setInspectorOpen(false)} />
      )}
    </div>
  );
}

export function TopHeader({
  title,
  wsState = "offline",
  sandboxLoad,
  sandboxKind,
  sandboxHost,
  sessionRunning,
  onSetSandbox,
  egress,
  backgroundTasks = NO_BG_TASKS,
  onSelectBackground,
  onOpenLeftSidebar,
  isLeftSidebarOpen,
  onToggleRightSidebar,
  isRightSidebarOpen,
  wideMode,
  onToggleWideMode,
  isAdmin,
  activeSessionId,
}: {
  title?: string;
  wsState?: WsState;
  sandboxLoad?: SandboxLoad | null;
  sandboxKind?: SandboxKind;
  sandboxHost?: string | null;
  sessionRunning?: boolean;
  onSetSandbox?: (kind: SandboxKind, targetId: string | null) => void;
  egress?: SessionEgress;
  backgroundTasks?: BackgroundTask[];
  onSelectBackground?: (id: string) => void;
  onOpenLeftSidebar?: () => void;
  isLeftSidebarOpen?: boolean;
  onToggleRightSidebar?: () => void;
  isRightSidebarOpen?: boolean;
  wideMode?: boolean;
  onToggleWideMode?: () => void;
  isAdmin?: boolean;
  activeSessionId?: string | null;
}) {
  const t = useT();
  const badge = WS_BADGE[wsState];
  return (
    <LazyMotion features={domAnimation}>
    <div data-testid="top-header" className="relative flex items-center justify-between h-[48px] px-4 shrink-0 border-b border-[#F0F0F0] dark:border-[#333] w-full min-w-0">
      <div className="flex min-w-0 flex-1 items-center text-[#111] dark:text-[#E0E0E0] font-medium text-[13.5px]">
        {!isLeftSidebarOpen && (
          <button
            type="button"
            onClick={onOpenLeftSidebar}
            aria-label={t("nav.openSidebar")}
            className="group/hoverlabel relative p-2.5 md:p-1.5 min-h-10 min-w-10 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] cursor-pointer text-[#777] dark:text-[#A0A0A0] transition-colors mr-2 shrink-0"
          >
            <PanelLeft strokeWidth={1.5} className="size-[15px]" />
            <HoverLabel label={t("nav.openSidebar")} />
          </button>
        )}
        <span data-testid="session-title" className="min-w-0 truncate max-w-[400px]">{title || t("session.untitled")}</span>
      </div>

      <div className="flex shrink-0 items-center gap-x-2">
        <BackgroundTasksIndicator tasks={backgroundTasks} onSelect={onSelectBackground} />

        {wsState === "open" && sandboxLoad && (
          <LoadIndicator load={sandboxLoad} kind={sandboxKind} egress={egress} />
        )}

        <span
          data-testid="ws-badge"
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md ${badge.box} ${
            wsState === "open" && sandboxLoad ? "hidden" : ""
          }`}
        >
          <StatusDot tone={badge.tone} pulse={badge.pulse} />
          {t(WS_LABEL_KEY[wsState])}
        </span>

        <OverflowMenu
          isAdmin={isAdmin}
          activeSessionId={activeSessionId}
          sandboxKind={sandboxKind}
          sandboxHost={sandboxHost}
          sessionRunning={sessionRunning}
          onSetSandbox={onSetSandbox}
        />

        {onToggleWideMode && (
          <button
            type="button"
            onClick={onToggleWideMode}
            aria-label={t(wideMode ? "nav.narrowColumn" : "nav.widenColumn")}
            aria-pressed={wideMode}
            className={`group/hoverlabel relative hidden lg:flex p-1.5 items-center justify-center rounded-md cursor-pointer transition-colors hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] ${wideMode ? 'text-[#111] dark:text-[#E0E0E0]' : 'text-[#777] dark:text-[#A0A0A0]'}`}
          >
            {wideMode
              ? <FoldHorizontal strokeWidth={1.5} className="size-[15px]" />
              : <UnfoldHorizontal strokeWidth={1.5} className="size-[15px]" />}
            <HoverLabel label={t(wideMode ? "nav.narrowColumn" : "nav.widenColumn")} />
          </button>
        )}
        <button
          type="button"
          onClick={onToggleRightSidebar}
          aria-label={t("nav.toggleDetails")}
          aria-pressed={isRightSidebarOpen}
          className={`group/hoverlabel relative p-2.5 md:p-1.5 min-h-10 min-w-10 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md cursor-pointer transition-colors hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] ${isRightSidebarOpen ? 'text-[#111] dark:text-[#E0E0E0]' : 'text-[#777] dark:text-[#A0A0A0]'}`}
        >
          <PanelRight strokeWidth={1.5} className="size-[15px]" />
          <HoverLabel label={t("nav.toggleDetails")} />
        </button>
      </div>
    </div>
    </LazyMotion>
  );
}
