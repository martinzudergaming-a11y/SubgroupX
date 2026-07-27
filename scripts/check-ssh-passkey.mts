import assert from "node:assert/strict";
import { encryptKey } from "../server/src/identity/auth.ts";
import {
  unlockKey,
  getUnlockedKey,
  isUnlocked,
  lockKey,
  resolveSshPrivateKey,
  SshUnlockRequiredError,
} from "../server/src/runtime/ssh-unlock.ts";

let failed = 0;
const ok = (name: string) => console.log(`  ✓ ${name}`);
const check = (name: string, fn: () => void) => {
  try {
    fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const U = "u_test", T = "ssh_test";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----";

check("miss before unlock → null / not unlocked", () => {
  lockKey(U, T);
  assert.equal(getUnlockedKey(U, T), null);
  assert.equal(isUnlocked(U, T), false);
});

check("unlock caches the key, isUnlocked true", () => {
  unlockKey(U, T, KEY, 60_000);
  assert.equal(getUnlockedKey(U, T), KEY);
  assert.equal(isUnlocked(U, T), true);
});

check("lock clears it", () => {
  unlockKey(U, T, KEY, 60_000);
  lockKey(U, T);
  assert.equal(getUnlockedKey(U, T), null);
});

check("TTL expiry evicts (0ms → immediately gone)", () => {
  unlockKey(U, T, KEY, 0);
  assert.equal(getUnlockedKey(U, T), null, "a 0ms TTL must be treated as expired");
});

check("cache is scoped per (user,target)", () => {
  unlockKey(U, T, KEY, 60_000);
  assert.equal(getUnlockedKey("other_user", T), null);
  assert.equal(getUnlockedKey(U, "other_target"), null);
  lockKey(U, T);
});

check("resolveSshPrivateKey: legacy row decrypts with the platform secret", () => {
  const row = { id: "ssh_legacy", enc_key: encryptKey(KEY), key_protected: 0 };
  assert.equal(resolveSshPrivateKey(U, row), KEY);
});

check("resolveSshPrivateKey: protected row throws SshUnlockRequiredError when locked", () => {
  const row = { id: "ssh_prot", enc_key: '{"v":1,"credentialId":"x","salt":"y","iv":"z","ct":"w"}', key_protected: 1 };
  lockKey(U, row.id);
  assert.throws(() => resolveSshPrivateKey(U, row), SshUnlockRequiredError);
});

check("resolveSshPrivateKey: protected row returns the unlocked key (never decrypts the blob)", () => {
  const row = { id: "ssh_prot2", enc_key: '{"v":1,"credentialId":"x"}', key_protected: 1 };
  unlockKey(U, row.id, KEY, 60_000);
  assert.equal(resolveSshPrivateKey(U, row), KEY);
  lockKey(U, row.id);
});

if (failed) {
  console.error(`\n${failed} ssh-passkey check(s) FAILED`);
  process.exit(1);
}
console.log("\nall ssh-passkey checks passed");
