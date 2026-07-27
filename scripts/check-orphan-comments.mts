import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const EXEMPT = new Map<string, string>();

type Block = { start: number; end: number; doc: boolean };
type Token = Block | { code: number };

function tokenize(lines: string[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (t.startsWith("/*")) {
      const start = i;
      while (i < lines.length && !lines[i]!.trim().endsWith("*/")) i++;
      out.push({ start, end: i, doc: true });
      i++;
    } else if (t.startsWith("//")) {
      const start = i;
      while (i < lines.length && lines[i]!.trim().startsWith("//")) i++;
      out.push({ start, end: i - 1, doc: false });
    } else {
      out.push({ code: i });
      i++;
    }
  }
  return out;
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const findings: string[] = [];

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const tokens = tokenize(lines);

  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if ("code" in a || !a.doc) continue;
    if (!/^\s/.test(lines[a.start] ?? "")) continue;

    if (!("code" in b) && b.doc) {
      findings.push(`${file}:${a.start + 1}: doc comment is followed by another doc comment — its declaration is gone`);
      continue;
    }
    if ("code" in b && b.code > a.end + 1) {
      findings.push(`${file}:${a.start + 1}: member doc comment is separated from the next declaration by a blank line`);
    }
  }
}

if (findings.length) {
  for (const f of findings) console.error(f);
  console.error(`\n${findings.length} orphaned doc comment(s).`);
  console.error("Move the explanation to whichever module now owns the declaration, or delete it if that module already says the same thing.");
  process.exit(1);
}

console.log(`OK orphan-comments: no doc comment is stranded (${files.length} files)`);
