import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-audit-check-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_AUDIT_STDOUT = "1";
process.env.AGENT_WEB_AUDIT_DB = "1";
process.env.AGENT_WEB_AUDIT_MAX_ROWS = "3";
process.env.AGENT_WEB_AUDIT_PRUNE_EVERY = "1";

const lines: string[] = [];
const originalInfo = console.info;
let closeDb: (() => void) | null = null;
console.info = (value?: unknown) => {
  lines.push(String(value ?? ""));
};

try {
  const { auditPrune, logAudit } = await import("../server/src/observability/audit-log.ts");
  const { auditEventDao, db } = await import("../server/src/persistence/index.ts");
  closeDb = () => db.close();

  logAudit("Bad Event Name", {
    userId: "u_test",
    sessionId: "s_test",
    data: {
      email: "person@example.com",
      token: ["sk", "1234567890abcdef"].join("-"),
      text: "non-ascii: \u6d4b\u8bd5",
      large: "x".repeat(5000),
    },
  });
  for (let i = 0; i < 5; i++) {
    logAudit("row_keep", { data: { i } });
  }

  let threw = false;
  try {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", { enumerable: true, get() { throw new Error("nope"); } });
    logAudit("hostile_data", { data: hostile });
  } catch {
    threw = true;
  }
  assert.ok(!threw, "logAudit must not throw on hostile data (fail-open)");
  assert.ok(lines.some((l) => l.includes('"buildError":true')), "hostile data should degrade to a buildError marker");

  logAudit("token_redaction", {
    data: {
      reason:
        "failed with pair_ABCDEFGHIJ1234567890 and conn_11111111-2222-3333.deadbeefcafe1234 and eyJhbGc.eyJzdWI.sig1234",
    },
  });
  const tokenLine = lines.find((l) => l.includes("token_redaction"));
  assert.ok(tokenLine, "expected the token_redaction stdout line");
  assert.ok(!tokenLine!.includes("pair_ABCDEFGHIJ"), "pairing code should be redacted from free text");
  assert.ok(!tokenLine!.includes("conn_11111111"), "connector token should be redacted from free text");
  assert.ok(!tokenLine!.includes("eyJhbGc.eyJzdWI"), "JWT should be redacted from free text");

  logAudit("bool_roundtrip", { data: { yes: true, no: false } });
  const boolLine = lines.find((l) => l.includes("bool_roundtrip"));
  assert.ok(boolLine, "expected the bool_roundtrip stdout line");
  assert.ok(boolLine!.includes('"yes":true'), "true must round-trip as true (not null)");
  assert.ok(boolLine!.includes('"no":false'), "false must round-trip as false (not null)");

  auditPrune(true);

  const recent = auditEventDao.recent(10);
  assert.ok(recent.length <= 3, "audit_events should stay under AGENT_WEB_AUDIT_MAX_ROWS");
  assert.ok(recent.length > 0, "expected persisted audit events");
  for (const row of recent) {
    assert.match(row.event, /^[a-z0-9_.:-]+$/);
    assert.ok(!row.data_json.includes("person@example.com"), "email should be redacted");
    assert.ok(!row.data_json.includes("sk-1234567890abcdef"), "secret-like values should be redacted");
    for (let i = 0; i < row.data_json.length; i++) {
      assert.ok(row.data_json.charCodeAt(i) <= 0x7f, `data_json has non-ascii at offset ${i}`);
    }
  }
  assert.ok(lines.length > 0, "expected stdout JSONL audit logs");
  for (const line of lines) {
    JSON.parse(line);
    for (let i = 0; i < line.length; i++) {
      assert.ok(line.charCodeAt(i) <= 0x7f, `stdout log has non-ascii at offset ${i}`);
    }
  }
  console.info = originalInfo;
  closeDb();
  closeDb = null;
  console.log("all audit-log checks passed");
} finally {
  console.info = originalInfo;
  closeDb?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
