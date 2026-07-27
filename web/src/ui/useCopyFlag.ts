import { useCallback, useEffect, useRef, useState } from "react";

export function useCopyFlag(durationMs: number) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), durationMs);
  }, [durationMs]);
  return { copied, flash };
}
