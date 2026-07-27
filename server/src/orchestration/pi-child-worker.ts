import { Buffer } from "node:buffer";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Message, Model } from "@earendil-works/pi-ai";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type {
  OrchestrationJson,
  RuntimeTask,
  TaskActivityCode,
  Workflow,
} from "../../../shared/src/orchestration.ts";
import type {
  AgentTurnStatus,
  AssistantBlock,
  ShellResult,
  ToolKind,
  WireAgentEvent,
} from "../../../shared/src/protocol.ts";
import {
  AGENT_TRANSCRIPT_MAX_BYTES,
  AGENT_TRANSCRIPT_MAX_MESSAGES,
  AGENT_TRANSCRIPT_MAX_MESSAGE_BYTES,
  agentMessageDao,
  taskResultDeliveryDao,
  type OrchestrationRevisionChange,
} from "../persistence/orchestration.ts";
import type { Sandbox } from "../runtime/sandbox.ts";
import { countMessage, countText, prepareTokenizer, tokenizerReady } from "../runtime/token-count.ts";
import { createTools, toolKind } from "../runtime/tools.ts";
import {
  DEFAULT_AGENT_SUPERVISOR_LIMITS,
  type SupervisedAgentResult,
  type SupervisedAgentRun,
  type SupervisedAgentWorker,
  type SupervisedAgentWorkerFactory,
  type SupervisedAgentWorkerFactoryInput,
} from "./agent-supervisor.ts";
import type { WorkspaceWriteLease } from "./workspace-lease.ts";
import { WorkflowExpansionService } from "./workflow-launch.ts";
import { createWorkflowTools, WORKFLOW_TOOL_NAMES } from "./workflow-tools.ts";

export type PiChildContextMode = "none" | "recent" | "all";

export const PI_CHILD_SEED_MAX_MESSAGES = 96;
export const PI_CHILD_SEED_MAX_MESSAGE_BYTES = 512 * 1024;
export const PI_CHILD_SEED_MAX_BYTES = 2 * 1024 * 1024;

export interface PiChildContextSeedInput extends SupervisedAgentWorkerFactoryInput {
  task: RuntimeTask;
  mode: Exclude<PiChildContextMode, "none">;
  limits: Readonly<{
    maxMessages: number;
    maxMessageBytes: number;
    maxBytes: number;
  }>;
  signal: AbortSignal;
}

export type PiChildContextSeed = (
  input: PiChildContextSeedInput,
) => readonly Message[] | Promise<readonly Message[]>;

interface PiChildAgentState {
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly errorMessage?: string;
}

export interface PiChildAgent {
  readonly state: PiChildAgentState;
  readonly signal?: AbortSignal;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  prompt(message: string): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  clearAllQueues?(): void;
}

export type PiChildAgentFactory = (options: AgentOptions) => PiChildAgent;

type Resolvable<T> = T | ((input: SupervisedAgentWorkerFactoryInput) => T | Promise<T>);
type ToolResolver = readonly AgentTool<any>[] | ((
  input: SupervisedAgentWorkerFactoryInput & {
    sandbox: Sandbox;
    workspaceWriteLease: WorkspaceWriteLease;
  },
) => readonly AgentTool<any>[] | Promise<readonly AgentTool<any>[]>);

export interface PiChildWorkerFactoryOptions {
  sandbox: Sandbox;
  workspaceWriteLease: WorkspaceWriteLease;
  model: Resolvable<Model<any>>;
  systemPrompt: Resolvable<string>;
  workflowControllerPrompt: string;
  getApiKey: NonNullable<AgentOptions["getApiKey"]>;
  tools?: ToolResolver;
  contextSeed: PiChildContextSeed;
  thinkingLevel?: Resolvable<ThinkingLevel>;
  prepareStreamContext?: (
    context: Context,
    input: SupervisedAgentWorkerFactoryInput,
  ) => Context | Promise<Context>;
  onWorkflowMutation?: (workflow: Workflow) => void;
  workflowMaxTreeAgents?: () => number;
  streamFn?: AgentOptions["streamFn"];
  createAgent?: PiChildAgentFactory;
  now?: () => number;
  onResultAcknowledged?: (changes: readonly OrchestrationRevisionChange[]) => void;
}

export class AgentTranscriptConflictError extends Error {
  override name = "AgentTranscriptConflictError";

  constructor(readonly agentId: string, readonly taskId: string) {
    super(`Agent transcript changed or Task lease expired before ${taskId} could save`);
  }
}

export class PiChildRunError extends Error {
  override name: string;

  constructor(
    message: string,
    readonly stopReason: "error" | "aborted" | "missing",
    readonly tokensUsed = 0,
    readonly costUsedMicros = 0,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = stopReason === "aborted" ? "AbortError" : "PiChildRunError";
  }
}

interface Assignment {
  message: string;
  context: PiChildContextMode;
  resetContext: boolean;
}

interface ActiveTask {
  input: SupervisedAgentRun;
  acceptingSteer: boolean;
  activity: TaskActivityCode;
  tools: Map<string, TaskActivityCode>;
  turnId: string;
  startedAt: number;
  assistantOrdinal: number;
  assistantId: string | null;
  assistantMessage: AssistantMessage | null;
  proposed: Map<string, ProjectedTool>;
  running: Map<string, ProjectedTool & { startedAt: number }>;
  messageStart: number;
  usageBase: { tokensUsed: number; costUsedMicros: number };
  tokensUsed: number;
  costUsedMicros: number;
  controllerSealedGraph: boolean;
  workflow?: WorkflowExecutionContract;
}

interface ProjectedTool {
  name: string;
  toolKind: ToolKind;
  path?: string;
  arguments: Record<string, unknown>;
}

const CHILD_ARGUMENTS_MAX_BYTES = 24 * 1024;
const CHILD_TEXT_MAX_BYTES = 32 * 1024;
const CHILD_BLOCKS_MAX_BYTES = 96 * 1024;
const CHILD_BLOCKS_MAX_COUNT = 64;
const CHILD_RESULT_MAX_PARTS = 64;
const CHILD_IDENTIFIER_MAX_CODE_UNITS = 4 * 1024;

function progressIdentifier(value: string, label: string): string {
  if (value.length <= CHILD_IDENTIFIER_MAX_CODE_UNITS) return value;
  return `${value.slice(0, 1_024)}…[${label} ${value.length}]…${value.slice(-128)}`;
}

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: value.length > 0 };
  if (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  const suffix = Buffer.from("\n…[progress truncated]", "utf8");
  if (maxBytes <= suffix.length) return { text: maxBytes >= 3 ? "…" : "", truncated: true };
  const encoded = Buffer.from(value.slice(0, Math.max(0, maxBytes - suffix.length)), "utf8");
  const head = encoded.subarray(0, Math.max(0, maxBytes - suffix.length)).toString("utf8").replace(/\uFFFD+$/u, "");
  return { text: `${head}${suffix.toString("utf8")}`, truncated: true };
}

