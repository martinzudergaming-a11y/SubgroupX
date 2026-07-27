import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "../../platform/router";
import { useOnEscape } from "./use-on-escape";

export function Menu({
  open,
  onClose,
  ariaLabel,
  heading,
  testId,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  heading?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOnEscape(() => { if (open) onClose(); });
  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
  }, [open]);
  if (!open) return null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home"
      ? items[0]
      : e.key === "End"
        ? items.at(-1)
        : items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  return (
    <div
      ref={ref}
      data-testid={testId}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`z-30 origin-bottom-left rounded-[14px] border border-[#DED9C8] bg-[var(--app-surface)] p-1.5 oiia-shadow-pop dark:border-[#39362E] dark:bg-[#24231F] ${className ?? ""}`}
    >
      {heading != null && (
        <div className="px-2 py-1.5 text-[11px] font-semibold tracking-[0.01em] text-[#8D8B82] dark:text-[#858178]">
          {heading}
        </div>
      )}
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  danger,
  active,
  href,
  external,
  onSelect,
  testId,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  active?: boolean;
  href?: string;
  external?: string;
  onSelect?: () => void;
  testId?: string;
}) {
  const cls =
    `w-full min-h-10 text-left flex items-center gap-2 rounded-lg px-2 py-2 text-[12.5px] outline-none cursor-pointer transition-[background-color,color,transform] duration-100 active:scale-[.98] motion-reduce:transform-none md:min-h-0 md:py-1.5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C77D2E]/30 ${
      danger
        ? "text-[#8A3F38] hover:bg-[#F7EAE5] focus-visible:bg-[#F7EAE5] dark:text-[#D89B92] dark:hover:bg-[#392622] dark:focus-visible:bg-[#392622]"
        : `text-[#3F3C35] hover:bg-[#F1ECE1]/60 focus-visible:bg-[#F1ECE1]/60 dark:text-[#E1DDD3] dark:hover:bg-[#2C2A22] dark:focus-visible:bg-[#2C2A22] ${active ? "bg-[#F1ECE1] dark:bg-[#2C2A22]" : ""}`
    }`;
  const body = (
    <>
      {icon && <span className={`flex size-4 shrink-0 items-center justify-center ${danger ? "" : "text-[#77736A] dark:text-[#A19C91]"}`}>{icon}</span>}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint != null && <span className="shrink-0 text-[11px] text-[#99968D] dark:text-[#77736A] tabular-nums">{hint}</span>}
    </>
  );
  if (external) {
    return (
      <a data-menu-item role="menuitem" data-testid={testId} href={external} target="_blank" rel="noreferrer" onClick={onSelect} className={cls}>
        {body}
      </a>
    );
  }
  if (href) {
    return (
      <Link data-menu-item role="menuitem" data-testid={testId} to={href} onNavigate={onSelect} aria-current={active ? "page" : undefined} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button data-menu-item type="button" role="menuitem" data-testid={testId} onClick={onSelect} className={cls}>
      {body}
    </button>
  );
}

export function MenuDivider() {
  return <div role="separator" className="mx-2 my-1 h-px bg-[#E8E3D7] dark:bg-[#39362E]" />;
}

export function MenuKeycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center h-[17px] min-w-[17px] justify-center px-1 rounded-[4px] border border-[#E0DED2] dark:border-[#3A3A3A] bg-[#F3F2EA] dark:bg-[#2C2C2C] text-[10.5px] font-medium text-[#8A8A82] dark:text-[#999] not-italic">
      {children}
    </kbd>
  );
}
