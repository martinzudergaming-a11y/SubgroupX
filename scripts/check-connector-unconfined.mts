import assert from "node:assert";
import { ConnectorSandbox } from "../server/src/runtime/connector-sandbox.ts";

const WS = "/home/u/.agent-web/workspaces";
let passed = 0;
const ok = (label: string, fn: () => void) => { fn(); console.log("  OK " + label); passed++; };

const confined = new ConnectorSandbox({ connectorId: "c1", sessionId: "s1", mode: "danger-full-access", workspaceRoot: WS, unconfined: false });
ok("confined root is the per-session subdir", () => {
  assert.equal(confined.root, `${WS}/s1`);
});
ok("confined resolves a relative path under the session root", () => {
  assert.equal(confined.resolve("foo/bar.txt"), `${WS}/s1/foo/bar.txt`);
});
ok("confined rejects a `..` escape", () => {
  assert.throws(() => confined.resolve("../../etc/shadow"), /escapes workspace/);
});
ok("confined treats a leading-slash path as workspace-relative (not absolute)", () => {
  assert.equal(confined.resolve("/etc/passwd"), `${WS}/s1/etc/passwd`);
});

const free = new ConnectorSandbox({ connectorId: "c1", sessionId: "s1", mode: "danger-full-access", workspaceRoot: WS, unconfined: true });
ok("unconfined root is the workspace root as-is (no per-session subdir)", () => {
  assert.equal(free.root, WS);
});
ok("unconfined passes an absolute path through untouched", () => {
  assert.equal(free.resolve("/etc/hosts"), "/etc/hosts");
});
ok("unconfined does NOT throw on `..` (no confinement)", () => {
  assert.doesNotThrow(() => free.resolve("../sibling/file"));
});
ok("read-only mode still blocks writes regardless of unconfined", () => {
  const ro = new ConnectorSandbox({ connectorId: "c1", sessionId: "s1", mode: "read-only", workspaceRoot: WS, unconfined: true });
  assert.equal(ro.canWrite(), false);
});

console.log(`\nall connector-unconfined checks passed (${passed})`);
