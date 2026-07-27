import assert from "node:assert";
import { SSHSandbox } from "../server/src/runtime/ssh-sandbox.ts";

const ROOT = "/home/u/.agent-web/sessions/s1";
const target = { host: "example.com", port: 22, username: "u", privateKey: "" } as any;
let passed = 0;
const ok = (label: string, fn: () => void) => { fn(); console.log("  OK " + label); passed++; };

const confined = new SSHSandbox({ root: ROOT, mode: "danger-full-access", target, unconfined: false });
ok("confined resolves a relative path under the session root", () => {
  assert.equal(confined.resolve("foo/bar.txt"), `${ROOT}/foo/bar.txt`);
});
ok("confined rejects a `..` escape", () => {
  assert.throws(() => confined.resolve("../../etc/shadow"), /escapes workspace/);
});
ok("confined treats a leading-slash path as workspace-relative (not absolute)", () => {
  assert.equal(confined.resolve("/etc/passwd"), `${ROOT}/etc/passwd`);
});
ok("confined toRel is workspace-relative", () => {
  assert.equal(confined.toRel(`${ROOT}/a/b`), "a/b");
});

const free = new SSHSandbox({ root: ROOT, mode: "danger-full-access", target, unconfined: true });
ok("unconfined passes an absolute path through untouched", () => {
  assert.equal(free.resolve("/etc/passwd"), "/etc/passwd");
});
ok("unconfined normalizes an absolute path (no escape rejection)", () => {
  assert.equal(free.resolve("/var/log/../lib/x"), "/var/lib/x");
});
ok("unconfined keeps a relative path relative (SFTP resolves it against $HOME)", () => {
  assert.equal(free.resolve("notes/todo.md"), "notes/todo.md");
});
ok("unconfined toRel returns the real absolute path (no workspace to be relative to)", () => {
  assert.equal(free.toRel("/etc/hosts"), "/etc/hosts");
});

console.log(`\nall ssh-unconfined checks passed (${passed})`);
