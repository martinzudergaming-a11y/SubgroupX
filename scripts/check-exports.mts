import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

const ALLOWED: Record<string, string> = {
  "server/src/persistence/index.ts":
    "package barrel over modules that each already curate their own surface; predates this rule "
    + "and re-exports only sibling DAO modules, not an internals module",
};

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.length > 0);

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of tracked) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute)) continue;
  const lines = fs.readFileSync(absolute, "utf8").split("\n");
  lines.forEach((text, index) => {
    if (!/^\s*export\s+\*\s/.test(text)) return;
    if (ALLOWED[file]) return;
    offenders.push({ file, line: index + 1, text: text.trim() });
  });
}

if (offenders.length > 0) {
  console.error(`check-exports: ${offenders.length} wildcard re-export(s)\n`);
  for (const { file, line, text } of offenders) console.error(`  ${file}:${line}  ${text}`);
  console.error(
    "\nRe-export by name instead, so the public surface is authored rather than inherited."
    + `\nIf a wildcard is genuinely right, add an argued entry to ALLOWED in ${path.relative(ROOT, import.meta.filename)}.`,
  );
  process.exit(1);
}

console.log(`check-exports: no unargued wildcard re-exports (${Object.keys(ALLOWED).length} allowed).`);
