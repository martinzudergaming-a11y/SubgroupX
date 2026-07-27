import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-stepup-check-"));
process.env["AGENT_WEB_DATA_DIR"] = tmpDir;
process.env["AGENT_WEB_SECRET"] = "stepup-check-fixed-secret-32chars!";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  issueToken,
  verifyToken,
  issuePasswordSetupToken,
  verifyPasswordSetupToken,
  parseOAuthState,
  githubStepupAuthorizeUrl,
  changePassword,
} = await import(path.join(root, "server/src/identity/auth.ts"));

const { userDao } = await import(path.join(root, "server/src/persistence/index.ts"));

function makeUser(opts: {
  github_id?: string | null;
  password_hash?: string;
}): { id: string; email: string; password_hash: string; created_at: number; github_id?: string | null } {
  const id = "u_test_" + crypto.randomBytes(6).toString("hex");
  const email = `test-${id}@example.com`;
  const row = {
    id,
    email,
    password_hash: opts.password_hash ?? "",
    created_at: Date.now(),
    github_id: opts.github_id ?? null,
  };
  userDao.create(row);
  return row;
}

{
  const row = makeUser({ github_id: "gh-x", password_hash: "" });

  const setupProof = issuePasswordSetupToken(row);
  const fromProof = verifyToken(setupProof);
  assert.strictEqual(
    fromProof,
    null,
    "TOKEN CONFUSION: pw_setup proof must NOT verify as an auth token",
  );

  process.env["AGENT_WEB_GITHUB_CLIENT_ID"] = "fake-client-id";
  const authUrl = githubStepupAuthorizeUrl("https://example.com/cb", row);
  const stateParam = new URL(authUrl).searchParams.get("state")!;
  assert.ok(stateParam, "expected a state param in the stepup URL");
  const fromState = verifyToken(stateParam);
  assert.strictEqual(
    fromState,
    null,
    "TOKEN CONFUSION: gh_stepup OAuth state must NOT verify as an auth token",
  );

  const authToken = issueToken({ id: row.id, email: row.email });
  const fromAuth = verifyToken(authToken);
  assert.ok(fromAuth !== null, "TOKEN CONFUSION: real auth token must verify");
  assert.strictEqual(fromAuth.id, row.id);

  console.log("  ✓ 1. token confusion guards all pass");
}

{
  const row = makeUser({ github_id: "gh-binding-test", password_hash: "" });
  const otherRow = makeUser({ github_id: "gh-other", password_hash: "" });

  const proof = issuePasswordSetupToken(row);

  const good = verifyPasswordSetupToken(proof, row.id);
  assert.ok(good !== null, "PROOF BINDING: correct userId must return proof claims");
  assert.strictEqual(good.gh, "gh-binding-test");
  assert.strictEqual(typeof good.pwc, "number");

  const bad = verifyPasswordSetupToken(proof, otherRow.id);
  assert.strictEqual(bad, null, "PROOF BINDING: wrong userId must return null");

  console.log("  ✓ 2. proof binding checks pass");
}

{
  const row = makeUser({ github_id: "gh-gating", password_hash: "" });

  await assert.rejects(
    () => changePassword(row.id, "", "newpassword1"),
    /identity verification required/i,
    "GATING: changePassword without proof on a passwordless account must throw",
  );

  const proof = issuePasswordSetupToken(row);
  const stepupProof = verifyPasswordSetupToken(proof, row.id);
  assert.ok(stepupProof !== null);
  await changePassword(row.id, "", "newpassword1", stepupProof);

  const updated = userDao.byId(row.id);
  assert.ok(updated?.password_hash, "GATING: password_hash must be set after successful changePassword");
  assert.notStrictEqual(updated.password_hash, "", "GATING: password_hash must not be empty");

  console.log("  ✓ 3. gating checks pass");
}

{
  const row = makeUser({ github_id: "gh-nobypass", password_hash: "" });

  const proof1 = issuePasswordSetupToken(row);
  const sp1 = verifyPasswordSetupToken(proof1, row.id);
  assert.ok(sp1 !== null);
  await changePassword(row.id, "", "firstpassword1", sp1);

  const freshProof = issuePasswordSetupToken(userDao.byId(row.id)!);
  const sp2 = verifyPasswordSetupToken(freshProof, row.id);
  assert.ok(sp2 !== null);

  await assert.rejects(
    () => changePassword(row.id, "wrongcurrent", "another123", sp2),
    /current password is incorrect/i,
    "NO-BYPASS: stepup proof must NOT bypass wrong current-password check",
  );

  console.log("  ✓ 4. no-bypass check passes");
}

{
  const row = makeUser({ github_id: null, password_hash: "" });

  const ghostRow = makeUser({ github_id: "gh-ghost", password_hash: "" });
  const ghostProof = issuePasswordSetupToken(ghostRow);
  const sp = verifyPasswordSetupToken(ghostProof, ghostRow.id)!;

  await assert.rejects(
    () => changePassword(row.id, "", "newpassword1", sp),
    /this account cannot set a password/i,
    "NO-GITHUB: passwordless user with no github_id must throw on changePassword",
  );

  console.log("  ✓ 5. no-github rejection passes");
}

{
  const row = makeUser({ github_id: "gh-state-test", password_hash: "" });

  const authUrl = githubStepupAuthorizeUrl("https://example.com/cb", row);
  const stateJwt = new URL(authUrl).searchParams.get("state")!;

  const parsed = parseOAuthState(stateJwt);
  assert.ok(parsed !== null, "parseOAuthState: valid gh_stepup state must parse");
  assert.strictEqual(parsed.k, "gh_stepup");
  assert.strictEqual(parsed.uid, row.id);
  assert.strictEqual(parsed.gh, "gh-state-test");
  assert.strictEqual(typeof parsed.pwc, "number");

  const garbage = parseOAuthState("this.is.garbage");
  assert.strictEqual(garbage, null, "parseOAuthState: garbage must return null");

  const mismatch = parseOAuthState(issuePasswordSetupToken(row));
  assert.strictEqual(mismatch, null, "parseOAuthState: pw_setup token must return null (wrong shape)");

  console.log("  ✓ 6. parseOAuthState checks pass");
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("\nall step-up checks passed");
