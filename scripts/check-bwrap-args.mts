import assert from "node:assert/strict";
import { buildBwrapArgs } from "../server/src/runtime/sandbox.ts";

const ROOT = "/data/workspaces/u_alice/s_123";

function bindFlagFor(args: string[], target: string): string | null {
  for (let i = 0; i < args.length - 2; i++) {
    if ((args[i] === "--bind" || args[i] === "--ro-bind" || args[i] === "--ro-bind-try") && args[i + 1] === target) {
      return args[i];
    }
  }
  return null;
}

const tests: { name: string; run: () => void }[] = [
  {
    name: "always unshares user/pid/ipc/uts/cgroup + die-with-parent",
    run: () => {
      const a = buildBwrapArgs({ root: ROOT, mode: "workspace-write", networkAccess: false, tty: false });
      for (const flag of ["--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup", "--die-with-parent"]) {
        assert.ok(a.includes(flag), `missing ${flag}`);
      }
    },
  },
  {
    name: "binds the workspace read-WRITE at the same path in workspace-write mode",
    run: () => {
      const a = buildBwrapArgs({ root: ROOT, mode: "workspace-write", networkAccess: false, tty: false });
      assert.equal(bindFlagFor(a, ROOT), "--bind");
      const i = a.indexOf("--bind");
      assert.equal(a[i + 1], ROOT);
      assert.equal(a[i + 2], ROOT, "workspace must be bound at the same absolute path");
      assert.ok(a.includes("--chdir") && a[a.indexOf("--chdir") + 1] === ROOT);
    },
  },
  {
    name: "binds the workspace READ-ONLY in read-only mode",
    run: () => {
      const a = buildBwrapArgs({ root: ROOT, mode: "read-only", networkAccess: false, tty: false });
      assert.equal(bindFlagFor(a, ROOT), "--ro-bind");
      const i = a.indexOf("--bind");
      assert.ok(i === -1 || a[i + 1] !== ROOT);
    },
  },
  {
    name: "NEVER binds /data, the workspaces parent, or / (no secrets / sibling exposure)",
    run: () => {
      for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
        const a = buildBwrapArgs({ root: ROOT, mode, networkAccess: mode === "danger-full-access", tty: false });
        for (const forbidden of ["/", "/data", "/data/workspaces", "/data/workspaces/u_alice"]) {
          assert.equal(bindFlagFor(a, forbidden), null, `must not bind ${forbidden} (mode=${mode})`);
        }
        assert.equal(bindFlagFor(a, "/usr"), "--ro-bind-try");
        assert.ok(!a.includes("--bind") || a[a.indexOf("--bind") + 1] === ROOT, "the only --bind is the workspace");
      }
    },
  },
  {
    name: "unshares the network unless full access; shares it for danger-full-access",
    run: () => {
      assert.ok(buildBwrapArgs({ root: ROOT, mode: "workspace-write", networkAccess: false, tty: false }).includes("--unshare-net"));
      assert.ok(buildBwrapArgs({ root: ROOT, mode: "read-only", networkAccess: false, tty: false }).includes("--unshare-net"));
      assert.ok(!buildBwrapArgs({ root: ROOT, mode: "danger-full-access", networkAccess: true, tty: false }).includes("--unshare-net"));
    },
  },
  {
    name: "new-session for non-tty exec (anti tty-injection); none for an interactive PTY",
    run: () => {
      assert.ok(buildBwrapArgs({ root: ROOT, mode: "workspace-write", networkAccess: false, tty: false }).includes("--new-session"));
      assert.ok(!buildBwrapArgs({ root: ROOT, mode: "workspace-write", networkAccess: false, tty: true }).includes("--new-session"));
    },
  },
];

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (failed) {
  console.error(`\n${failed}/${tests.length} bwrap-args checks FAILED`);
  process.exit(1);
}
console.log(`\nall ${tests.length} bwrap-args checks passed`);
