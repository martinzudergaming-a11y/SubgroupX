import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_LINES = 1000;
const ROOT = path.resolve(import.meta.dirname, "..");

const EXEMPT: Record<string, string> = {};

const LEGACY_BASELINE: Record<string, number> = {
  "server/src/persistence/orchestration.ts": 9115,
  "server/src/runtime/agent-session.ts": 5574,
  "test/e2e/app.spec.ts": 5434,
  "server/src/persistence/workflow.ts": 3299,
  "server/src/persistence/core.ts": 2418,
  "scripts/check-workflow-engine.mts": 2280,
  "scripts/check-runtime-task-dispatcher.mts": 2192,
  "server/src/orchestration/agent-supervisor.ts": 2025,
  "scripts/check-agent-team.mts": 2008,
  "server/src/runtime/manager.ts": 1747,
  "web/src/dashboard/session/MainContent.tsx": 1733,
  "server/src/orchestration/pi-child-worker.ts": 1602,
  "scripts/check-pi-child-worker.mts": 1543,
  "scripts/check-agent-supervisor.mts": 1460,
  "scripts/check-agent-task-store.mts": 1441,
  "server/src/orchestration/read-model.ts": 1323,
  "scripts/check-orchestration-read-model.mts": 1252,
  "server/src/persistence/sessions.ts": 1234,
  "web/src/i18n/en.ts": 1205,
  "web/src/i18n/zh.ts": 1178,
  "web/src/files/PdfPreview.tsx": 1157,
  "scripts/check-tool-stream.mts": 1112,
  "scripts/check-compaction-audit.mts": 1109,
};

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.mjs"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((line) => line.length > 0);

const offenders: string[] = [];
const seen = new Set<string>();
for (const file of tracked) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute)) continue;
  seen.add(file);
  const lines = fs.readFileSync(absolute, "utf8").split("\n").length;
  const baseline = LEGACY_BASELINE[file];
  if (baseline !== undefined) {
    if (lines > baseline) {
      offenders.push(
        `  ${String(lines).padStart(6)}  ${file} — grew past its ${baseline}-line ratchet; shrink it back, or raise the baseline WITH an argument in the same PR`,
      );
    } else if (lines <= MAX_LINES) {
      offenders.push(
        `  ${String(lines).padStart(6)}  ${file} — now within ${MAX_LINES} lines; delete its LEGACY_BASELINE entry so the ceiling owns it from here on`,
      );
    }
    continue;
  }
  if (lines <= MAX_LINES) continue;
  if (EXEMPT[file]) {
    console.log(`  · ${file} (${lines}) — exempt: ${EXEMPT[file]}`);
    continue;
  }
  offenders.push(`  ${String(lines).padStart(6)}  ${file}`);
}

for (const file of Object.keys(LEGACY_BASELINE)) {
  if (!seen.has(file)) {
    offenders.push(`       -  ${file} — LEGACY_BASELINE entry for a file that no longer exists; delete the entry`);
  }
}

if (offenders.length > 0) {
  console.error(`check-file-size: ${offenders.length} file(s) violate the ${MAX_LINES}-line ceiling or its legacy ratchet\n`);
  for (const line of offenders) console.error(line);
  console.error(
    `\nSplit along a responsibility boundary, or add an argued entry to EXEMPT in ${path.relative(ROOT, import.meta.filename)}.`,
  );
  process.exit(1);
}

const legacyCount = Object.keys(LEGACY_BASELINE).length;
console.log(
  `check-file-size: every non-legacy source file is within ${MAX_LINES} lines; ${legacyCount} legacy file(s) held at or below their ratchet.`,
);
