import assert from "node:assert/strict";
import {
  groupTimelineUnits,
  isQuietTool,
  summarizeToolRun,
  QUIET_BODY_MAX_CHARS,
  type ToolFoldMode,
} from "../web/src/dashboard/session/timeline/timeline-helpers.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

let seq = 0;
function tool(over: Partial<ToolItem> & { name?: string }): ToolItem {
  seq += 1;
  return {
    kind: "tool",
    id: `t${seq}`,
    seq,
    name: over.name ?? "bash",
    toolKind: over.toolKind ?? "shell",
    arguments: {},
    status: "success",
    ts: seq,
    ...over,
  } as ToolItem;
}
const prose = (): TimelineItem =>
  ({ kind: "assistant", id: `a${++seq}`, seq, blocks: [{ type: "text", text: "hi" }], streaming: false, ts: seq }) as TimelineItem;
const thinking = (streaming = false): TimelineItem =>
  ({ kind: "assistant", id: `a${++seq}`, seq, blocks: [{ type: "thinking", thinking: "hmm" }], streaming, ts: seq }) as TimelineItem;

const silentShell = () => tool({ toolKind: "shell", shell: { stdout: "", stderr: "", exitCode: 0 } as ToolItem["shell"] });
const loudShell = (out = "hello") => tool({ toolKind: "shell", shell: { stdout: out, stderr: "", exitCode: 0 } as ToolItem["shell"] });

assert.equal(isQuietTool(silentShell()), true, "a shell call with no output is quiet");
assert.equal(isQuietTool(loudShell("x")), false, "ANY shell stdout is real output — never quiet");
assert.equal(isQuietTool(tool({ toolKind: "shell", resultText: "" })), true, "shell without structured result and empty text is quiet");
assert.equal(isQuietTool(tool({ toolKind: "read", name: "read_file", resultText: "long\nfile\ncontent" })), true, "reads are navigation — always quiet");
assert.equal(isQuietTool(tool({ toolKind: "search", name: "grep", resultText: "a.ts:1: hit" })), true, "searches are navigation — always quiet");
assert.equal(isQuietTool(tool({ toolKind: "list", name: "list_files", resultText: "a\nb" })), true, "listings are navigation — always quiet");
assert.equal(isQuietTool(tool({ toolKind: "write", name: "write_file", resultText: "" })), false, "writes keep their row (visible side effect)");
assert.equal(isQuietTool(tool({ toolKind: "edit", name: "edit_file", resultText: "" })), false, "edits keep their row (visible side effect)");
assert.equal(isQuietTool(tool({ toolKind: "other", name: "mcp__fff__grep", resultText: "ok" })), true, "a one-line confirmation is not 正文");
assert.equal(
  isQuietTool(tool({ toolKind: "other", name: "mcp__x__y", resultText: "x".repeat(QUIET_BODY_MAX_CHARS + 1) })),
  false,
  "a long single line is real output",
);
assert.equal(isQuietTool(tool({ toolKind: "other", name: "mcp__x__y", resultText: "a\nb" })), false, "multi-line output is real output");

const run = [silentShell(), silentShell(), tool({ toolKind: "list", name: "list_files", resultText: "a\nb" }), loudShell(), tool({ toolKind: "write", name: "write_file" })];

const off = groupTimelineUnits(run, "off");
assert.equal(off.length, 5, "off → identity");
assert.ok(off.every((u) => u.item), "off → no groups");

const quiet = groupTimelineUnits(run, "quiet");
assert.equal(quiet.length, 3, "quiet → [group(silent×2+list), loudShell, write]");
assert.equal(quiet[0].tools?.length, 3, "the two silent shells + the listing fold");
assert.equal((quiet[1].item as ToolItem).toolKind, "shell", "the command WITH output keeps its row");
assert.equal((quiet[2].item as ToolItem).toolKind, "write", "the write keeps its row");

const all = groupTimelineUnits(run, "all");
assert.equal(all.length, 1, "all → one group");
assert.equal(all[0].tools?.length, 5, "all five calls fold");

const broken = groupTimelineUnits([silentShell(), prose(), silentShell()], "quiet");
assert.equal(broken.length, 3, "a run of 1 on each side of prose stays individual");
assert.ok(broken.every((u) => u.item), "no group forms across prose");

const live = groupTimelineUnits([silentShell(), silentShell(), tool({ status: "running" })], "all");
assert.equal(live.length, 2, "terminal run folds, live tool stays out");
assert.equal(live[0].tools?.length, 2);
assert.equal((live[1].item as ToolItem).status, "running");

const failed = groupTimelineUnits([silentShell(), tool({ status: "error" }), silentShell()], "all");
assert.ok(failed.every((u) => u.item), "an error row never enters a group");

{
  const chain = [thinking(), silentShell(), thinking(), silentShell(), thinking(), prose()];
  const units = groupTimelineUnits(chain, "quiet");
  assert.equal(units.length, 3, "chain → [group, trailing thinking, prose]");
  assert.equal(units[0].tools?.length, 2, "both actions fold");
  assert.equal(units[0].run?.length, 4, "the run replays leading+interleaved thinking with its actions");
  assert.equal(units[1].item?.kind, "assistant", "a trailing interlude (no following action) spills back out");
  assert.equal(units[2].item?.kind, "assistant");

  const live = groupTimelineUnits([silentShell(), thinking(true), silentShell()], "all");
  assert.ok(live.every((u) => u.item), "a streaming interlude breaks the run");

  const prosed = groupTimelineUnits([silentShell(), prose(), silentShell()], "all");
  assert.ok(prosed.every((u) => u.item), "prose between actions never folds away");
}

const withCanvas = groupTimelineUnits([silentShell(), tool({ toolKind: "canvas", name: "canvas" }), silentShell()], "all");
assert.ok(withCanvas.every((u) => u.item), "a canvas card never folds into a group");
const withChildren = groupTimelineUnits(
  [silentShell(), tool({ name: "spawn_subagent", toolKind: "other", children: [prose()] }), silentShell()],
  "all",
);
assert.ok(withChildren.every((u) => u.item), "a subagent (nested timeline) never folds");

const parts = summarizeToolRun([
  silentShell(),
  tool({ toolKind: "read", name: "read_file" }),
  silentShell(),
  tool({ toolKind: "other", name: "mcp__fff__grep" }),
  tool({ toolKind: "other", name: "mcp__fff__grep" }),
  tool({ toolKind: "list", name: "list_files" }),
]);
assert.deepEqual(
  parts,
  [
    { kind: "shell", name: undefined, count: 2 },
    { kind: "read", name: undefined, count: 1 },
    { kind: "other", name: "mcp__fff__grep", count: 2 },
    { kind: "list", name: undefined, count: 1 },
  ],
  "parts count per kind, keep first-appearance order, and group unknown kinds by NAME",
);

console.log("check-tool-fold: fold levels, quiet classification, exclusions and summaries hold");
