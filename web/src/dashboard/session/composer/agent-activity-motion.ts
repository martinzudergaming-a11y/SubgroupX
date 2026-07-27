import type { OrbState } from "thinking-orbs";
import type { TimelineItem, ToolKind } from "@shared/protocol";
import { toolPhase } from "../../../conversation/tools/tool-presentation-helpers";

export interface SessionActivityMotion {
  state: OrbState;
  paused: boolean;
}

function runningToolState(kind: ToolKind): OrbState {
  switch (kind) {
    case "read":
    case "list":
    case "search":
    case "external":
      return "searching";
    case "write":
    case "edit":
      return "composing";
    case "subagent":
    case "canvas":
      return "shaping";
    case "shell":
    case "other":
      return "working";
  }
}

export function sessionActivityMotion({
  modelRetrying,
  awaitingApproval,
  last,
}: {
  modelRetrying: boolean;
  awaitingApproval: boolean;
  last?: TimelineItem;
}): SessionActivityMotion {
  if (awaitingApproval) return { state: "listening", paused: true };
  if (modelRetrying) return { state: "solving", paused: false };

  if (last?.kind === "tool") {
    switch (toolPhase(last.status)) {
      case "writing":
        return { state: "shaping", paused: false };
      case "committing":
      case "waiting":
        return { state: "listening", paused: false };
      case "running":
        return { state: runningToolState(last.toolKind), paused: false };
      case "done":
        return { state: "solving", paused: false };
    }
  }

  if (last?.kind === "assistant" && last.streaming) {
    const hasText = last.blocks?.some((block) => block.type === "text" && block.text.trim());
    return { state: hasText ? "composing" : "solving", paused: false };
  }

  return { state: "solving", paused: false };
}
