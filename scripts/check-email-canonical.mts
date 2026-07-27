import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "emailcanon-"));

const R = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { signup, githubUpsert, canonicalizeEmailForUniqueness } = await import(R + "/server/src/identity/auth.ts");
const { userDao, db } = await import(R + "/server/src/persistence/index.ts");
const { runBackfill } = await import(R + "/scripts/backfill-canonical-email.mts");
const { DatabaseSync } = await import("node:sqlite");

assert.equal(canonicalizeEmailForUniqueness("user+tag@gmail.com"), "user@gmail.com", "+alias stripped");
assert.equal(canonicalizeEmailForUniqueness("u.s.er@gmail.com"), "user@gmail.com", "dots stripped");
assert.equal(canonicalizeEmailForUniqueness("user@googlemail.com"), "user@gmail.com", "googlemail.com normalized");
assert.equal(canonicalizeEmailForUniqueness("u.s.er+x@googlemail.com"), "user@gmail.com", "combined normalization");
assert.equal(canonicalizeEmailForUniqueness("user@gmail.com"), "user@gmail.com", "plain gmail unchanged");
assert.equal(canonicalizeEmailForUniqueness("+tag@gmail.com"), null, "+tag@gmail.com → null (empty local)");
assert.equal(canonicalizeEmailForUniqueness("....@gmail.com"), null, "....@gmail.com → null (empty local)");
assert.equal(canonicalizeEmailForUniqueness(".@googlemail.com"), null, ".@googlemail.com → null (empty local)");

assert.equal(canonicalizeEmailForUniqueness("user.name@example.com"), "user.name@example.com", "non-google dot preserved");
assert.equal(canonicalizeEmailForUniqueness("user+tag@example.com"), "user+tag@example.com", "non-google plus preserved");
assert.equal(canonicalizeEmailForUniqueness("user@outlook.com"), "user@outlook.com", "outlook untouched");

console.log("  OK canonicalization unit checks");

const u1 = await signup("base@gmail.com", "password123");
assert.ok(u1.id, "base gmail signup succeeds");
await assert.rejects(() => signup("base+x@gmail.com", "password123"), /email already registered/, "+alias after base rejected");
await assert.rejects(() => signup("b.a.s.e@gmail.com", "password123"), /email already registered/, "dot variant after base rejected");
await assert.rejects(() => signup("base@googlemail.com", "password123"), /email already registered/, "googlemail after base rejected");
console.log("  OK base-first: alias / dot / googlemail variants all rejected");

const a1 = await signup("alias+promo@gmail.com", "password123");
assert.ok(a1.id, "alias-first signup succeeds");
await assert.rejects(() => signup("alias@gmail.com", "password123"), /email already registered/, "BASE after alias rejected (BLOCKER 1)");
await assert.rejects(() => signup("a.l.i.a.s@gmail.com", "password123"), /email already registered/, "dot variant after alias rejected");
console.log("  OK alias-first: bare base + dot variant rejected (BLOCKER 1 regression)");

const d1 = await signup("d.o.t.t.e.d@gmail.com", "password123");
assert.ok(d1.id, "dot-first signup succeeds");
await assert.rejects(() => signup("dotted@gmail.com", "password123"), /email already registered/, "base after dot-first rejected");
await assert.rejects(() => signup("dotted+x@googlemail.com", "password123"), /email already registered/, "alias+googlemail after dot-first rejected");
console.log("  OK dot-first: base + alias-googlemail variants rejected");

const g1 = await signup("gm.user@googlemail.com", "password123");
assert.ok(g1.id, "googlemail-first signup succeeds");
await assert.rejects(() => signup("gmuser@gmail.com", "password123"), /email already registered/, "gmail.com after googlemail-first rejected");
console.log("  OK googlemail-first: gmail.com variant rejected");

await assert.rejects(() => signup("+only@gmail.com", "password123"), /invalid email/, "+only@gmail.com signup rejected (empty local)");
console.log("  OK +only@gmail.com signup rejected (MED 1: empty local part)");

const o1 = await signup("user.name@outlook.com", "password123");
assert.ok(o1.id, "non-google dot address is a distinct account");
const o2 = await signup("user+tag@outlook.com", "password123");
assert.ok(o2.id, "non-google plus address is a distinct account");
await assert.rejects(() => signup("user.name@outlook.com", "password123"), /email already registered/, "exact duplicate non-google rejected");
console.log("  OK non-google dot/plus accepted as distinct; exact duplicate rejected");

db.prepare("INSERT INTO users (id, email, password_hash, created_at, github_id, canonical_email) VALUES (?, ?, ?, ?, ?, ?)").run(
  "u_legacy_test",
  "legacy@gmail.com",
  "x",
  Date.now(),
  null,
  null,
);
assert.equal(userDao.byCanonicalEmail("legacy@gmail.com"), undefined, "legacy NULL row is not found by canonical lookup (documented gap)");
const legacyAlias = await signup("le.gacy+x@gmail.com", "password123");
assert.ok(legacyAlias.id, "alias of a pre-feature NULL row signs up (gap closed only by backfill)");
console.log("  OK pre-feature NULL row: no crash; documented retro gap behaves as specified");

