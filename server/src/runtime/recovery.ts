import crypto from "node:crypto";
import {
  agentNodeDao,
  agentTurnDao,
  pendingMessageDao,
  runInTransaction,
  runtimeTaskDao,
  teamTaskDao,
  teamTurnOutcomeDao,
  sessionDao,
  timelineDao,
} from "../persistence/index.ts";
import type { TimelineItem } from "../../../shared/src/protocol.ts";
import { PRODUCT_NAME } from "../config.ts";

const TERMINAL_TOOL_STATUSES = new Set(["success", "error", "denied"]);
const PROCESS_RECOVERY_ID = `boot_${crypto.randomUUID()}`;

export interface TeamTurnRetirement {
  taskId: string;
  turnId: string;
  reason: string;
  outcomeStatus?: "interrupted" | "cancelled";
  origin?: "deadline" | "lease_lost" | "owner_session_deleted" | "runtime_replacement";
}

function settleToolTree(
  item: Extract<TimelineItem, { kind: "tool" }>,
  status: "error" | "cancelled",
  resultText: string,
): { item: Extract<TimelineItem, { kind: "tool" }>; changed: boolean } {
  let changed = false;
  const children = item.children?.map((child) => {
    if (child.kind !== "tool") return child;
    const settled = settleToolTree(child, status, resultText);
    changed ||= settled.changed;
    return settled.item;
  });
  if (!TERMINAL_TOOL_STATUSES.has(item.status)) {
    changed = true;
    const persistedStatus = status === "cancelled" ? "denied" as const : "error" as const;
    return {
      changed,
      item: {
        ...item,
        status: persistedStatus,
        termination: status === "cancelled" ? "cancelled" : undefined,
        resultText,
        isError: status === "error",
        ...(children ? { children } : {}),
      },
    };
  }
  return { item: children && changed ? { ...item, children } : item, changed };
}

function settlePersistedTools(
  sessionId: string,
  items: TimelineItem[],
  belongs: (item: Extract<TimelineItem, { kind: "tool" }>) => boolean,
  status: "error" | "cancelled" = "cancelled",
  interruptionReason?: string,
): void {
  const resultText = status === "error"
    ? "The turn failed before this tool settled."
    : interruptionReason ?? "Interrupted by a server restart before this tool settled.";
  for (const item of items) {
    if (item.kind !== "tool" || !belongs(item)) continue;
    const settled = settleToolTree(item, status, resultText);
    if (settled.changed) timelineDao.append(sessionId, settled.item);
  }
}

type RunningRecoveryResult = "interrupted" | "terminal" | "failed" | "none";

