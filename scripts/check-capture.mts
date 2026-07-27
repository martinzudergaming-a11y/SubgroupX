import {
  allowlistResponseHeaders,
  boundForCapture,
  packCapture,
  unpackCapture,
  redactSecrets,
  CAPTURE_BUDGET_BYTES,
} from "../server/src/runtime/capture.ts";
import { OPERATOR_MODEL_PROVIDER } from "../shared/src/protocol.ts";

let failed = false;
function check(name: string, ok: boolean): void {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}

const filtered = allowlistResponseHeaders({
  authorization: "Bearer sk-secret",
  "set-cookie": "session=abc",
  cookie: "session=abc",
  "x-internal-token": "leak-me",
  "x-request-id": "req_123",
  "retry-after": "5",
  "x-ratelimit-remaining": "42",
  "ratelimit-reset": "100",
});
check("drops authorization", !("authorization" in filtered));
check("drops set-cookie", !("set-cookie" in filtered));
check("drops cookie", !("cookie" in filtered));
check("drops unknown x-internal-token", !("x-internal-token" in filtered));
check("keeps x-request-id", filtered["x-request-id"] === "req_123");
check("keeps retry-after", filtered["retry-after"] === "5");
check("keeps x-ratelimit-* (prefix)", filtered["x-ratelimit-remaining"] === "42");
check("keeps ratelimit-* (prefix)", filtered["ratelimit-reset"] === "100");

const small = boundForCapture({ hello: "world" });
check("small body passes through", small === JSON.stringify({ hello: "world" }));

const bigMsgs = { input: Array.from({ length: 400 }, (_, i) => ({ role: "user", content: `msg ${i} ` + "x".repeat(2000) })) };
const bounded = boundForCapture(bigMsgs);
const bp = JSON.parse(bounded) as { input?: unknown[] };
check("normal ~1MB body kept intact (no all-or-nothing marker)", Array.isArray(bp.input) && bp.input.length === 400);
check("intact body has no elision marker", !bounded.includes("__elided_items__") && !bounded.includes("chars elided"));

const huge = { keepKey: "shape", input: [{ role: "user", content: "y".repeat(CAPTURE_BUDGET_BYTES + 100000) }] };
const hb = boundForCapture(huge);
check("over-budget body stays under budget", Buffer.byteLength(hb, "utf8") <= CAPTURE_BUDGET_BYTES);
const hbp = JSON.parse(hb) as { keepKey?: string; input?: { content?: string }[] };
check("over-budget body keeps structure", hbp.keepKey === "shape" && Array.isArray(hbp.input));
check("over-budget body elides the giant leaf", String(hbp.input?.[0]?.content ?? "").includes("chars elided"));

const manyItems = { input: Array.from({ length: 5000 }, () => ({ content: "z".repeat(1000) })) };
const mi = boundForCapture(manyItems);
check("huge array is elided with a count marker", mi.includes("__elided_items__"));

const packedBig = packCapture(bigMsgs);
check("big body is gzip-packed (gz: sentinel)", packedBig.startsWith("gz:"));
check("big packed body is much smaller than raw", packedBig.length < bounded.length / 2);
const round = unpackCapture(packedBig) as { input?: unknown[] };
check("unpack round-trips the full body", Array.isArray(round.input) && round.input.length === 400);
const packedSmall = packCapture({ hello: "world" });
check("tiny body stays plain (no gz: sentinel)", !packedSmall.startsWith("gz:"));
check("unpack of plain row works", JSON.stringify(unpackCapture(packedSmall)) === JSON.stringify({ hello: "world" }));
check("unpack of NULL is null", unpackCapture(null) === null);
check("unpack of a legacy plain row works", JSON.stringify(unpackCapture('{"a":1}')) === JSON.stringify({ a: 1 }));

import zlib from "node:zlib";
let deep: unknown = "leaf";
for (let i = 0; i < 1000; i++) deep = [deep];
let deepOk = true;
let deepStr = "";
try {
  deepStr = boundForCapture({ pad: "x".repeat(CAPTURE_BUDGET_BYTES + 10), deep });
  JSON.parse(deepStr);
} catch {
  deepOk = false;
}
check("deeply-nested body bounds via depth guard without throwing", deepOk && deepStr.includes("__elided_depth__"));
const manyKeys: Record<string, number> = {};
for (let i = 0; i < 200000; i++) manyKeys["k" + i] = i;
const mk = boundForCapture(manyKeys);
check("huge object is key-capped + stays under budget", mk.includes("__elided_keys__") && Buffer.byteLength(mk, "utf8") <= CAPTURE_BUDGET_BYTES);
const bigKeys: Record<string, number> = {};
for (let i = 0; i < 30; i++) bigKeys["x".repeat(100000) + i] = i;
const bk = boundForCapture(bigKeys);
const bkParsed = JSON.parse(bk) as { __oversized__?: boolean; preview?: string };
check("pathological body falls back to a bounded preview (not whole body)", bkParsed.__oversized__ === true && typeof bkParsed.preview === "string");
check("oversized fallback stays bounded", Buffer.byteLength(bk, "utf8") <= CAPTURE_BUDGET_BYTES + 4096);
const bomb = "gz:" + zlib.gzipSync(Buffer.alloc(9 * 1024 * 1024, 122)).toString("base64");
const bombOut = unpackCapture(bomb) as { __capture_error__?: string };
check("oversized gzip row is rejected (no unbounded inflate)", typeof bombOut.__capture_error__ === "string");

