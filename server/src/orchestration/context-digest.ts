import { createHash } from "node:crypto";
import type {
  AgentNode,
  AgentRosterCounts,
  TaskActivityCode,
  TaskDigest,
  TaskStatus,
  TaskWaitReasonCode,
} from "../../../shared/src/orchestration.ts";
import { countTextExact } from "../runtime/token-count.ts";

export const AGENT_CONTEXT_TYPICAL_CTX = 96;
export const AGENT_CONTEXT_HARD_CTX = 192;

const TITLE_CODE_POINTS = 48;
const DEFAULT_CACHE_ENTRIES = 16;
const ALIAS_HASH_DIGITS = 6;

const ACTIVITY_CODES = new Set<TaskActivityCode>([
  "model",
  "approval",
  "handoff",
  "tool:shell",
  "tool:read",
  "tool:write",
  "tool:search",
  "tool:browser",
  "tool:other",
]);
const WAIT_REASON_CODES = new Set<TaskWaitReasonCode>([
  "approval",
  "dependency",
  "resource",
  "rate",
  "signal",
  "other",
]);
const TERMINAL_STATUSES = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface AgentTaskRoster {
  revision: number;
  rootAgentId: string;
  nodes: readonly AgentNode[];
  tasks: readonly TaskDigest[];
  counts?: AgentRosterCounts;
}

export interface RenderedAgentContextDigest {
  readonly text: string;
  readonly ctx: number;
  readonly exact: boolean;
  readonly revision: number;
  readonly includedTaskIds: readonly string[];
  readonly omittedTasks: number;
}

export type AgentContextTokenCounter = (text: string) => number | Promise<number>;

export interface AgentContextDigestRendererOptions {
  maxEntries?: number;
  countTokens?: AgentContextTokenCounter;
}

interface Candidate {
  task: TaskDigest;
  alias: string;
  bucket: number;
  orderAt: number;
  full: string;
  compact: string;
}

interface CachedRender {
  value: Promise<RenderedAgentContextDigest>;
}

