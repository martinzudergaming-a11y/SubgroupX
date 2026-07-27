import { boundForCapture } from "./capture.ts";
import { errorMessage } from "../foundation/errors.ts";
import { JAIL_API, JAIL_BASE_URL } from "./providers.ts";

const REPLAY_TIMEOUT_MS = 90_000;
const MAX_REPLAY_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > max) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
        }
        break;
      }
      chunks.push(value);
    }
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), truncated };
}

export interface ReplayResult {
  ok: boolean;
  status: number;
  response: unknown;
  outputText: string | null;
  errorMessage: string | null;
}

function extractOutputText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.output_text === "string") return o.output_text;
  const out = o.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      const content = (item as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") parts.push(b.text);
        }
      }
    }
    if (parts.length) return parts.join("");
  }
  return null;
}

function extractError(json: unknown, httpOk: boolean): string | null {
  if (!json || typeof json !== "object") return httpOk ? null : "request failed";
  const o = json as Record<string, unknown>;
  const err = o.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") return err.message;
  const incomplete = o.incomplete_details as Record<string, unknown> | undefined;
  if (incomplete && typeof incomplete.reason === "string") return `incomplete: ${incomplete.reason}`;
  return null;
}

export async function replayOperatorRequest(params: unknown): Promise<ReplayResult> {
  const key = process.env.AGENT_WEB_JAIL_KEY;
  if (!key || !JAIL_BASE_URL || JAIL_API !== "openai-responses") {
    return {
      ok: false,
      status: 0,
      response: null,
      outputText: null,
      errorMessage: "operator model not configured for replay",
    };
  }
  const base = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const include = Array.isArray(base.include) ? [...base.include] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  const body = {
    ...base,
    stream: false,
    prompt_cache_key:
      typeof base.prompt_cache_key === "string" && base.prompt_cache_key ? base.prompt_cache_key : "oiia-admin-replay",
    include,
  };
  try {
    const res = await globalThis.fetch(`${JAIL_BASE_URL}/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "oiia/1.0",
      },
      body: JSON.stringify(body),
    });
    const { text } = await readCapped(res, MAX_REPLAY_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { __nonjson_body__: text.slice(0, 8192) };
    }
    const scrubbed = JSON.parse(boundForCapture(json));
    return {
      ok: res.ok,
      status: res.status,
      response: scrubbed,
      outputText: extractOutputText(scrubbed),
      errorMessage: extractError(scrubbed, res.ok),
    };
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      status: 0,
      response: null,
      outputText: null,
      errorMessage: aborted ? `replay timed out after ${REPLAY_TIMEOUT_MS}ms` : errorMessage(e),
    };
  }
}