const truncateUtf8 = (value: string, maxBytes: number): string => boundedUtf8(value, maxBytes).text;

function boundedArguments(value: unknown, maxBytes = CHILD_ARGUMENTS_MAX_BYTES): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const budget = { bytes: Math.max(0, maxBytes - 128), nodes: 256, truncated: false };
  const bound = (entry: unknown, depth: number): unknown => {
    if (budget.nodes-- <= 0 || budget.bytes <= 0) {
      budget.truncated = true;
      return "[progress omitted]";
    }
    if (typeof entry === "string") {
      const max = Math.min(16 * 1024, budget.bytes);
      const bounded = boundedUtf8(entry, max);
      if (bounded.truncated) budget.truncated = true;
      const text = bounded.text;
      budget.bytes -= Buffer.byteLength(text, "utf8");
      return text;
    }
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") {
      budget.bytes -= 16;
      return entry;
    }
    if (depth >= 4) {
      budget.truncated = true;
      return "[progress depth omitted]";
    }
    if (Array.isArray(entry)) {
      if (entry.length > 32) budget.truncated = true;
      return entry.slice(0, 32).map((item) => bound(item, depth + 1));
    }
    if (!isRecord(entry)) return truncateUtf8(String(entry), Math.min(1_024, budget.bytes));
    const nested: Record<string, unknown> = {};
    let keys = 0;
    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      if (keys++ >= 64) {
        budget.truncated = true;
        break;
      }
      if (key.length > 512) {
        budget.truncated = true;
        break;
      }
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > 512 || budget.bytes - keyBytes <= 0) {
        budget.truncated = true;
        break;
      }
      budget.bytes -= keyBytes;
      nested[key] = bound(entry[key], depth + 1);
    }
    return nested;
  };
  const out: Record<string, unknown> = {};
  const preferred = ["path", "command", "query", "url", "content", "old", "new", "input"];
  const seen = new Set<string>();
  let keys = 0;
  const add = (key: string): boolean => {
    if (seen.has(key) || !Object.prototype.hasOwnProperty.call(value, key)) return true;
    if (keys++ >= 64) {
      budget.truncated = true;
      return false;
    }
    if (key.length > 512) {
      budget.truncated = true;
      return false;
    }
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > 512 || budget.bytes - keyBytes <= 0) {
      budget.truncated = true;
      return false;
    }
    seen.add(key);
    budget.bytes -= keyBytes;
    out[key] = bound(value[key], 1);
    return budget.bytes > 0;
  };
  for (const key of preferred) if (!add(key)) break;
  if (budget.bytes > 0 && keys < 64) {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || seen.has(key)) continue;
      if (!add(key)) break;
    }
  }
  if (budget.truncated) out.__progressTruncated = true;
  return out;
}

function assistantBlocks(message: AssistantMessage): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  let bytes = CHILD_BLOCKS_MAX_BYTES;
  for (let index = 0; index < message.content.length && index < CHILD_BLOCKS_MAX_COUNT && bytes > 256; index += 1) {
    const block = message.content[index]!;
    if (block.type === "text") {
      const text = truncateUtf8(block.text, Math.min(CHILD_TEXT_MAX_BYTES, bytes));
      blocks.push({ type: "text", text });
      bytes -= Buffer.byteLength(text, "utf8") + 64;
      continue;
    }
    if (block.type === "thinking") {
      const thinking = truncateUtf8(block.thinking, Math.min(CHILD_TEXT_MAX_BYTES, bytes));
      blocks.push({ type: "thinking", thinking });
      bytes -= Buffer.byteLength(thinking, "utf8") + 64;
      continue;
    }
    if (block.type !== "toolCall") continue;
    const args = boundedArguments(block.arguments, Math.min(CHILD_ARGUMENTS_MAX_BYTES, bytes));
    const id = progressIdentifier(block.id, "Tool call id");
    const name = progressIdentifier(block.name, "Tool name");
    const projected: AssistantBlock = {
      type: "toolCall",
      id,
      name,
      arguments: args,
      toolKind: toolKind(name),
      ...(typeof args.path === "string" ? { path: args.path } : {}),
    };
    blocks.push(projected);
    bytes -= Buffer.byteLength(JSON.stringify(projected), "utf8") + 32;
  }
  return blocks;
}

function projectedTool(name: string, args: unknown): ProjectedTool {
  const boundedName = progressIdentifier(name, "Tool name");
  const bounded = boundedArguments(args);
  return {
    name: boundedName,
    toolKind: toolKind(boundedName),
    ...(typeof bounded.path === "string" ? { path: bounded.path } : {}),
    arguments: bounded,
  };
}

function childToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return truncateUtf8(result == null ? "" : String(result), CHILD_TEXT_MAX_BYTES).trim();
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return truncateUtf8(content, CHILD_TEXT_MAX_BYTES).trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let remaining = CHILD_TEXT_MAX_BYTES;
    for (let index = 0; index < content.length && index < CHILD_RESULT_MAX_PARTS && remaining > 1; index += 1) {
      const part = content[index];
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
      const separatorBytes = parts.length === 0 ? 0 : 1;
      const text = truncateUtf8(part.text, Math.max(0, remaining - separatorBytes));
      parts.push(text);
      remaining -= Buffer.byteLength(text, "utf8") + separatorBytes;
    }
    const text = parts.join("\n").trim();
    if (text) return truncateUtf8(text, CHILD_TEXT_MAX_BYTES);
  }
  const record = content !== undefined && isRecord(content) ? content : result;
  if (isRecord(record)) {
    for (const key of ["text", "message", "summary", "error"]) {
      if (typeof record[key] === "string") return truncateUtf8(record[key], CHILD_TEXT_MAX_BYTES).trim();
    }
  }
  return "[Structured tool result omitted from progress.]";
}

function childShell(result: unknown): ShellResult | undefined {
  const details = (result as { details?: unknown } | undefined)?.details;
  if (!isRecord(details) || !isRecord(details.shell)) return undefined;
  const shell = details.shell;
  if (typeof shell.exitCode !== "number") return undefined;
  const stdout = boundedUtf8(typeof shell.stdout === "string" ? shell.stdout : "", 12 * 1024);
  const stderr = boundedUtf8(typeof shell.stderr === "string" ? shell.stderr : "", 12 * 1024);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: shell.exitCode,
    timedOut: shell.timedOut === true,
    truncated: shell.truncated === true || stdout.truncated || stderr.truncated,
  };
}

interface WorkflowExecutionContract {
  workflowId: string;
  nodeId: string;
  nodeKind: "work" | "controller";
  effect: "pure_readonly" | "workspace_read" | "workspace_write" | "network" | "unknown";
  allowedTools?: string[];
  maxTokens: number;
  maxCostMicros: number;
  deadlineAt: number;
  capabilityContractVersion: number;
}

