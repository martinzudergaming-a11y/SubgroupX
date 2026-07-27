import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

await import("../server/src/config.ts");
const { JAIL_API, JAIL_BASE_URL, JAIL_MODEL_IDS } = await import("../server/src/runtime/providers.ts");

const argv = process.argv.slice(2);
const roundsArg = argv.find((arg) => arg.startsWith("--rounds="));
const rounds = Math.min(5, Math.max(1, Number(roundsArg?.slice("--rounds=".length) || 1) || 1));
const requireIncremental = argv.includes("--require-incremental");
const paceArg = argv.find((arg) => arg.startsWith("--pace-ms="));
const paceMs = Math.min(60_000, Math.max(0, Number(paceArg?.slice("--pace-ms=".length) || 0) || 0));
const retriesArg = argv.find((arg) => arg.startsWith("--retries="));
const retries = Math.min(4, Math.max(0, Number(retriesArg?.slice("--retries=".length) || 0) || 0));
const toolOnly = argv.includes("--tool-only");
const textOnly = argv.includes("--text-only");
if (toolOnly && textOnly) throw new Error("--tool-only and --text-only are mutually exclusive");
const requestedModels = argv.filter((arg) => !arg.startsWith("--"));
const models = requestedModels.length > 0 ? [...new Set(requestedModels)] : JAIL_MODEL_IDS;
const key = process.env.AGENT_WEB_JAIL_KEY ?? "";
const baseUrl = JAIL_BASE_URL.replace(/\/$/, "");

if (!key || !baseUrl) throw new Error("AGENT_WEB_JAIL_KEY and AGENT_WEB_JAIL_BASE_URL are required");
if (JAIL_API !== "openai-responses") throw new Error(`audit supports openai-responses, received ${JAIL_API}`);

type JsonObject = Record<string, any>;
type StreamRead = {
  status: number;
  contentType: string;
  transferEncoding: string | null;
  headersMs: number;
  terminalType: string | null;
  terminalMs: number | null;
  attempts: number;
  reads: number;
  totalBytes: number;
  maxReadBytes: number;
  events: JsonObject[];
  eventReadBatches: number[];
  eventMs: number[];
};

function emptyStreamRead(status = 0, contentType = "", transferEncoding: string | null = null): StreamRead {
  return {
    status,
    contentType,
    transferEncoding,
    headersMs: 0,
    terminalType: null,
    terminalMs: null,
    attempts: 1,
    reads: 0,
    totalBytes: 0,
    maxReadBytes: 0,
    events: [],
    eventReadBatches: [],
    eventMs: [],
  };
}

async function responsesStream(payload: JsonObject, timeoutMs = 180_000): Promise<StreamRead> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": "oiia-upstream-audit/1.0",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return emptyStreamRead();
  }
  const headersMs = performance.now() - started;
  if (!response.ok || !response.body) {
    try { await response.body?.cancel(); } catch {  }
    return {
      ...emptyStreamRead(
        response.status,
        response.headers.get("content-type") ?? "",
        response.headers.get("transfer-encoding"),
      ),
      headersMs,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: JsonObject[] = [];
  const eventReadBatches: number[] = [];
  const eventMs: number[] = [];
  let buffer = "";
  let reads = 0;
  let totalBytes = 0;
  let maxReadBytes = 0;
  let terminalType: string | null = null;
  let terminalMs: number | null = null;

  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      reads++;
      totalBytes += value.byteLength;
      maxReadBytes = Math.max(maxReadBytes, value.byteLength);
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let event: JsonObject;
          try { event = JSON.parse(data) as JsonObject; } catch { continue; }
          events.push(event);
          eventReadBatches.push(reads);
          eventMs.push(performance.now() - started);
          if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
            terminalType = event.type;
            terminalMs = performance.now() - started;
            await reader.cancel();
            break outer;
          }
        }
      }
    }
  } catch {
    try { await reader.cancel(); } catch {  }
  }

  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    transferEncoding: response.headers.get("transfer-encoding"),
    headersMs,
    terminalType,
    terminalMs,
    attempts: 1,
    reads,
    totalBytes,
    maxReadBytes,
    events,
    eventReadBatches,
    eventMs,
  };
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function responsesStreamWithRetries(payload: JsonObject, timeoutMs = 180_000): Promise<StreamRead> {
  let read = await responsesStream(payload, timeoutMs);
  let attempts = 1;
  while (attempts <= retries && RETRYABLE_STATUSES.has(read.status)) {
    await sleep(Math.max(1_000, paceMs));
    attempts++;
    read = await responsesStream(payload, timeoutMs);
  }
  return { ...read, attempts };
}

