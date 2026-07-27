import { useEffect, useRef, useState } from "react";

type Variant = "spin3d" | "rotate" | "flip" | "shear" | "squash";
const VARIANTS: Variant[] = ["spin3d", "spin3d", "rotate", "flip", "shear", "squash"];

function CatSpinner({ size = 96, label }: { size?: number; label?: string }) {
  const [variant] = useState<Variant>(() => VARIANTS[Math.floor(Math.random() * VARIANTS.length)]);
  const src = variant === "spin3d" ? "/oiia-spin.webp" : "/oiia-cat.png";
  return (
    <output className="oiia-spin-wrap flex flex-col items-center gap-3" aria-label={label || "Loading"}>
      <div className="oiia-stage" style={{ width: size, height: size }}>
        <img
          src={src}
          alt=""
          aria-hidden="true"
          width={size}
          height={size}
          draggable={false}
          className={`oiia-cat oiia-${variant}`}
        />
      </div>
      {label && <span className="text-[12.5px] text-[#999] dark:text-[#777] select-none">{label}</span>}
    </output>
  );
}

export function SessionLoaderOverlay({
  active,
  label,
  bottomInset = 0,
  delayMs = 170,
}: {
  active: boolean;
  label?: string;
  bottomInset?: number;
  delayMs?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => { if (activeRef.current) setRevealed(true); }, delayMs);
    return () => window.clearTimeout(t);
  }, [active, delayMs]);

  if (!revealed) return null;
  const phase: "in" | "out" = active ? "in" : "out";
  return (
    <div
      className={`oiia-overlay ${phase === "out" ? "oiia-overlay-out" : "oiia-overlay-in"}`}
      style={{ bottom: bottomInset }}
      onAnimationEnd={() => { if (phase === "out") setRevealed(false); }}
    >
      <CatSpinner label={label} />
    </div>
  );
}
