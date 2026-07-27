import { memo, useCallback, useRef, useState } from "react";
import { InstallAppDialog } from "./InstallAppDialog.tsx";
import { IS_STANDALONE } from "../../platform/pwa.ts";
import {
  Search, Box, Clock, LayoutGrid, Waypoints, Settings, PanelLeft, Plus, LogOut, Pencil, SquareTerminal, Share2, Activity, ChevronsUpDown, ArrowUpRight, BookOpenText, CircleHelp, Compass, Download, Keyboard
} from "lucide-react";
import { Menu, MenuItem, MenuDivider } from "../ui/Menu";
import type { ViewType } from "../types";
import type { SessionInfo, SessionStatus } from "@shared/protocol";
import { SessionKindStatus } from "../ui/SandboxKindBadge";
import { type WsState, type UpdateAvailable } from "../../platform/ws.ts";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n/en";
import { StatusDot, type StatusTone } from "../../ui/StatusDot";
import { Link } from "../../platform/router";
import { VIEW_PATH } from "../nav";
import { useOutsideClose } from "../ui/use-outside-close";
import { PRODUCT_NAME, REPO_URL } from "../../platform/brand";
import { BLOG_PATH } from "../../platform/blog-route";
import { GithubMark } from "../../ui/GithubMark";
import { INTERNAL_BLOG_ENABLED } from "../../platform/internal-features";

const WS_DOT: Record<WsState, { tone: StatusTone; pulse?: boolean }> = {
  open: { tone: "live" },
  connecting: { tone: "working", pulse: true },
  reconnecting: { tone: "working", pulse: true },
  offline: { tone: "muted" },
};

const WS_LABEL_KEY: Record<WsState, TranslationKey> = {
  open: "ws.open",
  connecting: "ws.connecting",
  reconnecting: "ws.reconnecting",
  offline: "ws.offline",
};

const SIDEBAR_ROW_BASE = "w-full text-left flex items-center gap-x-2.5 px-2.5 py-[6px] rounded-md cursor-pointer transition-colors";
const sidebarRowTone = (active?: boolean) => active
  ? "bg-black/[0.09] dark:bg-white/[0.09] text-[#111] dark:text-[#FFF] font-medium"
  : "hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[#444] dark:text-[#D0D0D0]";

