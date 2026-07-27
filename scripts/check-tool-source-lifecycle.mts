import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpToolSource } from "../server/src/runtime/tool-sources.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-mcp-lifecycle-"));
const pidFile = path.join(tmp, "pid");
const wrapper = path.join(tmp, "delayed-mcp.mjs");
fs.writeFileSync(
  wrapper,
  `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await new Promise((resolve) => setTimeout(resolve, 250));
await import(${JSON.stringify(new URL("../examples/mcp-demo-server.mjs", import.meta.url).href)});
`,
);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const source = mcpToolSource({ id: "lifecycle", command: process.execPath, args: [wrapper] });
let pid = 0;
try {
  const listing = source.listTools();
  const concurrentListing = source.listTools();
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(pidFile), "delayed MCP child did not start");
  pid = Number(fs.readFileSync(pidFile, "utf8"));

  await source.close?.();
  await assert.rejects(listing, /closed while connecting|is closed/);
  await assert.rejects(concurrentListing, /closed while connecting|is closed/);

  const exitDeadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(alive(pid), false, "close-during-connect resurrected an orphan MCP child");
  await assert.rejects(source.listTools(), /is closed/, "a tombstoned source must never spawn again");
  assert.equal(alive(pid), false, "listTools after close resurrected the MCP child");
} finally {
  await source.close?.();
  if (pid && alive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {  }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("OK tool-source-lifecycle: close-during-connect rejects stale publication and reaps MCP child");
