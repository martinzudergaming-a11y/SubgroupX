import assert from "node:assert/strict";
import {
  FileContentCache,
  FILE_CONTENT_CACHE_MAX_CHARS,
  FILE_CONTENT_CACHE_MAX_ENTRIES,
} from "../web/src/files/file-content-cache.ts";

const cache = new FileContentCache();
for (let index = 0; index < FILE_CONTENT_CACHE_MAX_ENTRIES; index++) cache.write(`file-${index}`, `content-${index}`);
assert.equal(cache.stats().entries, FILE_CONTENT_CACHE_MAX_ENTRIES);

assert.equal(cache.read("file-0"), "content-0");
cache.write("file-new", "new");
assert.equal(cache.read("file-1"), null);
assert.equal(cache.read("file-0"), "content-0");
assert.equal(cache.stats().entries, FILE_CONTENT_CACHE_MAX_ENTRIES);

cache.clear();
const half = "x".repeat(Math.floor(FILE_CONTENT_CACHE_MAX_CHARS / 2));
cache.write("a", half);
cache.write("b", half);
cache.write("c", "tail");
assert.equal(cache.read("a"), null, "character budget evicts the oldest large preview");
assert.equal(cache.stats().chars, half.length + 4);

cache.write("b", "short");
assert.deepEqual(cache.stats(), { entries: 2, chars: 9, paths: ["c", "b"] });

cache.delete("c");
assert.deepEqual(cache.snapshot(), new Map([["b", "short"]]));

cache.write("oversized", "z".repeat(FILE_CONTENT_CACHE_MAX_CHARS + 1));
assert.equal(cache.stats().entries, 1);
assert.equal(cache.read("oversized")?.length, FILE_CONTENT_CACHE_MAX_CHARS + 1);
cache.write("next", "ok");
assert.deepEqual(cache.stats(), { entries: 1, chars: 2, paths: ["next"] });

console.log("file content cache checks passed");