function abortError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" && reason ? reason : fallback,
    reason === undefined ? undefined : { cause: reason },
  );
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assignmentFrom(task: RuntimeTask): Assignment {
  if (!isRecord(task.payload) || typeof task.payload.message !== "string" || !task.payload.message.trim()) {
    throw new TypeError(`Task ${task.id} does not contain a non-empty payload.message`);
  }
  const context = task.payload.context ?? "none";
  if (context !== "none" && context !== "recent" && context !== "all") {
    throw new TypeError(`Task ${task.id} contains an invalid context handoff mode`);
  }
  return { message: task.payload.message, context, resetContext: task.payload.resetContext === true };
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return Number(value);
}

function workflowExecutionContract(task: RuntimeTask): WorkflowExecutionContract | undefined {
  if (task.kind !== "workflow_node") return undefined;
  if (!task.workflowId || !isRecord(task.payload) || !isRecord(task.payload.workflow)) {
    throw new TypeError(`Workflow Task ${task.id} is missing its trusted execution contract`);
  }
  const value = task.payload.workflow;
  if (value.workflowId !== task.workflowId || typeof value.nodeId !== "string" || !value.nodeId) {
    throw new TypeError(`Workflow Task ${task.id} has mismatched durable identity`);
  }
  if (value.nodeKind !== "work" && value.nodeKind !== "controller") {
    throw new TypeError(`Workflow Task ${task.id} has an invalid node kind`);
  }
  if (!["pure_readonly", "workspace_read", "workspace_write", "network", "unknown"].includes(String(value.effect))) {
    throw new TypeError(`Workflow Task ${task.id} has an invalid effect contract`);
  }
  if (
    task.capabilityContractVersion !== 1
    || value.capabilityContractVersion !== task.capabilityContractVersion
    || !isRecord(value.budget)
  ) {
    throw new TypeError(`Workflow Task ${task.id} has an unsupported capability contract`);
  }
  let allowedTools: string[] | undefined;
  if (value.allowedTools !== undefined) {
    if (
      !Array.isArray(value.allowedTools)
      || value.allowedTools.some((name) => typeof name !== "string" || !name || name.length > 128)
    ) throw new TypeError(`Workflow Task ${task.id} has an invalid Tool allowlist`);
    allowedTools = [...new Set(value.allowedTools as string[])].sort();
  }
  const contract: WorkflowExecutionContract = {
    workflowId: task.workflowId,
    nodeId: value.nodeId,
    nodeKind: value.nodeKind,
    effect: value.effect as WorkflowExecutionContract["effect"],
    ...(allowedTools === undefined ? {} : { allowedTools }),
    maxTokens: positiveInteger(value.budget.maxTokens, "Workflow Task maxTokens"),
    maxCostMicros: positiveInteger(value.budget.maxCostMicros, "Workflow Task maxCostMicros"),
    deadlineAt: positiveInteger(value.budget.deadlineAt, "Workflow Task deadlineAt"),
    capabilityContractVersion: 1,
  };
  const safeReadTools = contract.effect === "pure_readonly"
    ? ["workflow_read_dependency"]
    : contract.effect === "workspace_read"
      ? ["list_files", "read_file", "read_image", "workflow_read_dependency"]
      : undefined;
  if (task.checkpointSafe) {
    if (
      contract.nodeKind !== "work"
      || safeReadTools === undefined
      || JSON.stringify(contract.allowedTools ?? null) !== JSON.stringify(safeReadTools)
    ) throw new TypeError(`Workflow Task ${task.id} has an unsafe checkpoint capability contract`);
  }
  return contract;
}

function toolContractFingerprint(contract: WorkflowExecutionContract | undefined): string {
  if (!contract) return "delegation:full";
  return `${contract.capabilityContractVersion}:${contract.nodeKind}:${contract.effect}:`
    + (contract.allowedTools?.join(",") ?? "full");
}

function systemPromptForTask(
  basePrompt: string,
  controllerPrompt: string,
  task: RuntimeTask,
): string {
  if (!basePrompt.trim()) throw new Error("Child Agent system prompt must not be empty");
  if (workflowExecutionContract(task)?.nodeKind !== "controller") return basePrompt;
  if (!controllerPrompt.trim()) throw new Error("Workflow Controller system prompt must not be empty");
  return `${basePrompt.trim()}\n\n---\n\n${controllerPrompt.trim()}`;
}

function requestTokenUpperBound(context: Context): number {
  try {
    return Buffer.byteLength(JSON.stringify({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })) ?? [],
    }), "utf8") + 512;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function budgetErrorStream(model: Model<any>, message: string): AssistantMessageEventStream {
  return lazyStream(model, async () => { throw new Error(message); });
}

function canonicalJson(value: unknown, label: string): OrchestrationJson {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(encoded) as OrchestrationJson;
}

function messageRole(value: OrchestrationJson): string | undefined {
  return isRecord(value) && typeof value.role === "string" ? value.role : undefined;
}

function canonicalMessages(messages: readonly unknown[], label: string): OrchestrationJson[] {
  return messages.map((message, index) => canonicalJson(message, `${label} message ${index}`));
}

function boundedReport(value: string, maxBytes = 240 * 1024): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const points = Array.from(value);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(points.slice(0, mid).join(""), "utf8") <= maxBytes - 64) low = mid;
    else high = mid - 1;
  }
  return `${points.slice(0, low).join("")}\n…[full report truncated]`;
}

function hardTextTokens(text: string): number {
  return tokenizerReady() ? countText(text) : Buffer.byteLength(text, "utf8");
}

function hardMessageTokens(message: OrchestrationJson): number {
  return tokenizerReady()
    ? countMessage(message)
    : Buffer.byteLength(JSON.stringify(message), "utf8");
}

function assertSeedBounds(messages: readonly OrchestrationJson[]): void {
  if (messages.length > PI_CHILD_SEED_MAX_MESSAGES) {
    throw new RangeError(`Child context seed exceeds ${PI_CHILD_SEED_MAX_MESSAGES} messages`);
  }
  let total = 0;
  messages.forEach((message, index) => {
    const role = messageRole(message);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      throw new TypeError(`Child context seed message ${index} is not a pi Message`);
    }
    if (!isRecord(message) || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
      throw new TypeError(`Child context seed message ${index} requires a finite timestamp`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > PI_CHILD_SEED_MAX_MESSAGE_BYTES) {
      throw new RangeError(`Child context seed message ${index} exceeds ${PI_CHILD_SEED_MAX_MESSAGE_BYTES} bytes`);
    }
    total += bytes;
  });
  if (total > PI_CHILD_SEED_MAX_BYTES) {
    throw new RangeError(`Child context seed exceeds ${PI_CHILD_SEED_MAX_BYTES} bytes`);
  }
}

