import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const assets = path.resolve(import.meta.dirname, "../web/dist/assets");
assert.ok(fs.existsSync(assets), "web/dist is missing. Build with AGENT_WEB_INTERNAL_BLOG=0 first.");
const javascript = fs.readdirSync(assets, { recursive: true })
  .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".js"))
  .map((entry) => fs.readFileSync(path.join(assets, entry), "utf8"))
  .join("\n");

for (const marker of [
  "semantic-completion-not-eof",
  "range-first-pdf-reader",
  "How we found and corrected product problems.",
  "我们如何发现并修正产品问题。",
]) {
  assert.ok(!javascript.includes(marker), `restricted bundle contains Blog marker: ${marker}`);
}

console.log("OK internal-blog-disabled-bundle: restricted assets do not contain article text");
