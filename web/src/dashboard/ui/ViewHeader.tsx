import type { LucideIcon } from "lucide-react";
import { PanelLeft } from "lucide-react";
import { useT } from "../../i18n";
import { iconButtonClass } from "./controlStyles.ts";

export function ViewHeader({
  icon: Icon,
  title,
  subtitle,
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  action,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  action?: React.ReactNode;
  testId?: string;
}) {
  const t = useT();
  return (
    <header
      data-testid={testId ?? "view-header"}
      className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[#E5E8E0] px-4 dark:border-[#31332E] md:px-5"
    >
      {!isLeftSidebarOpen && (
        <button
          type="button"
          onClick={onOpenLeftSidebar}
          aria-label={t("nav.openSidebar")}
          className={`${iconButtonClass} -ml-1`}
        >
          <PanelLeft className="size-[17px]" strokeWidth={1.5} />
        </button>
      )}
      <Icon className="size-[16px] shrink-0 text-[#686B63] dark:text-[#A0A29B]" strokeWidth={1.6} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h1 className="text-[13.5px] font-semibold leading-4 text-[#30322D] dark:text-[#E1E2DC]">{title}</h1>
        {subtitle && (
          <p className="hidden truncate text-[11px] leading-4 text-[#686C63] dark:text-[#A0A39B] sm:block">
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </header>
  );
}
