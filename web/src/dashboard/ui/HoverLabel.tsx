export function HoverLabel({ label, placement = "bottom" }: { label: string; placement?: "bottom" | "right" }) {
  const position = placement === "right"
    ? "left-[calc(100%+9px)] top-1/2 -translate-y-1/2 -translate-x-0.5 group-hover/hoverlabel:translate-x-0 group-focus-visible/hoverlabel:translate-x-0"
    : "left-1/2 top-[calc(100%+7px)] -translate-x-1/2 -translate-y-0.5 group-hover/hoverlabel:translate-y-0 group-focus-visible/hoverlabel:translate-y-0";

  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-[#E2E5DD] bg-white px-2 py-1 text-[11px] font-medium leading-none text-[#444840] opacity-0 shadow-[0_5px_14px_-6px_rgba(0,0,0,.24)] transition-[opacity,transform] delay-0 duration-100 ease-out group-hover/hoverlabel:opacity-100 group-hover/hoverlabel:delay-300 group-focus-visible/hoverlabel:opacity-100 dark:border-[#3B3E39] dark:bg-[#292B28] dark:text-[#E7E9E3] motion-reduce:transform-none motion-reduce:transition-none ${position}`}
    >
      {label}
    </span>
  );
}
