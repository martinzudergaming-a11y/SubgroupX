import { Gauge } from "lucide-react";
import type { ThinkingLevel } from "@shared/protocol";
import { useT } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/en";
import { ComposerControlLabel, ComposerIconButton, ComposerMenu, ComposerMenuOption } from "./composer-controls";
import { useComposerPopover, type ComposerPopoverGroup } from "./useHoverPopover";

const ALL_LEVELS: { value: ThinkingLevel; labelKey: TranslationKey }[] = [
  { value: "low", labelKey: "think.low" },
  { value: "medium", labelKey: "think.medium" },
  { value: "high", labelKey: "think.high" },
  { value: "xhigh", labelKey: "think.xhigh" },
  { value: "max", labelKey: "think.max" },
];
const DEFAULT_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];

export function ThinkingLevelSwitcher({
  level,
  levels = DEFAULT_LEVELS,
  onChange,
  showCategory = false,
  popoverGroup = "composer-footer",
}: {
  level: ThinkingLevel;
  levels?: ThinkingLevel[];
  onChange: (l: ThinkingLevel) => void;
  showCategory?: boolean;
  popoverGroup?: ComposerPopoverGroup;
}) {
  const t = useT();
  const { open, rootRef, triggerRef, close, scheduleClose, openFromHover, togglePinned, menuAutoFocus } = useComposerPopover({ group: popoverGroup });

  const LEVELS = ALL_LEVELS.filter((l) => levels.includes(l.value) || l.value === level);
  const current = LEVELS.find((l) => l.value === level) ?? LEVELS[1] ?? LEVELS[0];

  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={openFromHover} onMouseLeave={scheduleClose}>
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        data-testid="thinking-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
        title={`${t("think.title")}: ${t(current.labelKey)}`}
        layout={showCategory ? "overflow" : "compact"}
      >
        <Gauge strokeWidth={2} className="size-4" />
        <ComposerControlLabel category={t("think.title")} value={t(current.labelKey)} showCategory={showCategory} />
      </ComposerIconButton>

      <ComposerMenu open={open} title={t("think.title")} width="w-40" testId="thinking-menu" autoFocus={menuAutoFocus}>
        {LEVELS.map((l) => {
          const active = l.value === level;
          return (
            <ComposerMenuOption
              key={l.value}
              testId={`thinking-opt-${l.value}`}
              active={active}
              label={t(l.labelKey)}
              onSelect={() => { onChange(l.value); close(); }}
            />
          );
        })}
      </ComposerMenu>
    </div>
  );
}