function basePayload(model: string, nonce: string): JsonObject {
  return {
    model,
    stream: true,
    max_output_tokens: 1_600,
    reasoning: { effort: "low", summary: "auto" },
    prompt_cache_key: `oiia-upstream-audit-${model}-${nonce}`,
    include: ["reasoning.encrypted_content"],
    store: false,
  };
}

type TextAudit = {
  model: string;
  round: number;
  status: number;
  contentType: string;
  transferEncoding: string | null;
  headersMs: number;
  firstDeltaMs: number | null;
  visibleDeltaSpanMs: number;
  terminalMs: number | null;
  reads: number;
  deltaBatches: number;
  deltaEvents: number;
  deltaChars: number;
  maxReadShare: number;
  maxBatchTextShare: number;
  terminalType: string | null;
  attempts: number;
  noncePresent: boolean;
  genuineIncrementalStream: boolean;
};

async function auditText(model: string, round: number): Promise<TextAudit> {
  const nonce = crypto.randomBytes(5).toString("hex");
  const input = [
    `Unique stream audit ${nonce}. Return exactly 128 lines.`,
    `Line N must be \"NNN-${nonce}-incremental-transport-proof\" for N 001 through 128.`,
    "No heading, markdown fence, or explanation.",
  ].join(" ");
  const read = await responsesStreamWithRetries({
    ...basePayload(model, `${round}-${nonce}`),
    input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
  });

  const deltaBatches = new Set<number>();
  const charsByBatch = new Map<number, number>();
  let firstDeltaMs: number | null = null;
  let lastDeltaMs: number | null = null;
  let deltaEvents = 0;
  let deltaChars = 0;
  let text = "";
  for (let index = 0; index < read.events.length; index++) {
    const event = read.events[index];
    if (event.type !== "response.output_text.delta" || typeof event.delta !== "string") continue;
    const now = read.eventMs[index];
    firstDeltaMs ??= now;
    lastDeltaMs = now;
    deltaEvents++;
    deltaChars += event.delta.length;
    text += event.delta;
    const batch = read.eventReadBatches[index];
    deltaBatches.add(batch);
    charsByBatch.set(batch, (charsByBatch.get(batch) ?? 0) + event.delta.length);
  }
  const maxBatchChars = Math.max(0, ...charsByBatch.values());
  const maxBatchTextShare = deltaChars > 0 ? maxBatchChars / deltaChars : 1;
  const visibleDeltaSpanMs = firstDeltaMs === null || lastDeltaMs === null ? 0 : lastDeltaMs - firstDeltaMs;
  const maxReadShare = read.totalBytes > 0 ? read.maxReadBytes / read.totalBytes : 1;
  const genuineIncrementalStream =
    read.status === 200 &&
    read.contentType.includes("text/event-stream") &&
    read.terminalType === "response.completed" &&
    deltaEvents >= 20 &&
    deltaBatches.size >= 5 &&
    visibleDeltaSpanMs >= 100 &&
    maxBatchTextShare < 0.8;

  return {
    model,
    round,
    status: read.status,
    contentType: read.contentType,
    transferEncoding: read.transferEncoding,
    headersMs: Math.round(read.headersMs),
    firstDeltaMs: firstDeltaMs === null ? null : Math.round(firstDeltaMs),
    visibleDeltaSpanMs: Math.round(visibleDeltaSpanMs),
    terminalMs: read.terminalMs === null ? null : Math.round(read.terminalMs),
    reads: read.reads,
    deltaBatches: deltaBatches.size,
    deltaEvents,
    deltaChars,
    maxReadShare: Number(maxReadShare.toFixed(4)),
    maxBatchTextShare: Number(maxBatchTextShare.toFixed(4)),
    terminalType: read.terminalType,
    attempts: read.attempts,
    noncePresent: text.includes(nonce),
    genuineIncrementalStream,
  };
}

