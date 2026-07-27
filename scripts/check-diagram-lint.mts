import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { lintDiagram } from "../server/src/runtime/diagram-lint.ts";

const diagramPrompt = await readFile(
  new URL("../server/src/runtime/prompts/diagrams.md", import.meta.url),
  "utf8",
);
const promptLines = diagramPrompt.split("\n").filter((line) => line.trim());
assert.ok(promptLines.length > 0);
assert.ok(promptLines.every((line) => line.startsWith(">")), "diagram system guidance must stay quoted");
assert.match(diagramPrompt, /call `diagram_lint` with the exact final fence language and source/);
assert.match(diagramPrompt, /correct the source and lint it again/);
assert.match(diagramPrompt, /copy that exact source/);

const mermaidGood = await lintDiagram("mermaid", "flowchart LR\n  A[输入] --> B[输出]");
assert.equal(mermaidGood.valid, true);
if (mermaidGood.valid) assert.match(String(mermaidGood.details.diagramType), /flowchart/);

const mermaidBad = await lintDiagram("mermaid", "flowchart LR\n  A -->");
assert.equal(mermaidBad.valid, false);
if (!mermaidBad.valid) assert.match(mermaidBad.error, /Parse error|Expecting|EOF/i);

const d2Good = await lintDiagram("d2", "direction: right\n输入 -> 编译器: lint\n编译器 -> 输出: valid");
assert.equal(d2Good.valid, true);
if (d2Good.valid) {
  assert.equal(Number(d2Good.details.shapes), 3);
  assert.equal(Number(d2Good.details.connections), 2);
  assert.ok(Number(d2Good.details.svgBytes) > 1_000);
}

const d2Bad = await lintDiagram("d2", "a ->");
assert.equal(d2Bad.valid, false);
if (!d2Bad.valid) assert.match(d2Bad.error, /index:1:1.*missing destination/i);

const empty = await lintDiagram("d2", "  \n");
assert.deepEqual(empty, { valid: false, language: "d2", error: "diagram source is empty" });

const held = lintDiagram("d2", "held -> slot");
const controller = new AbortController();
const cancelled = lintDiagram("mermaid", "flowchart LR\n A --> B", controller.signal);
controller.abort(new Error("cancel queued lint"));
await assert.rejects(cancelled, /cancel queued lint/);
assert.equal((await held).valid, true);

const concurrent = await Promise.all([
  lintDiagram("d2", "a -> b"),
  lintDiagram("mermaid", "flowchart LR\n A --> B"),
  lintDiagram("d2", "c -> d"),
]);
assert.ok(concurrent.every((result) => result.valid), "the bounded compiler queue must drain every request");

console.log("diagram lint: Mermaid + D2 valid/invalid compiler paths passed");
