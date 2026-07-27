import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_WEB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-sbid-"));
const { idEntryAction } = await import("../server/src/runtime/sandbox.ts");

let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const passwd = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n";

check("absent on empty file", () => assert.equal(idEntryAction("", "agentweb40004", 40004), "absent"));
check("absent for a fresh uid in a real passwd", () => assert.equal(idEntryAction(passwd, "agentweb40004", 40004), "absent"));
check("present when the exact name→uid record exists", () =>
  assert.equal(idEntryAction(passwd + "agentweb40004:x:40004:40004::/x:/bin/bash\n", "agentweb40004", 40004), "present"));
check("conflict when the name maps to a DIFFERENT uid", () =>
  assert.equal(idEntryAction(passwd + "agentweb40004:x:99999:99999::/x:/bin/bash\n", "agentweb40004", 40004), "conflict"));
check("absent when the uid exists only under a DIFFERENT name (still add our name)", () =>
  assert.equal(idEntryAction(passwd + "someother:x:40004:40004::/x:/bin/bash\n", "agentweb40004", 40004), "absent"));
check("absent ignores malformed/blank lines", () =>
  assert.equal(idEntryAction("\n# comment\nbad\n" + passwd, "agentweb40004", 40004), "absent"));
check("distinct uids don't collide", () => {
  const t = passwd + "agentweb40000:x:40000:40000::/x:/bin/bash\n";
  assert.equal(idEntryAction(t, "agentweb40001", 40001), "absent");
  assert.equal(idEntryAction(t, "agentweb40000", 40000), "present");
});

if (failed) {
  console.error(`\n${failed} sandbox-id checks FAILED`);
  process.exit(1);
}
console.log(`\nall sandbox-id checks passed`);
