import { useEffect, useRef, type CSSProperties, type MouseEventHandler, type Ref, type ReactNode } from "react";
import { LazyMotion, m, domAnimation, AnimatePresence, useReducedMotion } from "motion/react";

export const COMPOSER_ICON_SIZE = 16;

interface ComposerIconButtonProps {
  active?: boolean;
  title?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  layout?: "compact" | "overflow";
  iconOnly?: boolean;
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function ComposerIconButton({ active, disabled, onClick, layout = "compact", iconOnly = false, className = "", children, ref, ...rest }: ComposerIconButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={`${
        layout === "overflow"
          ? "grid min-h-10 w-full grid-cols-[16px_minmax(0,1fr)_minmax(0,7rem)_13px] items-center gap-x-1.5 rounded-lg px-2.5 text-left"
          : iconOnly
            ? "flex size-8 shrink-0 items-center justify-center rounded-full p-0"
            : "flex h-8 items-center gap-1.5 rounded-lg px-2"
      } leading-none outline-none transition-[background-color,color,box-shadow,transform] duration-100 active:scale-[.97] motion-reduce:transform-none focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 ${
        disabled
          ? "text-[#C0C0BA] dark:text-[#555] cursor-default"
          : active
            ? "bg-[#EEEAE0] dark:bg-[#333027] text-[#33312B] dark:text-[#ECE8DD] shadow-[inset_0_0_0_1px_#DED8C7] dark:shadow-[inset_0_0_0_1px_#474235]"
            : "text-[#7B7B74] dark:text-[#A0A0A0] hover:text-[#33312B] dark:hover:text-[#ECE8DD] hover:bg-[#F1EFE8] dark:hover:bg-[#2D2B25]"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function ComposerControlLabel({
  category,
  value,
  showCategory = false,
  valueStyle,
}: {
  category: ReactNode;
  value: ReactNode;
  showCategory?: boolean;
  valueStyle?: CSSProperties;
}) {
  if (showCategory) {
    return (
      <>
        <span data-composer-control-category className="min-w-0 truncate text-[11px] leading-none text-[#99968D] dark:text-[#77736A]">{category}</span>
        <span
          data-composer-control-value
          style={valueStyle}
          className="min-w-0 truncate text-right text-[11px] font-medium leading-none text-[#45423B] dark:text-[#D9D4C8]"
        >
          {value}
        </span>
      </>
    );
  }
  return <span style={valueStyle} className="min-w-0 truncate text-[11px] font-medium leading-none">{value}</span>;
}

export function ComposerMenu({
  open,
  title,
  titleEnd,
  width,
  testId,
  kind = "menu",
  autoFocus = false,
  children,
}: {
  open: boolean;
  title: string;
  titleEnd?: ReactNode;
  width: string;
  testId?: string;
  kind?: "menu" | "dialog";
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!open || !autoFocus || kind !== "menu") return;
    const frame = requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLElement>("[data-composer-menu-item]:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, kind, open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (kind !== "menu") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>("[data-composer-menu-item]:not(:disabled)") ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "Home") next = 0;
    else next = (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence>
        {open && (
          <m.div
            ref={cardRef}
            data-testid={testId}
            role={kind}
            aria-label={title}
            onKeyDown={onKeyDown}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 6, scale: reduceMotion ? 1 : 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1, pointerEvents: "auto" }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 4, scale: reduceMotion ? 1 : 0.99, pointerEvents: "none" }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={`absolute bottom-full left-0 mb-2 z-50 ${width} rounded-[14px] border border-[#DED9C8] dark:border-[#39362E] bg-[var(--app-surface)] dark:bg-[#24231F] oiia-shadow-pop p-1.5 origin-bottom-left`}
          >
            <div className="flex items-baseline justify-between px-2 py-1.5 text-[11px] font-semibold tracking-[0.01em] text-[#8D8B82] dark:text-[#858178]">
              <span>{title}</span>
              {titleEnd != null && <span className="tabular-nums">{titleEnd}</span>}
            </div>
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}

export function ComposerMenuOption({
  active,
  icon,
  label,
  description,
  meta,
  testId,
  onSelect,
}: {
  active: boolean;
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  testId?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      data-composer-menu-item
      data-testid={testId}
      onClick={onSelect}
      className={`group/option w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C77D2E]/30 ${
        active
          ? "bg-[#F1ECE1] dark:bg-[#2C2A22]"
          : "hover:bg-[#F1ECE1]/60 dark:hover:bg-[#26241D] focus-visible:bg-[#F1ECE1]/60 dark:focus-visible:bg-[#26241D]"
      }`}
    >
      {icon && <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-[#77736A] dark:text-[#A19C91]">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] leading-4 text-[#33312B] dark:text-[#E8E4DA]">
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {meta != null && <span className="shrink-0 text-[11px] font-normal text-[#99968D] dark:text-[#77736A]">{meta}</span>}
        </span>
        {description != null && <span className="mt-0.5 block text-[11px] leading-snug text-[#99968D] dark:text-[#77736A]">{description}</span>}
      </span>
    </button>
  );
}

export function ComposerActionButton({
  tone,
  hint,
  children,
  ...props
}: {
  tone: "quiet" | "strong";
  hint?: ReactNode;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button
      type="button"
      {...props}
      className={`group/action flex h-8 shrink-0 items-center rounded-full px-3 text-[12px] font-medium outline-none transition-[background-color,color,border-color,opacity,box-shadow,transform] duration-100 active:scale-[.97] motion-reduce:transform-none focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 disabled:pointer-events-none disabled:opacity-45 ${
        tone === "strong"
          ? "border border-[#222] dark:border-[#E0E0E0] bg-[#222] dark:bg-[#E0E0E0] text-white dark:text-[#222] shadow-sm hover:opacity-90"
          : "border border-[#D9D7CE] dark:border-[#44413A] bg-transparent text-[#5F5D56] dark:text-[#BBB6AA] hover:border-[#C9C5B8] hover:bg-[#F1EFE8] dark:hover:bg-[#2D2B25]"
      }`}
    >
      {children}
      {hint != null && (
        <kbd
          aria-hidden
          className={`ml-1.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[4px] px-0.5 font-sans text-[10px] font-normal leading-none ${
            tone === "strong"
              ? "bg-white/[.16] text-white/80 dark:bg-black/[.12] dark:text-black/70"
              : "bg-black/[.055] text-[#8D8B82] dark:bg-white/[.08] dark:text-[#8F8B80]"
          }`}
        >
          {hint}
        </kbd>
      )}
    </button>
  );
}
