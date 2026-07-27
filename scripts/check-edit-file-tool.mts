import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createEditFileTool, extractEditResult, type EditFileResult } from "../server/src/runtime/edit-file-tool.ts";
import { createPiWorkspaceAdapter } from "../server/src/runtime/pi-workspace-adapter.ts";
import type { Sandbox } from "../server/src/runtime/sandbox.ts";
import { reduceTimeline } from "../shared/src/timeline-reducer.ts";
import type { TimelineItem } from "../shared/src/protocol.ts";
import { buildShareSnapshot } from "../server/src/sharing/redact.ts";

type RawArgs = Record<string, unknown>;

function memoryTool(initial: string, onRead?: () => Promise<void>) {
  let content = initial;
  let writes = 0;
  let leased = false;
  const seenPaths: string[] = [];
  const sandbox = {
    async statFile(path: string) {
      assert.equal(leased, true, "stat must stay inside the workspace write lease");
      seenPaths.push(path);
      return path === "file.txt"
        ? { name: "file.txt", path, kind: "file" as const, size: content.length, modifiedAt: 1 }
        : null;
    },
    async readFile(path: string) {
      assert.equal(leased, true, "read must stay inside the workspace write lease");
      seenPaths.push(path);
      await onRead?.();
      return content;
    },
    async writeFile(path: string, next: string) {
      assert.equal(leased, true, "write must stay inside the workspace write lease");
      seenPaths.push(path);
      content = next;
      writes++;
    },
  } as unknown as Sandbox;
  const workspace = createPiWorkspaceAdapter(sandbox, async (operation, signal) => {
    if (signal?.aborted) throw new Error("Operation aborted");
    assert.equal(leased, false, "edit must acquire the lease once");
    leased = true;
    try {
      return await operation();
    } finally {
      leased = false;
    }
  });
  const tool = createEditFileTool(workspace);
  return {
    tool,
    workspace,
    content: () => content,
    writes: () => writes,
    seenPaths,
  };
}

async function execute(tool: AgentTool<any, EditFileResult>, args: RawArgs, signal?: AbortSignal) {
  const prepared = tool.prepareArguments?.(args) ?? args;
  return tool.execute("edit-check", prepared, signal);
}

{
  const state = memoryTool("alpha\nbeta\ngamma\n");
  const result = await execute(state.tool, {
    path: "file.txt",
    edits: [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "gamma", newText: "GAMMA" },
    ],
  });
  assert.equal(state.content(), "ALPHA\nbeta\nGAMMA\n");
  assert.equal(state.writes(), 1, "disjoint replacements commit in one write");
  assert.equal(result.details?.replacements, 2);
  assert.match(result.details?.patch ?? "", /^--- file\.txt/m, "result carries pi's unified patch");
  const persisted = extractEditResult(result);
  assert.equal(persisted?.replacements, 2);
  const timeline = reduceTimeline([{
    kind: "tool",
    id: "edit-check",
    seq: 1,
    name: "edit_file",
    toolKind: "edit",
    path: "file.txt",
    arguments: { path: "file.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
    status: "running",
    ts: 1,
  }], {
    t: "tool_end",
    id: "edit-check",
    status: "success",
    resultText: "edited",
    isError: false,
    edit: persisted,
  });
  assert.equal(timeline[0]?.kind === "tool" ? timeline[0].edit?.patch : undefined, persisted?.patch);

  const bounded = extractEditResult({ details: { patch: "x".repeat(130_000), replacements: 1 } });
  assert.equal(bounded?.truncated, true);
  assert.ok((bounded?.patch.length ?? Infinity) < 130_000, "persisted patch has a hard bound");

  const shared = buildShareSnapshot(timeline as TimelineItem[]);
  const sharedTool = shared.items[0];
  assert.equal(sharedTool?.kind, "tool");
  if (sharedTool?.kind === "tool") {
    assert.deepEqual(sharedTool.arguments, { path: "file.txt" }, "public share strips every edit payload shape");
  }
}

{
  const state = memoryTool("before\n");
  await state.workspace.writeFile("file.txt", "written\n");
  assert.equal(state.content(), "written\n", "write_file and edit_file share one workspace mutation capability");
  assert.equal(state.writes(), 1);
}

{
  const state = memoryTool("\uFEFFfirst\r\nsecond\r\n");
  await execute(state.tool, {
    path: "file.txt",
    edits: JSON.stringify([{ oldText: "first\nsecond", newText: "one\ntwo" }]),
  });
  assert.equal(state.content(), "\uFEFFone\r\ntwo\r\n", "BOM and CRLF survive normalized matching");
}

{
  const state = memoryTool("const label = ‘safe’ ;  \n");
  await execute(state.tool, {
    path: "file.txt",
    old: "const label = 'safe' ;",
    new: "const label = 'safer';",
  });
  assert.equal(state.content(), "const label = 'safer';\n", "legacy args use pi's fuzzy Unicode/whitespace matching");
}

for (const [name, args] of [
  ["missing region", { path: "file.txt", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "absent", newText: "B" }] }],
  ["duplicate region", { path: "file.txt", edits: [{ oldText: "same", newText: "changed" }] }],
  ["overlap", { path: "file.txt", edits: [{ oldText: "same same", newText: "x" }, { oldText: "same", newText: "y" }] }],
  ["no-op", { path: "file.txt", edits: [{ oldText: "same same", newText: "same same" }] }],
] as const) {
  const state = memoryTool("same same\n");
  await assert.rejects(execute(state.tool, args), undefined, name);
  assert.equal(state.content(), "same same\n", `${name} must leave the file unchanged`);
  assert.equal(state.writes(), 0, `${name} must fail before write`);
}

{
  const controller = new AbortController();
  const state = memoryTool("before\n", async () => controller.abort());
  await assert.rejects(
    execute(state.tool, { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] }, controller.signal),
    /aborted/i,
  );
  assert.equal(state.content(), "before\n", "abort observed after read must prevent write");
  assert.equal(state.writes(), 0);
}

{
  let reads = 0;
  let releaseReads!: () => void;
  let bothStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReads = resolve; });
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  const onRead = async () => {
    reads++;
    if (reads === 2) bothStarted();
    await gate;
  };
  const first = memoryTool("one\n", onRead);
  const second = memoryTool("one\n", onRead);
  const args = { path: "file.txt", edits: [{ oldText: "one", newText: "two" }] };
  const pending = Promise.all([execute(first.tool, args), execute(second.tool, args)]);
  await Promise.race([
    started,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("separate Sandboxes were globally serialized")), 250)),
  ]);
  releaseReads();
  await pending;
  assert.equal(reads, 2, "the pi per-file queue is namespaced per Sandbox");
}

{
  const state = memoryTool("before\n");
  await assert.rejects(
    execute(state.tool, { path: "../file.txt", edits: [{ oldText: "before", newText: "after" }] }),
    /inside the workspace/i,
  );
  assert.deepEqual(state.seenPaths, [], "an escaping path must not reach the Sandbox adapter");
}

console.log("edit_file: pi matching + patch semantics preserved behind Sandbox and workspace lease");
