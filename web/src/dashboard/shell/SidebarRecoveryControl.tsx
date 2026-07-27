import { PanelLeft } from "lucide-react";
import { useT } from "../../i18n";

export function SidebarRecoveryControl({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="sidebar-recovery"
      onClick={onOpen}
      aria-label={t("nav.openSidebar")}
      title={t("nav.openSidebar")}
      className="absolute left-3 top-3 z-20 flex min-h-10 min-w-10 items-center justify-center rounded-md text-[#777] transition-colors hover:bg-[#F5F5F5] dark:text-[#A0A0A0] dark:hover:bg-[#2A2A2A] md:left-4 md:top-[14px] md:min-h-0 md:min-w-0 md:p-1.5"
    >
      <PanelLeft strokeWidth={1.5} className="size-[15px]" />
    </button>
  );
}

export function PlaceholderPane({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  children,
}: {
  isLeftSidebarOpen: boolean;
  onOpenLeftSidebar: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-1 items-center justify-center bg-[var(--app-surface)] text-[14px] text-[#777] dark:bg-[#1A1A1A] dark:text-[#999]">
      {!isLeftSidebarOpen && <SidebarRecoveryControl onOpen={onOpenLeftSidebar} />}
      {children}
    </div>
  );
}