export function LeftSidebar({
  onClose,
  userEmail,
  sessions,
  sessionsLoaded,
  sessionHydrationVisible,
  activeSessionId,
  wsState,
  currentView,
  onCurrentViewChange,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onShareSession,
  onNewSession,
  onLogout,
  onOpenShortcuts,
  update,
  onReload,
}: {
  onClose?: () => void,
  userEmail: string,
  sessions: SessionInfo[],
  sessionsLoaded: boolean,
  sessionHydrationVisible: boolean,
  activeSessionId: string | null,
  wsState: WsState,
  currentView: ViewType,
  onCurrentViewChange: (view: ViewType) => void,
  onSelectSession: (session: SessionInfo) => void,
  onDeleteSession: (id: string, e: React.MouseEvent) => void,
  onRenameSession: (id: string, title: string) => void,
  onShareSession?: (id: string) => void,
  onNewSession: () => void,
  onLogout: () => void,
  onOpenShortcuts: () => void,
  update?: UpdateAvailable | null,
  onReload?: () => void,
}) {
  const t = useT();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  useOutsideClose(accountRef, () => setAccountMenuOpen(false), accountMenuOpen);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  useOutsideClose(helpRef, () => setHelpMenuOpen(false), helpMenuOpen);
  const closeHelpMenuAndRestoreFocus = useCallback(() => {
    setHelpMenuOpen(false);
    requestAnimationFrame(() => helpTriggerRef.current?.focus({ preventScroll: true }));
  }, []);
  const closeAccountMenuAndRestoreFocus = useCallback(() => {
    setAccountMenuOpen(false);
    requestAnimationFrame(() => accountTriggerRef.current?.focus({ preventScroll: true }));
  }, []);
  const agentWorking = sessions.some((s) => s.status === "running");
  return (
    <div className="w-full shrink-0 bg-[var(--app-frame)] dark:bg-[#1E1E1E] h-full flex flex-col text-[13.5px] text-[#333] dark:text-[#E0E0E0] select-none font-sans">
      <div className="px-3 pt-3 flex items-center justify-between">

        <div className="flex items-center gap-2 min-w-0 pl-1.5">
          <span className="size-[12px] rotate-45 rounded-[2px] bg-[#ff003c] shrink-0" aria-hidden />
          <span className="font-bold text-[12.5px] tracking-[0.05em] text-[#1A1A1A] dark:text-[#EDEDED] select-none shrink-0">
            SUBGROUP<span className="text-[#0AA6B4] dark:text-[#00E5F0]">X</span>
          </span>

          <span className="w-px h-[13px] bg-black/[0.14] dark:bg-white/[0.16] shrink-0" aria-hidden />
          <span
            className={`brand-oiia ${agentWorking ? "is-working" : ""}`}
            title={agentWorking ? t("nav.agentWorking") : PRODUCT_NAME}
            aria-label={agentWorking ? t("nav.agentWorking") : PRODUCT_NAME}
          >
            {PRODUCT_NAME}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("nav.collapseSidebar")}
          className="p-1.5 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.06] cursor-pointer text-[#777] dark:text-[#A0A0A0] transition-colors shrink-0"
        >
          <PanelLeft strokeWidth={1.5} className="size-[15px]" />
        </button>
      </div>

      <div className="px-3 pt-3 pb-0 space-y-1">

        <SidebarItem
          icon={<SquareTerminal strokeWidth={1.5} className="size-[16px]" />}
          label={t("nav.terminal")}
          testId="open-terminal"
          isActive={currentView === 'shell'}
          onClick={() => onCurrentViewChange('shell')}
          href={VIEW_PATH.shell}
        />
        <SidebarItem
          icon={<Box strokeWidth={1.5} className="size-[16px]" />}
          label={t("nav.skills")}
          testId="open-skills"
          isActive={currentView === 'skills'}
          onClick={() => onCurrentViewChange('skills')}
          href={VIEW_PATH.skills}
        />
        <SidebarItem
          icon={<LayoutGrid strokeWidth={1.5} className="size-[16px]" />}
          label={t("nav.plugins")}
          testId="open-plugins"
          isActive={currentView === 'plugins'}
          onClick={() => onCurrentViewChange('plugins')}
          href={VIEW_PATH.plugins}
        />
        <SidebarItem
          icon={<Clock strokeWidth={1.5} className="size-[16px]" />}
          label={t("nav.automations")}
          testId="open-automations"
          isActive={currentView === 'automations'}
          onClick={() => onCurrentViewChange('automations')}
          href={VIEW_PATH.automations}
        />
        <Link
          to={VIEW_PATH.agents}
          data-testid="open-agents"
          onNavigate={() => onCurrentViewChange('agents')}
          className={`w-full flex items-center justify-between px-2.5 py-[5px] rounded-md cursor-pointer transition-colors ${currentView === 'agents' ? 'bg-black/[0.09] dark:bg-white/[0.09] text-[#111] dark:text-[#FFF] font-medium' : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[#444] dark:text-[#D0D0D0]'}`}
        >
          <span className="flex items-center gap-x-2.5">
            <span className={currentView === 'agents' ? 'text-[#333] dark:text-[#E0E0E0]' : 'text-[#666] dark:text-[#A0A0A0]'}>
              <Waypoints strokeWidth={1.5} className="size-[16px]" />
            </span>
            <span>{t("nav.agents")}</span>
          </span>
          <span className="flex size-4 items-center justify-center" title={t(WS_LABEL_KEY[wsState])}>
            <StatusDot tone={WS_DOT[wsState].tone} pulse={WS_DOT[wsState].pulse} />
          </span>
        </Link>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col mt-3">
        <div className="px-3 pl-5 py-2 font-medium text-[12px] text-[#888] dark:text-[#777] flex items-center justify-between">
          <span>{t("nav.sessions")}</span>
          <div className="flex items-center gap-1.5">

            <Link
              to={VIEW_PATH.search}
              onNavigate={() => onCurrentViewChange('search')}
              data-testid="open-search"
              aria-label={t("nav.search")}
              title={t("nav.search")}
              className="p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[#777] dark:text-[#999] transition-colors"
            >
              <Search className="size-[15px]" strokeWidth={1.75} />
            </Link>

            <button
              type="button"
              data-testid="new-session"
              aria-label={t("session.newAria")}
              title={t("session.newAria")}
              onClick={onNewSession}
              className="new-session shrink-0 flex items-center justify-center size-[26px] rounded-full bg-[#1A1A1A] dark:bg-[#EDEDED] text-white dark:text-[#1A1A1A] hover:bg-[#333] dark:hover:bg-white transition-colors shadow-sm"
            >
              <Plus className="size-[15px]" strokeWidth={2.4} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-6 space-y-[3px]">
          {!sessionsLoaded && (
            <div
              className={`px-2.5 py-[7px] space-y-3 transition-opacity duration-200 [transition-timing-function:cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none ${sessionHydrationVisible ? "opacity-100" : "opacity-0"}`}
              data-testid="session-list-hydration"
              data-visible={sessionHydrationVisible ? "true" : "false"}
              aria-hidden="true"
            >
              <div className="h-2 w-[58%] rounded-full bg-black/[0.055] dark:bg-white/[0.07]" />
              <div className="h-2 w-[72%] rounded-full bg-black/[0.045] dark:bg-white/[0.06]" />
              <div className="h-2 w-[46%] rounded-full bg-black/[0.04] dark:bg-white/[0.05]" />
            </div>
          )}
          {sessionsLoaded && sessions.length === 0 && (
            <div className="px-2.5 py-[7px] text-[12px] text-[#999] dark:text-[#888]">
              {t("sessions.empty")}
            </div>
          )}
          {sessionsLoaded && sessions.map((session) => (
            <SidebarListItem
              key={session.id}
              session={session}
              age={sessionAge(session.createdAt)}
              active={currentView === 'chat' && activeSessionId === session.id}
              onSelect={onSelectSession}
              onDelete={onDeleteSession}
              onRename={onRenameSession}
              onShare={onShareSession}
            />
          ))}
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[var(--app-frame)] dark:from-[#1E1E1E] to-transparent pointer-events-none"></div>
      </div>

      <div className="px-3 pb-3 pt-2 shrink-0 bg-[var(--app-frame)] dark:bg-[#1E1E1E] z-10 w-full relative space-y-1">

        {update && (
          <button
            type="button"
            data-testid="update-reload"
            onClick={onReload}
            className={`w-full flex items-center gap-x-2.5 px-2.5 py-[7px] rounded-md cursor-pointer transition-colors ${update.protocol
              ? 'bg-[#FBF1E0] dark:bg-[#2E2717] text-[#8A6516] dark:text-[#E0B463] hover:bg-[#F6E9CE] dark:hover:bg-[#382F1B]'
              : 'bg-[#EAF3EC] dark:bg-[#1C2A21] text-[#2F7D52] dark:text-[#79C39B] hover:bg-[#DDEDE1] dark:hover:bg-[#233529]'}`}
          >
            <StatusDot tone={update.protocol ? 'working' : 'live'} pulse />
            <span className="flex-1 text-left text-[13px] font-medium truncate">
              {update.protocol ? t('app.updateRequired') : t('app.updateAvailable')}
            </span>
            <span className="shrink-0 text-[11.5px] font-semibold opacity-80">{t('app.reload')}</span>
          </button>
        )}

        <div ref={helpRef} className="relative">
          <button
            ref={helpTriggerRef}
            type="button"
            data-testid="help-menu-trigger"
            onClick={() => setHelpMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={helpMenuOpen}
            className={`${SIDEBAR_ROW_BASE} ${sidebarRowTone(helpMenuOpen)}`}
          >
            <CircleHelp strokeWidth={1.5} className="size-[16px] shrink-0" />
            <span className="flex-1 truncate text-[13px]">{t("nav.help")}</span>
          </button>
          <Menu
            open={helpMenuOpen}
            onClose={closeHelpMenuAndRestoreFocus}
            ariaLabel={t("nav.help")}
            heading={t("nav.help")}
            testId="help-menu"
            className="absolute left-0 right-0 bottom-full mb-1.5"
          >
            <MenuItem
              icon={<Compass strokeWidth={1.5} className="size-[15px]" />}
              label={t("help.whatIsThis", { product: PRODUCT_NAME })}
              href="/about"
              testId="help-about"
              onSelect={() => setHelpMenuOpen(false)}
            />
            <MenuItem
              icon={<Keyboard strokeWidth={1.5} className="size-[15px]" />}
              label={t("help.shortcuts")}
              hint={<span className="font-mono text-[10.5px]">⌘K</span>}
              testId="help-shortcuts"
              onSelect={() => { setHelpMenuOpen(false); onOpenShortcuts(); }}
            />
            {INTERNAL_BLOG_ENABLED && (
              <MenuItem
                icon={<BookOpenText strokeWidth={1.5} className="size-[15px]" />}
                label={t("nav.blog")}
                hint={<ArrowUpRight className="size-[13px]" />}
                external={BLOG_PATH}
                testId="open-blog"
                onSelect={() => setHelpMenuOpen(false)}
              />
            )}

            {!IS_STANDALONE && (
              <MenuItem
                icon={<Download strokeWidth={1.5} className="size-[15px]" />}
                label={t("install.menu")}
                testId="help-install"
                onSelect={() => { setHelpMenuOpen(false); setInstallOpen(true); }}
              />
            )}
            <MenuItem
              icon={<GithubMark className="size-[13px]" />}
              label={t("help.source")}
              hint={<ArrowUpRight className="size-[13px]" />}
              external={REPO_URL}
              testId="help-github"
              onSelect={() => setHelpMenuOpen(false)}
            />
          </Menu>
          <InstallAppDialog open={installOpen} onOpenChange={setInstallOpen} />
        </div>

        <div ref={accountRef} className="relative">
          <button
            ref={accountTriggerRef}
            type="button"
            data-testid="account-menu-trigger"
            onClick={() => setAccountMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            aria-label={`${t("nav.signedInAs")} ${userEmail}`}
            title={userEmail}
            className={`w-full min-w-0 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#C77D2E]/30 ${accountMenuOpen ? 'bg-black/[0.09] dark:bg-white/[0.09]' : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.06]'}`}
          >
            <span className="min-w-0 flex-1 leading-tight">
              <span data-account-name className="block truncate text-[12.5px] font-medium text-[#333] dark:text-[#E0E0E0]">
                {userEmail.split("@")[0] || userEmail}
              </span>
              <span data-account-email className="block truncate text-[11px] text-[#999] dark:text-[#777]">
                {userEmail}
              </span>
            </span>
            <ChevronsUpDown aria-hidden strokeWidth={1.75} className="size-[15px] shrink-0 text-[#999] dark:text-[#777]" />
          </button>
          <Menu
            open={accountMenuOpen}
            onClose={closeAccountMenuAndRestoreFocus}
            ariaLabel={t("nav.signedInAs")}
            heading={t("settings.account")}
            testId="account-menu"
            className="absolute left-0 right-0 bottom-full mb-1.5"
          >
            <MenuItem
              icon={<Settings strokeWidth={1.5} className="size-[15px]" />}
              label={t("nav.settings")}
              href={VIEW_PATH.settings}
              active={currentView === 'settings'}
              testId="open-settings"
              onSelect={() => { setAccountMenuOpen(false); onCurrentViewChange('settings'); }}
            />
            <MenuItem
              icon={<Activity strokeWidth={1.5} className="size-[15px]" />}
              label={t("nav.statusPage")}
              hint={<ArrowUpRight className="size-[13px]" />}
              external="/status"
              testId="status-page"
              onSelect={() => setAccountMenuOpen(false)}
            />
            <MenuDivider />
            <MenuItem
              danger
              icon={<LogOut strokeWidth={1.5} className="size-[15px]" />}
              label={t("nav.logout")}
              testId="logout"
              onSelect={() => { setAccountMenuOpen(false); onLogout(); }}
            />
          </Menu>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, isActive, onClick, href, testId }: { icon: React.ReactNode, label: string, isActive?: boolean, onClick?: () => void, href?: string, testId?: string }) {
  const className = `${SIDEBAR_ROW_BASE} ${sidebarRowTone(isActive)}`;
  const body = (
    <>
      <span className={isActive ? 'text-[#333] dark:text-[#E0E0E0]' : 'text-[#666] dark:text-[#A0A0A0]'}>{icon}</span>
      <span className="text-[14px]">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link to={href} onNavigate={onClick} data-testid={testId} aria-current={isActive ? 'page' : undefined} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} data-testid={testId} className={className}>
      {body}
    </button>
  );
}

function sessionAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

function SessionStatusDot({ status }: { status?: SessionStatus }) {
  const tone: StatusTone = status === 'running' ? 'working' : status === 'error' ? 'error' : 'idle';
  return <StatusDot tone={tone} pulse={status === 'running'} title={status ?? 'idle'} />;
}

const SidebarListItem = memo(function SidebarListItem({
  session,
  age,
  active,
  onSelect,
  onDelete,
  onRename,
  onShare,
}: {
  session: SessionInfo,
  age: string,
  active?: boolean,
  onSelect: (session: SessionInfo) => void,
  onDelete: (id: string, e: React.MouseEvent) => void,
  onRename: (id: string, title: string) => void,
  onShare?: (id: string) => void,
}) {
  const t = useT();
  const { title: label, targetName, status, sandboxKind, sandboxTargetId: sandboxHost, isTeamMemberSession } = session;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const skipCommit = useRef(false);

  const focusInput = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      setEditing(false);
      setDraft(label);
      return;
    }
    const value = draft.trim();
    setEditing(false);
    if (value && value !== label) onRename(session.id, value);
    else setDraft(label);
  };

  return (
    <div
      data-session-item
      role={editing ? undefined : "button"}
      tabIndex={editing ? undefined : 0}
      aria-label={editing ? undefined : label}
      aria-current={!editing && active ? "page" : undefined}
      onClick={editing ? undefined : () => onSelect(session)}
      onKeyDown={editing ? undefined : (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-session-item]') ?? []);
          const i = rows.indexOf(e.currentTarget);
          const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
          next?.focus();
        }
      }}
      className={`session-item flex items-center justify-between px-3 py-[7px] md:py-[5.5px] rounded-lg cursor-pointer text-[#555] dark:text-[#B0B0B0] transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-[#3A82F6]/40 dark:focus-visible:ring-[#5A9BFF]/40 ${active ? 'bg-black/[0.09] dark:bg-white/[0.09]' : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.06] focus-visible:bg-black/[0.06] dark:focus-visible:bg-white/[0.06]'}`}
    >
      {editing ? (
        <input
          ref={focusInput}
          value={draft}
          aria-label={t("session.rename")}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); skipCommit.current = true; inputRef.current?.blur(); }
          }}
          onBlur={commit}
          className="session-rename-input flex-1 min-w-0 bg-white dark:bg-[#262626] border border-[#D8D8D8] dark:border-[#444] rounded px-1.5 py-0.5 -my-0.5 text-[13px] text-[#222] dark:text-[#E8E8E8] outline-none focus:border-[#999] dark:focus:border-[#666]"
        />
      ) : (
        <>
          <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">

            {sandboxKind
              ? <SessionKindStatus kind={sandboxKind} status={status} host={sandboxHost} />
              : <SessionStatusDot status={status} />}

            <span className="truncate text-[13.5px] md:text-[12.5px] leading-tight group-hover:text-[#333] dark:group-hover:text-[#E0E0E0] transition-colors">{label}</span>
          </div>

          <div className="shrink-0 flex items-center">
            <div className="flex items-center gap-1.5 text-[10.5px] leading-none text-[#A0A0A0] dark:text-[#767676] tabular-nums group-hover:hidden group-focus-within:hidden">
              {isTeamMemberSession
                ? <span>{t("session.teamMemberShort")}</span>
                : targetName && <span className="truncate max-w-[72px]">{targetName}</span>}
              <span>{age}</span>
            </div>
            <div className="hidden group-hover:flex group-focus-within:flex items-center gap-2">
              {onShare && (
                <button
                  type="button"
                  aria-label={t("share.dialog.title")}
                  title={t("share.dialog.title")}
                  onClick={(e) => { e.stopPropagation(); onShare(session.id); }}
                  className="session-share text-[#999] dark:text-[#888] hover:text-[#333] dark:hover:text-[#E0E0E0] transition-colors"
                >
                  <Share2 className="w-[12px] h-[12px]" />
                </button>
              )}
              <button
                type="button"
                aria-label={t("session.rename")}
                onClick={(e) => { e.stopPropagation(); setDraft(label); setEditing(true); }}
                className="session-rename text-[#999] dark:text-[#888] hover:text-[#333] dark:hover:text-[#E0E0E0] transition-colors"
              >
                <Pencil className="size-[12px]" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(session.id, e); }}
                className="session-del text-[13px] leading-none text-[#999] dark:text-[#888] hover:text-[#b42318]"
              >
                ×
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
