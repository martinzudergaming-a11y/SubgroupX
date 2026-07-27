import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const modules = [
  path.join(ROOT, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js"),
  path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js"),
];

const model = {
  id: "terminal-fixture",
  name: "Terminal fixture",
  api: "openai-responses",
  provider: "fixture",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

function output() {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function openAfterTerminal(type: "response.completed" | "response.incomplete") {
  let emitted = false;
  let closed = false;
  const status = type === "response.completed" ? "completed" : "incomplete";
  const events: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!emitted) {
            emitted = true;
            return {
              done: false as const,
              value: {
                type,
                sequence_number: 1,
                response: {
                  id: `resp_${status}`,
                  status,
                  output: [],
                  usage: {
                    input_tokens: 12,
                    output_tokens: 3,
                    total_tokens: 15,
                    input_tokens_details: { cached_tokens: 0 },
                  },
                },
              },
            };
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        async return() {
          closed = true;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  return { events, wasClosed: () => closed };
}

async function within<T>(promise: Promise<T>, ms = 150): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`waited more than ${ms} ms for transport EOF`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const modulePath of modules) {
  const imported = await import(pathToFileURL(modulePath).href) as {
    processResponsesStream: (
      events: AsyncIterable<unknown>,
      output: Record<string, any>,
      stream: { push: (event: unknown) => void },
      model: Record<string, any>,
    ) => Promise<void>;
  };

  for (const type of ["response.completed", "response.incomplete"] as const) {
    const result = output();
    const source = openAfterTerminal(type);
    await within(imported.processResponsesStream(source.events, result, { push() {} }, model));
    assert.equal(source.wasClosed(), true, `${modulePath}: ${type} closes the idle iterator tail`);
    assert.equal(result.stopReason, type === "response.completed" ? "stop" : "length");
    assert.equal(result.usage.totalTokens, 15);
  }

  await assert.rejects(
    imported.processResponsesStream(
      (async function* () {
        yield { type: "response.created", sequence_number: 0, response: { id: "resp_early_eof" } };
      })(),
      output(),
      { push() {} },
      model,
    ),
    /ended before a terminal response event/,
    `${modulePath}: pre-terminal EOF remains an error`,
  );
}

console.log("OK responses-terminal: completed/incomplete stop both pi-ai copies without waiting for EOF");
