import type { ToolCallStatus, ToolKind } from "./protocol.ts";

export type ShareDisplayState =
  | "runningAtShare"
  | "completedOutputHidden"
  | "completedNoOutput";

export interface ShareAttachment {
  name: string;
}

export interface ShareOutcome {
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export type ShareTextBlock = { type: "text"; text: string };
export type ShareToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type ShareThinkingBlock = { type: "thinking"; text: string };
export type ShareAssistantBlock = ShareTextBlock | ShareToolCallBlock | ShareThinkingBlock;

type ShareTurnMember = {  turnId?: string };

export type ShareItem =
  | ({ kind: "user"; id: string; seq: number; text: string; attachments?: ShareAttachment[]; ts: number } & ShareTurnMember)
  | ({ kind: "assistant"; id: string; seq: number; blocks: ShareAssistantBlock[]; ts: number } & ShareTurnMember)
  | {
      kind: "tool";
      id: string;
      seq: number;
      name: string;
      toolKind: ToolKind;
      path?: string;
      arguments: Record<string, unknown>;
      status: ToolCallStatus;
      termination?: "cancelled";
      displayState: ShareDisplayState;
      outcome?: ShareOutcome;
      resultText?: string;
      ts: number;
      durationMs?: number;
      children?: ShareItem[];
      turnId?: string;
    }
  | ({ kind: "error"; id: string; seq: number; message: string; ts: number } & ShareTurnMember)
  | ({ kind: "interrupted"; id: string; seq: number; ts: number; resumeText?: string } & ShareTurnMember)
  | { kind: "compaction"; id: string; seq: number; ts: number; summarizedCount: number };

export interface ShareMeta {
  model?: string;
  provider?: string;
  createdAt: number;
  itemCount: number;
  reasoning?: boolean;
  contextWindow?: number;
  scope?: "full" | "selected";
  detailed?: boolean;
}

export interface SharePayload {
  title: string;
  items: ShareItem[];
  meta: ShareMeta;
  createdAt: number;
  originalCount: number;
  truncated: boolean;
  sharedVia: "oiia" | "o11n";
}
