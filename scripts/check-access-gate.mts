import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "gatetest-"));
process.env.AGENT_WEB_RESEND_KEY = "test_key";
process.env.AGENT_WEB_EMAIL_FROM = "oiia <noreply@example.test>";

const R = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { userDao } = await import(R + "/server/src/persistence/index.ts");
const ev = await import(R + "/server/src/identity/email-verify.ts");
const ban = await import(R + "/server/src/identity/ban.ts");
const { signup, issueToken } = await import(R + "/server/src/identity/auth.ts");
const gate = await import(R + "/server/src/identity/access-gate.ts");
const { sessionManager } = await import(R + "/server/src/runtime/manager.ts");

const active = await signup("gate-active@gmail.com", "password123");
assert.equal(gate.socketDenial(active.id), null, "active: socket admitted");
assert.equal(gate.executionDenial(active.id), null, "active: execution admitted");

const pending = await signup("gate-pending@gmail.com", "password123", { requireEmailVerification: true });
await ev.prepareVerificationEmail(pending.email);
assert.equal(gate.socketDenial(pending.id), null, "pending: socket still admitted (can browse)");
const pd = gate.executionDenial(pending.id);
assert.equal(pd?.kind, "email_verification_required", "pending: execution denied with email kind");
assert.equal(pd?.wsCode, 4005, "pending: wsCode 4005");
assert.equal(pd?.httpStatus, 403, "pending: httpStatus 403");

const banned = await signup("gate-banned@gmail.com", "password123");
ban.banUser(banned.id, "abuse");
assert.equal(gate.socketDenial(banned.id)?.kind, "suspended", "banned: socket denied");
const bd = gate.executionDenial(banned.id);
assert.equal(bd?.kind, "suspended", "banned: execution denied (suspended)");
assert.equal(bd?.wsCode, 4003, "banned: wsCode 4003");

const both = await signup("gate-both@gmail.com", "password123", { requireEmailVerification: true });
await ev.prepareVerificationEmail(both.email);
ban.banUser(both.id, "abuse + unverified");
assert.equal(gate.executionDenial(both.id)?.kind, "suspended", "ban outranks email-verify");

const tokUser = await signup("gate-token@gmail.com", "password123");
const tok = issueToken(tokUser);
assert.equal(gate.tokenStillValidForUser(tok, tokUser.id), true, "fresh token valid");
assert.equal(gate.tokenStillValidForUser(tok, "u_someone_else"), false, "token not valid for another user");
ban.banUser(tokUser.id, "x");
assert.equal(gate.tokenStillValidForUser(tok, tokUser.id), false, "token rejected after pwc bump");

const drainUser = await signup("gate-drain@gmail.com", "password123");
assert.equal(gate.executionDenial(drainUser.id, { includeDraining: true }), null, "not draining yet");
sessionManager.setDraining();
assert.equal(gate.executionDenial(drainUser.id, { includeDraining: true })?.kind, "draining", "draining when opted in");
assert.equal(gate.executionDenial(drainUser.id)?.kind ?? null, null, "no draining denial without opt-in");
assert.equal(gate.socketDenial(drainUser.id, { includeDraining: true })?.kind, "draining", "socket draining when opted in");

console.log("all access-gate checks passed");
