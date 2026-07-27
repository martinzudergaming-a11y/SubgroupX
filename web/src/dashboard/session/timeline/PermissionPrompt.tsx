import { useEffect, useRef } from "react";
import type { PermissionDecision, PermissionRequestPayload } from "@shared/protocol";
import { useT } from "../../../i18n";
import { StatusDot } from "../../../ui/StatusDot";
import { permissionSubject } from "./permission-subject";

export function PermissionPrompt({
  request,
  onRespond,
}: {
  request: PermissionRequestPayload;
  onRespond: (decision: PermissionDecision) => void;
}) {
  const t = useT();
  const { titleKey, confirmKey, refuseKey, subject, kind } = permissionSubject(request);
  const rootRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const typing = Boolean(active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA"));
    if (!typing) runRef.current?.focus({ preventScroll: true });
  }, [request.requestId]);

  return (
    <div
      ref={rootRef}
      data-testid="permission"
      role="group"
      aria-label={t(titleKey)}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Enter") {
          if ((event.target as HTMLElement | null)?.closest("button, a, input, textarea, select")) return;
          event.preventDefault();
          onRespond("approve");
        } else if (event.key === "Escape") {
          event.preventDefault();
          onRespond("deny");
        }
      }}
      className="mt-5 rounded-[14px] border border-[#E1E4DC] bg-[#FDFEFA] p-4 dark:border-[#373733] dark:bg-[#20201E]"
    >
      <div className="flex items-center gap-2">

        <StatusDot tone="working" pulse />
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#302F2A] dark:text-[#E8E5DC]">
          {t(titleKey)}
        </h3>
      </div>

      <pre
        data-testid="perm-summary"
        className={`mt-2.5 max-h-[9.5rem] overflow-auto whitespace-pre-wrap rounded-[9px] border border-[#E6E8E1] bg-[#F6F7F3] px-3 py-2.5 text-[12.5px] leading-[1.65] text-[#3F3E39] dark:border-[#3B3B36] dark:bg-[#252521] dark:text-[#D5D2C9] ${kind === "prose" ? "font-sans" : ""}`}
        style={kind === "prose" ? undefined : { fontFamily: "var(--font-code)" }}
      >
        {subject}
      </pre>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button
          ref={runRef}
          type="button"
          data-testid="perm-approve"
          onClick={() => onRespond("approve")}
          className="primary !min-h-9 !rounded-[10px] !px-3.5 !py-1.5 !text-[13px] inline-flex items-center gap-2"
        >
          {t(confirmKey)}
          <Keycap>↵</Keycap>
        </button>
        <button
          type="button"
          data-testid="perm-deny"
          onClick={() => onRespond("deny")}
          className="secondary !min-h-9 !rounded-[10px] !px-3.5 !py-1.5 !text-[13px] inline-flex items-center gap-2"
        >
          {t(refuseKey)}
          <Keycap>esc</Keycap>
        </button>

        <button
          type="button"
          data-testid="perm-approve-session"
          onClick={() => onRespond("approve_session")}
          className="ml-auto rounded-[8px] px-2 py-1.5 text-[12px] text-[#77766E] underline decoration-[#D7D4CA] underline-offset-[3px] transition-colors hover:text-[#302F2A] focus-visible:ring-2 focus-visible:ring-[#C77D2E]/35 dark:text-[#A6A299] dark:decoration-[#4A4841] dark:hover:text-[#E8E5DC]"
        >
          {t("perm.alwaysThisSession")}
        </button>
      </div>
    </div>
  );
}

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="hidden rounded-[4px] border border-white/25 px-1 font-mono text-[10px] leading-[1.5] opacity-70 sm:inline-block [.secondary_&]:border-black/15 dark:[.secondary_&]:border-white/20"
    >
      {children}
    </span>
  );
}
