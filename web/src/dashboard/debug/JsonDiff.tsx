import { useMemo } from "react";
import { DIFF_MAX_LINES, DIFF_ROW_CLASS, lineDiff, prettyOf } from "./json-view-helpers";

export function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const rows = useMemo(() => {
    const diff = lineDiff(prettyOf(before).split("\n"), prettyOf(after).split("\n"));
    if (diff === null) return null;
    let seq = 0;
    return diff.map((r) => ({ ...r, key: `${seq++} ${r.tag} ${r.text}` }));
  }, [before, after]);
  if (rows === null) {
    return (
      <div className="h-full min-h-0 overflow-auto rounded-lg bg-[#FAFAFA] dark:bg-[#171717] border border-[#F0F0F0] dark:border-[#2A2A2A] p-4 text-[12px] text-[#999] dark:text-[#777]">
        Too large to diff inline (&gt;{DIFF_MAX_LINES} lines). Compare the Request / Replay views directly.
      </div>
    );
  }
  const changed = rows.some((r) => r.tag !== " ");
  return (
    <div
      data-testid="json-diff"
      className="h-full min-h-0 overflow-auto rounded-lg bg-[#FAFAFA] dark:bg-[#171717] border border-[#F0F0F0] dark:border-[#2A2A2A] font-mono text-[11.5px] leading-relaxed"
    >
      {!changed && <div className="px-3 py-2 text-[11px] text-[#AAA] dark:text-[#666] italic">No differences.</div>}
      {rows.map((r) => (
        <div key={r.key} className={`flex whitespace-pre-wrap break-words ${DIFF_ROW_CLASS[r.tag]}`}>
          <span className="w-4 shrink-0 select-none text-center opacity-70">{r.tag === " " ? "" : r.tag}</span>
          <span className="min-w-0">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
