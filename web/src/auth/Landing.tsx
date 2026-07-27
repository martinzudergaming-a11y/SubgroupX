import { useEffect, useRef } from "react";
import { ArrowLeft, ChevronDown, History, Laptop, Network, ShieldCheck } from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { LangToggle } from "../ui/LangToggle.tsx";
import { GithubMark } from "../ui/GithubMark.tsx";
import { PRODUCT_NAME, REPO_URL } from "../platform/brand";
import { LandingTelemetrySurface } from "./LandingLiveSurfaces.tsx";

const SHOTS = {
  "session": { w: 2880, h: 1400 },
  "rail-files": { w: 798, h: 300 },
  "rail-terminal": { w: 940, h: 216 },
  "rail-approval": { w: 1604, h: 334 },
} as const;

type ShotName = keyof typeof SHOTS;

const CLAIMS = [
  { key: "f1", Icon: History },
  { key: "f2", Icon: Laptop },
  { key: "f3", Icon: Network },
  { key: "f4", Icon: ShieldCheck },
] as const;

type Proof =
  | { id: string; live: true; titleKey: TranslationKey; bodyKey: TranslationKey }
  | { id: string; shot: ShotName; titleKey: TranslationKey; bodyKey: TranslationKey };

const PROOFS = [
  { id: "machine", live: true, titleKey: "landing.proofMachineT", bodyKey: "landing.proofMachineD" },
  { id: "terminal", shot: "rail-terminal", titleKey: "landing.proofTerminalT", bodyKey: "landing.proofTerminalD" },
  { id: "workspace", shot: "rail-files", titleKey: "landing.proofFilesT", bodyKey: "landing.proofFilesD" },
  { id: "approval", shot: "rail-approval", titleKey: "landing.proofApprovalT", bodyKey: "landing.proofApprovalD" },
] as const satisfies ReadonlyArray<Proof>;

const RAIL = [
  { id: "session", shot: "session", labelKey: "landing.railSession" },
  { id: "workspace", shot: "rail-files", labelKey: "landing.railFiles" },
  { id: "terminal", shot: "rail-terminal", labelKey: "landing.railTerminal" },
  { id: "approval", shot: "rail-approval", labelKey: "landing.railApproval" },
] as const satisfies ReadonlyArray<{ id: string; shot: ShotName; labelKey: TranslationKey }>;

