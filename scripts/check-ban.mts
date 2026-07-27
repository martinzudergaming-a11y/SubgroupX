import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "bantest-"));

const R = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { userDao } = await import(R + "/server/src/persistence/index.ts");
const ban = await import(R + "/server/src/identity/ban.ts");
const { signup, issueToken, verifyToken } = await import(R + "/server/src/identity/auth.ts");

const u = await signup("ban-test@gmail.com", "password123");
assert.equal(userDao.banInfo(u.id), null, "active user has no ban info");
assert.equal(ban.bannedReason(u.id), null, "active user has no reason");

const tok = issueToken(u);
assert.ok(verifyToken(tok), "pre-ban token verifies");

const email = ban.banUser(u.id, "Using the platform to attack external hosts");
assert.equal(email, "ban-test@gmail.com", "banUser returns the email");
const info = userDao.banInfo(u.id);
assert.ok(info && typeof info.bannedAt === "number", "banInfo set after ban");
assert.equal(info!.reason, "Using the platform to attack external hosts", "reason stored");
assert.equal(ban.bannedReason(u.id), "Using the platform to attack external hosts", "bannedReason returns stored reason");

assert.equal(verifyToken(tok), null, "pre-ban token rejected after ban (pwc bump)");

const u2 = await signup("ban-test2@gmail.com", "password123");
ban.banUser(u2.id, null);
assert.equal(ban.bannedReason(u2.id), ban.DEFAULT_BAN_REASON, "empty reason falls back to default");
assert.equal(userDao.banInfo(u2.id)!.reason, null, "stored reason stays null (default is presentational)");

ban.unbanUser(u.id);
assert.equal(userDao.banInfo(u.id), null, "banInfo cleared after unban");
assert.equal(ban.bannedReason(u.id), null, "no reason after unban");
assert.ok(verifyToken(issueToken(u)), "post-unban token verifies");

assert.equal(ban.banUser("u_does_not_exist", "x"), null, "ban unknown user → null");

console.log("all ban checks passed");
