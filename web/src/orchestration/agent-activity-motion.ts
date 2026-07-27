import type { OrbState } from "thinking-orbs";
import type { TaskActivityCode, TaskStatus } from "@shared/orchestration";

export interface AgentActivityMotion {
  state: OrbState;
  paused: boolean;
}

export function taskActivityMotion(
  status: TaskStatus,
  activity?: TaskActivityCode,
): AgentActivityMotion | null {
  if (status === "starting") return { state: "shaping", paused: false };
  if (status === "waiting") return { state: "listening", paused: true };
  if (status !== "running") return null;

  switch (activity) {
    case "model":
      return { state: "solving", paused: false };
    case "approval":
      return { state: "listening", paused: true };
    case "handoff":
      return { state: "shaping", paused: false };
    case "tool:read":
    case "tool:search":
    case "tool:browser":
      return { state: "searching", paused: false };
    case "tool:write":
      return { state: "composing", paused: false };
    case "tool:shell":
    case "tool:other":
    case undefined:
      return { state: "working", paused: false };
  }
}
