import { randomUUID } from "node:crypto";
import type {
  OrchestrationJson,
  RuntimeTask,
  TeamMail,
  TeamWorkBudget,
} from "../../../shared/src/orchestration.ts";
import {
  runtimeTaskDao,
  teamTaskDao,
  teamTurnOutcomeDao,
} from "../persistence/orchestration.ts";

export type TeamInternalTurnTerminalStatus = "completed" | "failed" | "interrupted" | "cancelled";

export interface TeamInternalTurnResult {
  status: TeamInternalTurnTerminalStatus;
  completedAt: number;
  summary: string;
  body?: OrchestrationJson;
  artifacts?: OrchestrationJson;
  usage: {
    modelCycles: number;
    tokens: number;
  };
  errorKind?: string;
  retryable?: boolean;
}

export interface TeamInternalTurnInput {
  turnId: string;
  task: RuntimeTask;
  assignment: OrchestrationJson;
  sourceSessionId: string;
  deadlineAt: number;
  budget: TeamWorkBudget;
  lease: {
    taskGeneration: number;
    mailId: string;
    claimToken: string;
    claimGeneration: number;
  };
  signal: AbortSignal;
}

export interface TeamSessionTurnRuntime {
  beginInternalTeamTurn(input: TeamInternalTurnInput):
    | { accepted: false; reason: "busy" | "gated" | "draining" }
    | { accepted: true; completion: Promise<TeamInternalTurnResult> };
}

export interface TeamSessionTurnGateway {
  activateSession(userId: string, sessionId: string): TeamSessionTurnRuntime;
  executionGate?(userId: string): "gated" | "draining" | undefined;
  retireSessionTurn?(
    userId: string,
    sessionId: string,
    taskId: string,
    turnId: string,
    reason: string,
  ): boolean;
}

export interface TeamTurnExecutorOptions {
  userId: string;
  gateway: TeamSessionTurnGateway;
  onChanged?: (change: { task: RuntimeTask; mail: TeamMail }) => void;
  now?: () => number;
  id?: (kind: "claim" | "turn" | "result") => string;
  mailLeaseMs?: number;
}

export type TeamTurnExecutionOutcome =
  | { status: "skipped" | "parked"; taskId: string; reason?: string }
  | { status: "succeeded"; task: RuntimeTask; mail: TeamMail }
  | {
      status: "failed" | "interrupted" | "cancelled";
      task: RuntimeTask;
      mail: TeamMail;
      error: string;
      attemptSettled?: Promise<void>;
    };

class TeamDeadlineError extends Error {}
class TeamLeaseLostError extends Error {}

function payloadRecord(value: OrchestrationJson): Record<string, OrchestrationJson> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Team Task payload must be an object");
  }
  return value;
}

