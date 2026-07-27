import { useEffect, useRef, type RefObject } from "react";
export function useOutsideClose(ref: RefObject<HTMLElement | null>, onClose: () => void, active: boolean) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [active, ref]);
}
