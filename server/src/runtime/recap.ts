import type { RecapJobRow } from "../persistence/index.ts";
import { errorKind, logAudit } from "../observability/audit-log.ts";
import {
  jailAvailable,
  JAIL_API,
  JAIL_BASE_URL,
  JAIL_MODEL_ID,
  JAIL_PROVIDER,
} from "./providers.ts";

export const RECAP_CONTRACT_VERSION = 1;

export type RecapActivity = { name: string; kind: string; path?: string };

export interface RecapSnapshotV1 {
  previousRequests: string[];
  latestRequest: string;
  assistantReply: string;
  activity: RecapActivity[];
  turnProvider: string;
  turnModel: string;
}

export interface PendingRecap {
  turnId: string;
  anchorSeq: number;
  dueAt: number;
  contractVersion: number;
  snapshot: RecapSnapshotV1;
}

export interface RecapGeneration {
  text: string;
  source: "llm" | "fallback";
  generatorProvider: string;
  generatorModel: string;
}

interface RecapAuditContext {
  userId: string;
  sessionId: string;
  targetId: string | null;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shortText(text: string, max = 120): string {
  const compacted = compactText(text);
  if (compacted.length <= max) return compacted;
  return compacted.slice(0, Math.max(0, max - 3)).trimEnd() + "...";
}

function boundAssistantReply(text: string): string {
  const full = compactText(text);
  return full.length <= 900
    ? full
    : `${full.slice(0, 450).trimEnd()} [...] ${full.slice(-450).trimStart()}`;
}

function boundActivity(activity: RecapActivity[]): RecapActivity[] {
  return activity.slice(0, 40).map((item) => ({
    name: shortText(item.name, 120),
    kind: shortText(item.kind, 40),
    ...(item.path ? { path: shortText(item.path, 240) } : {}),
  }));
}

export function decodeRecapJob(row: RecapJobRow): PendingRecap | null {
  if (
    row.contract_version !== RECAP_CONTRACT_VERSION
    || typeof row.turn_id !== "string"
    || row.turn_id.length === 0
    || row.turn_id.length > 160
    || !Number.isSafeInteger(row.anchor_seq)
    || row.anchor_seq < 0
    || !Number.isSafeInteger(row.due_at)
    || row.due_at < 0
  ) return null;
  try {
    const value = JSON.parse(row.payload_json) as Partial<RecapSnapshotV1>;
    if (
      !Array.isArray(value.previousRequests)
      || !value.previousRequests.every((text) => typeof text === "string")
      || typeof value.latestRequest !== "string"
      || typeof value.assistantReply !== "string"
      || typeof value.turnProvider !== "string"
      || typeof value.turnModel !== "string"
      || !Array.isArray(value.activity)
    ) return null;
    const activity = value.activity.filter((item): item is RecapActivity => Boolean(
      item && typeof item === "object"
      && typeof (item as RecapActivity).name === "string"
      && typeof (item as RecapActivity).kind === "string"
      && ((item as RecapActivity).path == null || typeof (item as RecapActivity).path === "string"),
    ));
    return {
      turnId: row.turn_id,
      anchorSeq: row.anchor_seq,
      dueAt: row.due_at,
      contractVersion: row.contract_version,
      snapshot: {
        previousRequests: value.previousRequests.slice(-2).map((text) => shortText(text, 240)),
        latestRequest: shortText(value.latestRequest, 600),
        assistantReply: boundAssistantReply(value.assistantReply),
        activity: boundActivity(activity),
        turnProvider: shortText(value.turnProvider, 120),
        turnModel: shortText(value.turnModel, 160),
      },
    };
  } catch {
    return null;
  }
}

export function buildRecapSnapshot(input: {
  recentRequests: string[];
  latestRequest: string;
  assistantReply: string;
  activity: RecapActivity[];
  turnProvider: string;
  turnModel: string;
}): RecapSnapshotV1 {
  return {
    previousRequests: input.recentRequests.slice(-3, -1).map((text) => shortText(text, 240)),
    latestRequest: shortText(input.latestRequest, 600),
    assistantReply: boundAssistantReply(input.assistantReply),
    activity: boundActivity(input.activity),
    turnProvider: shortText(input.turnProvider, 120),
    turnModel: shortText(input.turnModel, 160),
  };
}

function stripRecapStyling(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9]*\n?/g, "").replace(/```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, "$1")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d{1,9}[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractResponsesOutputText(json: unknown): string {
  const body = json as { output_text?: unknown; output?: unknown };
  if (typeof body?.output_text === "string") return body.output_text;
  const output = Array.isArray(body?.output) ? body.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = part as { type?: unknown; text?: unknown };
      if (value.type === "output_text" && typeof value.text === "string") parts.push(value.text);
    }
  }
  return parts.join("");
}

function describeActivity(activity: RecapActivity[]): string {
  if (activity.length === 0) return "";
  const verb: Record<string, string> = {
    edit: "edited", write: "wrote", read: "read", shell: "ran", search: "searched",
    list: "listed", canvas: "rendered", subagent: "delegated", external: "called",
  };
  const noun: Record<string, [string, string]> = {
    shell: ["command", "commands"], read: ["file", "files"], edit: ["file", "files"],
    write: ["file", "files"], search: ["search", "searches"],
  };
  const byKind = new Map<string, { count: number; firstPath?: string }>();
  for (const item of activity) {
    const group = byKind.get(item.kind) ?? { count: 0 };
    group.count++;
    if (!group.firstPath && item.path) group.firstPath = item.path;
    byKind.set(item.kind, group);
  }
  const parts: string[] = [];
  for (const [kind, group] of byKind) {
    const action = verb[kind] ?? "used";
    if (group.firstPath) parts.push(`${action} ${group.firstPath}${group.count > 1 ? ` (+${group.count - 1} more)` : ""}`);
    else {
      const [one, many] = noun[kind] ?? ["call", "calls"];
      parts.push(`${action} ${group.count} ${group.count === 1 ? one : many}`);
    }
  }
  return parts.join("; ");
}

function buildFallback(snapshot: RecapSnapshotV1): string {
  const prompt = shortText(snapshot.latestRequest || "the latest request", 120);
  const activity = describeActivity(snapshot.activity);
  if (activity) return `Last turn ${activity} — for: "${prompt}".`;
  if (snapshot.assistantReply) {
    return `Last turn handled "${prompt}" and replied: "${shortText(snapshot.assistantReply, 160)}".`;
  }
  return `Last turn handled "${prompt}".`;
}

async function generateWithOperator(
  snapshot: RecapSnapshotV1,
  audit: RecapAuditContext,
): Promise<RecapGeneration | null> {
  if (!jailAvailable() || JAIL_API !== "openai-responses") return null;
  const key = process.env.AGENT_WEB_JAIL_KEY;
  if (!key) return null;
  const activity = snapshot.activity.length
    ? snapshot.activity.map((item) => `- ${item.kind}${item.path ? ` ${item.path}` : ` (${item.name})`}`).join("\n")
    : "";
  if (!snapshot.latestRequest && !snapshot.assistantReply && !activity) return null;
  const continuity = snapshot.previousRequests.length
    ? snapshot.previousRequests.map((request) => `- ${request}`).join("\n")
    : "(none)";
  const input =
    "The user stepped away from this coding session and is coming back. Recap in under 40 words, " +
    "1-2 plain sentences, no markdown, no backticks, no bullets (the chip renders raw text). " +
    "State the latest task and current outcome, then ONE next action only when the evidence supports " +
    "one. The latest request, tool activity, and final reply are authoritative. Earlier recent " +
    "requests are weak continuity hints only: ignore them when the topic changed. Never revive the " +
    "session's original task merely because it came first. Skip root-cause narrative, fix internals, " +
    "secondary to-dos, and em-dash tangents. No preamble, no quotes.\n\n" +
    `Immediately preceding requests (oldest to newest; optional context):\n${continuity}\n\n` +
    `Latest request: ${snapshot.latestRequest || "(none)"}\n\n` +
    `Tools used in the last turn:\n${activity || "(none)"}\n\n` +
    `Assistant's last reply: ${snapshot.assistantReply || "(no text reply)"}`;
  const generatorModel = process.env.AGENT_WEB_RECAP_MODEL || JAIL_MODEL_ID;
  try {
    const response = await globalThis.fetch(`${JAIL_BASE_URL}/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "oiia/1.0" },
      body: JSON.stringify({
        model: generatorModel,
        input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
        stream: false,
        max_output_tokens: 256,
        reasoning: { effort: "low" },
        prompt_cache_key: audit.sessionId,
        include: ["reasoning.encrypted_content"],
      }),
    });
    if (!response.ok) {
      logAudit("recap_upstream_failed", {
        level: "warn", ...audit,
        data: { contractVersion: RECAP_CONTRACT_VERSION, status: response.status },
      });
      return null;
    }
    const text = extractResponsesOutputText(await response.json());
    if (!text) {
      logAudit("recap_upstream_failed", {
        level: "warn", ...audit,
        data: { contractVersion: RECAP_CONTRACT_VERSION, reason: "missing_output_text" },
      });
      return null;
    }
    const clean = stripRecapStyling(text);
    return clean ? {
      text: shortText(clean, 320),
      source: "llm",
      generatorProvider: JAIL_PROVIDER,
      generatorModel,
    } : null;
  } catch (e) {
    logAudit("recap_upstream_failed", {
      level: "warn", ...audit,
      data: { contractVersion: RECAP_CONTRACT_VERSION, errorKind: errorKind(e) },
    });
    return null;
  }
}

export async function generateRecapText(
  snapshot: RecapSnapshotV1,
  audit: RecapAuditContext,
): Promise<RecapGeneration> {
  const generated = await generateWithOperator(snapshot, audit).catch(() => null);
  return generated ?? {
    text: buildFallback(snapshot),
    source: "fallback",
    generatorProvider: "local",
    generatorModel: `recap-template-v${RECAP_CONTRACT_VERSION}`,
  };
}