function transcriptFits(
  messages: readonly { value: OrchestrationJson; bytes: number; tokens: number }[],
  start: number,
  maxTokens: number,
): boolean {
  if (messages.length - start > AGENT_TRANSCRIPT_MAX_MESSAGES) return false;
  let total = 0;
  let tokens = 0;
  for (let index = start; index < messages.length; index += 1) {
    const bytes = messages[index]!.bytes;
    if (bytes > AGENT_TRANSCRIPT_MAX_MESSAGE_BYTES) return false;
    total += bytes;
    tokens += messages[index]!.tokens;
    if (total > AGENT_TRANSCRIPT_MAX_BYTES) return false;
    if (tokens > maxTokens) return false;
  }
  return true;
}

function assistantToolCalls(message: OrchestrationJson): Array<{ id: string; name: string }> | null {
  if (!isRecord(message) || !Array.isArray(message.content)) return null;
  const calls: Array<{ id: string; name: string }> = [];
  const ids = new Set<string>();
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || ids.has(block.id)) {
      return null;
    }
    ids.add(block.id);
    calls.push({ id: block.id, name: block.name });
  }
  return calls;
}

function coherentEnd(messages: readonly { value: OrchestrationJson }[], start: number): number {
  const pending = new Map<string, string>();
  let safeEnd = start;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]!.value;
    const role = messageRole(message);
    if (role === "user") {
      if (pending.size > 0) break;
      safeEnd = index + 1;
      continue;
    }
    if (role === "assistant") {
      if (pending.size > 0) break;
      const calls = assistantToolCalls(message);
      if (calls === null) break;
      if (calls.length === 0) {
        safeEnd = index + 1;
        continue;
      }
      for (const call of calls) pending.set(call.id, call.name);
      continue;
    }
    if (role === "toolResult") {
      if (!isRecord(message) || typeof message.toolCallId !== "string" || typeof message.toolName !== "string") break;
      if (pending.get(message.toolCallId) !== message.toolName) break;
      pending.delete(message.toolCallId);
      if (pending.size === 0) safeEnd = index + 1;
      continue;
    }
    break;
  }
  return safeEnd;
}

export function projectPiChildTranscript(
  messages: readonly AgentMessage[],
  maxTokens = Number.POSITIVE_INFINITY,
): OrchestrationJson[] {
  if (!(maxTokens >= 0)) throw new RangeError("Child transcript token budget must be non-negative");
  const encoded = canonicalMessages(messages, "Agent transcript").map((value) => ({
    value,
    bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    tokens: hardMessageTokens(value),
  }));
  if (encoded.length === 0) return [];

  let stableEnd = 0;
  for (let start = 0; start < encoded.length; start += 1) {
    if (messageRole(encoded[start]!.value) !== "user") continue;
    stableEnd = Math.max(stableEnd, coherentEnd(encoded, start));
  }
  if (stableEnd === 0) return [];
  const stable = encoded.slice(0, stableEnd);
  for (let start = 0; start < stable.length; start += 1) {
    if (messageRole(stable[start]!.value) !== "user") continue;
    if (coherentEnd(stable, start) !== stable.length) continue;
    if (transcriptFits(stable, start, maxTokens)) return stable.slice(start).map((entry) => entry.value);
  }
  throw new RangeError("The latest Child Agent Task transcript exceeds its durable or model context budget");
}

function childTranscriptBaseBudget(
  model: Model<any>,
  systemPrompt: string,
  tools: readonly AgentTool<any>[],
): number {
  const contextWindow = Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? Math.trunc(model.contextWindow)
    : 128_000;
  const toolContract = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const fixed = hardTextTokens(systemPrompt)
    + hardTextTokens(JSON.stringify(toolContract))
    + 512;
  const outputReserve = Math.max(8_192, Math.floor(contextWindow * 0.2));
  const budget = contextWindow - fixed - outputReserve;
  if (budget < 1_024) {
    throw new RangeError("Child Agent system and tools leave no safe model context budget");
  }
  return budget;
}

function latestAssistant(messages: readonly AgentMessage[], from: number): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= from; index -= 1) {
    const message = messages[index] as Message | undefined;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function taskProviderUsage(messages: readonly AgentMessage[], from: number): {
  tokensUsed: number;
  costUsedMicros: number;
} {
  let tokensUsed = 0;
  let costUsedMicros = 0;
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index] as Message | undefined;
    if (message?.role !== "assistant") continue;
    tokensUsed += Math.max(0, Math.trunc(message.usage.totalTokens));
    costUsedMicros += Math.max(0, Math.round(message.usage.cost.total * 1_000_000));
  }
  return { tokensUsed, costUsedMicros };
}

function runErrorWithUsage(
  error: unknown,
  usage: { tokensUsed: number; costUsedMicros: number },
  fallbackStopReason: PiChildRunError["stopReason"] = "error",
): Error & { tokensUsed: number; costUsedMicros: number } {
  const currentTokens = error instanceof PiChildRunError ? error.tokensUsed : 0;
  const currentCost = error instanceof PiChildRunError ? error.costUsedMicros : 0;
  const value = error instanceof Error
    ? error
    : new PiChildRunError(String(error), fallbackStopReason, 0, 0, { cause: error });
  try {
    Object.assign(value, {
      tokensUsed: Math.max(usage.tokensUsed, currentTokens),
      costUsedMicros: Math.max(usage.costUsedMicros, currentCost),
    });
    return value as Error & { tokensUsed: number; costUsedMicros: number };
  } catch {
    return new PiChildRunError(
      value.message,
      fallbackStopReason,
      Math.max(usage.tokensUsed, currentTokens),
      Math.max(usage.costUsedMicros, currentCost),
      { cause: value },
    );
  }
}

export function taskActivityForTool(toolName: string): TaskActivityCode {
  const name = toolName.toLowerCase();
  const kind = toolKind(toolName);
  if (kind === "shell") return "tool:shell";
  if (kind === "read" || kind === "list") return "tool:read";
  if (kind === "write" || kind === "edit") return "tool:write";
  if (/browser|playwright|chrome|safari|firefox/.test(name)) return "tool:browser";
  if (/(^|__|_|-)(search|grep|find|rg|exa)(_|-|$)/.test(name)) return "tool:search";
  return "tool:other";
}

async function resolveValue<T>(
  value: Resolvable<T>,
  input: SupervisedAgentWorkerFactoryInput,
): Promise<T> {
  return typeof value === "function"
    ? await (value as (factoryInput: SupervisedAgentWorkerFactoryInput) => T | Promise<T>)(input)
    : value;
}

class PiChildWorker implements SupervisedAgentWorker {
  private agentPromise: Promise<PiChildAgent> | null = null;
  private agent: PiChildAgent | null = null;
  private unsubscribe: (() => void) | null = null;
  private transcriptVersion = 0;
  private transcriptBaseBudget = Number.POSITIVE_INFINITY;
  private transcriptTokenBudget = Number.POSITIVE_INFINITY;
  private toolFingerprint: string | undefined;
  private active: ActiveTask | null = null;
  private closed = false;
  private readonly now: () => number;
  private readonly lifecycleAbort: () => void;