const secrets: Record<string, string> = {
  openai: ["sk", "proj", ["abcdEFGH1234567890", "abcdEFGH1234567890"].join("")].join("-"),
  anthropic: ["sk", "ant", "api03", ["abcdEFGH1234567890", "abcdEFGH12"].join("")].join("-"),
  groq: ["gsk", ["abcdEFGH1234567890", "abcdEFGH12345"].join("")].join("_"),
  google: ["AIza", "SyA1234567890", "abcdEFGH1234567890", "abcdEFG"].join(""),
  aws: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  github: ["ghp", ["abcdEFGH1234567890", "abcdEFGH1234567890"].join("")].join("_"),
  slack: ["xoxb", "12345678901", "abcdEFGH1234"].join("-"),
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join("."),
  bearer: "Authorization: Bearer " + ["sk", "livesecrettoken1234567890abcd"].join("-"),
};
for (const [name, val] of Object.entries(secrets)) {
  const out = boundForCapture({ messages: [{ role: "user", content: `here is my key ${val} ok` }] });
  check(`scrubs ${name} from request body`, !out.includes(val) && out.includes("«redacted:"));
}
const benign = `the user said hello and ran "git status" in /tmp/project-abc`;
check("leaves ordinary text intact", redactSecrets(JSON.stringify(benign)) === JSON.stringify(benign));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.AGENT_WEB_DATA_DIR = mkdtempSync(path.join(tmpdir(), "oiia-capture-test-"));

const { db, sessionDao, userDao, requestCaptureDao, CAPTURE_RING_MAX_FOR_TEST } = await import("../server/src/persistence/index.ts");

const now = Date.now();
userDao.create({ id: "u_test", email: "t@example.com", password_hash: "x", created_at: now });
sessionDao.create({
  id: "s_test",
  user_id: "u_test",
  title: "t",
  provider: OPERATOR_MODEL_PROVIDER,
  model: "operator-model",
  sandbox_mode: "workspace-write",
  sandbox_kind: "local",
  sandbox_id: null,
  sandbox_target_id: null,
  e2b_snapshot_id: null,
  mode: "coding",
  approval_policy: "on-request",
  status: "idle",
  thinking_level: "medium",
  cwd: "/tmp",
  created_at: now,
  updated_at: now,
});

const TOTAL = CAPTURE_RING_MAX_FOR_TEST + 17;
for (let i = 0; i < TOTAL; i++) {
  requestCaptureDao.append({
    session_id: "s_test",
    message_id: `a_${i}`,
    seq: i + 1,
    provider: OPERATOR_MODEL_PROVIDER,
    model: "operator-model",
    request_json: packCapture({ i }),
    response_meta_json: JSON.stringify({ status: 200, headers: {} }),
    response_msg_json: packCapture({ ok: true }),
    created_at: now + i,
  });
}

const count = (db.prepare("SELECT COUNT(*) AS c FROM request_captures WHERE session_id = ?").get("s_test") as { c: number }).c;
check(`ring holds exactly ${CAPTURE_RING_MAX_FOR_TEST}`, count === CAPTURE_RING_MAX_FOR_TEST);

const oldestGone = requestCaptureDao.get("s_test", "a_0") === undefined;
const newestKept = requestCaptureDao.get("s_test", `a_${TOTAL - 1}`) !== undefined;
check("oldest capture pruned", oldestGone);
check("newest capture kept", newestKept);

const meta = requestCaptureDao.listMeta("s_test");
check("listMeta newest-first", meta[0]?.messageId === `a_${TOTAL - 1}`);
check("listMeta surfaces status", meta[0]?.status === 200);
check("listMeta carries no body fields", !("request_json" in (meta[0] as object)));

if (failed) {
  console.error("\nFAIL: a capture invariant regressed.");
  process.exit(1);
}
console.log("\nOK: header allowlist, truncation, and the 50-capture ring all hold.");
