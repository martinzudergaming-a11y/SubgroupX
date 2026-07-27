import type { ComponentType } from "react";
import { Check, XCircle, Circle, Ban, PencilLine, Clock3 } from "lucide-react";
import { Spinner } from "./Spinner";

export type StatusIcon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
import type { ToolCallStatus, SessionStatus } from "@shared/protocol";

export const TOOL_STATUS_ICON: Record<ToolCallStatus, { Icon: StatusIcon; cls: string; spin?: boolean; pulse?: boolean }> = {
  streaming_args: { Icon: PencilLine, cls: "text-[#8A8F98] dark:text-[#8A8F98]", pulse: true },
  ready: { Icon: Clock3, cls: "text-[#B48A52] dark:text-[#C8A46E]", pulse: true },
  pending: { Icon: Circle, cls: "text-[#B8BCC2] dark:text-[#5A5A5A]" },
  approved: { Icon: Circle, cls: "text-[#2C6FCC] dark:text-[#79A9E8]" },
  running: { Icon: Spinner, cls: "text-[#C99A20] dark:text-[#E5C669]" },
  success: { Icon: Check, cls: "text-[#A8ACA2] dark:text-[#6E7268]" },
  error: { Icon: XCircle, cls: "text-[#D2433B] dark:text-[#E89B9B]" },
  denied: { Icon: Ban, cls: "text-[#D2433B] dark:text-[#E89B9B]" },
};

export const TOOL_STATUS_PILL: Record<string, string> = {
  streaming_args: "bg-[#F4F4F5] dark:bg-[#2A2A2A] text-[#8A8F98] dark:text-[#8A8F98]",
  ready: "bg-[#F7F2E9] dark:bg-[#2B261F] text-[#8B6B43] dark:text-[#C8A46E]",
  pending: "bg-[#F4F4F5] dark:bg-[#333] text-[#888] dark:text-[#999]",
  approved: "bg-[#EAF2FF] dark:bg-[#1E2A3A] text-[#2C6FCC] dark:text-[#79A9E8]",
  running: "bg-[#FFF6E5] dark:bg-[#2D2618] text-[#9A7100] dark:text-[#E5C669]",
  success: "bg-[#EAF6EC] dark:bg-[#1E2E22] text-[#2E7D45] dark:text-[#7FC894]",
  error: "bg-[#FBEAEA] dark:bg-[#3A2323] text-[#9A3333] dark:text-[#E89B9B]",
  denied: "bg-[#FBEAEA] dark:bg-[#3A2323] text-[#9A3333] dark:text-[#E89B9B]",
};

export const SESSION_STATUS_STYLE: Record<SessionStatus, string> = {
  initializing: "bg-[#FFF4E5] dark:bg-[#3A2E1C] text-[#B26A00] dark:text-[#E0A85A]",
  idle: "bg-[#EFEFEF] dark:bg-[#333] text-[#666] dark:text-[#A0A0A0]",
  running: "bg-[#E6F4EA] dark:bg-[#1C3A26] text-[#1E7E34] dark:text-[#5AC97A]",
  error: "bg-[#FBE9E7] dark:bg-[#3A1F1C] text-[#C62828] dark:text-[#E08A82]",
  closed: "bg-[#EFEFEF] dark:bg-[#333] text-[#999] dark:text-[#777]",
};
