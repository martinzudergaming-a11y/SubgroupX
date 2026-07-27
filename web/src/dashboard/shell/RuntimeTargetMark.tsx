export function RuntimeTargetMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3 19.79 7.5 19.79 16.5 12 21 4.21 16.5 4.21 7.5Z" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.4" />
    </svg>
  );
}
