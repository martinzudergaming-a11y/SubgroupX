import { ChevronDown } from "lucide-react";
import { ModelBrandIcon } from "./model-brand-icons";
import { ComposerControlLabel, ComposerIconButton, ComposerMenu, ComposerMenuOption } from "./composer-controls";
import { useComposerPopover, type ComposerPopoverGroup } from "./useHoverPopover";
import { useT } from "../../../i18n";
import type { ModelInfo, SessionInfo } from "@shared/protocol";

export function ModelSwitcher({
  session,
  models,
  onChange,
  showCategory = false,
  popoverGroup = "composer-footer",
  condenseLabel = false,
}: {
  session: SessionInfo;
  models: ModelInfo[];
  onChange: (provider: string, model: string) => void;
  showCategory?: boolean;
  popoverGroup?: ComposerPopoverGroup;
  condenseLabel?: boolean;
}) {
  const t = useT();
  const { open, rootRef, triggerRef, close, scheduleClose, openFromHover, togglePinned, menuAutoFocus } = useComposerPopover({ group: popoverGroup });
  const condense = condenseLabel === true;
  const selectable = models.filter((m) => !m.mock);
  if (selectable.length < 2) return null;
  const current = selectable.find((m) => m.provider === session.provider && m.id === session.model);
  const currentName = current?.name || session.model;

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 items-center"
      onMouseEnter={openFromHover}
      onMouseLeave={scheduleClose}
    >
      <ComposerIconButton
        ref={triggerRef}
        active={open}
        data-testid="model-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => togglePinned({ autoFocus: event.detail === 0 })}
        title={condense ? `${t("model.switch")} · ${currentName}` : t("model.switch")}
        layout={showCategory ? "overflow" : "compact"}
        className={showCategory ? "" : "min-w-0"}
      >
        <ModelBrandIcon modelId={current?.id ?? session.model} modelName={currentName} className="size-4 shrink-0" />
        {showCategory
          ? <ComposerControlLabel category={t("model.switch")} value={currentName} showCategory />
          : condense
            ? null
            : <span className="flex min-w-0 max-w-[190px]"><ComposerControlLabel category={t("model.switch")} value={currentName} /></span>}
        <ChevronDown strokeWidth={2} className="size-[13px] shrink-0 opacity-70" />
      </ComposerIconButton>
      <ComposerMenu
        open={open}
        title={t("model.switch")}
        width="w-[min(18rem,calc(100vw-2rem))] max-h-[52vh] overflow-y-auto [scrollbar-width:thin]"
        testId="model-menu"
        autoFocus={menuAutoFocus}
      >
        {selectable.map((m) => {
          const active = m.provider === session.provider && m.id === session.model;
          return (
            <ComposerMenuOption
              key={`${m.provider}::${m.id}`}
              testId={`model-opt-${m.provider}-${m.id}`}
              active={active}
              onSelect={() => { close(); if (!active) onChange(m.provider, m.id); }}
              label={m.name || m.id}
              meta={m.provider}
            />
          );
        })}
      </ComposerMenu>
    </div>
  );
}