type ToolAudit = {
  model: string;
  status: number;
  terminalType: string | null;
  attempts: number;
  headersMs: number;
  firstArgumentDeltaMs: number | null;
  lastArgumentDeltaMs: number | null;
  argumentDeltaSpanMs: number;
  argumentsDoneMs: number | null;
  callItemDoneMs: number | null;
  terminalMs: number | null;
  providerCommitWaitMs: number | null;
  argumentDeltaEvents: number;
  argumentDeltaBatches: number;
  argumentDeltaChars: number;
  maxArgumentBatchShare: number;
  reads: number;
  totalBytes: number;
  maxReadShare: number;
  genuineIncrementalArguments: boolean;
  callMatched: boolean;
  resultStatus: number | null;
  resultTerminalType: string | null;
  resultAttempts: number | null;
  resultHeadersMs: number | null;
  resultFirstDeltaMs: number | null;
  resultDeltaSpanMs: number;
  resultDeltaEvents: number;
  resultDeltaBatches: number;
  resultTerminalMs: number | null;
  resultMatched: boolean;
  passed: boolean;
};

async function auditToolRoundTrip(model: string): Promise<ToolAudit> {
  const nonce = crypto.randomBytes(5).toString("hex");
  const tool = {
    type: "function",
    name: "stream_probe",
    description: "Records an upstream audit token",
    parameters: {
      type: "object",
      properties: { token: { type: "string" }, payload: { type: "string" } },
      required: ["token", "payload"],
      additionalProperties: false,
    },
    strict: true,
  };
  const probePayload = Array.from({ length: 48 }, (_, index) => `${String(index + 1).padStart(2, "0")}-${nonce}`).join("|");
  const user = {
    role: "user",
    content: [{
      type: "input_text",
      text: `Call stream_probe exactly once with token ${nonce} and payload exactly ${probePayload}. After its result, reply exactly TOOL_OK_${nonce}.`,
    }],
  };
  const first = await responsesStreamWithRetries({
    ...basePayload(model, `tool-${nonce}`),
    input: [user],
    tools: [tool],
    tool_choice: "auto",
    max_output_tokens: 500,
  });
  const argumentDeltas: Array<{ delta: string; batch: number; ms: number }> = [];
  const outputItems: JsonObject[] = [];
  let argumentsDoneMs: number | null = null;
  let callItemDoneMs: number | null = null;
  for (let index = 0; index < first.events.length; index++) {
    const event = first.events[index];
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      argumentDeltas.push({ delta: event.delta, batch: first.eventReadBatches[index], ms: first.eventMs[index] });
    }
    if (event.type === "response.function_call_arguments.done") {
      argumentsDoneMs = first.eventMs[index];
    }
    if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      outputItems.push(event.item);
      if (event.item.type === "function_call") callItemDoneMs = first.eventMs[index];
    }
  }
  const argumentDeltaChars = argumentDeltas.reduce((sum, item) => sum + item.delta.length, 0);
  const argumentCharsByBatch = new Map<number, number>();
  for (const item of argumentDeltas) {
    argumentCharsByBatch.set(item.batch, (argumentCharsByBatch.get(item.batch) ?? 0) + item.delta.length);
  }
  const argumentDeltaBatches = new Set(argumentDeltas.map((item) => item.batch)).size;
  const firstArgumentDeltaMs = argumentDeltas[0]?.ms ?? null;
  const lastArgumentDeltaMs = argumentDeltas.at(-1)?.ms ?? null;
  const argumentDeltaSpanMs = firstArgumentDeltaMs == null || lastArgumentDeltaMs == null
    ? 0
    : lastArgumentDeltaMs - firstArgumentDeltaMs;
  const maxArgumentBatchChars = Math.max(0, ...argumentCharsByBatch.values());
  const maxArgumentBatchShare = argumentDeltaChars > 0 ? maxArgumentBatchChars / argumentDeltaChars : 1;
  const maxReadShare = first.totalBytes > 0 ? first.maxReadBytes / first.totalBytes : 1;
  const providerCommitWaitMs = callItemDoneMs == null || first.terminalMs == null
    ? null
    : Math.max(0, first.terminalMs - callItemDoneMs);
  const genuineIncrementalArguments =
    first.status === 200 &&
    argumentDeltas.length >= 4 &&
    argumentDeltaBatches >= 2 &&
    argumentDeltaSpanMs >= 20 &&
    maxArgumentBatchShare < 0.9;
  const call = outputItems.find((item) => item.type === "function_call");
  let args: JsonObject | null = null;
  try { args = JSON.parse(String(call?.arguments ?? "")) as JsonObject; } catch {  }
  const callMatched = call?.name === "stream_probe" && args?.token === nonce && args?.payload === probePayload && typeof call?.call_id === "string";
  const baseResult = {
    model,
    status: first.status,
    terminalType: first.terminalType,
    attempts: first.attempts,
    headersMs: Math.round(first.headersMs),
    firstArgumentDeltaMs: firstArgumentDeltaMs == null ? null : Math.round(firstArgumentDeltaMs),
    lastArgumentDeltaMs: lastArgumentDeltaMs == null ? null : Math.round(lastArgumentDeltaMs),
    argumentDeltaSpanMs: Math.round(argumentDeltaSpanMs),
    argumentsDoneMs: argumentsDoneMs == null ? null : Math.round(argumentsDoneMs),
    callItemDoneMs: callItemDoneMs == null ? null : Math.round(callItemDoneMs),
    terminalMs: first.terminalMs == null ? null : Math.round(first.terminalMs),
    providerCommitWaitMs: providerCommitWaitMs == null ? null : Math.round(providerCommitWaitMs),
    argumentDeltaEvents: argumentDeltas.length,
    argumentDeltaBatches,
    argumentDeltaChars,
    maxArgumentBatchShare: Number(maxArgumentBatchShare.toFixed(4)),
    reads: first.reads,
    totalBytes: first.totalBytes,
    maxReadShare: Number(maxReadShare.toFixed(4)),
    genuineIncrementalArguments,
  };
  if (!callMatched) {
    return {
      ...baseResult,
      callMatched: false,
      resultStatus: null,
      resultTerminalType: null,
      resultAttempts: null,
      resultHeadersMs: null,
      resultFirstDeltaMs: null,
      resultDeltaSpanMs: 0,
      resultDeltaEvents: 0,
      resultDeltaBatches: 0,
      resultTerminalMs: null,
      resultMatched: false,
      passed: false,
    };
  }

  const replayItems = outputItems
    .filter((item) => item.type === "reasoning" || item === call)
    .map((item) => item === call
      ? { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments }
      : item);
  if (paceMs > 0) await sleep(paceMs);
  const second = await responsesStreamWithRetries({
    ...basePayload(model, `tool-result-${nonce}`),
    input: [
      user,
      ...replayItems,
      { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ accepted: true, token: nonce }) },
    ],
    tools: [tool],
    tool_choice: "auto",
    max_output_tokens: 500,
  });
  const finalText = second.events
    .filter((event) => event.type === "response.output_text.delta" && typeof event.delta === "string")
    .map((event) => event.delta)
    .join("")
    .trim();
  const resultDeltas = second.events.flatMap((event, index) =>
    event.type === "response.output_text.delta" && typeof event.delta === "string"
      ? [{ ms: second.eventMs[index], batch: second.eventReadBatches[index] }]
      : []
  );
  const resultFirstDeltaMs = resultDeltas[0]?.ms ?? null;
  const resultLastDeltaMs = resultDeltas.at(-1)?.ms ?? null;
  const resultMatched = finalText === `TOOL_OK_${nonce}`;
  const passed =
    first.status === 200 &&
    first.terminalType === "response.completed" &&
    callMatched &&
    second.status === 200 &&
    second.terminalType === "response.completed" &&
    resultMatched;
  return {
    ...baseResult,
    callMatched,
    resultStatus: second.status,
    resultTerminalType: second.terminalType,
    resultAttempts: second.attempts,
    resultHeadersMs: Math.round(second.headersMs),
    resultFirstDeltaMs: resultFirstDeltaMs == null ? null : Math.round(resultFirstDeltaMs),
    resultDeltaSpanMs: resultFirstDeltaMs == null || resultLastDeltaMs == null ? 0 : Math.round(resultLastDeltaMs - resultFirstDeltaMs),
    resultDeltaEvents: resultDeltas.length,
    resultDeltaBatches: new Set(resultDeltas.map((item) => item.batch)).size,
    resultTerminalMs: second.terminalMs == null ? null : Math.round(second.terminalMs),
    resultMatched,
    passed,
  };
}

