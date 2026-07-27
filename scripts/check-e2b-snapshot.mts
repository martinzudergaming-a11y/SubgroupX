import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-e2b-snapshot-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const { db, sessionDao, userDao } = await import("../server/src/persistence/index.ts");
const { E2BSandbox } = await import("../server/src/runtime/e2b-sandbox.ts");
import type { SessionRow } from "../server/src/persistence/index.ts";

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

type TableInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

const now = Date.now();
userDao.create({ id: "u_snapshot", email: "snapshot@test", password_hash: "x", created_at: now });

const baseSession: SessionRow = {
  id: "s_snapshot",
  user_id: "u_snapshot",
  title: "snapshot test",
  provider: "mock",
  model: "mock",
  sandbox_mode: "workspace-write",
  sandbox_kind: "e2b",
  sandbox_id: null,
  sandbox_target_id: null,
  e2b_snapshot_id: null,
  mode: "coding",
  approval_policy: "never",
  status: "idle",
  thinking_level: "medium",
  cwd: "/tmp",
  created_at: now,
  updated_at: now,
};

sessionDao.create(baseSession);

await check("sessions table has nullable e2b_snapshot_id column", () => {
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as unknown as TableInfo[];
  const col = cols.find((c) => c.name === "e2b_snapshot_id");
  assert.ok(col, "missing e2b_snapshot_id");
  assert.equal(col.type.toUpperCase(), "TEXT");
  assert.equal(col.notnull, 0);
  assert.equal(col.dflt_value, null);
});

await check("newly-created session defaults e2b_snapshot_id to null", () => {
  const row = sessionDao.byId("s_snapshot");
  assert.ok(row);
  for (const [key, value] of Object.entries(baseSession)) {
    assert.deepEqual(row[key as keyof SessionRow], value, key);
  }
  assert.equal(row.e2b_snapshot_id, null);
});

await check("sessionDao.setSnapshotId round-trips through byId()", () => {
  sessionDao.setSnapshotId("s_snapshot", "snap_123");
  const row = sessionDao.byId("s_snapshot");
  assert.ok(row);
  assert.equal(row.e2b_snapshot_id, "snap_123");
});

await check("markDirty dirties writable E2B sandboxes", () => {
  const sandbox = new E2BSandbox({
    userId: "u_snapshot",
    mode: "workspace-write",
  }) as unknown as { canWrite(): boolean; markDirty(): void; dirty: boolean };

  assert.equal(sandbox.canWrite(), true);
  assert.equal(sandbox.dirty, false);
  sandbox.markDirty();
  assert.equal(sandbox.dirty, true);
});

await check("markDirty does not dirty read-only E2B sandboxes for read-like operations", () => {
  const sandbox = new E2BSandbox({
    userId: "u_snapshot",
    mode: "read-only",
  }) as unknown as { canWrite(): boolean; markDirty(): void; dirty: boolean };

  assert.equal(sandbox.canWrite(), false);
  sandbox.markDirty();
  assert.equal(sandbox.dirty, false);
});

await check("allowReadOnly byte writes dirty the sandbox without an E2B key or network", async () => {
  const writes: { abs: string; data: ArrayBuffer }[] = [];
  const sandbox = new E2BSandbox({
    userId: "u_snapshot",
    mode: "read-only",
  }) as unknown as {
    dirty: boolean;
    withSandbox(fn: (sbx: { files: { write(abs: string, data: ArrayBuffer): Promise<void> } }) => Promise<void>): Promise<void>;
    writeFileBytes(relPath: string, data: Uint8Array, opts?: { allowReadOnly?: boolean }): Promise<void>;
  };

  sandbox.withSandbox = async (fn) =>
    await fn({
      files: {
        write: async (abs, data) => {
          writes.push({ abs, data });
        },
      },
    });

  await sandbox.writeFileBytes("uploads/read-only.bin", new Uint8Array([1, 2, 3]), { allowReadOnly: true });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].abs, "/home/user/uploads/read-only.bin");
  assert.equal(sandbox.dirty, true);
});

await check("non-zero E2B ranges stay O(requested bytes) and split at 4 MiB", async () => {
  const commands: string[] = [];
  const sandbox = new E2BSandbox({
    userId: "u_snapshot",
    mode: "read-only",
  }) as unknown as {
    withSandbox(fn: (sbx: { commands: { run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> } }) => Promise<string>): Promise<string>;
    beginOperation(): void;
    endOperation(): void;
    readFileChunks(path: string, opts: { start: number; endExclusive: number }): AsyncGenerator<Uint8Array>;
  };
  sandbox.beginOperation = () => {};
  sandbox.endOperation = () => {};
  sandbox.withSandbox = async (fn) => await fn({
    commands: {
      run: async (command) => {
        commands.push(command);
        const count = Number(/ count=(\d+)/.exec(command)?.[1]);
        return { exitCode: 0, stdout: Buffer.alloc(count, 0x61).toString("base64"), stderr: "" };
      },
    },
  });
  let bytes = 0;
  for await (const chunk of sandbox.readFileChunks("tail.pdf", {
    start: 10 * 1024 * 1024,
    endExclusive: 15 * 1024 * 1024,
  })) bytes += chunk.byteLength;
  assert.equal(bytes, 5 * 1024 * 1024);
  assert.equal(commands.length, 2);
  assert.match(commands[0], /skip=10485760 count=4194304/);
  assert.match(commands[1], /skip=14680064 count=1048576/);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} e2b snapshot checks FAILED`);
  process.exit(1);
}
console.log(`\nall e2b snapshot checks passed`);
