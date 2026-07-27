import { decryptKey } from "../identity/auth.ts";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class SshUnlockRequiredError extends Error {
  constructor(public readonly targetId: string) {
    super("passkey unlock required");
    this.name = "SshUnlockRequiredError";
  }
}

export function resolveSshPrivateKey(
  userId: string,
  row: { id: string; enc_key: string; key_protected: number },
): string {
  if (!row.key_protected) return decryptKey(row.enc_key);
  const k = getUnlockedKey(userId, row.id);
  if (!k) throw new SshUnlockRequiredError(row.id);
  unlockKey(userId, row.id, k);
  return k;
}

interface Entry {
  privateKey: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function keyOf(userId: string, targetId: string): string {
  return `${userId}\u0000${targetId}`;
}

export function unlockKey(userId: string, targetId: string, privateKey: string, ttlMs = DEFAULT_TTL_MS): number {
  const expiresAt = Date.now() + ttlMs;
  store.set(keyOf(userId, targetId), { privateKey, expiresAt });
  return expiresAt;
}

export function getUnlockedKey(userId: string, targetId: string): string | null {
  const k = keyOf(userId, targetId);
  const e = store.get(k);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    store.delete(k);
    return null;
  }
  return e.privateKey;
}

export function isUnlocked(userId: string, targetId: string): boolean {
  return getUnlockedKey(userId, targetId) !== null;
}

export function lockKey(userId: string, targetId: string): void {
  store.delete(keyOf(userId, targetId));
}

export function unlockTtlRemaining(userId: string, targetId: string): number {
  const e = store.get(keyOf(userId, targetId));
  if (!e) return 0;
  return Math.max(0, e.expiresAt - Date.now());
}