function recoverOrphanLifecycle(sessionId: string, retirement?: TeamTurnRetirement): boolean {
  const session = sessionDao.byId(sessionId);
  if (!session || session.status === "running") return false;
  const turn = agentTurnDao.latestInProgress(sessionId);
  if (!turn) return false;
  const items = timelineDao.list(sessionId);
  const failed = session.status === "error";
  if (turn.source === "team" && turn.teamTaskId) {
    const exactRetirement = retirement
      && retirement.taskId === turn.teamTaskId
      && retirement.turnId === turn.id
      ? retirement
      : undefined;
    if (turn.teamTaskLeaseGeneration == null || turn.teamMailClaimGeneration == null) {
      runInTransaction(() => {
        settlePersistedTools(sessionId, items, (item) => item.turnId === turn.id, failed ? "error" : "cancelled");
        agentTurnDao.complete(sessionId, turn.id, failed ? "failed" : "interrupted", Date.now());
        sessionDao.setStatus(sessionId, failed ? "error" : "idle");
      });
      return true;
    }
    const taskLeaseGeneration = turn.teamTaskLeaseGeneration;
    const mailClaimGeneration = turn.teamMailClaimGeneration;
    if (!teamTaskDao.attemptMatches(
      session.user_id,
      turn.teamTaskId,
      taskLeaseGeneration,
      mailClaimGeneration,
    )) {
      runInTransaction(() => {
        settlePersistedTools(sessionId, items, (item) => item.turnId === turn.id, "cancelled");
        agentTurnDao.complete(sessionId, turn.id, "interrupted", Date.now());
        sessionDao.setStatus(sessionId, "idle");
      });
      return true;
    }
    const completedAt = Date.now();
    const retirementStatus = exactRetirement?.outcomeStatus ?? "interrupted";
    runInTransaction(() => {
      settlePersistedTools(
        sessionId,
        items,
        (item) => item.turnId === turn.id,
        failed ? "error" : "cancelled",
        exactRetirement?.reason,
      );
      agentTurnDao.complete(sessionId, turn.id, failed ? "failed" : "interrupted", completedAt);
      teamTurnOutcomeDao.record({
        taskId: turn.teamTaskId!,
        userId: session.user_id,
        sessionId,
        turnId: turn.id,
        taskLeaseGeneration,
        mailClaimGeneration,
        status: failed ? "failed" : retirementStatus,
        summary: failed
          ? "Team Turn failed before runtime settlement."
          : exactRetirement?.reason ?? "Team Turn was interrupted by runtime replacement.",
        body: exactRetirement
          ? {
              recovery: "runtime_retirement",
              reason: exactRetirement.reason,
              ...(exactRetirement.origin ? { origin: exactRetirement.origin } : {}),
            }
          : { recovery: "orphan_lifecycle" },
        artifacts: [],
        at: completedAt,
      });
      sessionDao.setStatus(sessionId, failed ? "error" : "idle");
    });
    return true;
  }
  runInTransaction(() => {
    settlePersistedTools(
      sessionId,
      items,
      (item) => item.turnId === turn.id,
      failed ? "error" : "cancelled",
    );
    agentTurnDao.complete(sessionId, turn.id, failed ? "failed" : "interrupted", Date.now());
    agentTurnDao.clearAcceptedInput(sessionId, turn.id);
    pendingMessageDao.reclassifyPendingKind(sessionId, "steer", "queue");
    if (!failed && session.status !== "idle") sessionDao.setStatus(sessionId, "idle");
  });
  return true;
}

