import { Server, Boxes, Laptop, Plug } from "lucide-react";
import type { SandboxKind, SessionStatus } from "@shared/protocol";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n/en";

const KIND_META: Record<SandboxKind, { icon: typeof Server; labelKey: TranslationKey; tone: string }> = {
  local: {
    icon: Server,
    labelKey: "sandbox.kind.local",
    tone: "bg-[#EEF0F2] dark:bg-[#26292E] text-[#5A6270] dark:text-[#9AA3B2]",
  },
  e2b: {
    icon: Boxes,
    labelKey: "sandbox.kind.e2b",
    tone: "bg-[#ECEDFB] dark:bg-[#222138] text-[#5B57C9] dark:text-[#9E9BE0]",
  },
  ssh: {
    icon: Laptop,
    labelKey: "sandbox.kind.ssh",
    tone: "bg-[#E7F4EC] dark:bg-[#1B2A22] text-[#3F8560] dark:text-[#7FC3A0]",
  },
  connector: {
    icon: Plug,
    labelKey: "sandbox.kind.connector",
    tone: "bg-[#F7F0E2] dark:bg-[#2A2519] text-[#8A6D2E] dark:text-[#CBAE6E]",
  },
};

export function SandboxKindBadge({
  kind,
  host,
  compact,
  className = "",
}: {
  kind: SandboxKind;
  host?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const meta = KIND_META[kind] ?? KIND_META.local;
  const Icon = meta.icon;
  const label = t(meta.labelKey);
  const text = (kind === "ssh" || kind === "connector") && host ? host : label;
  const title = `${label}${host ? ` · ${host}` : ""} — ${t(`sandbox.kind.${kind}.desc` as TranslationKey)}`;
  return (
    <span
      data-testid="sandbox-kind"
      data-kind={kind}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md text-[11px] font-medium leading-none select-none ${meta.tone} ${compact ? "p-1" : "px-1.5 py-1"} ${className}`}
    >
      <Icon strokeWidth={1.75} className="size-[13px] shrink-0" />
      {!compact && <span className="truncate max-w-[120px]">{text}</span>}
    </span>
  );
}

const STATUS_TONE: Record<"running" | "error" | "idle", string> = {
  running: "text-[#C58A2E] dark:text-[#D8A94E]",
  error: "text-[#B4472F] dark:text-[#D98A72]",
  idle: "text-[#B0AEA2] dark:text-[#6E6E66]",
};

export function SessionKindStatus({
  kind,
  status,
  host,
}: {
  kind: SandboxKind;
  status?: SessionStatus;
  host?: string | null;
}) {
  const t = useT();
  const meta = KIND_META[kind] ?? KIND_META.local;
  const Icon = meta.icon;
  const running = status === "running";
  const tone = status === "error" ? STATUS_TONE.error : running ? STATUS_TONE.running : STATUS_TONE.idle;
  const kindLabel = t(meta.labelKey);
  const statusLabel = t(`sandbox.status.${status ?? "idle"}` as TranslationKey);
  return (
    <span
      data-testid="session-kind-status"
      data-kind={kind}
      data-status={status ?? "idle"}
      title={`${kindLabel}${host ? ` · ${host}` : ""} — ${statusLabel}`}
      className={`inline-flex items-center justify-center shrink-0 ${tone}`}
    >
      <Icon strokeWidth={2} className={`size-[14px] ${running ? "activity-dot-pulse" : ""}`} />
    </span>
  );
}
