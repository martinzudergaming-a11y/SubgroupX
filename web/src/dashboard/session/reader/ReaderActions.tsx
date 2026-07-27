import { useEffect, useRef, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { ArrowDown } from "lucide-react";
import { OutlineGlyph, ShareGlyph } from "./reader-glyphs";
import { AnimatePresence, LazyMotion, domAnimation, m } from "motion/react";
import { useT } from "../../../i18n";
import { IS_STANDALONE } from "../../../platform/pwa";

export interface TocPrompt {
  turnId: string;
  id: string;
  text: string;
  idx: number;
  inferred: boolean;
}

const TOC_PANEL_ID = "conversation-toc-panel";

type DockVariant = "rail" | "corner" | "shoulder";
const DOCK_VARIANT: DockVariant = (() => {
  try {
    const v = localStorage.getItem("oiia.dockVariant");
    return v === "corner" || v === "shoulder" ? v : "rail";
  } catch {
    return "rail";
  }
})();

export function ReaderActionDock({
  bottom,
  turns,
  tocOpen,
  setTocOpen,
  tocActiveId,
  onJumpToPrompt,
  onShare,
  visible,
  recessed = false,
}: {
  bottom: number;
  turns: TocPrompt[];
  tocOpen: boolean;
  setTocOpen: Dispatch<SetStateAction<boolean>>;
  tocActiveId: string | null;
  onJumpToPrompt: (id: string, idx: number) => void;
  onShare?: () => void;
  visible: boolean;
  recessed?: boolean;
}) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const showToc = turns.length > 1;

  const closeAndRestoreFocus = () => {
    setTocOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    if (!tocOpen) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const active = panel?.querySelector<HTMLElement>('[role="menuitem"][aria-current="true"]');
      const target = active ?? panel?.querySelector<HTMLElement>('[role="menuitem"]');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tocOpen]);

  useEffect(() => {
    if (!showToc && tocOpen) setTocOpen(false);
  }, [showToc, setTocOpen, tocOpen]);

  useEffect(() => {
    if (!visible && tocOpen) setTocOpen(false);
  }, [visible, setTocOpen, tocOpen]);

  useEffect(() => {
    if (DOCK_VARIANT === "rail" && recessed && tocOpen) setTocOpen(false);
  }, [recessed, setTocOpen, tocOpen]);

  if (!showToc && !onShare) return null;

  const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (rows.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, rows.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % rows.length
          : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const actionClass =
    "flex size-10 items-center justify-center rounded-full text-[#6C7065] outline-none transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(.16,1,.3,1)] hover:bg-[#F1EFE8] hover:text-[#20231D] active:scale-[.96] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/30 md:size-8 @5xl:size-9 dark:text-[#A6A99F] dark:hover:bg-[#2D2B25] dark:hover:text-[#F0F0EA] motion-reduce:transition-none";
  const actionOpenClass = " bg-[#EEF1EA] text-[#20231D] dark:bg-[#30312D] dark:text-[#F0F0EA]";
  const anchorWide = DOCK_VARIANT === "shoulder" ? "@5xl:col-start-2" : "@5xl:col-start-3 @5xl:justify-start";
  const dockWide = DOCK_VARIANT === "shoulder" ? "" : " @5xl:ml-2";
  const recessWide =
    DOCK_VARIANT === "rail" && recessed ? " @5xl:pointer-events-none @5xl:translate-y-1 @5xl:opacity-0" : "";
  const tabbable = visible && !(DOCK_VARIANT === "rail" && recessed);

  return (
    <div
      data-testid="reader-actions-layer"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 sm:px-6"
      style={{
        "--dock-b": `${bottom}px`,
        "--dock-b-wide": `calc(var(--composer-pb, ${IS_STANDALONE ? "calc(env(safe-area-inset-bottom, 0px) + 2.25rem)" : "0.75rem"}) + 0.25rem)`,
      } as React.CSSProperties}
      aria-hidden={!visible}
      onDragEnter={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "none";
      }}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="@container w-full max-w-[var(--composer-dock-w)]">
        <div className={`mx-auto grid w-full max-w-[var(--composer-stack-w)] grid-cols-1 pb-[var(--dock-b)] @5xl:max-w-none @5xl:grid-cols-[minmax(0,1fr)_minmax(20rem,var(--composer-w))_minmax(0,1fr)]${DOCK_VARIANT === "rail" ? " @5xl:pb-[var(--dock-b-wide)]" : ""}`}>
          <div data-testid="reader-actions-anchor" className={`col-start-1 flex min-w-0 justify-end ${anchorWide}`}>
            <div
              data-testid="reader-actions-dock"
              className={`pointer-events-auto relative flex h-11 items-center gap-0.5 rounded-full border border-[#E3E6DD] bg-[var(--app-surface)] px-0.5 shadow-[0_2px_10px_-8px_rgba(35,39,31,.4)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(.16,1,.3,1)] md:h-10 md:px-1 @5xl:border-transparent @5xl:bg-transparent @5xl:px-0 @5xl:shadow-none @5xl:gap-1 dark:border-[#3A3C38] dark:bg-[#292A27] dark:shadow-[0_3px_12px_-8px_rgba(0,0,0,.8)] @5xl:dark:border-transparent @5xl:dark:bg-transparent @5xl:dark:shadow-none ${
                visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
              }${dockWide}${recessWide} motion-reduce:transition-none`}
            >
              <LazyMotion features={domAnimation}>
                <AnimatePresence>
                  {tocOpen && (
                    <>
                      <button
                        type="button"
                        aria-label={t("common.close")}
                        tabIndex={-1}
                        className="fixed inset-0 z-40 cursor-default"
                        onClick={closeAndRestoreFocus}
                      />
                      <m.div
                        ref={panelRef}
                        id={TOC_PANEL_ID}
                        role="menu"
                        aria-label={t("toc.title")}
                        onKeyDown={moveMenuFocus}
                        initial={{ opacity: 0, scale: 0.97, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 5 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        data-testid="conversation-toc-panel"
                        className={`absolute bottom-full z-50 mb-2 max-h-[min(60vh,32rem)] w-[min(280px,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-[#E4E7DF] bg-white p-1.5 oiia-shadow-pop dark:border-[#333] dark:bg-[#1E1E1E] right-0 origin-bottom-right${DOCK_VARIANT === "rail" ? " @5xl:left-0 @5xl:right-auto @5xl:origin-bottom-left" : ""}`}
                      >
                        <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[#999] select-none dark:text-[#777]">
                          {t("toc.title")}
                        </div>
                        {turns.map((prompt, index) => {
                          const active = prompt.id === tocActiveId;
                          const firstLine = prompt.text.split("\n").find((line) => line.trim()) ?? prompt.text;
                          return (
                            <button
                              key={prompt.id}
                              type="button"
                              role="menuitem"
                              data-testid="toc-row"
                              aria-current={active ? "true" : undefined}
                              title={firstLine}
                              onClick={() => {
                                onJumpToPrompt(prompt.id, prompt.idx);
                                requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
                              }}
                              className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors md:py-1.5 ${
                                active
                                  ? "bg-[#F0F2EC] text-[#222] dark:bg-[#2A2A2A] dark:text-[#E8E8E8]"
                                  : "text-[#555] hover:bg-[#F6F7F3] focus-visible:bg-[#F6F7F3] dark:text-[#B0B0B0] dark:hover:bg-[#262626] dark:focus-visible:bg-[#262626]"
                              }`}
                            >
                              <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-[#AAA] dark:text-[#666]">{index + 1}</span>
                              <span className="truncate text-[12.5px] leading-[1.5]">{firstLine}</span>
                            </button>
                          );
                        })}
                      </m.div>
                    </>
                  )}
                </AnimatePresence>
              </LazyMotion>

              {showToc && (
                <button
                  ref={triggerRef}
                  type="button"
                  data-testid="conversation-toc"
                  aria-label={t("toc.title")}
                  title={t("toc.title")}
                  aria-expanded={tocOpen}
                  aria-haspopup="menu"
                  aria-controls={TOC_PANEL_ID}
                  tabIndex={tabbable ? 0 : -1}
                  onClick={() => setTocOpen((open) => !open)}
                  className={`${actionClass}${tocOpen ? actionOpenClass : ""}`}
                >
                  <OutlineGlyph className="size-4" />
                </button>
              )}
              {onShare && (
                <button
                  type="button"
                  data-testid="chat-share"
                  aria-label={t("share.scope.shareButton")}
                  title={t("share.scope.shareButton")}
                  tabIndex={tabbable ? 0 : -1}
                  onClick={onShare}
                  className={actionClass}
                >
                  <ShareGlyph className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function JumpToLatest({
  bottom,
  show,
  onJump,
}: {
  bottom: number;
  show: boolean;
  onJump: () => void;
}) {
  const t = useT();
  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-40 flex justify-center px-4 sm:px-6"
      style={{ bottom }}
      aria-hidden={!show}
    >
      <div className="@container w-full max-w-[var(--composer-dock-w)]">
        <div className="mx-auto grid w-full max-w-[var(--composer-stack-w)] grid-cols-1 @5xl:max-w-none @5xl:grid-cols-[minmax(0,1fr)_minmax(20rem,var(--composer-w))_minmax(0,1fr)]">
          <div data-testid="jump-to-latest-anchor" className="col-start-1 flex min-w-0 justify-center @5xl:col-start-2">
            <button
              type="button"
              data-testid="jump-to-latest"
              aria-label={t("chat.jumpToLatest")}
              title={t("chat.jumpToLatest")}
              tabIndex={show ? 0 : -1}
              onClick={onJump}
              className={`pointer-events-auto flex size-11 items-center justify-center gap-1.5 rounded-full border bg-[var(--app-surface)] text-[#5F625B] outline-none shadow-[0_3px_10px_-6px_rgba(35,39,31,0.34)] transition-[opacity,transform,background-color,color,border-color] duration-200 ease-[cubic-bezier(.16,1,.3,1)] md:h-8 md:w-auto md:px-3 md:text-[12px] md:font-medium dark:bg-[#242522] dark:text-[#B9BBB4] dark:shadow-[0_4px_12px_-6px_rgba(0,0,0,0.65)] ${
                show
                  ? "translate-y-0 border-[#DDE1D8] opacity-100 hover:border-[#CED3C8] hover:bg-white hover:text-[#252721] dark:border-[#3B3D38] dark:hover:border-[#4A4D46] dark:hover:bg-[#2B2C28] dark:hover:text-[#F0F0EA]"
                  : "pointer-events-none translate-y-1 border-transparent opacity-0"
              } focus-visible:ring-2 focus-visible:ring-[#C77D2E]/30 motion-reduce:transition-none`}
            >
              <ArrowDown strokeWidth={2.1} className="size-[15px] shrink-0" />
              <span className="hidden md:inline">{t("chat.jumpToLatest")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
