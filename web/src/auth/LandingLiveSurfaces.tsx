import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { TelemetryPanelView, type TelemetryPoint } from "../telemetry/TelemetryPanel.tsx";
import { SAMPLE_INTERVAL_MS, SAMPLE_WINDOW, nextIn, sampleTelemetry, seedHistory, seededWalk } from "./landing-telemetry-sample.ts";

function useSampleTelemetry(ref: React.RefObject<HTMLElement | null>) {
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState<TelemetryPoint[]>([]);
  const random = useRef(seededWalk(0xbeef));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: number | undefined;
    let onScreen = false;

    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      if (timer !== undefined || !onScreen || document.hidden || motion.matches) return;
      timer = window.setInterval(() => {
        setHistory((previous) => {
          const last = previous[previous.length - 1];
          const at = Date.now();
          const next: TelemetryPoint = {
            sampledAt: at,
            cpuPct: nextIn(random.current, last?.cpuPct ?? 21, 8, 48, 4),
            memPct: nextIn(random.current, last?.memPct ?? 63, 58, 72, 1.2),
          };
          setNow(at);
          return [...previous.slice(-(SAMPLE_WINDOW - 1)), next];
        });
      }, SAMPLE_INTERVAL_MS);
    };
    const sync = () => (onScreen && !document.hidden && !motion.matches ? start() : stop());

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = Boolean(entry?.isIntersecting);
      if (onScreen) setHistory((current) => (current.length > 0 ? current : seedHistory(Date.now())));
      sync();
    }, { rootMargin: "128px" });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, [ref]);

  const last = history[history.length - 1];
  return {
    telemetry: sampleTelemetry(last?.cpuPct ?? 21, last?.memPct ?? 63, now),
    history,
  };
}

export function LandingTelemetrySurface() {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const { telemetry, history } = useSampleTelemetry(ref);

  return (
    <div ref={ref} data-testid="landing-live-telemetry" className="@container/detail overflow-hidden rounded-[12px] border border-black/[0.08] bg-white px-5 dark:border-white/[0.10] dark:bg-[#1A1A1A]">
      <TelemetryPanelView telemetry={telemetry} history={history} status={null} />
      <p className="pb-4 text-[11px] leading-[1.6] text-[#8A8880] dark:text-[#8A8A82]">
        {t("landing.liveSample")}
      </p>
    </div>
  );
}
