import assert from "node:assert/strict";
import { ProviderStreamTiming } from "../server/src/runtime/provider-stream-timing.ts";

const timing = new ProviderStreamTiming();
timing.beginRound(90);
timing.markRequestStarted(100);
timing.markHeaders(130, 200);
timing.observeUpdate("thinking_start", 145);
timing.observeUpdate("thinking_delta", 150);
timing.observeUpdate("thinking_end", 180);
timing.observeUpdate("text_delta", 190);
timing.observeUpdate("text_end", 210);

assert.deepEqual(timing.settle(480), {
  httpStatus: 200,
  requestToHeadersMs: 30,
  requestToFirstUpdateMs: 45,
  requestToFirstDeltaMs: 50,
  headersToFirstDeltaMs: 20,
  lastContentEndToAdapterSettledMs: 270,
  adapterDurationMs: 380,
  updateCount: 5,
  deltaCount: 2,
  contentEndCount: 2,
  lastContentEndKind: "text_end",
});

timing.beginRound(1_000);
timing.markRequestStarted(1_010);
timing.observeUpdate("toolcall_end", 1_080);
assert.deepEqual(timing.settle(1_120), {
  httpStatus: null,
  requestToHeadersMs: null,
  requestToFirstUpdateMs: 70,
  requestToFirstDeltaMs: null,
  headersToFirstDeltaMs: null,
  lastContentEndToAdapterSettledMs: 40,
  adapterDurationMs: 110,
  updateCount: 1,
  deltaCount: 0,
  contentEndCount: 1,
  lastContentEndKind: "toolcall_end",
});

timing.beginRound(2_000);
timing.markRequestStarted(2_005);
assert.deepEqual(timing.settle(2_025), {
  httpStatus: null,
  requestToHeadersMs: null,
  requestToFirstUpdateMs: null,
  requestToFirstDeltaMs: null,
  headersToFirstDeltaMs: null,
  lastContentEndToAdapterSettledMs: null,
  adapterDurationMs: 20,
  updateCount: 0,
  deltaCount: 0,
  contentEndCount: 0,
  lastContentEndKind: null,
});

console.log("OK provider stream timing: headers, TTFT, content-end tail, and adapter settlement stay distinct");
