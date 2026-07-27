export function Spinner({
  className = "",
  strokeWidth = 2.25,
  "aria-label": ariaLabel,
}: {
  className?: string;
  strokeWidth?: number;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin motion-reduce:animate-none ${className}`}
      role={ariaLabel ? "status" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      data-testid="spinner"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={strokeWidth} opacity="0.2" />
      <path d="M12 3A9 9 0 0 1 21 12" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M12 21A9 9 0 0 1 3 12" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}
