import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(path.join(tmpdir(), "oiia-selftraj-test-"));

const { db, sessionDao, timelineDao, userDao } = await import("../server/src/persistence/index.ts");
const { registerShareRoutes } = await import("../server/src/http/routes/share.ts");
const { buildShareSnapshot } = await import("../server/src/sharing/redact.ts");
const { SHARE_TOKEN_RE } = await import("../server/src/http/route-helpers.ts");
const express = (await import("express")).default;
import { OPERATOR_MODEL_PROVIDER, type TimelineItem } from "../shared/src/protocol.ts";

const now = Date.now();
userDao.create({ id: "u_test", email: "t@example.com", password_hash: "x", created_at: now });
for (const id of ["s_a", "s_b"]) {
  sessionDao.create({
    id,
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
}

const tokA = sessionDao.selfToken("s_a");
assert.ok(tokA, "token minted");
assert.equal(sessionDao.selfToken("s_a"), tokA, "stable across calls");
assert.match(tokA!, SHARE_TOKEN_RE, "token fits the shared capability alphabet");
const tokB = sessionDao.selfToken("s_b");
assert.notEqual(tokA, tokB, "unique per session");
assert.equal(sessionDao.selfToken("s_missing"), null, "unknown session mints nothing");
assert.equal(sessionDao.idBySelfToken(tokA!), "s_a", "token resolves to its session only");
assert.equal(sessionDao.idBySelfToken("A".repeat(24)), null, "unknown token resolves to nothing");

const item = (seq: number, text: string): TimelineItem =>
  ({ kind: "assistant", id: `a${seq}`, seq, blocks: [{ type: "text", text }], streaming: false }) as unknown as TimelineItem;
for (let s = 1; s <= 5; s++) timelineDao.append("s_a", item(s, `turn ${s}`));
timelineDao.append("s_a", item(6, "X".repeat(4000)));

let page = timelineDao.listPage("s_a", 0, 3, 1_500_000);
assert.equal(page.total, 6);
assert.deepEqual(page.items.map((i) => i.seq), [1, 2, 3], "limit respected in seq order");
assert.equal(page.hasMore, true);
page = timelineDao.listPage("s_a", 3, 500, 1_500_000);
assert.deepEqual(page.items.map((i) => i.seq), [4, 5, 6], "after-cursor pages forward");
assert.equal(page.hasMore, false, "end of timeline reported");
page = timelineDao.listPage("s_a", 0, 500, 100);
assert.equal(page.items.length, 1, "byte budget cuts after the first row");
assert.equal(page.hasMore, true);
page = timelineDao.listPage("s_a", 5, 500, 100);
assert.deepEqual(page.items.map((i) => i.seq), [6], "oversized single row still pages through");

const app = express();
const r = express.Router();
registerShareRoutes(r);
app.use("/api", r);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const get = async (p: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

assert.equal((await get("/self/short/trajectory")).status, 404, "malformed token: uniform 404");
assert.equal((await get(`/self/${"B".repeat(24)}/trajectory`)).status, 404, "unknown token: uniform 404");
const ok = await get(`/self/${tokA}/trajectory?limit=2`);
assert.equal(ok.status, 200);
assert.equal(ok.body.total, 6);
assert.deepEqual((ok.body.items as TimelineItem[]).map((i) => i.seq), [1, 2]);
assert.equal(ok.body.nextAfter, 2, "cursor for the next page");
const rest = await get(`/self/${tokA}/trajectory?after=2&limit=500`);
assert.deepEqual((rest.body.items as TimelineItem[]).map((i) => i.seq), [3, 4, 5, 6]);
assert.equal(rest.body.nextAfter, null, "exhausted timeline ends the cursor");
const other = await get(`/self/${tokB}/trajectory`);
assert.equal(other.body.total, 0, "a token never reads across sessions");

const echoed = item(9, `debug: fetched https://example.com/api/self/${tokA}/trajectory?after=2 ok`);
const snap = buildShareSnapshot([echoed]);
const text = JSON.stringify(snap);
assert.ok(!text.includes(tokA!), "capability token scrubbed from public shares");

server.close();
db.close();
console.log("check-self-trajectory: OK");
