import { useEffect, useMemo, useState } from "react";
import { Spinner } from "../ui/Spinner";
import { ChevronRight, GitBranch, RefreshCw, ScanSearch, FilePlus2, FileMinus2, FilePenLine, FileSymlink } from "lucide-react";
import type { WorkspaceDiff, DiffFile, DiffFileStatus, SessionInfo } from "@shared/protocol";
import { api } from "../platform/api.ts";
import { useT } from "../i18n";
import { REVIEW_PROMPT } from "../conversation/slash-commands";
import CodeBlock from "../conversation/markdown/CodeBlock";

const STATUS_META: Record<DiffFileStatus, { icon: typeof FilePlus2; cls: string; badge: string }> = {
  added: { icon: FilePlus2, cls: "text-[#2f8052] dark:text-[#54b879]", badge: "A" },
  untracked: { icon: FilePlus2, cls: "text-[#2f8052] dark:text-[#54b879]", badge: "U" },
  deleted: { icon: FileMinus2, cls: "text-[#c44f4a] dark:text-[#d67670]", badge: "D" },
  modified: { icon: FilePenLine, cls: "text-[#a07013] dark:text-[#d6a038]", badge: "M" },
  renamed: { icon: FileSymlink, cls: "text-[#0b73da] dark:text-[#1b87f3]", badge: "R" },
};

function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

function FileRow({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  const t = useT();
  const meta = STATUS_META[file.status] ?? STATUS_META.modified;
  const Icon = meta.icon;
  const { dir, base } = splitPath(file.path);
  return (
    <div className="border-b border-[#F0EFE8] dark:border-[#262626] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[#F6F5EF] dark:hover:bg-[#232323] transition-colors"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <ChevronRight strokeWidth={2} className={`size-3.5 shrink-0 text-[#B0AEA2] dark:text-[#6E6E66] transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon strokeWidth={1.75} className={`size-3.5 shrink-0 ${meta.cls}`} />
        <span className="flex min-w-0 flex-1 items-baseline">
          <span className="truncate font-medium text-[12.5px] text-[#333] dark:text-[#E0E0E0]">{base}</span>
          {dir && <span className="truncate text-[11px] text-[#999] dark:text-[#777] ml-1 direction-rtl" style={{ direction: "rtl", unicodeBidi: "plaintext" }}>{dir}</span>}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-[11px] flex items-center gap-1.5">
          {file.added > 0 && <span className="text-[#2f8052] dark:text-[#54b879]">+{file.added}</span>}
          {file.removed > 0 && <span className="text-[#c44f4a] dark:text-[#d67670]">−{file.removed}</span>}
          {file.binary && <span className="text-[#999] dark:text-[#777]">{t("changes.binary")}</span>}
        </span>
      </button>
      {open && !file.binary && (
        <div className="max-h-[60vh] overflow-auto border-t border-[#F0EFE8] dark:border-[#262626]">
          <CodeBlock code={file.patch} language="diff" hideHeader />
        </div>
      )}
    </div>
  );
}

export function ChangesPane({
  sessionId,
  session,
  refreshKey,
  onRequestReview,
  fallbackFiles = [],
}: {
  sessionId: string;
  session?: SessionInfo | null;
  refreshKey: number;
  onRequestReview: (prompt: string) => void;
  fallbackFiles?: { path: string; kind: "write" | "edit" }[];
}) {
  const t = useT();
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.diff(sessionId)
      .then((d) => { if (live) { setDiff(d); setOpen((cur) => (cur.size ? cur : new Set(d.files.slice(0, 1).map((f) => f.path)))); } })
      .catch(() => { if (live) setDiff({ isRepo: false, files: [] }); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sessionId, refreshKey, reloadTick]);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return { files: files.length, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) };
  }, [diff]);

  const running = session?.status === "running";
  const hasChanges = (diff?.files.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">

      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[#EFEDE3] dark:border-[#2C2C2C] shrink-0">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] text-[#888] dark:text-[#999]">
          <GitBranch strokeWidth={1.75} className="size-3.5 shrink-0" />
          <span className="truncate">
            {diff?.isRepo
              ? <>{diff.branch || t("changes.detached")}{diff.head ? <span className="text-[#B0AEA2] dark:text-[#6E6E66]"> · {diff.head}</span> : null}</>
              : t("changes.noRepo")}
          </span>
          {hasChanges && (
            <span className="shrink-0 font-mono tabular-nums text-[10.5px] ml-1">
              <span className="text-[#2f8052] dark:text-[#54b879]">+{totals.added}</span>{" "}
              <span className="text-[#c44f4a] dark:text-[#d67670]">−{totals.removed}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((n) => n + 1)}
          title={t("changes.refresh")}
          aria-label={t("changes.refresh")}
          className="flex size-6 items-center justify-center rounded-md text-[#888] dark:text-[#8C8C8C] hover:text-[#1A1A1A] dark:hover:text-[#EDEDED] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
        >
          <RefreshCw strokeWidth={1.75} className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          data-testid="review-changes"
          disabled={!hasChanges || running}
          onClick={() => onRequestReview(REVIEW_PROMPT)}
          title={running ? t("changes.reviewBusy") : t("changes.reviewHint")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[#0d74ce] dark:text-[#70b8ff] enabled:hover:bg-[#ECF1F8] dark:enabled:hover:bg-[#1B2433]"
        >
          <ScanSearch strokeWidth={1.75} className="size-3.5" />
          {t("changes.review")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !diff ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-[#999] dark:text-[#777]">
            <Spinner className="size-4" strokeWidth={2.2} /> {t("changes.loading")}
          </div>
        ) : !diff?.isRepo ? (
          fallbackFiles.length > 0 ? (
            <div>
              <div className="px-3 pt-2.5 pb-1.5 text-[11px] text-[#999] dark:text-[#777]">{t("changes.noRepoFallback")}</div>
              {fallbackFiles.map((f, i) => {
                const { dir, base } = splitPath(f.path);
                const M = STATUS_META[f.kind === "write" ? "added" : "modified"];
                const Icon = M.icon;
                return (
                  <div key={`${f.path}-${i}`} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[#F0EFE8] dark:border-[#262626] last:border-b-0" title={f.path}>
                    <Icon strokeWidth={1.75} className={`size-3.5 shrink-0 ${M.cls}`} />
                    <span className="truncate font-medium text-[12.5px] text-[#333] dark:text-[#E0E0E0]">{base}</span>
                    {dir && <span className="truncate text-[11px] text-[#999] dark:text-[#777]" style={{ direction: "rtl", unicodeBidi: "plaintext" }}>{dir}</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-4 py-10 text-center text-[12.5px] text-[#999] dark:text-[#777]">{t("changes.noRepoBody")}</div>
          )
        ) : !hasChanges ? (
          <div className="px-4 py-10 text-center text-[12.5px] text-[#999] dark:text-[#777]">{t("changes.none")}</div>
        ) : (
          <>
            {diff.files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                open={open.has(f.path)}
                onToggle={() => setOpen((cur) => { const n = new Set(cur); n.has(f.path) ? n.delete(f.path) : n.add(f.path); return n; })}
              />
            ))}
            {diff.truncated && (
              <div className="px-3 py-2 text-[11px] text-[#999] dark:text-[#777]">{t("changes.truncated")}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