  constructor(
    private readonly factoryInput: SupervisedAgentWorkerFactoryInput,
    private readonly options: PiChildWorkerFactoryOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.lifecycleAbort = () => this.abortActive();
    if (factoryInput.signal.aborted) this.closed = true;
    else factoryInput.signal.addEventListener("abort", this.lifecycleAbort, { once: true });
  }

  async run(input: SupervisedAgentRun): Promise<SupervisedAgentResult> {
    if (this.closed) throw abortError(this.factoryInput.signal.reason, "Child Agent worker is closed");
    if (this.active) throw new Error(`Agent ${this.factoryInput.agent.id} already has an active Task`);
    if (input.agent.id !== this.factoryInput.agent.id || input.task.agentId !== input.agent.id) {
      throw new Error("Child Agent worker received a Task for another Agent");
    }
    const assignment = assignmentFrom(input.task);
    let agent: PiChildAgent;
    try {
      const contract = workflowExecutionContract(input.task);
      agent = await this.ensureAgent(
        input.task,
        assignment.context,
        assignment.resetContext,
        input.signal,
        toolContractFingerprint(contract),
      );
      const source = assignment.resetContext ? [] : agent.state.messages;
      const prepared = this.projectTranscriptForAssignment(source, assignment.message);
      if (this.closed || this.factoryInput.signal.aborted || input.signal.aborted) {
        throw abortError(
          input.signal.reason ?? this.factoryInput.signal.reason,
          "Child Agent Task was aborted before its prompt started",
        );
      }
      agent.state.messages.splice(0, agent.state.messages.length, ...prepared);
    } catch (error) {
      this.releaseAgent();
      throw error;
    }
    if (this.closed || this.factoryInput.signal.aborted || input.signal.aborted) {
      throw abortError(
        input.signal.reason ?? this.factoryInput.signal.reason,
        "Child Agent Task was aborted before its prompt started",
      );
    }

    const beforeMessages = agent.state.messages.length;
    const workflow = workflowExecutionContract(input.task);
    const active: ActiveTask = {
      input,
      acceptingSteer: true,
      activity: "model",
      tools: new Map(),
      turnId: `turn_child_${input.task.id}_${input.task.leaseGeneration}`,
      startedAt: this.now(),
      assistantOrdinal: 0,
      assistantId: null,
      assistantMessage: null,
      proposed: new Map(),
      running: new Map(),
      messageStart: beforeMessages,
      usageBase: {
        tokensUsed: input.task.providerTokensUsed,
        costUsedMicros: input.task.providerCostUsedMicros,
      },
      tokensUsed: input.task.providerTokensUsed,
      costUsedMicros: input.task.providerCostUsedMicros,
      controllerSealedGraph: false,
      ...(workflow ? { workflow } : {}),
    };
    this.active = active;
    const taskAbort = () => this.abortActive();
    input.signal.addEventListener("abort", taskAbort, { once: true });

    let promptStarted = false;
    let result: SupervisedAgentResult | undefined;
    let runFailure: unknown;
    let saveFailure: unknown;
    let progressFailure: unknown;
    try {
      if (input.signal.aborted || this.factoryInput.signal.aborted) {
        throw abortError(input.signal.reason ?? this.factoryInput.signal.reason, "Child Agent Task was aborted");
      }
      this.publishProgress(active, { t: "turn_start", turnId: active.turnId, startedAt: active.startedAt });
      promptStarted = true;
      await agent.prompt(assignment.message);
      const terminal = latestAssistant(agent.state.messages, beforeMessages);
      const usage = this.cumulativeUsage(active, agent.state.messages);
      if (input.signal.aborted || this.factoryInput.signal.aborted) {
        throw abortError(input.signal.reason ?? this.factoryInput.signal.reason, "Child Agent Task was aborted");
      }
      if (!terminal) {
        throw new PiChildRunError(
          agent.state.errorMessage || "Child Agent stopped without an assistant response",
          "missing",
          usage.tokensUsed,
          usage.costUsedMicros,
        );
      }
      if (terminal.stopReason === "error") {
        throw new PiChildRunError(
          terminal.errorMessage || agent.state.errorMessage || "Child Agent provider response failed",
          "error",
          usage.tokensUsed,
          usage.costUsedMicros,
        );
      }
      if (terminal.stopReason === "aborted") {
        throw abortError(
          terminal.errorMessage || agent.state.errorMessage,
          "Child Agent provider response was aborted",
        );
      }
      if (workflow?.nodeKind === "controller" && !active.controllerSealedGraph) {
        throw new PiChildRunError(
          "Workflow Controller stopped before workflow_seal succeeded",
          "error",
          usage.tokensUsed,
          usage.costUsedMicros,
        );
      }
      const report = assistantText(terminal) || "Child Agent completed without a text report.";
      result = {
        summary: report,
        body: {
          agentId: input.agent.id,
          taskId: input.task.id,
          stopReason: terminal.stopReason,
          report: boundedReport(report),
        },
        artifacts: [],
        ...usage,
      };
    } catch (error) {
      runFailure = input.signal.aborted || this.factoryInput.signal.aborted
        ? abortError(input.signal.reason ?? this.factoryInput.signal.reason ?? error, "Child Agent Task was aborted")
        : error;
    } finally {
      active.acceptingSteer = false;
      input.signal.removeEventListener("abort", taskAbort);
      if (promptStarted) {
        try {
          this.persistTranscript(input);
        } catch (error) {
          saveFailure = error;
          this.releaseAgent();
        }
      }
      try {
        const intendedProgressStatus = input.signal.aborted
            || this.factoryInput.signal.aborted
            || this.closed
            || (runFailure instanceof Error && runFailure.name === "AbortError")
            ? "interrupted"
            : runFailure !== undefined || saveFailure !== undefined
              ? "failed"
              : "completed";
        const emittedProgressStatus = this.finishProgress(active, intendedProgressStatus);
        if (emittedProgressStatus !== intendedProgressStatus) {
          throw new Error("Child Agent completed with unsettled projected Tool steps");
        }
      } catch (error) {
        progressFailure = error;
      }
      if (this.active === active) this.active = null;
      if (this.closed) this.releaseAgent();
    }

    const usage = this.cumulativeUsage(active, agent.state.messages);
    const failures = [runFailure, saveFailure, progressFailure]
      .filter((error) => error !== undefined);
    if (failures.length > 0) {
      const failure = failures.length > 1
        ? new AggregateError(failures, "Child Agent run, progress, or transcript save failed")
        : progressFailure ?? saveFailure ?? runFailure;
      throw runErrorWithUsage(
        failure,
        usage,
        input.signal.aborted || this.factoryInput.signal.aborted ? "aborted" : "error",
      );
    }
    return result!;
  }

  steer(message: string): boolean {
    const active = this.active;
    const agent = this.agent;
    if (
      this.closed
      || !active?.acceptingSteer
      || active.input.signal.aborted
      || this.factoryInput.signal.aborted
      || !agent?.state.isStreaming
    ) return false;
    const value = message.trim();
    if (!value) return false;
    agent.steer({ role: "user", content: value, timestamp: this.now() });
    return true;
  }

