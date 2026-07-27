import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "../web/dist");
const assets = path.join(dist, "assets");
assert.ok(fs.existsSync(assets), "web/dist is missing. Build the default bundle first.");

const files = fs.readdirSync(assets, { recursive: true })
  .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".js"));
const source = new Map(files.map((entry) => [entry, fs.readFileSync(path.join(assets, entry), "utf8")]));
const markers = [
  "semantic-completion-not-eof",
  "range-first-pdf-reader",
  "How we found and corrected product problems.",
  "我们如何发现并修正产品问题。",
];

const articleAssets = files.filter((entry) => source.get(entry)?.includes(markers[0]));
assert.equal(articleAssets.length, 1, `expected one lazy Blog asset, found: ${articleAssets.join(", ")}`);
const articleAsset = articleAssets[0];
const articleSource = source.get(articleAsset) ?? "";
for (const marker of markers) {
  assert.ok(articleSource.includes(marker), `lazy Blog asset is missing marker: ${marker}`);
}

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"?]+\.js)"[^>]*><\/script>/);
assert.ok(entryMatch, "cannot find the browser entry asset in web/dist/index.html");
assert.notEqual(articleAsset, entryMatch[1], "Blog content entered the main browser asset");
for (const marker of markers) {
  assert.ok(!(source.get(entryMatch[1]) ?? "").includes(marker), `main browser asset contains Blog marker: ${marker}`);
}

const rawBytes = fs.statSync(path.join(assets, articleAsset)).size;
assert.ok(rawBytes <= 64 * 1024, `lazy Blog asset is too large: ${rawBytes} bytes`);
console.log(`OK internal-blog-bundle: ${articleAsset} is lazy and bounded (${rawBytes} bytes)`);
