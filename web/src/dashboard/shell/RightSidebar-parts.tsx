import { VscFolder, VscFolderOpened, VscChevronRight, VscChevronDown, VscClose } from "react-icons/vsc";
import { Download, Copy, Check } from "lucide-react";
import React, { lazy, Suspense, useEffect, useState } from "react";
import { api, type CompactionDetailResponse } from "../../platform/api.ts";
import { useT } from "../../i18n";
import type { TimelineItem } from "@shared/protocol";
import { fileIconFor } from "../../files/fileIcons";
import { TOOL_STATUS_PILL } from "../../ui/status-colors";

const FOLDER_ICON_CLASS = "size-[15px] text-[#555] dark:text-[#A0A0A0] shrink-0";

const CompactionDetail = lazy(() => import("../session/tools/CompactionDetail"));

export function CompactionPane({ sessionId, compactionId }: { sessionId: string; compactionId: string }) {
  const t = useT();
  const [detail, setDetail] = useState<CompactionDetailResponse | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(false);
    api
      .getCompaction(sessionId, compactionId)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [sessionId, compactionId]);

  const loading = <div className="text-[13px] text-[#999] dark:text-[#888] animate-pulse">{t("compaction.loading")}</div>;
  return (
    <div data-testid="compaction-pane" className="flex-1 overflow-y-auto w-full px-4 py-4">
      {error ? (
        <div className="text-[13px] text-[#A33] dark:text-[#F2B0B0]">{t("compaction.error")}</div>
      ) : !detail ? (
        loading
      ) : (
        <Suspense fallback={loading}>
          <CompactionDetail detail={detail} />
        </Suspense>
      )}
    </div>
  );
}

type TreeItemProps = {
  name: string;
  depth: number;
  kind: 'folder' | 'file';
  isOpen?: boolean;
  isActive?: boolean;
  onClick?: () => void;
  onHover?: () => void;
  onHoverEnd?: () => void;
  onDownload?: () => void;
  onCopy?: () => void;
  copied?: boolean;
  testId?: string;
}