function finiteRevision(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteTimestamp(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function utf8UpperBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function safeTitle(value: string): string {
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[^\p{L}\p{N}\p{M} ._:+#-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(normalized || "task");
  if (points.length <= TITLE_CODE_POINTS) return points.join("");
  return `${points.slice(0, TITLE_CODE_POINTS - 1).join("")}…`;
}

function safeActivity(value: TaskDigest["activity"]): TaskActivityCode | undefined {
  return value && ACTIVITY_CODES.has(value) ? value : undefined;
}

function safeWaitReason(value: TaskDigest["waitReason"]): TaskWaitReasonCode {
  return value && WAIT_REASON_CODES.has(value) ? value : "other";
}

function shortHash(prefix: string, value: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 5)}`;
}

export function stableAgentAliases(nodes: readonly AgentNode[], taskAgentIds: readonly string[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathCounts = new Map<string, number>();
  for (const node of nodes) pathCounts.set(node.path, (pathCounts.get(node.path) ?? 0) + 1);

  const agentIds = new Set(taskAgentIds);
  for (const node of nodes) agentIds.add(node.id);

  const seeds = [...agentIds].map((id) => {
    const node = byId.get(id);
    const path = node?.path;
    const seed = !path || (pathCounts.get(path) ?? 0) > 1 ? `${path || "missing-agent"}\0${id}` : path;
    const digest = createHash("sha256").update(seed).digest("hex");
    return { id, digest };
  });

  const aliases = new Map<string, string>();
  for (const item of seeds) {
    let length = ALIAS_HASH_DIGITS;
    while (
      length < item.digest.length &&
      seeds.some((other) => other.id !== item.id && other.digest.slice(0, length) === item.digest.slice(0, length))
    ) {
      length += 1;
    }
    aliases.set(item.id, `a${item.digest.slice(0, length)}`);
  }
  return aliases;
}

function taskBucket(task: TaskDigest): number {
  if (task.status === "waiting") return 0;
  if (TERMINAL_STATUSES.has(task.status) && task.unreadResult) return 1;
  if (task.status === "starting" || task.status === "running" || task.status === "cancel_requested") return 2;
  if (TERMINAL_STATUSES.has(task.status)) return 3;
  return 4;
}

function taskCode(task: TaskDigest): string {
  if (task.status === "waiting") return `W:${safeWaitReason(task.waitReason)}`;
  if (task.status === "succeeded") return task.unreadResult ? "D+" : "D";
  if (task.status === "failed" || task.status === "cancelled" || task.status === "interrupted") {
    return task.unreadResult ? "F+" : "F";
  }
  if (task.status === "queued") return "Q";
  return "R";
}

function taskOrderAt(task: TaskDigest, bucket: number): number {
  if (bucket === 4) return finiteTimestamp(task.createdAt);
  if (bucket === 1 || bucket === 3) return finiteTimestamp(task.settledAt ?? task.updatedAt);
  return finiteTimestamp(task.updatedAt);
}

function candidatesFor(roster: AgentTaskRoster): Candidate[] {
  const aliases = stableAgentAliases(roster.nodes, roster.tasks.map((task) => task.agentId));
  return roster.tasks
    .map((task): Candidate => {
      const alias = aliases.get(task.agentId) ?? shortHash("a", task.agentId);
      const bucket = taskBucket(task);
      const code = taskCode(task);
      const activity = safeActivity(task.activity);
      const activityPart = activity ? ` @${activity}` : "";
      const resultPart = task.resultId ? ` ->${shortHash("r", task.resultId)}` : "";
      return {
        task,
        alias,
        bucket,
        orderAt: taskOrderAt(task, bucket),
        full: `${alias} ${code} ${safeTitle(task.title)}${activityPart}${resultPart}`,
        compact: `${alias} ${code}${activityPart}${resultPart}`,
      };
    })
    .sort((left, right) => {
      if (left.bucket !== right.bucket) return left.bucket - right.bucket;
      const timeOrder = left.bucket === 4 ? left.orderAt - right.orderAt : right.orderAt - left.orderAt;
      if (timeOrder !== 0) return timeOrder;
      const aliasOrder = left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0;
      if (aliasOrder !== 0) return aliasOrder;
      return left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0;
    });
}

function countActiveAgents(roster: AgentTaskRoster): number {
  const ids = new Set<string>();
  for (const node of roster.nodes) {
    if (node.id !== roster.rootAgentId && node.status !== "closed") ids.add(node.id);
  }
  for (const task of roster.tasks) {
    if (task.agentId !== roster.rootAgentId && !TERMINAL_STATUSES.has(task.status)) ids.add(task.agentId);
  }
  return ids.size;
}

function headerFor(roster: AgentTaskRoster, omitted: number): string {
  const active = roster.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const background = roster.counts?.background
    ?? active.filter((task) => task.awaitPolicy === "background").length;
  const queued = roster.counts?.queued ?? roster.tasks.filter((task) => task.status === "queued").length;
  const waiting = roster.counts?.waiting ?? roster.tasks.filter((task) => task.status === "waiting").length;
  const unread = roster.counts?.unread
    ?? roster.tasks.filter((task) => TERMINAL_STATUSES.has(task.status) && task.unreadResult).length;
  const activeAgents = roster.counts?.activeAgents ?? countActiveAgents(roster);
  return `<agents v=${finiteRevision(roster.revision)} a=${activeAgents} bg=${background} q=${queued} w=${waiting} unread=${unread} more=${omitted}>`;
}

function compose(roster: AgentTaskRoster, rows: readonly string[], totalTasks: number): string {
  return `${headerFor(roster, Math.max(0, totalTasks - rows.length))}\n${rows.join("\n")}${rows.length ? "\n" : ""}</agents>`;
}

async function renderUncached(
  roster: AgentTaskRoster,
  tokenCounter: AgentContextTokenCounter,
): Promise<RenderedAgentContextDigest> {
  let exact = true;
  const measure = async (text: string): Promise<number> => {
    if (!exact) return utf8UpperBound(text);
    try {
      const value = await tokenCounter(text);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid token count");
      return value;
    } catch {
      exact = false;
      return utf8UpperBound(text);
    }
  };

  const candidates = candidatesFor(roster);
  const totalTasks = Math.max(candidates.length, roster.counts?.tasks ?? 0);
  const rows: string[] = [];
  const includedTaskIds: string[] = [];

  for (const candidate of candidates) {
    const budget = candidate.bucket <= 1 ? AGENT_CONTEXT_HARD_CTX : AGENT_CONTEXT_TYPICAL_CTX;
    const variants = candidate.bucket <= 1 && candidate.compact !== candidate.full
      ? [candidate.full, candidate.compact]
      : [candidate.full];
    for (const row of variants) {
      const next = compose(roster, [...rows, row], totalTasks);
      if (await measure(next) > budget) continue;
      rows.push(row);
      includedTaskIds.push(candidate.task.id);
      break;
    }
  }

  let text = compose(roster, rows, totalTasks);
  let ctx = await measure(text);
  while (ctx > AGENT_CONTEXT_HARD_CTX && rows.length > 0) {
    rows.pop();
    includedTaskIds.pop();
    text = compose(roster, rows, totalTasks);
    ctx = await measure(text);
  }

  if (ctx > AGENT_CONTEXT_HARD_CTX) {
    text = `<agents v=${finiteRevision(roster.revision)} a=${roster.counts?.activeAgents ?? countActiveAgents(roster)} more=${totalTasks}/>`;
    ctx = await measure(text);
  }

  return Object.freeze({
    text,
    ctx,
    exact,
    revision: finiteRevision(roster.revision),
    includedTaskIds: Object.freeze([...includedTaskIds]),
    omittedTasks: totalTasks - includedTaskIds.length,
  });
}

export class AgentContextDigestRenderer {
  readonly #maxEntries: number;
  readonly #countTokens: AgentContextTokenCounter;
  readonly #cache = new Map<string, CachedRender>();

  constructor(options: AgentContextDigestRendererOptions = {}) {
    const requestedEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
    this.#maxEntries = Number.isFinite(requestedEntries)
      ? Math.max(1, Math.min(64, Math.trunc(requestedEntries)))
      : DEFAULT_CACHE_ENTRIES;
    this.#countTokens = options.countTokens ?? countTextExact;
  }

  get size(): number {
    return this.#cache.size;
  }

  clear(): void {
    this.#cache.clear();
  }

  render(roster: AgentTaskRoster): Promise<RenderedAgentContextDigest> {
    const revision = finiteRevision(roster.revision);
    const key = `${roster.rootAgentId}\0${revision}`;
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.value;
    }

    let entry: CachedRender;
    const value = renderUncached(roster, this.#countTokens).catch((error: unknown) => {
      if (this.#cache.get(key) === entry) this.#cache.delete(key);
      throw error;
    });
    entry = { value };
    this.#cache.set(key, entry);
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return value;
  }
}

const defaultRenderer = new AgentContextDigestRenderer();

export function renderAgentContextDigest(roster: AgentTaskRoster): Promise<RenderedAgentContextDigest> {
  return defaultRenderer.render(roster);
}