  contextSnapshot(): readonly OrchestrationJson[] {
    return this.agent
      ? projectPiChildTranscript(this.agent.state.messages, this.transcriptBaseBudget)
      : [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factoryInput.signal.removeEventListener("abort", this.lifecycleAbort);
    this.abortActive();
    this.agent?.clearAllQueues?.();
    if (!this.active) this.releaseAgent();
  }

  private async ensureAgent(
    task: RuntimeTask,
    contextMode: PiChildContextMode,
    resetContext: boolean,
    signal: AbortSignal,
    fingerprint: string,
  ): Promise<PiChildAgent> {
    if (this.agent && this.toolFingerprint === fingerprint) return this.agent;
    if (this.agent) this.releaseAgent();
    if (this.agentPromise) return this.agentPromise;
    const pending = this.createAgent(task, contextMode, resetContext, signal, fingerprint);
    this.agentPromise = pending;
    try {
      const agent = await pending;
      this.agent = agent;
      return agent;
    } catch (error) {
      if (this.agentPromise === pending) this.agentPromise = null;
      throw error;
    }
  }

  private async createAgent(
    task: RuntimeTask,
    contextMode: PiChildContextMode,
    resetContext: boolean,
    signal: AbortSignal,
    fingerprint: string,
  ): Promise<PiChildAgent> {
    const snapshot = agentMessageDao.load(this.factoryInput.userId, this.factoryInput.agent.id);
    if (!snapshot) throw new Error("Child Agent identity no longer exists");
    this.transcriptVersion = snapshot.version;
    let messages = resetContext
      ? []
      : canonicalMessages(snapshot.messages, "Restored Agent transcript") as unknown as AgentMessage[];
    if (!resetContext && snapshot.version === 0 && messages.length === 0 && contextMode !== "none") {
      const limits = Object.freeze({
        maxMessages: PI_CHILD_SEED_MAX_MESSAGES,
        maxMessageBytes: PI_CHILD_SEED_MAX_MESSAGE_BYTES,
        maxBytes: PI_CHILD_SEED_MAX_BYTES,
      });
      const seed = canonicalMessages(await this.options.contextSeed({
        ...this.factoryInput,
        task,
        mode: contextMode,
        limits,
        signal,
      }), "Child context seed");
      assertSeedBounds(seed);
      messages = seed as unknown as AgentMessage[];
    }
    if (this.closed || signal.aborted || this.factoryInput.signal.aborted) {
      throw abortError(signal.reason ?? this.factoryInput.signal.reason, "Child Agent initialization was aborted");
    }

    const [model, baseSystemPrompt, thinkingLevel, tools] = await Promise.all([
      resolveValue(this.options.model, this.factoryInput),
      resolveValue(this.options.systemPrompt, this.factoryInput),
      resolveValue(this.options.thinkingLevel ?? "off", this.factoryInput),
      this.resolveTools(task),
    ]);
    const systemPrompt = systemPromptForTask(
      baseSystemPrompt,
      this.options.workflowControllerPrompt,
      task,
    );
    await prepareTokenizer();
    this.transcriptBaseBudget = childTranscriptBaseBudget(model, systemPrompt, tools);
    this.transcriptTokenBudget = this.tokenBudgetForAssignment(assignmentFrom(task).message);
    const projected = projectPiChildTranscript(messages, this.transcriptTokenBudget) as unknown as AgentMessage[];
    if (contextMode === "all" && projected.length !== messages.length) {
      throw new RangeError("Full parent context exceeds the actual Child Agent model budget");
    }
    messages = projected;
    if (this.closed || signal.aborted || this.factoryInput.signal.aborted) {
      throw abortError(signal.reason ?? this.factoryInput.signal.reason, "Child Agent initialization was aborted");
    }
    const createAgent = this.options.createAgent ?? ((agentOptions: AgentOptions) => new Agent(agentOptions));
    const agent = createAgent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel,
        tools: [...tools],
        messages,
      },
      sessionId: `${this.factoryInput.sessionId}:agent:${this.factoryInput.agent.id}`,
      getApiKey: this.options.getApiKey,
      streamFn: (activeModel, context, options) =>
        this.streamWithBudget(activeModel, context, options),
    });
    this.toolFingerprint = fingerprint;
    this.unsubscribe = agent.subscribe((event) => this.onAgentEvent(event));
    return agent;
  }

  private tokenBudgetForAssignment(message: string): number {
    const assignmentTokens = hardMessageTokens({ role: "user", content: message, timestamp: 0 });
    const budget = this.transcriptBaseBudget - assignmentTokens;
    if (budget < 1_024) throw new RangeError("Child Agent assignment leaves no safe model context budget");
    return budget;
  }

  private projectTranscriptForAssignment(messages: readonly AgentMessage[], message: string): AgentMessage[] {
    this.transcriptTokenBudget = this.tokenBudgetForAssignment(message);
    return projectPiChildTranscript(messages, this.transcriptTokenBudget) as unknown as AgentMessage[];
  }

  private async resolveTools(task: RuntimeTask): Promise<readonly AgentTool<any>[]> {
    const resolved = !this.options.tools
      ? createTools(this.options.sandbox, undefined, this.options.workspaceWriteLease)
      : typeof this.options.tools !== "function"
        ? this.options.tools
        : await this.options.tools({
      ...this.factoryInput,
      sandbox: this.options.sandbox,
      workspaceWriteLease: this.options.workspaceWriteLease,
    });
    const contract = workflowExecutionContract(task);
    if (!contract) return resolved.filter((tool) => !WORKFLOW_TOOL_NAMES.has(tool.name));
    const tools = [
      ...resolved.filter((tool) => !WORKFLOW_TOOL_NAMES.has(tool.name)),
      ...createWorkflowTools({
        nodeKind: contract.nodeKind,
        actor: () => this.workflowToolActor(),
        now: this.now,
        onMutation: this.options.onWorkflowMutation,
        expand: (input) => new WorkflowExpansionService({
          userId: this.factoryInput.userId,
          controllerAgent: this.factoryInput.agent,
          maxTreeAgents: this.options.workflowMaxTreeAgents?.()
            ?? DEFAULT_AGENT_SUPERVISOR_LIMITS.maxTreeAgents,
        }).expand({
          workflowId: input.workflowId,
          controllerNodeId: input.controllerNodeId,
          actorTaskId: input.actor.taskId,
          actorLeaseGeneration: input.actor.taskLeaseGeneration,
          expectedGraphRevision: input.expectedGraphRevision,
          mutationKey: input.mutationKey,
          nodes: input.nodes,
          edges: input.edges,
          at: input.at,
        }),
      }),
    ];
    if (contract.allowedTools === undefined) return tools;
    const allowed = new Set(contract.allowedTools);
    return tools.filter((tool) => allowed.has(tool.name));
  }

  private workflowToolActor() {
    const active = this.active;
    const workflow = active?.workflow;
    if (!active || !workflow || active.input.signal.aborted || this.factoryInput.signal.aborted) return undefined;
    return {
      userId: this.factoryInput.userId,
      taskId: active.input.task.id,
      taskLeaseGeneration: active.input.task.leaseGeneration,
      expectedWorkflowId: workflow.workflowId,
      expectedNodeId: workflow.nodeId,
      nodeKind: workflow.nodeKind,
    };
  }

  private async streamWithBudget(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> {
    const upstream = this.options.streamFn ?? streamSimple;
    let prepared = context;
    try {
      prepared = this.options.prepareStreamContext
        ? await this.options.prepareStreamContext(context, this.factoryInput)
        : context;
    } catch (error) {
      return budgetErrorStream(
        model,
        error instanceof Error ? error.message : "Child Agent provider context preparation failed",
      );
    }
    const active = this.active;
    const contract = active?.workflow;
    if (!active || !contract) return await upstream(model, prepared, options);
    const now = this.now();
    const remainingMs = contract.deadlineAt - now;
    if (remainingMs <= 0) return budgetErrorStream(model, "Workflow runtime budget expired before provider dispatch");
    const inputUpper = requestTokenUpperBound(prepared);
    const remainingTokens = contract.maxTokens - active.tokensUsed;
    let maxTokens = Math.min(
      Math.max(1, Math.trunc(model.maxTokens || remainingTokens)),
      options?.maxTokens ?? Number.MAX_SAFE_INTEGER,
      remainingTokens - inputUpper,
    );
    const rates = [model.cost.input, model.cost.cacheRead, model.cost.cacheWrite,
      ...(model.cost.tiers ?? []).flatMap((tier) => [tier.input, tier.cacheRead, tier.cacheWrite])]
      .filter((value) => Number.isFinite(value) && value >= 0);
    const inputRate = Math.max(0, ...rates);
    const outputRate = Math.max(0, model.cost.output,
      ...(model.cost.tiers ?? []).map((tier) => tier.output));
    const remainingCost = contract.maxCostMicros - active.costUsedMicros;
    const inputCostUpper = Math.ceil(inputUpper * inputRate);
    if (outputRate > 0) {
      maxTokens = Math.min(maxTokens, Math.floor((remainingCost - inputCostUpper) / outputRate));
    } else if (inputCostUpper > remainingCost) {
      maxTokens = 0;
    }
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      return budgetErrorStream(model, "Workflow token or cost reservation cannot admit another provider request");
    }
    return await upstream(model, prepared, {
      ...options,
      maxTokens,
      timeoutMs: Math.max(1, Math.min(options?.timeoutMs ?? remainingMs, remainingMs)),
    });
  }

  private cumulativeUsage(active: ActiveTask, messages: readonly AgentMessage[]): {
    tokensUsed: number;
    costUsedMicros: number;
  } {
    const current = taskProviderUsage(messages, active.messageStart);
    return {
      tokensUsed: active.usageBase.tokensUsed + current.tokensUsed,
      costUsedMicros: active.usageBase.costUsedMicros + current.costUsedMicros,
    };
  }

  private onAgentEvent(event: AgentEvent): void {
    const active = this.active;
    if (!active) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          if (active.tools.size === 0) this.publishActivity(active, "model");
          active.assistantOrdinal += 1;
          active.assistantId = `ca_${active.input.task.id}_${active.input.task.leaseGeneration}_${active.assistantOrdinal}`;
          active.assistantMessage = event.message as AssistantMessage;
          this.publishProgress(active, {
            t: "assistant_start",
            id: active.assistantId,
            turnId: active.turnId,
          });
        }
        break;
      case "message_update": {
        if (event.message.role !== "assistant" || !active.assistantId) break;
        const message = event.message as AssistantMessage;
        active.assistantMessage = message;
        const update = event.assistantMessageEvent;
        const block = "contentIndex" in update ? message.content[update.contentIndex] : undefined;
        if ((update.type === "toolcall_start" || update.type === "toolcall_delta") && block?.type === "toolCall") {
          active.proposed.set(
            progressIdentifier(block.id, "Tool call id"),
            projectedTool(block.name, block.arguments),
          );
        }
        if (update.type === "toolcall_start" || update.type === "toolcall_end") {
          this.publishProgress(active, {
            t: "assistant_update",
            id: active.assistantId,
            blocks: assistantBlocks(message),
            turnId: active.turnId,
          });
        }
        if (update.type === "toolcall_end") {
          const tool = projectedTool(update.toolCall.name, update.toolCall.arguments);
          const toolCallId = progressIdentifier(update.toolCall.id, "Tool call id");
          active.proposed.set(toolCallId, tool);
          this.publishProgress(active, {
            t: "tool_status",
            id: toolCallId,
            status: "ready",
            turnId: active.turnId,
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        const cumulative = this.cumulativeUsage(active, this.agent?.state.messages ?? []);
        active.tokensUsed = cumulative.tokensUsed;
        active.costUsedMicros = cumulative.costUsedMicros;
        if (!active.input.checkpointUsage(cumulative.tokensUsed, cumulative.costUsedMicros)) {
          this.abortActive();
        }
        if (active.assistantId) {
          const usage = message.usage?.totalTokens > 0 ? {
            input: message.usage.input,
            output: message.usage.output,
            total: message.usage.totalTokens,
            costUsd: message.usage.cost.total,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
          } : undefined;
          this.publishProgress(active, {
            t: "assistant_end",
            id: active.assistantId,
            blocks: assistantBlocks(message),
            ...(usage ? { usage } : {}),
            turnId: active.turnId,
          });
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            this.terminalizeProjectedTools(active, message.stopReason === "aborted" ? "interrupted" : "failed");
          }
          active.assistantId = null;
          active.assistantMessage = null;
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = progressIdentifier(event.toolCallId, "Tool call id");
        const activity = taskActivityForTool(event.toolName);
        active.tools.set(toolCallId, activity);
        this.publishActivity(active, activity);
        const tool = projectedTool(event.toolName, event.args);
        active.proposed.delete(toolCallId);
        active.running.set(toolCallId, { ...tool, startedAt: this.now() });
        this.publishProgress(active, {
          t: "tool_start",
          id: toolCallId,
          name: tool.name,
          toolKind: tool.toolKind,
          path: tool.path,
          arguments: tool.arguments,
          turnId: active.turnId,
        });
        this.publishProgress(active, {
          t: "tool_status",
          id: toolCallId,
          status: "running",
          runningElapsedMs: 0,
          turnId: active.turnId,
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = progressIdentifier(event.toolCallId, "Tool call id");
        const running = active.running.get(toolCallId);
        const tool = running ?? projectedTool(event.toolName, {});
        const interrupted = active.input.signal.aborted || this.factoryInput.signal.aborted;
        const sealed = isRecord(event.result)
          && isRecord(event.result.details)
          && event.result.details.graphSealed === true;
        if (event.toolName === "workflow_seal" && sealed && !interrupted && !event.isError) {
          active.controllerSealedGraph = true;
        }
        active.running.delete(toolCallId);
        active.tools.delete(toolCallId);
        this.publishProgress(active, {
          t: "tool_end",
          id: toolCallId,
          status: interrupted ? "denied" : event.isError ? "error" : "success",
          ...(interrupted ? { termination: "cancelled" as const } : {}),
          resultText: interrupted ? "Interrupted while this tool was running." : childToolText(event.result),
          isError: interrupted ? false : event.isError,
          durationMs: running ? Math.max(0, this.now() - running.startedAt) : undefined,
          shell: childShell(event.result),
          name: tool.name,
          toolKind: tool.toolKind,
          path: tool.path,
          arguments: tool.arguments,
          turnId: active.turnId,
        });
        if (event.isError) {
          try {
            taskResultDeliveryDao.discard({
              userId: this.factoryInput.userId,
              sessionId: this.factoryInput.sessionId,
              deliveryAgentId: active.input.agent.id,
              deliveryStepIds: [event.toolCallId],
            });
          } catch {
          }
        }
        const remaining = [...active.tools.values()].at(-1) ?? "model";
        this.publishActivity(active, remaining);
        break;
      }
    }
  }

  private publishProgress(active: ActiveTask, event: WireAgentEvent): void {
    if (active.input.task.awaitPolicy !== "join" || !active.input.task.ownerStepId) return;
    if (!active.input.publishProgress(event)) {
      throw abortError(undefined, "Joined Child progress attempt no longer owns its durable projection");
    }
  }

  private terminalizeProjectedTools(active: ActiveTask, status: "failed" | "interrupted"): void {
    const cancelled = status === "interrupted";
    const resultText = cancelled
      ? "Interrupted before this tool could settle."
      : "The Child Agent failed before this tool could settle.";
    for (const [id, tool] of active.proposed) {
      this.publishProgress(active, {
        t: "tool_end",
        id,
        status: cancelled ? "denied" : "error",
        ...(cancelled ? { termination: "cancelled" as const } : {}),
        resultText,
        isError: !cancelled,
        name: tool.name,
        toolKind: tool.toolKind,
        path: tool.path,
        arguments: tool.arguments,
        turnId: active.turnId,
      });
      active.proposed.delete(id);
    }
    for (const [id, tool] of active.running) {
      this.publishProgress(active, {
        t: "tool_end",
        id,
        status: cancelled ? "denied" : "error",
        ...(cancelled ? { termination: "cancelled" as const } : {}),
        resultText: cancelled ? "Interrupted while this tool was running." : resultText,
        isError: !cancelled,
        durationMs: Math.max(0, this.now() - tool.startedAt),
        name: tool.name,
        toolKind: tool.toolKind,
        path: tool.path,
        arguments: tool.arguments,
        turnId: active.turnId,
      });
      active.running.delete(id);
      active.tools.delete(id);
    }
  }

  private finishProgress(active: ActiveTask, status: AgentTurnStatus): AgentTurnStatus {
    if (active.input.task.awaitPolicy !== "join" || !active.input.task.ownerStepId) return status;
    let finalStatus = status;
    if (active.assistantId) {
      this.publishProgress(active, {
        t: "assistant_end",
        id: active.assistantId,
        blocks: active.assistantMessage ? assistantBlocks(active.assistantMessage) : [],
        turnId: active.turnId,
      });
      active.assistantId = null;
      active.assistantMessage = null;
    }
    if (active.proposed.size > 0 || active.running.size > 0) {
      if (finalStatus === "completed") finalStatus = "failed";
      this.terminalizeProjectedTools(active, finalStatus === "interrupted" ? "interrupted" : "failed");
    }
    const completedAt = this.now();
    this.publishProgress(active, {
      t: "turn_end",
      turnId: active.turnId,
      status: finalStatus,
      completedAt,
      durationMs: Math.max(0, completedAt - active.startedAt),
    });
    return finalStatus;
  }

  private publishActivity(active: ActiveTask, activity: TaskActivityCode): void {
    if (active.activity === activity || this.active !== active) return;
    active.activity = activity;
    try {
      active.input.updateActivity(activity);
    } catch {
    }
  }

  private persistTranscript(input: SupervisedAgentRun): void {
    if (!this.agent) throw new Error("Child Agent is missing while saving its transcript");
    const messages = projectPiChildTranscript(this.agent.state.messages, this.transcriptBaseBudget);
    const saved = agentMessageDao.replaceFromTask({
      userId: this.factoryInput.userId,
      agentId: input.agent.id,
      taskId: input.task.id,
      leaseGeneration: input.task.leaseGeneration,
      expectedVersion: this.transcriptVersion,
      messages,
      savedAt: this.now(),
    });
    if (!saved) throw new AgentTranscriptConflictError(input.agent.id, input.task.id);
    this.transcriptVersion = saved.version;
    const resultEvidence = messages.flatMap((message) =>
      isRecord(message)
        && message.role === "toolResult"
        && typeof message.toolCallId === "string"
        && typeof message.isError === "boolean"
        ? [{ stepId: message.toolCallId, isError: message.isError }]
        : []
    );
    if (resultEvidence.length > 0) {
      const timer = setTimeout(() => {
        try {
          const failed = resultEvidence.filter((item) => item.isError).map((item) => item.stepId);
          if (failed.length > 0) {
            taskResultDeliveryDao.discard({
              userId: this.factoryInput.userId,
              sessionId: this.factoryInput.sessionId,
              deliveryAgentId: input.agent.id,
              deliveryStepIds: failed,
            });
          }
          const delivered = resultEvidence.filter((item) => !item.isError).map((item) => item.stepId);
          const changes = delivered.length === 0 ? [] : taskResultDeliveryDao.commitDelivered({
            userId: this.factoryInput.userId,
            sessionId: this.factoryInput.sessionId,
            deliveryAgentId: input.agent.id,
            deliveryStepIds: delivered,
            at: this.now(),
          });
          try {
            this.options.onResultAcknowledged?.(changes);
          } catch {
          }
        } catch {
        }
      }, 0);
      timer.unref?.();
    }
    this.agent.state.messages.splice(
      0,
      this.agent.state.messages.length,
      ...(messages as unknown as AgentMessage[]),
    );
  }

  private abortActive(): void {
    if (!this.active) return;
    this.active.acceptingSteer = false;
    this.agent?.abort();
  }

  private releaseAgent(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.agent?.clearAllQueues?.();
    this.agent = null;
    this.agentPromise = null;
    this.toolFingerprint = undefined;
  }
}

export function createPiChildWorkerFactory(options: PiChildWorkerFactoryOptions): SupervisedAgentWorkerFactory {
  return (input) => new PiChildWorker(input, options);
}