const pw = await signup("oauthbase@gmail.com", "password123");
const linked = githubUpsert({ id: "gh_1001", login: "oauthbase", email: "oauth.base+work@gmail.com" });
assert.equal(linked.id, pw.id, "OAuth alias links to existing canonical account (HIGH 1)");
console.log("  OK OAuth alias links to existing password account (HIGH 1)");

const fresh = githubUpsert({ id: "gh_1002", login: "ghonly", email: "gh.only@gmail.com" });
const freshRow = userDao.byId(fresh.id);
assert.equal(freshRow?.canonical_email, "ghonly@gmail.com", "OAuth-created row stores canonical_email (HIGH 1)");
await assert.rejects(() => signup("ghonly+x@gmail.com", "password123"), /email already registered/, "alias signup after OAuth create rejected (HIGH 1)");
console.log("  OK OAuth-created account stores canonical key; later alias signup rejected (HIGH 1)");

const linked2 = githubUpsert({ id: "gh_1003", login: "ghonly", email: "g.h.only+more@googlemail.com" });
assert.equal(linked2.id, fresh.id, "OAuth alias-of-alias links to same account (HIGH 1)");
console.log("  OK second OAuth alias links to the same account (HIGH 1)");

function freshDb() {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, canonical_email TEXT);");
  return d;
}
function seed(d: InstanceType<typeof DatabaseSync>, id: string, email: string, createdAt: number) {
  d.prepare("INSERT INTO users (id, email, password_hash, created_at, canonical_email) VALUES (?, ?, ?, ?, NULL)").run(id, email, "x", createdAt);
}
function hasUniqueIndex(d: InstanceType<typeof DatabaseSync>): boolean {
  const row = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_users_canonical_email'").get() as { n: number };
  return row.n > 0;
}

{
  const d = freshDb();
  seed(d, "L1", "user@gmail.com", 1);
  seed(d, "L2", "u.s.er+x@gmail.com", 2);
  seed(d, "L3", "someone@outlook.com", 3);
  const res = runBackfill(d);
  assert.equal(res.updated, 2, "backfill updates exactly the 2 gmail rows (plain legacy + alias)");
  assert.equal((d.prepare("SELECT canonical_email AS c FROM users WHERE id='L1'").get() as { c: string }).c, "user@gmail.com", "plain legacy gmail row backfilled (not left NULL — BLOCKER)");
  assert.equal((d.prepare("SELECT canonical_email AS c FROM users WHERE id='L2'").get() as { c: string }).c, "user@gmail.com", "alias row canonicalized to same key");
  assert.equal((d.prepare("SELECT canonical_email AS c FROM users WHERE id='L3'").get() as { c: string | null }).c, null, "non-gmail row stays NULL");
  assert.equal(res.duplicates.length, 1, "one duplicate cluster detected");
  assert.equal(res.duplicates[0].canonical, "user@gmail.com", "cluster keyed on canonical inbox");
  assert.equal(res.duplicates[0].members.length, 2, "cluster has the legacy + alias members");
  assert.equal(res.indexCreated, false, "UNIQUE index NOT created while a duplicate cluster exists");
  assert.equal(hasUniqueIndex(d), false, "index truly absent in the DB");
  console.log("  OK backfill detects plain-legacy + alias as a duplicate cluster, no index (BLOCKER regression)");
}

{
  const d = freshDb();
  seed(d, "C1", "alice@gmail.com", 1);
  seed(d, "C2", "b.o.b+tag@googlemail.com", 2);
  seed(d, "C3", "carol@outlook.com", 3);
  const res = runBackfill(d);
  assert.equal(res.duplicates.length, 0, "no duplicate clusters in the clean case");
  assert.equal(res.indexCreated, true, "UNIQUE index created when clean");
  assert.ok(hasUniqueIndex(d), "index present in the DB");
  assert.equal((d.prepare("SELECT canonical_email AS c FROM users WHERE id='C2'").get() as { c: string }).c, "bob@gmail.com", "googlemail alias canonicalized + normalized");
  assert.throws(
    () => d.prepare("INSERT INTO users (id, email, password_hash, created_at, canonical_email) VALUES ('C4','alice+x@gmail.com','x',4,'alice@gmail.com')").run(),
    /UNIQUE constraint failed/,
    "UNIQUE index enforces canonical uniqueness post-migration",
  );
  const res2 = runBackfill(d);
  assert.equal(res2.duplicates.length, 0, "re-run still clean");
  assert.equal(res2.indexCreated, true, "re-run idempotent (index already exists)");
  console.log("  OK backfill clean case builds UNIQUE index + enforces it; idempotent re-run");
}

console.log("all email-canonical checks passed");
