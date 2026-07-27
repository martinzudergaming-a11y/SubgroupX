import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { lintDiagram, type DiagramLanguage } from "../server/src/runtime/diagram-lint.ts";

const cases: Array<{ name: string; language: DiagramLanguage; source: string; valid: boolean }> = [
  { name: "mermaid-valid", language: "mermaid", source: "flowchart LR\n A[Input] --> B[Output]", valid: true },
  { name: "mermaid-invalid", language: "mermaid", source: "flowchart LR\n A -->", valid: false },
  { name: "d2-valid", language: "d2", source: "direction: right\ninput -> compiler -> output", valid: true },
  { name: "d2-invalid", language: "d2", source: "a ->", valid: false },
];
const samples = Math.max(1, Number.parseInt(process.env.SAMPLES ?? "5", 10));
const measurements: Record<string, { samplesMs: number[]; medianMs: number; p95Ms: number }> = {};

for (const item of cases) {
  const values: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    const result = await lintDiagram(item.language, item.source);
    values.push(Math.round((performance.now() - start) * 10) / 10);
    if (result.valid !== item.valid) throw new Error(`${item.name}: unexpected compiler result`);
  }
  const sorted = values.toSorted((a, b) => a - b);
  measurements[item.name] = {
    samplesMs: values,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

const result = { node: process.version, platform: `${process.platform}-${process.arch}`, samples, measurements };
const output = process.env.OUT;
if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
