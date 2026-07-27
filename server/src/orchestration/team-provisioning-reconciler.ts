import { randomUUID } from "node:crypto";
import {
  ORCHESTRATION_QUERY_MAX,
  teamDao,
  type TeamMemberProvisionClaim,
} from "../persistence/orchestration.ts";

export interface TeamProvisioningReconcileHost {
  provision(claim: TeamMemberProvisionClaim): { sessionId: string };
  retire(userId: string, sessionId: string): void;
}

export interface TeamProvisioningReconcileOptions {
  now?: () => number;
  claimToken?: () => string;
  maxProvision?: number;
  onError?: (error: unknown, phase: "provision" | "cleanup") => void;
}

export interface TeamProvisioningReconcileStats {
  provisioned: number;
  finalized: number;
  failed: number;
  cleaned: number;
  cleanupPending: number;
}

function boundedLimit(value: number | undefined): number {
  const resolved = value ?? ORCHESTRATION_QUERY_MAX * 40;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ORCHESTRATION_QUERY_MAX * 100) {
    throw new RangeError(`Team provisioning reconciliation limit must be from 1 to ${ORCHESTRATION_QUERY_MAX * 100}`);
  }
  return resolved;
}

function report(
  options: TeamProvisioningReconcileOptions,
  error: unknown,
  phase: "provision" | "cleanup",
): void {
  try {
    options.onError?.(error, phase);
  } catch {
  }
}

export function reconcileTeamProvisioning(
  host: TeamProvisioningReconcileHost,
  options: TeamProvisioningReconcileOptions = {},
): TeamProvisioningReconcileStats {
  const now = options.now ?? Date.now;
  const makeClaimToken = options.claimToken ?? (() => `team-provision-${randomUUID()}`);
  const maxProvision = boundedLimit(options.maxProvision);
  const stats: TeamProvisioningReconcileStats = {
    provisioned: 0,
    finalized: 0,
    failed: 0,
    cleaned: 0,
    cleanupPending: 0,
  };

  const initial = teamDao.recoverMemberReservations(now());
  stats.finalized += initial.finalized;

  const cleanupAttempted = new Set<string>();
  const clean = (entries: readonly { reservationId: string; userId: string; sessionId: string }[]) => {
    for (const entry of entries) {
      if (cleanupAttempted.has(entry.reservationId)) continue;
      cleanupAttempted.add(entry.reservationId);
      try {
        host.retire(entry.userId, entry.sessionId);
        teamDao.completeMemberReservationCleanup({ ...entry, at: now() });
        stats.cleaned += 1;
      } catch (error) {
        stats.cleanupPending += 1;
        report(options, error, "cleanup");
      }
    }
  };
  clean(initial.retire);

  for (let index = 0; index < maxProvision; index += 1) {
    const claim = teamDao.claimNextMemberProvision({
      claimToken: makeClaimToken(),
      at: now(),
    });
    if (!claim) break;
    try {
      const created = host.provision(claim);
      if (created.sessionId !== claim.reservation.provisionedSessionId) {
        throw new Error("Team provisioner did not honor its reserved Session id");
      }
      teamDao.finalizeReservedMember({
        reservationId: claim.reservation.id,
        userId: claim.reservation.userId,
        actorSessionId: claim.reservation.actorSessionId,
        teamId: claim.reservation.teamId,
        generation: claim.generation,
        claimToken: claim.claimToken,
        member: {
          id: claim.reservation.memberId,
          sessionId: created.sessionId,
          agentId: claim.reservation.provisionedAgentId,
          role: claim.reservation.role,
        },
        at: now(),
      });
      stats.provisioned += 1;
      stats.finalized += 1;
    } catch (error) {
      const failed = teamDao.failMemberProvisionClaim({
        reservationId: claim.reservation.id,
        userId: claim.reservation.userId,
        actorSessionId: claim.reservation.actorSessionId,
        teamId: claim.reservation.teamId,
        generation: claim.generation,
        claimToken: claim.claimToken,
        at: now(),
      });
      if (failed.owned) {
        stats.failed += 1;
        clean(failed.retire);
      }
      report(options, error, "provision");
    }
  }

  for (let page = 0; page < 100; page += 1) {
    const recovered = teamDao.recoverMemberReservations(now());
    stats.finalized += recovered.finalized;
    const unseen = recovered.retire.filter((entry) => !cleanupAttempted.has(entry.reservationId));
    clean(unseen);
    if (recovered.retire.length < ORCHESTRATION_QUERY_MAX || unseen.length === 0) break;
  }
  return stats;
}
