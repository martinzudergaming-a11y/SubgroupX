import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OrchestrationJson, TeamWorkBudget } from "../../../shared/src/orchestration.ts";

const MAX_TASK_ID_BYTES = 128;
const MAX_TITLE_BYTES = 512;
const MAX_ASSIGNMENT_BYTES = 64 * 1024;
const MAX_MODEL_CYCLES = 64;
const MAX_TOKENS = 4_000_000;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is OrchestrationJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value as object)) return false;
  seen.add(value as object);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value as object);
  return valid;
}

export interface TeamAssignmentMessage {
  role: "teamAssignment";
  taskId: string;
  title: string;
  assignment: OrchestrationJson;
  deadlineAt: number;
  budget: TeamWorkBudget;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    teamAssignment: TeamAssignmentMessage;
  }
}

export function isTeamAssignmentMessage(message: AgentMessage | unknown): message is TeamAssignmentMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const value = message as Partial<TeamAssignmentMessage>;
  return value.role === "teamAssignment"
    && typeof value.taskId === "string" && value.taskId.length > 0 && utf8Bytes(value.taskId) <= MAX_TASK_ID_BYTES
    && typeof value.title === "string" && value.title.trim().length > 0 && utf8Bytes(value.title) <= MAX_TITLE_BYTES
    && Number.isSafeInteger(value.deadlineAt) && Number(value.deadlineAt) > 0
    && Number.isSafeInteger(value.timestamp) && Number(value.timestamp) > 0
    && Boolean(value.budget)
    && Number.isSafeInteger(value.budget?.maxModelCycles)
    && Number(value.budget?.maxModelCycles) >= 1
    && Number(value.budget?.maxModelCycles) <= MAX_MODEL_CYCLES
    && Number.isSafeInteger(value.budget?.maxTokens)
    && Number(value.budget?.maxTokens) >= 1
    && Number(value.budget?.maxTokens) <= MAX_TOKENS
    && isJsonValue(value.assignment)
    && utf8Bytes(JSON.stringify(value.assignment)) <= MAX_ASSIGNMENT_BYTES;
}

export function formatTeamAssignment(message: TeamAssignmentMessage): string {
  return [
    "<team_assignment>",
    `Task: ${message.title}`,
    `Task reference: ${message.taskId}`,
    `Deadline: ${new Date(message.deadlineAt).toISOString()}`,
    `Budget: ${message.budget.maxModelCycles} model cycles; ${message.budget.maxTokens} tokens`,
    "Assignment data:",
    JSON.stringify(message.assignment),
    "</team_assignment>",
  ].join("\n");
}

export function convertTeamMessagesToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (isTeamAssignmentMessage(message)) {
      return [{ role: "user", content: formatTeamAssignment(message), timestamp: message.timestamp }];
    }
    if ((message as { role?: unknown }).role === "teamAssignment") {
      throw new Error("Stored Team assignment does not satisfy the canonical bounded contract");
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      return [message as Message];
    }
    return [];
  });
}

export function convertTeamMessageToLlm(message: AgentMessage): Message[] {
  return convertTeamMessagesToLlm([message]);
}

export function isAgentPromptBoundary(message: AgentMessage): boolean {
  return message.role === "user" || isTeamAssignmentMessage(message);
}

export function validateStoredTeamMessages(messages: readonly unknown[]): AgentMessage[] {
  return messages.map((message, index) => {
    if (isTeamAssignmentMessage(message)) return message;
    if (
      message
      && typeof message === "object"
      && !Array.isArray(message)
      && ["user", "assistant", "toolResult"].includes(String((message as { role?: unknown }).role))
    ) return message as AgentMessage;
    throw new Error(`Session transcript message ${index} has an unsupported role`);
  });
}
