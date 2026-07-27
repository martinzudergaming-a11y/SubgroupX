import { useEffect } from "react";

export function useEdgeSwipe({
  enabled,
  leftOpen,
  rightOpen,
  setLeftOpen,
  setRightOpen,
}: {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  setLeftOpen: (v: boolean) => void;
  setRightOpen: (v: boolean) => void;
}) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const EDGE = 28;
    const DISTANCE = 55;
    const DOMINANCE = 1.2;

    let sx = 0;
    let sy = 0;
    let mode: "none" | "left-edge" | "right-edge" | "in-left" | "in-right" = "none";

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { mode = "none"; return; }
      const tch = e.touches[0];
      sx = tch.clientX;
      sy = tch.clientY;
      if (leftOpen) mode = "in-left";
      else if (rightOpen) mode = "in-right";
      else if (sx <= EDGE) mode = "left-edge";
      else if (sx >= window.innerWidth - EDGE) mode = "right-edge";
      else mode = "none";
    };

    const onEnd = (e: TouchEvent) => {
      const m = mode;
      mode = "none";
      if (m === "none") return;
      const tch = e.changedTouches[0];
      const dx = tch.clientX - sx;
      const dy = tch.clientY - sy;
      if (Math.abs(dx) < DISTANCE || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return;
      if (m === "left-edge" && dx > 0) setLeftOpen(true);
      else if (m === "right-edge" && dx < 0) setRightOpen(true);
      else if (m === "in-left" && dx < 0) setLeftOpen(false);
      else if (m === "in-right" && dx > 0) setRightOpen(false);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [enabled, leftOpen, rightOpen, setLeftOpen, setRightOpen]);
}
