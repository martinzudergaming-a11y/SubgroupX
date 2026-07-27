import { Hash, Plus, MessageSquarePlus } from "lucide-react";
import { ViewHeader } from "../../ui/ViewHeader.tsx";
import { primaryButtonClass } from "../../ui/controlStyles.ts";
import type { SessionInfo } from "@shared/protocol";
import { SESSION_STATUS_STYLE } from "../../../ui/status-colors";
import { useT } from "../../../i18n";

export function ChannelView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
}) {
  const t = useT();
  return (
    <div data-testid="channel-view" className="relative flex h-full min-w-0 flex-1 flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <ViewHeader
        icon={Hash}
        title={t("channel.title")}
        subtitle={
          sessions.length === 0
            ? t("channel.startToOpen")
            : t(sessions.length === 1 ? "channel.pick.one" : "channel.pick.other", { count: sessions.length })
        }
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
        action={
          <button type="button" onClick={onNewSession} className={`${primaryButtonClass} !min-h-8 !px-3 !text-[11.5px]`}>
            <Plus className="size-3.5" strokeWidth={2} />
            {t("channel.newSession")}
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-2 py-4">
        <div className="max-w-[48rem] mx-auto flex flex-col gap-1.5">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center gap-3 py-24 px-6">
              <div className="size-12 rounded-full bg-[#F4F4F5] dark:bg-[#2A2A2A] flex items-center justify-center text-[#999] dark:text-[#777]">
                <MessageSquarePlus strokeWidth={1.5} className="size-6" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-[15px] text-[#222] dark:text-[#E0E0E0]">{t("channel.emptyTitle")}</span>
                <span className="text-[13px] text-[#888] dark:text-[#777] max-w-[22rem]">
                  {t("channel.emptyDescription")}
                </span>
              </div>
              <button
                type="button"
                onClick={onNewSession}
                className="mt-1 flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium bg-[#222] dark:bg-[#E0E0E0] text-white dark:text-[#222] hover:opacity-90 transition-opacity"
              >
                <Plus strokeWidth={2.5} className="size-[14px]" />
                {t("channel.newSession")}
              </button>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
                className={`flex items-start gap-3.5 w-full text-left px-3 py-3 rounded-lg transition-colors group ${
                  activeSessionId === session.id
                    ? "bg-[#F0F0F0] dark:bg-[#2A2A2A]"
                    : "hover:bg-[#F9F9F9] dark:hover:bg-[#252525]"
                }`}
              >
                <div className="size-[36px] shrink-0 rounded-md bg-[#F0F0F0] dark:bg-[#2A2A2A] flex items-center justify-center text-[#888] dark:text-[#A0A0A0]">
                  <Hash strokeWidth={1.75} className="size-[18px]" />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-[14.5px] text-[#222] dark:text-[#E0E0E0] truncate group-hover:text-[#111] dark:group-hover:text-white transition-colors">
                      {session.title}
                    </span>
                    <span
                      className={`shrink-0 text-[11px] font-medium px-1.5 py-[1px] rounded-md leading-none ${SESSION_STATUS_STYLE[session.status]}`}
                    >
                      {session.status}
                    </span>
                  </div>
                  <span className="text-[12.5px] text-[#888] dark:text-[#777] mt-0.5 truncate">
                    {session.provider}/{session.model} · {session.sandboxMode}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
