import { Unlock, Lock, ShieldAlert, type LucideIcon } from "lucide-react";
import type { ApprovalPolicy } from "@shared/protocol";
import { useT } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/en";
import { ComposerControlLabel, ComposerIconButton, ComposerMenu, ComposerMenuOption } from "./composer-controls";
import { useComposerPopover, type ComposerPopoverGroup } from "./useHoverPopover";

const POLICIES: { value: ApprovalPolicy; Icon: LucideIcon; labelKey: TranslationKey; descKey: TranslationKey }[] = [
  { value: "never", Icon: Unlock, labelKey: "approval.never", descKey: "approval.neverDesc" },
  { value: "on-request", Icon: Lock, labelKey: "approval.onRequest", descKey: "approval.onRequestDesc" },
  { value: "untrusted", Icon: ShieldAlert, labelKey: "approval.untrusted", descKey: "approval.untrustedDesc" },
];

export function ApprovalSwitcher({
  policy,
  onChange,
  showCategory = false,
  popoverGroup = "composer-footer",
}: {
  policy: ApprovalPolicy;
  onChange: (p: ApprovalPolicy) => void;
  showCategory?: boolean;
  popoverGroup?: ComposerPopoverGroup;
}) {
  const t = useT();
  const { open, rootRef, triggerRef, close, scheduleClose, openFromHover, togglePinned, menuAutoFocus } = useComposerPopover({ group: popoverGroup });

  const current = POLICIES.find((p) => p.value === policy) ?? POLICIES[1];
  const CurrentIcon = current.Icon;

  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={openFromHover} onMouseLeave={scheduleClose}>
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        data-testid="approval-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
        title={`${t("approval.title")}: ${t(current.labelKey)}`}
        layout={showCategory ? "overflow" : "compact"}
      >
        <CurrentIcon strokeWidth={2} className="size-4" />
        <ComposerControlLabel category={t("approval.title")} value={t(current.labelKey)} showCategory={showCategory} />
      </ComposerIconButton>

      <ComposerMenu open={open} title={t("approval.title")} width="w-64" testId="approval-menu" autoFocus={menuAutoFocus}>
        {POLICIES.map((p) => {
          const { Icon } = p;
          const active = p.value === policy;
          return (
            <ComposerMenuOption
              key={p.value}
              testId={`approval-opt-${p.value}`}
              active={active}
              icon={<Icon strokeWidth={1.8} className="size-[15px]" />}
              label={t(p.labelKey)}
              description={t(p.descKey)}
              onSelect={() => { onChange(p.value); close(); }}
            />
          );
        })}
      </ComposerMenu>
    </div>
  );
}
