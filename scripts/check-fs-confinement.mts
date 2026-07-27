import assert from "node:assert";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "fsconf-data-"));
const { LocalSandbox } = await import("../server/src/runtime/sandbox.ts");

const root = mkdtempSync(join(tmpdir(), "fsconf-ws-"));
const outside = mkdtempSync(join(tmpdir(), "fsconf-secret-"));
fs.writeFileSync(join(outside, "secret.txt"), "TOPSECRET");

const sb = new LocalSandbox(root, "workspace-write");

await sb.writeFile("hello.txt", "hi there");
assert.equal(await sb.readFile("hello.txt"), "hi there", "normal read/write round-trips");
await sb.writeFile("sub/nested.txt", "deep");
assert.equal(await sb.readFile("sub/nested.txt"), "deep", "nested write+read works");
const list = await sb.listDir(".");
assert.ok(list.some((e) => e.name === "hello.txt"), "listDir shows written file");
assert.ok(list.some((e) => e.name === "sub" && e.kind === "directory"), "listDir shows subdir");
assert.equal((await sb.statFile("hello.txt"))?.size, 8, "direct stat stays inside the workspace");
const bounded: Uint8Array[] = [];
for await (const chunk of sb.readFileChunks("hello.txt", { start: 3, endExclusive: 8 })) bounded.push(chunk);
assert.equal(Buffer.concat(bounded.map((chunk) => Buffer.from(chunk))).toString("utf8"), "there");
console.log("  OK normal read/write/list");

fs.symlinkSync(join(outside, "secret.txt"), join(root, "leak"));
await assert.rejects(sb.readFile("leak"), /symlink|escape/i, "reading a symlink to outside is refused");
await assert.rejects(sb.statFile("leak"), /symlink|escape/i, "statting a symlink to outside is refused");
await assert.rejects(async () => {
  for await (const _chunk of sb.readFileChunks("leak")) {  }
}, /symlink|escape/i, "range-reading a symlink to outside is refused");
console.log("  OK pre-existing symlink read refused");

fs.symlinkSync(outside, join(root, "evildir"));
await assert.rejects(sb.readFile("evildir/secret.txt"), /symlink|escape/i, "read via an intermediate symlink dir refused");
console.log("  OK intermediate symlink-dir read refused");

const victim = join(outside, "victim-created.txt");
fs.symlinkSync(victim, join(root, "dangling"));
await assert.rejects(sb.readFile("dangling"), /symlink|escape/i, "dangling final symlink read refused (openInsideRoot)");
await assert.rejects(sb.writeFile("dangling", "x"), /symlink|escape/i, "dangling final symlink write refused");
assert.ok(!fs.existsSync(victim), "write did NOT create a file at the symlink target outside the root");
console.log("  OK dangling final-symlink refused at open (the TOCTOU-race layer)");

fs.writeFileSync(join(outside, "target.txt"), "ORIGINAL");
fs.symlinkSync(join(outside, "target.txt"), join(root, "wlink"));
await assert.rejects(sb.writeFile("wlink", "HACKED"), /symlink|escape/i, "write through symlink to outside refused");
assert.equal(fs.readFileSync(join(outside, "target.txt"), "utf8"), "ORIGINAL", "outside file NOT overwritten/truncated");
console.log("  OK write through symlink can't corrupt an outside file");

await assert.rejects(sb.readFile("../../etc/hostname"), /escape/i, "../ escape refused");
await assert.rejects(sb.readFile("/etc/hostname"), /escape|ENOENT|symlink/i, "absolute path treated relative to root");
console.log("  OK ../ and absolute escapes refused");

console.log("all fs-confinement checks passed");
