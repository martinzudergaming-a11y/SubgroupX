import { verifyToken } from "./auth.ts";
import { bannedReason } from "./ban.ts";
import { execBlockedForVerification } from "./email-verify.ts";
import { runtimeDrainState } from "../runtime/runtime-drain-state.ts";

const EMAIL_VERIFY_MSG =
  "Please verify your email before running tasks — check your inbox for the verification link.";
const DRAINING_MSG = "The server is restarting — please try again in a moment.";

export type AccessDenial =
  | { kind: "suspended"; message: string; wsCode: 4003; httpStatus: 403 }
  | { kind: "email_verification_required"; message: string; wsCode: 4005; httpStatus: 403 }
  | { kind: "draining"; message: string; wsCode: 1013; httpStatus: 503 };

export function socketDenial(userId: string, opts: { includeDraining?: boolean } = {}): AccessDenial | null {
  const ban = bannedReason(userId);
  if (ban) return { kind: "suspended", message: ban, wsCode: 4003, httpStatus: 403 };
  if (opts.includeDraining && runtimeDrainState.isDraining()) {
    return { kind: "draining", message: DRAINING_MSG, wsCode: 1013, httpStatus: 503 };
  }
  return null;
}

export function executionDenial(userId: string, opts: { includeDraining?: boolean } = {}): AccessDenial | null {
  const ban = bannedReason(userId);
  if (ban) return { kind: "suspended", message: ban, wsCode: 4003, httpStatus: 403 };
  if (execBlockedForVerification(userId)) {
    return { kind: "email_verification_required", message: EMAIL_VERIFY_MSG, wsCode: 4005, httpStatus: 403 };
  }
  if (opts.includeDraining && runtimeDrainState.isDraining()) {
    return { kind: "draining", message: DRAINING_MSG, wsCode: 1013, httpStatus: 503 };
  }
  return null;
}

export function runtimeExecutionDenial(userId: string, draining: boolean): AccessDenial | null {
  const denial = executionDenial(userId);
  if (denial) return denial;
  return draining
    ? { kind: "draining", message: DRAINING_MSG, wsCode: 1013, httpStatus: 503 }
    : null;
}

export function tokenStillValidForUser(token: string, userId: string): boolean {
  return verifyToken(token)?.id === userId;
}
