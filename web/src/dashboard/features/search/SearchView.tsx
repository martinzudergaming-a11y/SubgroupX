import { useEffect, useReducer, useRef, useState } from "react";
import { ViewHeader } from "../../ui/ViewHeader.tsx";
import { Search, Hash, CornerDownLeft } from "lucide-react";
import { api } from "../../../platform/api.ts";
import { useT } from "../../../i18n";
import type { SessionInfo, SearchMatch } from "@shared/protocol";

type SearchState = { matches: SearchMatch[]; loading: boolean; searched: boolean };
type SearchAction =
  | { type: "reset" }
  | { type: "start" }
  | { type: "success"; matches: SearchMatch[] }
  | { type: "error" };

const initialSearchState: SearchState = { matches: [], loading: false, searched: false };

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "reset":
      return { ...state, matches: [], searched: false };
    case "start":
      return { ...state, loading: true };
    case "success":
      return { matches: action.matches, loading: false, searched: true };
    case "error":
      return { matches: [], loading: false, searched: true };
  }
}

const KIND_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
  tool: "Tool",
  error: "Error",
  title: "Session",
};

function highlight(text: string, q: string) {
  if (!q) return text;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      out.push(text.slice(i));
      break;
    }
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark key={key++} className="bg-yellow-200/70 dark:bg-yellow-500/30 text-inherit rounded-[2px] px-[1px]">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    i = at + needle.length;
  }
  return out;
}

export function SearchView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  sessions,
  onSelectSession,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  sessions: SessionInfo[];
  onSelectSession: (session: SessionInfo) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [{ matches, loading, searched }, dispatch] = useReducer(searchReducer, initialSearchState);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      dispatch({ type: "reset" });
      return;
    }
    dispatch({ type: "start" });
    const timer = setTimeout(async () => {
      try {
        const res = await api.search(q);
        dispatch({ type: "success", matches: res.matches });
      } catch {
        dispatch({ type: "error" });
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  const groups: { id: string; title: string; rows: SearchMatch[] }[] = [];
  const groupById = new Map<string, { id: string; title: string; rows: SearchMatch[] }>();
  for (const m of matches) {
    let g = groupById.get(m.sessionId);
    if (!g) {
      g = { id: m.sessionId, title: m.sessionTitle, rows: [] };
      groupById.set(m.sessionId, g);
      groups.push(g);
    }
    g.rows.push(m);
  }

  function open(sessionId: string) {
    const s = sessions.find((x) => x.id === sessionId);
    if (s) onSelectSession(s);
  }

  return (
    <div data-testid="search-view" className="relative flex h-full min-w-0 flex-1 flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <ViewHeader
        icon={Search}
        title={t("search.title")}
        subtitle={t("search.headerSubtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
      />

      <div className="px-4 md:px-5 pt-5 pb-2 shrink-0">
        <div className="max-w-[48rem] mx-auto">
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-[#E2E2E2] dark:border-[#3A3A3A] bg-[#FAFAFA] dark:bg-[#222] focus-within:border-[#C0C0C0] dark:focus-within:border-[#555] transition-colors">
            <Search strokeWidth={1.75} className="size-[17px] text-[#999] dark:text-[#888] shrink-0" />
            <input
              ref={inputRef}
              data-testid="search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              className="flex-1 min-w-0 bg-transparent outline-none text-[14px] text-[#222] dark:text-[#E0E0E0] placeholder:text-[#AAA] dark:placeholder:text-[#666]"
            />
            {loading && <span className="shrink-0 text-[11px] text-[#999] dark:text-[#777]">{t("search.searching")}</span>}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-5 pb-8">
        <div className="max-w-[48rem] mx-auto">
          {query.trim().length < 2 && (
            <p className="text-[13px] text-[#999] dark:text-[#777] px-1 py-6 text-center">
              {t("search.hint")}
            </p>
          )}

          {searched && query.trim().length >= 2 && matches.length === 0 && !loading && (
            <p data-testid="search-empty" className="text-[13px] text-[#999] dark:text-[#777] px-1 py-6 text-center break-words">
              {t("search.noMatches", { query: query.trim() })}
            </p>
          )}

          {matches.length > 0 && (
            <p className="text-[12px] text-[#999] dark:text-[#777] px-1 pb-2">
              {t(matches.length === 1 ? "search.summary.matches.one" : "search.summary.matches.other", { n: matches.length })}
              {t(groups.length === 1 ? "search.summary.sessions.one" : "search.summary.sessions.other", { m: groups.length })}
            </p>
          )}

          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g.id} data-testid="search-group">
                <button
                  type="button"
                  onClick={() => open(g.id)}
                  className="flex min-h-10 md:min-h-0 w-full min-w-0 items-center gap-2 mb-1.5 group text-left"
                >
                  <span className="size-[22px] shrink-0 rounded-md bg-[#F0F0F0] dark:bg-[#2A2A2A] flex items-center justify-center text-[#888] dark:text-[#A0A0A0]">
                    <Hash strokeWidth={1.75} className="size-[13px]" />
                  </span>
                  <span className="min-w-0 flex-1 font-semibold text-[13.5px] text-[#333] dark:text-[#E0E0E0] group-hover:text-[#111] dark:group-hover:text-white transition-colors truncate">
                    {g.title}
                  </span>
                  <CornerDownLeft
                    strokeWidth={1.75}
                    className="size-[12px] shrink-0 text-[#BBB] dark:text-[#666] opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </button>
                <div className="flex flex-col gap-1 pl-[30px]">
                  {g.rows.map((m, i) => (
                    <button
                      key={`${m.seq}-${i}`}
                      type="button"
                      data-testid="search-result"
                      onClick={() => open(m.sessionId)}
                      className="flex min-h-10 md:min-h-0 items-start gap-2.5 w-full text-left px-3 py-2 rounded-lg hover:bg-[#F7F7F7] dark:hover:bg-[#252525] transition-colors"
                    >
                      <span className="shrink-0 mt-[1px] text-[10.5px] font-medium uppercase tracking-wide text-[#999] dark:text-[#777] w-[58px]">
                        {KIND_LABEL[m.kind] ?? m.kind}
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] text-[#555] dark:text-[#B5B5B5] leading-snug break-words">
                        {highlight(m.snippet, query.trim())}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
