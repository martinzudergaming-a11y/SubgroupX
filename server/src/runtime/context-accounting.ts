import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { countText, countMessage } from "./token-count.ts";

type ModelWithWindow = Model<any> & { contextWindow?: number; compactAt?: number };

export interface ContextUsage {
  used: number;
  measured: number;
  pending: number;
  total: number;
  compactAt: number;
  parts: { system: number; tools: number; user: number; assistant: number; toolResults: number };
}

export function compactionReserveTokens(model: ModelWithWindow): number {
  const contextWindow = model.contextWindow ?? 0;
  return Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.round(contextWindow * 0.12));
}

export function compactTriggerAt(model: ModelWithWindow): number {
  const contextWindow = model.contextWindow ?? 0;
  if (!contextWindow) return 0;
  const byReserve = contextWindow - compactionReserveTokens(model);
  return Math.max(0, model.compactAt ? Math.min(model.compactAt, byReserve) : byReserve);
}

export function computeContextUsage(
  model: ModelWithWindow,
  messages: Message[],
  systemPrompt: string,
  toolsJson: string,
  measured: number,
): ContextUsage {
  const total = model.contextWindow ?? 0;

  const parts = { system: 0, tools: 0, user: 0, assistant: 0, toolResults: 0 };
  parts.system = countText(systemPrompt);
  parts.tools = toolsJson ? countText(toolsJson) : 0;
  for (const m of messages) {
    const tok = countMessage(m);
    if (m.role === "assistant") parts.assistant += tok;
    else if (m.role === "toolResult") parts.toolResults += tok;
    else parts.user += tok;
  }

  let pending = 0;
  if (measured > 0) {
    let lastUsageIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const u = (messages[i] as AssistantMessage).usage;
      if (messages[i].role === "assistant" && u && u.totalTokens > 0) {
        lastUsageIdx = i;
        break;
      }
    }
    for (let i = lastUsageIdx + 1; i < messages.length; i++) pending += countMessage(messages[i]);
  } else {
    for (const m of messages) pending += countMessage(m);
  }

  return { used: measured + pending, measured, pending, total, compactAt: compactTriggerAt(model), parts };
}

export function seedContextTokensFromTranscript(messages: Message[], summaryPrefix: string): number {
  const leadingText = (content: Message["content"]): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const first = content.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
      return first?.text ?? "";
    }
    return "";
  };
  let newestSummaryTs = 0;
  let newestSummaryIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && leadingText(m.content).startsWith(summaryPrefix)) {
      newestSummaryIdx = i;
      newestSummaryTs = Math.max(newestSummaryTs, m.timestamp ?? 0);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const u = (m as AssistantMessage).usage;
    if (m.role === "assistant" && u && u.totalTokens > 0) {
      if (newestSummaryIdx === -1) return u.totalTokens;
      const ts = m.timestamp ?? 0;
      if (ts && newestSummaryTs && ts !== newestSummaryTs) return ts > newestSummaryTs ? u.totalTokens : 0;
      return i > newestSummaryIdx ? u.totalTokens : 0;
    }
  }
  return 0;
}
