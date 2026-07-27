import { userDao } from "../persistence/index.ts";
import type { PendingMutationResult } from "../../../shared/src/protocol.ts";

export const AUTH_EPOCH_REVOKED_MESSAGE = "Your sign-in session changed. Sign in again.";

export class AuthEpochRevokedError extends Error {
  readonly code = "auth_revoked" as const;

  constructor() {
    super(AUTH_EPOCH_REVOKED_MESSAGE);
    this.name = "AuthEpochRevokedError";
  }
}

export class RuntimeMutationRejectedError extends Error {
  constructor(readonly result: Extract<PendingMutationResult, { ok: false }>) {
    super(result.message);
    this.name = "RuntimeMutationRejectedError";
  }
}

export function assertAuthEpochInWriterTransaction(userId: string, expected: number | undefined): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected) || !userDao.authEpochMatches(userId, expected)) {
    throw new AuthEpochRevokedError();
  }
}
