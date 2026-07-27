import type {
  AgentNodeStatus,
  TaskStatus,
  TeamMailDeliveryStatus,
  TeamMemberStatus,
  TeamStatus,
  WorkflowNodeStatus,
  WorkflowStatus,
} from "@shared/orchestration";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { StatusDot, type StatusTone } from "../ui/StatusDot";

export type OrchestrationStatusValue =
  | AgentNodeStatus
  | TaskStatus
  | WorkflowStatus
  | WorkflowNodeStatus
  | TeamStatus
  | TeamMemberStatus
  | TeamMailDeliveryStatus;

const TONE: Record<OrchestrationStatusValue, StatusTone> = {
  initializing: "working",
  idle: "idle",
  running: "working",
  interrupted: "muted",
  error: "error",
  closed: "muted",
  queued: "info",
  starting: "working",
  waiting: "working",
  cancel_requested: "working",
  cancelling: "working",
  succeeded: "live",
  failed: "error",
  cancelled: "muted",
  draft: "muted",
  blocked: "muted",
  ready: "info",
  active: "live",
  paused: "working",
  removed: "muted",
  claimed: "working",
  acknowledged: "live",
};

const LABEL: Record<OrchestrationStatusValue, TranslationKey> = {
  initializing: "agents.status.initializing",
  idle: "agents.status.idle",
  running: "agents.status.running",
  interrupted: "agents.status.interrupted",
  error: "agents.status.error",
  closed: "agents.status.closed",
  queued: "agents.status.queued",
  starting: "agents.status.starting",
  waiting: "agents.status.waiting",
  cancel_requested: "agents.status.cancelling",
  cancelling: "agents.status.cancelling",
  succeeded: "agents.status.succeeded",
  failed: "agents.status.failed",
  cancelled: "agents.status.cancelled",
  draft: "agents.status.draft",
  blocked: "agents.status.blocked",
  ready: "agents.status.ready",
  active: "agents.status.active",
  paused: "agents.status.paused",
  removed: "agents.status.removed",
  claimed: "agents.status.claimed",
  acknowledged: "agents.status.acknowledged",
};

export function OrchestrationStatus({ value, compact = false }: {
  value: OrchestrationStatusValue;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const pulse = value === "running" || value === "starting" || value === "cancelling";
  return (
    <span
      data-status={value}
      className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[#777B75] dark:text-[#9A9E97]"
    >
      <StatusDot tone={TONE[value]} pulse={pulse} />
      {!compact && <span>{t(LABEL[value])}</span>}
    </span>
  );
}

export function activityLabel(activity?: string): TranslationKey {
  switch (activity) {
    case "model": return "agents.activity.model";
    case "approval": return "agents.activity.approval";
    case "handoff": return "agents.activity.handoff";
    case "tool:shell": return "agents.activity.shell";
    case "tool:read": return "agents.activity.read";
    case "tool:write": return "agents.activity.write";
    case "tool:search": return "agents.activity.search";
    case "tool:browser": return "agents.activity.browser";
    case "tool:other": return "agents.activity.tool";
    default: return "agents.activity.idle";
  }
}

export function useRelativeTime() {
  const { locale } = useI18n();
  const formatter = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  return (at?: number) => {
    if (!at) return "—";
    const deltaSeconds = Math.round((at - Date.now()) / 1_000);
    if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
    const deltaMinutes = Math.round(deltaSeconds / 60);
    if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");
    const deltaHours = Math.round(deltaMinutes / 60);
    if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");
    return formatter.format(Math.round(deltaHours / 24), "day");
  };
}