function recoverRunningSession(sessionId: string, retirement?: TeamTurnRetirement): RunningRecoveryResult {
  const row = sessionDao.byId(sessionId);
  if (!row || row.status !== "running") return "none";

  const items = timelineDao.list(row.id);
  const interruptedTurn = agentTurnDao.latestInProgress(row.id);
  if (interruptedTurn?.source === "team" && interruptedTurn.teamTaskId) {
    const exactRetirement = retirement
      && retirement.taskId === interruptedTurn.teamTaskId
      && retirement.turnId === interruptedTurn.id
      ? retirement
      : undefined;
    if (interruptedTurn.teamTaskLeaseGeneration == null || interruptedTurn.teamMailClaimGeneration == null) {
      runInTransaction(() => {
        settlePersistedTools(row.id, items, (item) => item.turnId === interruptedTurn.id, "cancelled");
        agentTurnDao.complete(row.id, interruptedTurn.id, "interrupted", Date.now());
        sessionDao.setStatus(row.id, "idle");
      });
      return "interrupted";
    }
    const taskLeaseGeneration = interruptedTurn.teamTaskLeaseGeneration;
    const mailClaimGeneration = interruptedTurn.teamMailClaimGeneration;
    if (!teamTaskDao.attemptMatches(
      row.user_id,
      interruptedTurn.teamTaskId,
      taskLeaseGeneration,
      mailClaimGeneration,
    )) {
      runInTransaction(() => {
        settlePersistedTools(row.id, items, (item) => item.turnId === interruptedTurn.id, "cancelled");
        agentTurnDao.complete(row.id, interruptedTurn.id, "interrupted", Date.now());
        sessionDao.setStatus(row.id, "idle");
      });
      return "interrupted";
    }
    const failed = items.some((item) => item.kind === "error" && item.turnId === interruptedTurn.id);
    const completedAt = Date.now();
    const retirementStatus = exactRetirement?.outcomeStatus ?? "interrupted";
    runInTransaction(() => {
      settlePersistedTools(
        row.id,
        items,
        (item) => item.turnId === interruptedTurn.id,
        failed ? "error" : "cancelled",
        exactRetirement?.reason,
      );
      agentTurnDao.complete(row.id, interruptedTurn.id, failed ? "failed" : "interrupted", completedAt);
      teamTurnOutcomeDao.record({
        taskId: interruptedTurn.teamTaskId!,
        userId: row.user_id,
        sessionId: row.id,
        turnId: interruptedTurn.id,
        taskLeaseGeneration,
        mailClaimGeneration,
        status: failed ? "failed" : retirementStatus,
        summary: failed
          ? "Team Turn failed before runtime settlement."
          : exactRetirement?.reason ?? "Team Turn was interrupted by a server restart.",
        body: exactRetirement
          ? {
              recovery: "runtime_retirement",
              reason: exactRetirement.reason,
              ...(exactRetirement.origin ? { origin: exactRetirement.origin } : {}),
            }
          : { recovery: "running_session" },
        artifacts: [],
        at: completedAt,
      });
      sessionDao.setStatus(row.id, failed ? "error" : "idle");
    });
    return failed ? "failed" : "interrupted";
  }
  const durableTurnError = interruptedTurn && items.some((item) =>
    item.kind === "error" && item.turnId === interruptedTurn.id
  );
  if (interruptedTurn && durableTurnError) {
    runInTransaction(() => {
      settlePersistedTools(row.id, items, (item) => item.turnId === interruptedTurn.id, "error");
      agentTurnDao.complete(row.id, interruptedTurn.id, "failed", Date.now());
      agentTurnDao.clearAcceptedInput(row.id, interruptedTurn.id);
      pendingMessageDao.reclassifyPendingKind(row.id, "steer", "queue");
      sessionDao.setStatus(row.id, "error");
    });
    return "failed";
  }
  const latestTurn = agentTurnDao.latest(row.id);
  const legacyTailUsers = items.filter((item): item is Extract<TimelineItem, { kind: "user" }> =>
    item.kind === "user" && !item.turnId && (
      latestTurn == null || (latestTurn.endSeq != null
        ? item.seq > latestTurn.endSeq
        : item.ts >= latestTurn.startedAt)
    )
  );
  const legacyTailUser = legacyTailUsers.at(-1);
  const latestAcceptedInput = latestTurn ? agentTurnDao.acceptedInput(row.id, latestTurn.id) : null;
  const latestInputMaterialized = latestTurn
    ? items.some((item) => item.kind === "user" && item.turnId === latestTurn.id)
    : false;
  const terminalInputNeedsNotice = Boolean(latestTurn && latestAcceptedInput && !latestInputMaterialized);
  const recoveryTurn = legacyTailUser
    ? null
    : interruptedTurn ?? (terminalInputNeedsNotice ? latestTurn : null);
  if (!recoveryTurn && !legacyTailUser && latestTurn) {
    runInTransaction(() => {
      agentTurnDao.clearAcceptedInput(row.id, latestTurn.id);
      pendingMessageDao.reclassifyPendingKind(row.id, "steer", "queue");
      sessionDao.setStatus(row.id, "idle");
    });
    return "terminal";
  }

  let resumeText = legacyTailUser?.text;
  if (resumeText === undefined && recoveryTurn) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user" && item.turnId === recoveryTurn.id) {
        resumeText = item.text;
        break;
      }
    }
  }
  if (resumeText === undefined && recoveryTurn) {
    resumeText = agentTurnDao.acceptedInput(row.id, recoveryTurn.id) ?? undefined;
  }
  const seq = timelineDao.maxSeq(row.id) + 1;
  const notice: TimelineItem = {
    kind: "interrupted",
    id: `int_${row.id}_${seq}`,
    seq,
    ts: Date.now(),
    resumeText,
    ...(recoveryTurn ? { turnId: recoveryTurn.id } : {}),
  };
  runInTransaction(() => {
    if (interruptedTurn) {
      settlePersistedTools(row.id, items, (item) => item.turnId === interruptedTurn.id);
    }
    if (legacyTailUser) {
      settlePersistedTools(row.id, items, (item) => !item.turnId && item.seq >= legacyTailUser.seq);
    } else if (recoveryTurn && recoveryTurn !== interruptedTurn) {
      settlePersistedTools(row.id, items, (item) => item.turnId === recoveryTurn.id);
    }
    timelineDao.append(row.id, notice);
    if (interruptedTurn) agentTurnDao.complete(row.id, interruptedTurn.id, "interrupted", notice.ts);
    if (recoveryTurn) agentTurnDao.clearAcceptedInput(row.id, recoveryTurn.id);
    if (interruptedTurn && interruptedTurn !== recoveryTurn) {
      agentTurnDao.clearAcceptedInput(row.id, interruptedTurn.id);
    }
    pendingMessageDao.reclassifyPendingKind(row.id, "steer", "queue");
    sessionDao.setStatus(row.id, "idle");
  });
  return "interrupted";
}

