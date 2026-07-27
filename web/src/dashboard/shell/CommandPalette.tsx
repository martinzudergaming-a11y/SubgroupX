import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LazyMotion, m, domAnimation, AnimatePresence } from "motion/react";
import { useT } from "../../i18n";
import { useOnEscape } from "../ui/use-on-escape";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

function fuzzyMatch(query: string, hay: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  let i = 0;
  for (let j = 0; j < h.length && i < q.length; j++) if (h[j] === q[i]) i++;
  return i === q.length;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`)),
    [commands, query],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useOnEscape(() => { if (open) onClose(); });

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    requestAnimationFrame(() => c.run());
  };

  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence>
        <m.div
          key="cmdk"
          data-testid="command-palette"
          className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div className="absolute inset-0 bg-black/20 dark:bg-black/45" />
          <m.div
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-[560px] rounded-2xl border border-[#E4E2D3] dark:border-[#333] bg-[var(--app-surface)] dark:bg-[#1E1E1E] oiia-shadow-modal overflow-hidden"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(filtered[active]); }
            }}
          >
            <input
              ref={inputRef}
              data-testid="command-palette-input"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              placeholder={t("cmdk.placeholder")}
              className="w-full bg-transparent px-4 py-3.5 text-[15px] text-[#222] dark:text-[#E8E8E8] outline-none placeholder:text-[#A5A398] border-b border-[#EFEDE3] dark:border-[#2E2E2E]"
              spellCheck={false}
              autoComplete="off"
            />

            <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5 scroll-py-1.5 hide-scrollbar">
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center text-[13px] text-[#999] dark:text-[#777]">{t("cmdk.empty")}</div>
              ) : (
                filtered.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    data-active={i === active}
                    data-testid={`cmdk-item-${c.id}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(c)}
                    className={`w-full flex items-center gap-3 px-3 rounded-lg py-2 text-left transition-colors ${
                      i === active ? "bg-[#F1ECE1] dark:bg-[#2C2A22]" : ""
                    }`}
                  >
                    {c.icon && <span className="shrink-0 text-[#777] dark:text-[#9A988A] flex items-center">{c.icon}</span>}
                    <span className="flex-1 min-w-0 truncate text-[13.5px] text-[#333] dark:text-[#E0E0E0]">{c.label}</span>
                    {c.hint && <span className="shrink-0 text-[11px] text-[#A5A398] dark:text-[#777] tabular-nums">{c.hint}</span>}
                  </button>
                ))
              )}
            </div>
          </m.div>
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
}