function Shot({ name, alt, className, eager }: {
  name: ShotName;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const { w, h } = SHOTS[name];
  return (
    <picture>
      <source srcSet={`/landing/${name}-dark.png`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/landing/${name}-light.png`}
        alt={alt}
        width={w}
        height={h}
        className={className}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        {...(eager ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

function BrandLockup() {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="size-[10px] rotate-45 rounded-[2px] bg-[#ff003c] shrink-0" aria-hidden />
      <span className="font-bold text-[11.5px] tracking-[0.14em] text-[#1A1A1A] dark:text-[#EDEDED] select-none shrink-0">
        SUBGROUP<span className="text-[#0AA6B4] dark:text-[#00E5F0]">X</span>
      </span>
      <span className="w-px h-[12px] bg-black/[0.14] dark:bg-white/[0.16] shrink-0" aria-hidden />
      <span className="brand-oiia">{PRODUCT_NAME}</span>
    </div>
  );
}

const NAV_LINK =
  "font-mono text-[11px] tracking-[0.18em] uppercase text-[#6B6A62] dark:text-[#9A9A90] transition-colors hover:text-[#1A1A1A] dark:hover:text-[#EDEDED] cursor-pointer";

export function Landing({
  onAuth,
  signedIn = false,
  onEnterApp,
}: {
  onAuth: (mode: "login" | "signup") => void;
  signedIn?: boolean;
  onEnterApp?: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      const viewport = window.innerHeight || 1;
      const scrolled = window.scrollY;
      const total = Math.max(1, document.documentElement.scrollHeight - viewport);
      root.style.setProperty("--lp-p", String(Math.min(1, scrolled / viewport)));
      root.style.setProperty("--lp-scroll", String(Math.min(1, scrolled / total)));
      root.dataset.pastHero = scrolled > viewport * 0.55 ? "true" : "false";
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    const targets = rootRef.current?.querySelectorAll<HTMLElement>(".lp-reveal");
    if (!targets?.length) return;
    if (typeof IntersectionObserver === "undefined"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      targets.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const primary = signedIn
    ? <button type="button" data-testid="landing-enter-app" onClick={() => onEnterApp?.()} className="inline-flex items-center gap-2 rounded-full bg-[#1A1A1A] px-6 py-3 text-[14px] font-medium text-white transition-colors hover:bg-[#333] active:scale-[.98] motion-reduce:active:scale-100 dark:bg-[#EDEDED] dark:text-[#1A1A1A] dark:hover:bg-white">
        <ArrowLeft className="size-[15px]" strokeWidth={1.8} />{t("landing.backToApp")}
      </button>
    : <button type="button" onClick={() => onAuth("signup")} className="rounded-full bg-[#1A1A1A] px-6 py-3 text-[14px] font-medium text-white transition-colors hover:bg-[#333] active:scale-[.98] motion-reduce:active:scale-100 dark:bg-[#EDEDED] dark:text-[#1A1A1A] dark:hover:bg-white">
        {t("landing.ctaPrimary")}
      </button>;

  return (
    <main
      ref={rootRef}
      data-testid="landing"
      className="lp-root relative min-h-dvh bg-[#F4F5F2] text-[#1A1A1A] font-sans antialiased dark:bg-[#131313] dark:text-[#E5E5E5]"
    >

      <div aria-hidden className="pointer-events-none fixed right-6 top-1/2 z-40 hidden h-[22vh] w-px -translate-y-1/2 bg-black/[0.09] dark:bg-white/[0.12] lg:block">
        <div className="lp-progress h-full w-full origin-top bg-[#1A1A1A] dark:bg-[#EDEDED]" />
      </div>

      <header className="lp-fade fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-3 px-4 py-4 sm:gap-4 sm:px-8">
        <nav className="hidden items-center gap-7 md:flex">
          <a href="#what" className={NAV_LINK}>{t("landing.navWhat")}</a>
          <a href="#how" className={NAV_LINK}>{t("landing.navHow")}</a>
          <a href="#start" className={NAV_LINK}>{t("landing.navStart")}</a>
        </nav>
        <div className="md:absolute md:left-1/2 md:-translate-x-1/2"><BrandLockup /></div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="landing-github"
            aria-label={t("nav.starGithub")}
            title={t("nav.starGithub")}
            className="hidden items-center justify-center rounded-md p-1.5 text-[#6B6A62] transition-colors hover:bg-black/[0.05] hover:text-[#1A1A1A] sm:flex dark:text-[#9A9A90] dark:hover:bg-white/[0.07] dark:hover:text-[#EDEDED]"
          >
            <GithubMark className="size-[15px]" />
          </a>
          <LangToggle />
          {!signedIn && (
            <button type="button" onClick={() => onAuth("login")} className="hidden rounded-md px-3 py-1.5 text-[13px] font-medium text-[#555] transition-colors hover:bg-black/[0.05] hover:text-[#1A1A1A] sm:block dark:text-[#B0B0B0] dark:hover:bg-white/[0.07] dark:hover:text-[#EDEDED]">
              {t("landing.login")}
            </button>
          )}
          <button
            type="button"
            onClick={() => (signedIn ? onEnterApp?.() : onAuth("signup"))}
            data-testid={signedIn ? "landing-enter-app-top" : undefined}
            className="rounded-md bg-[#1A1A1A] px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#333] dark:bg-[#EDEDED] dark:text-[#1A1A1A] dark:hover:bg-white"
          >
            {signedIn ? t("landing.backToApp") : t("landing.signup")}
          </button>
        </div>
      </header>

      <section data-testid="landing-hero" className="relative min-h-dvh overflow-hidden">

        <h1
          data-testid="landing-wordmark"
          aria-hidden
          className="lp-wordmark pointer-events-none absolute left-1/2 top-[13vh] z-10 -translate-x-1/2 select-none text-[#D5D7D0] dark:text-[#262626]"
        >
          {PRODUCT_NAME}
        </h1>

        <div
          data-testid="landing-stage"
          className="lp-stage lp-rise absolute inset-x-0 bottom-0 z-20 mx-auto h-[56vh] w-full max-w-[980px] px-5 sm:px-8"
          style={{ "--d": "0.18s" } as React.CSSProperties}
        >
          <div className="h-full overflow-hidden rounded-t-[14px] border border-b-0 border-black/[0.09] bg-white shadow-[0_-30px_90px_-45px_rgba(0,0,0,.4)] dark:border-white/[0.10] dark:bg-[#1A1A1A]">
            <Shot name="session" alt={t("landing.shotAlt")} eager className="block size-full object-cover object-left-top" />
          </div>
        </div>

        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[13vh] bg-gradient-to-t from-[#F4F5F2] via-[#F4F5F2]/72 to-transparent dark:from-[#131313] dark:via-[#131313]/72" />

        <aside data-testid="landing-rail" className="lp-rail fixed left-5 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2.5 xl:flex">
          {RAIL.map(({ id, shot, labelKey }) => (
            <a
              key={id}
              href={`#${id}`}
              data-testid={`landing-rail-${id}`}
              title={t(labelKey)}
              aria-label={t(labelKey)}
              className="group block size-[76px] overflow-hidden rounded-[10px] border border-black/[0.08] bg-white transition-[transform,border-color] duration-200 ease-[cubic-bezier(.16,1,.3,1)] hover:-translate-y-0.5 hover:border-black/[0.22] motion-reduce:hover:translate-y-0 dark:border-white/[0.10] dark:bg-[#1D1D1D] dark:hover:border-white/[0.3]"
            >
              <Shot name={shot} alt="" className="size-full origin-top-left scale-[2.6] object-cover object-left-top opacity-80 transition-opacity duration-200 group-hover:opacity-100" />
            </a>
          ))}
        </aside>

        <div className="lp-hero-foot pointer-events-none absolute inset-x-0 bottom-7 z-30 flex flex-col items-center gap-3 px-6">
          <p className="lp-rise max-w-[46ch] text-center font-mono text-[11.5px] leading-[1.8] tracking-[0.04em] text-[#6B6A62] dark:text-[#9A9A90]" style={{ "--d": "0.3s" } as React.CSSProperties}>
            {t("landing.eyebrow")}
          </p>
          <ChevronDown className="lp-chevron size-[18px] text-[#9A9890] dark:text-[#7A7A72]" strokeWidth={1.5} aria-hidden />
        </div>
      </section>

      <section id="what" data-testid="landing-what" className="mx-auto max-w-[1080px] scroll-mt-24 px-5 pb-16 pt-24 sm:px-8 sm:pt-32">
        <h2 className="lp-reveal max-w-[20ch] text-[clamp(30px,5vw,54px)] font-bold leading-[1.12] tracking-[-0.03em] text-balance">
          {t("landing.h1")}
        </h2>
        <p className="lp-reveal mt-6 max-w-[54ch] text-[15px] leading-[1.75] text-[#6B6A62] dark:text-[#A8A8A0]" style={{ "--d": "0.08s" } as React.CSSProperties}>
          {t("landing.sub")}
        </p>

        <div className="mt-16 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {CLAIMS.map(({ key, Icon }, i) => (
            <div key={key} className="lp-reveal" style={{ "--d": `${i * 0.09}s` } as React.CSSProperties}>
              <Icon strokeWidth={1.4} className="size-[18px] text-[#6B6A62] dark:text-[#A0A098]" aria-hidden />
              <h3 className="mt-3 text-[15px] font-semibold leading-[1.35] tracking-[-0.01em] text-balance">{t(`landing.${key}.t`)}</h3>
              <p className="mt-2 text-[13.5px] leading-[1.7] text-[#6B6A62] dark:text-[#A0A098]">{t(`landing.${key}.d`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" data-testid="landing-how" className="mx-auto max-w-[1080px] scroll-mt-24 px-5 pb-8 pt-16 sm:px-8">
        <div className="lp-reveal mb-10 flex items-center gap-3">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[#8A8880] dark:text-[#9A9A90]">
            {t("landing.proofLabel")}
          </h2>
          <span aria-hidden className="h-px flex-1 bg-black/[0.08] dark:bg-white/[0.10]" />
        </div>

        {PROOFS.map((proof, i) => (
          <article
            key={proof.id}
            id={proof.id}
            data-testid={`landing-proof-${proof.id}`}
            className="lp-reveal grid scroll-mt-24 items-center gap-6 border-t border-black/[0.07] py-12 dark:border-white/[0.09] lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:gap-14"
            style={{ "--d": `${i * 0.05}s` } as React.CSSProperties}
          >
            <div>
              <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.02em] text-balance">{t(proof.titleKey)}</h3>
              <p className="mt-2.5 text-[13.5px] leading-[1.7] text-[#6B6A62] dark:text-[#A0A098]">{t(proof.bodyKey)}</p>
            </div>

            {"live" in proof ? (
              <LandingTelemetrySurface />
            ) : (
              <div className="overflow-hidden rounded-[12px] border border-black/[0.08] bg-white dark:border-white/[0.10] dark:bg-[#1A1A1A]">
                <Shot name={proof.shot} alt={t(proof.titleKey)} className="block h-auto w-full" />
              </div>
            )}
          </article>
        ))}

        <p className="lp-reveal border-t border-black/[0.07] pt-8 text-[12.5px] leading-[1.8] text-[#8A8880] dark:border-white/[0.09] dark:text-[#8A8A82]">
          <span className="font-medium text-[#6B6A62] dark:text-[#A0A098]">{t("landing.alsoLabel")}: </span>
          {t("landing.also")}
        </p>
      </section>

      <section id="start" data-testid="landing-start" className="mx-auto max-w-[1080px] scroll-mt-24 px-5 pb-24 pt-16 text-center sm:px-8">
        <h2 className="lp-reveal mx-auto max-w-[18ch] text-[clamp(26px,4vw,42px)] font-bold leading-[1.15] tracking-[-0.03em] text-balance">
          {t("landing.closingTitle")}
        </h2>
        <div className="lp-reveal mt-8 flex flex-wrap items-center justify-center gap-3" style={{ "--d": "0.06s" } as React.CSSProperties}>
          {primary}
          {!signedIn && (
            <button type="button" onClick={() => onAuth("login")} className="rounded-full px-5 py-3 text-[14px] font-medium text-[#555] transition-colors hover:bg-black/[0.05] hover:text-[#1A1A1A] dark:text-[#B0B0B0] dark:hover:bg-white/[0.07] dark:hover:text-[#EDEDED]">
              {t("landing.ctaSecondary")}
            </button>
          )}
        </div>
        {!signedIn && (
          <p className="lp-reveal mt-5 text-[12.5px] text-[#8A8880] dark:text-[#8A8A82]" style={{ "--d": "0.1s" } as React.CSSProperties} data-testid="landing-signup-terms">
            {t("landing.signupTerms")}
          </p>
        )}
        <p className="lp-reveal mt-4 font-mono text-[11px] tracking-[0.06em] text-[#9A9890] dark:text-[#7A7A72]" style={{ "--d": "0.14s" } as React.CSSProperties}>
          {t("landing.backends")}
        </p>
      </section>

      <footer className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-black/[0.07] px-5 py-6 font-mono text-[11px] tracking-[0.08em] text-[#9A9890] dark:border-white/[0.09] dark:text-[#6E6E68] sm:px-8">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-[8px] rotate-45 rounded-[1px] bg-[#ff003c]" />
          SUBGROUPX · {PRODUCT_NAME}
        </span>
        <span>{t("landing.eyebrow")}</span>
      </footer>
    </main>
  );
}