export function recoverInterruptedSession(sessionId: string, retirement?: TeamTurnRetirement): boolean {
  if (retirement) {
    const turn = agentTurnDao.latestInProgress(sessionId);
    if (
      !turn
      || turn.source !== "team"
      || turn.teamTaskId !== retirement.taskId
      || turn.id !== retirement.turnId
    ) return false;
  }
  const running = recoverRunningSession(sessionId, retirement);
  return running !== "none" || recoverOrphanLifecycle(sessionId, retirement);
}

export function recoverInterruptedSessions(): number {
  const orchestrationNow = Date.now();
  const taskRecovery = runtimeTaskDao.recoverAfterRestart(orchestrationNow, PROCESS_RECOVERY_ID);
  const recoveredAgents = agentNodeDao.recoverAfterRestart(orchestrationNow);
  const running = sessionDao.listRunning();
  const runningIds = new Set(running.map((row) => row.id));
  let interruptedCount = 0;
  let terminalRaceCount = 0;
  let failedCount = 0;
  for (const row of running) {
    const result = recoverRunningSession(row.id);
    if (result === "interrupted") interruptedCount++;
    else if (result === "terminal") terminalRaceCount++;
    else if (result === "failed") failedCount++;
  }

  let orphanLifecycleCount = 0;
  for (const turn of agentTurnDao.listInProgress()) {
    if (runningIds.has(turn.sessionId)) continue;
    if (recoverOrphanLifecycle(turn.sessionId)) orphanLifecycleCount++;
  }
  if (running.length > 0) {
    console.log(
      `[${PRODUCT_NAME}] #61 restart recovery: ${interruptedCount} interrupted session(s), ` +
      `${terminalRaceCount} already-terminal session(s) normalized, ${failedCount} failed lifecycle(s) closed`,
    );
  }
  if (orphanLifecycleCount > 0) {
    console.log(`[${PRODUCT_NAME}] closed ${orphanLifecycleCount} orphaned Agent Turn lifecycle(s) after restart`);
  }
  const recoveredTasks = taskRecovery.interrupted + taskRecovery.requeued
    + taskRecovery.waiting + taskRecovery.cancelled;
  if (recoveredTasks > 0 || recoveredAgents > 0) {
    console.log(
      `[${PRODUCT_NAME}] orchestration recovery: ${recoveredTasks} Task(s), ${recoveredAgents} Agent(s) fenced`,
    );
  }
  return running.length;
}