const discoveryResponse = await fetch(`${baseUrl}/models`, {
  headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "oiia-upstream-audit/1.0" },
  signal: AbortSignal.timeout(30_000),
  redirect: "error",
}).catch(() => null);
const discoveryBody = (await discoveryResponse?.json().catch(() => ({})) ?? {}) as JsonObject;
const discovered = (Array.isArray(discoveryBody.data)
  ? discoveryBody.data
  : Array.isArray(discoveryBody.models)
    ? discoveryBody.models
    : [])
  .map((item: any) => typeof item === "string" ? item : item?.id)
  .filter((id: unknown): id is string => typeof id === "string");
const discovery = {
  status: discoveryResponse?.status ?? 0,
  requested: models.map((model) => ({ model, present: discovered.includes(model) })),
};
console.log(JSON.stringify({ kind: "discovery", ...discovery }));

const textAudits: TextAudit[] = [];
if (!toolOnly) {
  for (let round = 1; round <= rounds; round++) {
    for (const model of models) {
      if (textAudits.length > 0 && paceMs > 0) await sleep(paceMs);
      const result = await auditText(model, round);
      textAudits.push(result);
      console.log(JSON.stringify({ kind: "text", ...result }));
    }
  }
}

const toolAudits: ToolAudit[] = [];
if (!textOnly) {
  for (const model of models) {
    if ((textAudits.length > 0 || toolAudits.length > 0) && paceMs > 0) await sleep(paceMs);
    const result = await auditToolRoundTrip(model);
    toolAudits.push(result);
    console.log(JSON.stringify({ kind: "tool", ...result }));
  }
}

const summary = {
  discoveryOk: Boolean(discoveryResponse?.ok) && discovery.requested.every((item) => item.present),
  toolsOk: toolAudits.every((item) => item.passed),
  incrementalByModel: models.map((model) => {
    const runs = textAudits.filter((item) => item.model === model);
    return { model, passed: runs.filter((item) => item.genuineIncrementalStream).length, rounds: runs.length };
  }),
};
console.log(JSON.stringify({ kind: "summary", ...summary }));

if (!summary.discoveryOk || (!textOnly && !summary.toolsOk)) process.exitCode = 1;
if (requireIncremental && (!toolOnly && summary.incrementalByModel.some((item) => item.passed !== item.rounds))) process.exitCode = 2;
