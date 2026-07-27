import { userDao } from "../persistence/index.ts";

export const DEFAULT_BAN_REASON =
  "Your account has been suspended for activity that violates the acceptable-use policy.";

export function bannedReason(userId: string): string | null {
  const info = userDao.banInfo(userId);
  if (!info) return null;
  return info.reason || DEFAULT_BAN_REASON;
}

export function banUser(userId: string, reason: string | null): string | null {
  return userDao.ban(userId, reason);
}

export function unbanUser(userId: string): void {
  userDao.unban(userId);
}
