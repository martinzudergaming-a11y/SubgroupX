import type { SVGProps } from "react";

export function OutlineGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>

      <path d="M5 5.9h14" />
      <path d="M9.5 12h9.5" />
      <path d="M5 18.1h14" />
    </svg>
  );
}

export function ShareGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>

      <path d="M12 14.2V4.6" />
      <path d="m8.3 7.7 3.7-3.6 3.7 3.6" />
      <path d="M8.4 10.6H7.6A2.6 2.6 0 0 0 5 13.2v4.2A2.6 2.6 0 0 0 7.6 20h8.8a2.6 2.6 0 0 0 2.6-2.6v-4.2a2.6 2.6 0 0 0-2.6-2.6h-.8" />
    </svg>
  );
}