export function TreeItem({ name, depth, kind, isOpen, isActive, onClick, onHover, onHoverEnd, onDownload, onCopy, copied, testId }: TreeItemProps) {
  const paddingLeft = depth * 14 + 10;
  const stop = (fn?: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn?.(); };

  return (
    <div className="px-1.5 w-full py-[1px]">
      <div
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') onHover?.(); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') onHoverEnd?.(); }}
        className={`group flex min-w-0 items-center text-[13px] text-[#333] dark:text-[#E0E0E0] min-h-[34px] md:min-h-[26px] ${isActive ? 'bg-[#E3E3E3] dark:bg-[#333] rounded-[6px]' : 'hover:bg-[#F3F4F6] dark:hover:bg-[#2A2A2A] rounded-[6px]'}`}
      >
        <button
          type="button"
          data-testid={testId}
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center cursor-pointer text-inherit min-h-[34px] md:min-h-[26px]"
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          <div className="flex items-center w-[16px] shrink-0">
            {kind === 'folder' ? (isOpen ? <VscChevronDown className="size-4 text-[#777] dark:text-[#A0A0A0]" /> : <VscChevronRight className="size-4 text-[#777] dark:text-[#A0A0A0]" />) : null}
          </div>
          <div className="w-[18px] flex items-center justify-center shrink-0">
            {kind === 'folder'
              ? (isOpen ? <VscFolderOpened className={FOLDER_ICON_CLASS} /> : <VscFolder className={FOLDER_ICON_CLASS} />)
              : fileIconFor(name)}
          </div>
          <span className="min-w-0 flex-1 truncate pr-2 tracking-wide font-medium text-[#444] dark:text-[#D0D0D0] ml-1 text-left">{name}</span>
        </button>
        {kind === 'file' && (onCopy || onDownload) && (
          <div className="flex items-center gap-0.5 shrink-0 pr-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {onCopy && (
              <button
                type="button"
                aria-label="Copy file contents"
                onClick={stop(onCopy)}
                className="p-1 rounded-md text-[#888] dark:text-[#999] hover:text-[#222] dark:hover:text-[#E0E0E0] hover:bg-[#E3E3E3] dark:hover:bg-[#3A3A3A] transition-colors"
              >
                {copied ? <Check className="size-[13px] text-[#2E7D45]" /> : <Copy className="size-[13px]" />}
              </button>
            )}
            {onDownload && (
              <button
                type="button"
                aria-label="Download file"
                onClick={stop(onDownload)}
                className="p-1 rounded-md text-[#888] dark:text-[#999] hover:text-[#222] dark:hover:text-[#E0E0E0] hover:bg-[#E3E3E3] dark:hover:bg-[#3A3A3A] transition-colors"
              >
                <Download className="size-[13px]" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export function StatusPill({ status, termination }: { status: string; termination?: "cancelled" }) {
  const label = termination === "cancelled" ? "cancelled" : status;
  const pill = termination === "cancelled"
    ? "bg-[#F4F4F5] dark:bg-[#2A2A2A] text-[#7D827A] dark:text-[#999]"
    : TOOL_STATUS_PILL[status] ?? TOOL_STATUS_PILL.pending;
  return (
    <span className={`px-2 py-[2px] rounded-full text-[11.5px] font-medium shrink-0 ${pill}`}>{label}</span>
  );
}

export function TabItem({ icon, label, compact = false, isActive, onClick, onClose }: { icon: React.ReactNode, label?: string, compact?: boolean, isActive: boolean, onClick: () => void, onClose?: () => void }) {
  return (
    <div
      title={label}
      className={`group relative flex items-center h-9 md:h-[28px] rounded-md cursor-pointer transition-colors shrink-0 select-none overflow-hidden
        ${compact ? 'w-9 md:w-[30px]' : 'max-w-[160px] md:max-w-[200px]'}
        ${isActive ? 'bg-[#EAEAEA] dark:bg-[#333] text-[#333] dark:text-[#E0E0E0]' : 'text-[#666] dark:text-[#A0A0A0] hover:bg-[#F3F4F6] dark:hover:bg-[#2A2A2A] hover:text-[#444] dark:hover:text-[#D0D0D0]'}`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`flex size-full min-w-0 items-center text-inherit ${compact ? 'justify-center px-0' : 'space-x-[6px] pl-3 pr-3'}`}
      >
        <span className={`shrink-0 flex items-center justify-center ${isActive ? 'opacity-100' : 'opacity-80'}`}>{icon}</span>
        {label && !compact && <span className="text-[12.5px] truncate flex items-center mt-[1px]">{label}</span>}
      </button>

      {onClose && (
        <div
          className={compact
            ? "absolute -right-px -top-px flex size-4 items-center justify-center rounded-full bg-[#F3F4F6] text-[#777] opacity-100 shadow-sm ring-1 ring-white transition-opacity hover:bg-[#DFDFDF] hover:text-[#111] md:opacity-0 md:group-hover:opacity-100 dark:bg-[#2A2A2A] dark:text-[#A0A0A0] dark:ring-[#1A1A1A] dark:hover:bg-[#444] dark:hover:text-[#E0E0E0]"
            : `absolute right-0 top-0 bottom-0 w-10 md:w-[36px] pr-1.5 flex items-center justify-end opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity
              ${isActive
                ? 'bg-[linear-gradient(to_right,transparent,#EAEAEA_12px,#EAEAEA)] dark:bg-[linear-gradient(to_right,transparent,#333_12px,#333)]'
                : 'bg-[linear-gradient(to_right,transparent,#F3F4F6_12px,#F3F4F6)] dark:bg-[linear-gradient(to_right,transparent,#2A2A2A_12px,#2A2A2A)]'
              }`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label={`Close ${label ?? 'tab'}`}
            className={compact ? "p-0" : "p-1.5 md:p-[3px] rounded-md hover:bg-[#DFDFDF] dark:hover:bg-[#444] hover:text-[#111] dark:hover:text-[#E0E0E0] text-[#777] dark:text-[#A0A0A0] transition-colors"}
          >
            <VscClose className={compact ? "size-3" : "size-3.5"} />
          </button>
        </div>
      )}
    </div>
  );
}