function readBudget(value: OrchestrationJson): TeamWorkBudget {
  const record = payloadRecord(value);
  if (
    !Number.isSafeInteger(record.maxModelCycles)
    || Number(record.maxModelCycles) < 1
    || !Number.isSafeInteger(record.maxTokens)
    || Number(record.maxTokens) < 1
  ) throw new Error("Team Task payload has no valid execution budget");
  return { maxModelCycles: Number(record.maxModelCycles), maxTokens: Number(record.maxTokens) };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TeamTurnExecutor {
  private readonly now: () => number;
  private readonly makeId: (kind: "claim" | "turn" | "result") => string;
  private readonly mailLeaseMs: number;

  constructor(private readonly options: TeamTurnExecutorOptions) {
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((kind) => `${kind}_${randomUUID()}`);
    this.mailLeaseMs = options.mailLeaseMs ?? 300_000;
    if (!Number.isSafeInteger(this.mailLeaseMs) || this.mailLeaseMs < 1_000 || this.mailLeaseMs > 300_000) {
      throw new RangeError("Team executor lease must be from 1000 to 300000 ms");
    }
  }

  private notifyChanged(task: RuntimeTask, mail: TeamMail): void {
    try {
      this.options.onChanged?.({ task, mail });
    } catch (error) {
      console.error(`[team-executor] invalidation: ${errorText(error).slice(0, 500)}`);
    }
  }

  async executeNext(): Promise<TeamTurnExecutionOutcome | undefined> {
    const next = teamTaskDao.listQueued(this.options.userId, 1)[0];
    return next ? this.execute(next.id) : undefined;
  }

  async execute(taskId: string): Promise<TeamTurnExecutionOutcome> {
    const durable = runtimeTaskDao.byId(this.options.userId, taskId);
    if (!durable || durable.kind !== "team_turn") {
      return { status: "skipped", taskId };
    }
    const durableOutcome = teamTurnOutcomeDao.byTask(this.options.userId, taskId);
    if (durableOutcome) {
      const settled = teamTaskDao.settleOutcome({
        userId: this.options.userId,
        taskId,
        resultId: this.makeId("result"),
        at: this.now(),
      });
      if (!settled) return { status: "skipped", taskId };
      this.notifyChanged(settled.task, settled.mail);
      return durableOutcome.status === "completed"
        ? { status: "succeeded", task: settled.task, mail: settled.mail }
        : {
            status: durableOutcome.status === "failed" ? "failed" : durableOutcome.status,
            task: settled.task,
            mail: settled.mail,
            error: durableOutcome.summary,
          };
    }
    if (durable.status !== "queued") return { status: "skipped", taskId };
    const gate = this.options.gateway.executionGate?.(this.options.userId);
    if (gate) return { status: "parked", taskId, reason: gate };

    const claimToken = this.makeId("claim");
    const claimed = teamTaskDao.claimWithMail({
      id: durable.id,
      userId: this.options.userId,
      expectedVersion: durable.version,
      claimToken,
      at: this.now(),
      leaseMs: this.mailLeaseMs,
    });
    if (!claimed) return { status: "skipped", taskId };
    this.notifyChanged(claimed.task, claimed.mail);
    let ownedTask = claimed.task;
    const claimedMail = claimed.mail;
    const abort = new AbortController();
    let leaseReject: ((error: Error) => void) | undefined;
    const leaseLost = new Promise<never>((_resolve, reject) => { leaseReject = reject; });
    const renewEvery = Math.max(100, Math.min(1_000, Math.floor(this.mailLeaseMs / 2)));
    const renewTimer = setInterval(() => {
      try {
        const renewed = teamTaskDao.renewAttempt({
          userId: this.options.userId,
          taskId: ownedTask.id,
          expectedTaskLeaseGeneration: ownedTask.leaseGeneration,
          mailId: claimedMail.id,
          claimToken,
          claimGeneration: claimedMail.claimGeneration,
          at: this.now(),
          leaseMs: this.mailLeaseMs,
        });
        if (renewed) return;
        throw new TeamLeaseLostError("Team Task execution lease was lost");
      } catch (cause) {
        const error = cause instanceof TeamLeaseLostError
          ? cause
          : new TeamLeaseLostError(`Team Task lease renewal failed: ${errorText(cause)}`);
        abort.abort(error);
        leaseReject?.(error);
      }
    }, renewEvery);
    renewTimer.unref?.();

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      const delay = Math.max(0, Math.min(2_147_483_647, claimedMail.deadlineAt - this.now()));
      deadlineTimer = setTimeout(() => {
        const error = new TeamDeadlineError("Team Turn deadline reached");
        abort.abort(error);
        reject(error);
      }, delay);
      deadlineTimer.unref?.();
    });
    let internalAccepted = false;
    let admittedTurnId: string | undefined;
    let admittedCompletion: Promise<TeamInternalTurnResult> | undefined;

    try {
      const payload = payloadRecord(ownedTask.payload);
      const budget = readBudget(payload.budget ?? null);
      const deadlineAt = Number(payload.deadlineAt);
      if (!Number.isSafeInteger(deadlineAt) || deadlineAt !== claimedMail.deadlineAt) {
        throw new Error("Team Task deadline does not match its mail envelope");
      }
      let completion: Promise<TeamInternalTurnResult>;
      {
        const runtime = this.options.gateway.activateSession(this.options.userId, ownedTask.sessionId);
        const turnId = this.makeId("turn");
        const admission = runtime.beginInternalTeamTurn({
          turnId,
          task: ownedTask,
          assignment: payload.assignment ?? null,
          sourceSessionId: String(payload.sourceSessionId ?? ownedTask.ownerSessionId),
          deadlineAt,
          budget,
          lease: {
            taskGeneration: ownedTask.leaseGeneration,
            mailId: claimedMail.id,
            claimToken,
            claimGeneration: claimedMail.claimGeneration,
          },
          signal: abort.signal,
        });
        if (!admission.accepted) {
          const released = teamTaskDao.releaseBusyAttempt({
            userId: this.options.userId,
            taskId: ownedTask.id,
            expectedTaskVersion: ownedTask.version,
            expectedLeaseGeneration: ownedTask.leaseGeneration,
            mailId: claimedMail.id,
            claimToken,
            claimGeneration: claimedMail.claimGeneration,
            at: this.now(),
            reason: admission.reason,
          });
          if (released) this.notifyChanged(released.task, released.mail);
          return { status: "parked", taskId, reason: released ? admission.reason : "lease_lost" };
        }
        internalAccepted = true;
        admittedTurnId = turnId;
        admittedCompletion = admission.completion;
        completion = admission.completion;
      }

      const running = teamTaskDao.markRunning({
        taskId: ownedTask.id,
        userId: this.options.userId,
        expectedTaskVersion: ownedTask.version,
        expectedLeaseGeneration: ownedTask.leaseGeneration,
        at: this.now(),
        eventPayload: { mailId: claimedMail.id },
      });
      if (!running) throw new TeamLeaseLostError("Team Task lease was lost before running");
      ownedTask = running;
      this.notifyChanged(running, claimedMail);

      completion.catch(() => {});
      const result = await Promise.race([completion, deadline, leaseLost]);
      if (
        !Number.isSafeInteger(result.completedAt)
        || !Number.isSafeInteger(result.usage.modelCycles)
        || !Number.isSafeInteger(result.usage.tokens)
        || result.usage.modelCycles < 0
        || result.usage.tokens < 0
      ) throw new Error("Team Turn returned invalid completion metadata");
      if (result.completedAt > deadlineAt) throw new TeamDeadlineError("Team Turn completed after its deadline");

      const authoritative = teamTurnOutcomeDao.byTask(this.options.userId, ownedTask.id);
      if (!authoritative) throw new Error("Team Session completed without its durable outcome outbox");
      const settled = teamTaskDao.settleOutcome({
        userId: this.options.userId,
        taskId: ownedTask.id,
        resultId: this.makeId("result"),
        at: this.now(),
      });
      if (!settled) throw new TeamLeaseLostError("Team Task lease was lost before atomic settlement");
      this.notifyChanged(settled.task, settled.mail);
      return authoritative.status === "completed"
        ? { status: "succeeded", task: settled.task, mail: settled.mail }
        : {
            status: authoritative.status === "failed" ? "failed" : authoritative.status,
            task: settled.task,
            mail: settled.mail,
            error: authoritative.summary,
          };
    } catch (error) {
      if (!abort.signal.aborted) abort.abort(error);
      if (error instanceof TeamDeadlineError || error instanceof TeamLeaseLostError) {
        const outcome = teamTurnOutcomeDao.byTask(this.options.userId, ownedTask.id);
        if (outcome && outcome.createdAt <= claimedMail.deadlineAt) {
          const settled = teamTaskDao.settleOutcome({
            userId: this.options.userId,
            taskId: ownedTask.id,
            resultId: this.makeId("result"),
            at: this.now(),
          });
          if (settled) {
            this.notifyChanged(settled.task, settled.mail);
            return outcome.status === "completed"
              ? { status: "succeeded", task: settled.task, mail: settled.mail }
              : {
                  status: outcome.status === "failed" ? "failed" : outcome.status,
                  task: settled.task,
                  mail: settled.mail,
                  error: outcome.summary,
                };
          }
        }
        if (internalAccepted && admittedTurnId) {
          this.options.gateway.retireSessionTurn?.(
            this.options.userId,
            ownedTask.sessionId,
            ownedTask.id,
            admittedTurnId,
            error.message,
          );
          const retiredOutcome = teamTurnOutcomeDao.byTask(this.options.userId, ownedTask.id);
          if (retiredOutcome) {
            const settled = teamTaskDao.settleOutcome({
              userId: this.options.userId,
              taskId: ownedTask.id,
              resultId: this.makeId("result"),
              at: this.now(),
            });
            if (settled) {
              this.notifyChanged(settled.task, settled.mail);
              return retiredOutcome.status === "completed"
                && retiredOutcome.createdAt <= claimedMail.deadlineAt
                ? { status: "succeeded", task: settled.task, mail: settled.mail }
                : {
                    status: retiredOutcome.status === "failed" ? "failed" : "interrupted",
                    task: settled.task,
                    mail: settled.mail,
                    error: retiredOutcome.summary,
                    ...(admittedCompletion
                      ? { attemptSettled: admittedCompletion.then(() => undefined, () => undefined) }
                      : {}),
                  };
            }
          }
        }
        const fenced = teamTaskDao.fenceAttempt({
          userId: this.options.userId,
          taskId: ownedTask.id,
          expectedTaskVersion: ownedTask.version,
          expectedLeaseGeneration: ownedTask.leaseGeneration,
          mailId: claimedMail.id,
          claimToken,
          claimGeneration: claimedMail.claimGeneration,
          resultId: this.makeId("result"),
          at: this.now(),
          reason: error instanceof TeamDeadlineError ? "deadline" : "lease_lost",
        });
        if (fenced) this.notifyChanged(fenced.task, fenced.mail);
        return {
          status: "interrupted",
          task: fenced?.task ?? (runtimeTaskDao.byId(this.options.userId, taskId) ?? ownedTask),
          mail: fenced?.mail ?? claimedMail,
          error: error.message,
          ...(admittedCompletion
            ? { attemptSettled: admittedCompletion.then(() => undefined, () => undefined) }
            : {}),
        };
      }
      const message = errorText(error);
      if (internalAccepted) {
        const outcome = teamTurnOutcomeDao.byTask(this.options.userId, ownedTask.id);
        if (outcome) {
          const settled = teamTaskDao.settleOutcome({
            userId: this.options.userId,
            taskId: ownedTask.id,
            resultId: this.makeId("result"),
            at: this.now(),
          });
          if (settled) {
            this.notifyChanged(settled.task, settled.mail);
            return outcome.status === "completed"
              ? { status: "succeeded", task: settled.task, mail: settled.mail }
              : {
                  status: outcome.status === "failed" ? "failed" : outcome.status,
                  task: settled.task,
                  mail: settled.mail,
                  error: outcome.summary,
                };
          }
        }
        const fenced = teamTaskDao.fenceAttempt({
          userId: this.options.userId,
          taskId: ownedTask.id,
          expectedTaskVersion: ownedTask.version,
          expectedLeaseGeneration: ownedTask.leaseGeneration,
          mailId: claimedMail.id,
          claimToken,
          claimGeneration: claimedMail.claimGeneration,
          resultId: this.makeId("result"),
          at: this.now(),
          reason: "runtime_lost",
        });
        if (fenced) this.notifyChanged(fenced.task, fenced.mail);
        return {
          status: "interrupted",
          task: fenced?.task ?? (runtimeTaskDao.byId(this.options.userId, taskId) ?? ownedTask),
          mail: fenced?.mail ?? claimedMail,
          error: message,
        };
      }
      const settled = teamTaskDao.settleWithResultAndMail({
        taskId: ownedTask.id,
        userId: this.options.userId,
        expectedTaskVersion: ownedTask.version,
        expectedLeaseGeneration: ownedTask.leaseGeneration,
        nextStatus: "failed",
        resultId: this.makeId("result"),
        summary: message.slice(0, 4_096),
        body: { error: message.slice(0, 16_384) },
        artifacts: [],
        mailId: claimedMail.id,
        claimToken,
        claimGeneration: claimedMail.claimGeneration,
        completedAt: Math.min(this.now(), claimedMail.deadlineAt),
        usage: { modelCycles: 0, tokens: 0 },
        at: this.now(),
        eventPayload: { error: message.slice(0, 512) },
      });
      if (settled) this.notifyChanged(settled.task, settled.mail);
      return {
        status: "failed",
        task: settled?.task ?? (runtimeTaskDao.byId(this.options.userId, taskId) ?? ownedTask),
        mail: settled?.mail ?? claimedMail,
        error: message,
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      clearInterval(renewTimer);
    }
  }
}
