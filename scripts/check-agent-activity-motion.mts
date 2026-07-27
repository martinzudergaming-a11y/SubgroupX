import assert from "node:assert/strict";
import { taskActivityMotion } from "../web/src/orchestration/agent-activity-motion.ts";
import { sessionActivityMotion } from "../web/src/dashboard/session/composer/agent-activity-motion.ts";
import type { TimelineItem, ToolCallStatus, ToolKind } from "../shared/src/protocol.ts";

const now = 1_784_700_000_000;

function tool(status: ToolCallStatus, toolKind: ToolKind): Extract<TimelineItem, { kind: "tool" }> {
  return {
    kind: "tool",
    id: `tool-${status}-${toolKind}`,
    seq: 1,
    name: "fixture",
    toolKind,
    arguments: {},
    status,
    ts: now,
  };
}

assert.deepEqual(taskActivityMotion("starting"), { state: "shaping", paused: false });
assert.deepEqual(taskActivityMotion("running", "model"), { state: "solving", paused: false });
assert.deepEqual(taskActivityMotion("running", "tool:search"), { state: "searching", paused: false });
assert.deepEqual(taskActivityMotion("running", "tool:write"), { state: "composing", paused: false });
assert.deepEqual(taskActivityMotion("running", "approval"), { state: "listening", paused: true });
assert.deepEqual(taskActivityMotion("waiting", "tool:shell"), { state: "listening", paused: true });
assert.equal(taskActivityMotion("queued", "model"), null);
assert.equal(taskActivityMotion("succeeded", "tool:write"), null);

assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("streaming_args", "shell") }), { state: "shaping", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("ready", "shell") }), { state: "listening", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("running", "search") }), { state: "searching", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("running", "write") }), { state: "composing", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("running", "subagent") }), { state: "shaping", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: tool("success", "shell") }), { state: "solving", paused: false });

const thinking: Extract<TimelineItem, { kind: "assistant" }> = {
  kind: "assistant",
  id: "assistant-thinking",
  seq: 2,
  blocks: [{ type: "thinking", thinking: "Inspecting the evidence" }],
  streaming: true,
  ts: now,
};
const composing: Extract<TimelineItem, { kind: "assistant" }> = {
  ...thinking,
  id: "assistant-composing",
  blocks: [{ type: "text", text: "Here is the result" }],
};
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: thinking }), { state: "solving", paused: false });
assert.deepEqual(sessionActivityMotion({ modelRetrying: false, awaitingApproval: false, last: composing }), { state: "composing", paused: false });

assert.deepEqual(sessionActivityMotion({ modelRetrying: true, awaitingApproval: true, last: tool("running", "shell") }), { state: "listening", paused: true });
assert.deepEqual(sessionActivityMotion({ modelRetrying: true, awaitingApproval: false, last: tool("running", "shell") }), { state: "solving", paused: false });

console.log("agent activity motion checks passed");
