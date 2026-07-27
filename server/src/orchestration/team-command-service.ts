import type {
  OrchestrationJson,
  RuntimeTask,
  Team,
  TeamMail,
  TeamMailDeliveryStatus,
  TeamMailDigest,
  TeamMember,
  TeamSnapshot,
} from "../../../shared/src/orchestration.ts";
import type { ActiveTeamRouteLease } from "../foundation/team-route-lease.ts";
import type { TeamMailListOptions as PersistenceTeamMailListOptions } from "../persistence/orchestration.ts";
import {
  TeamCoordinator,
  type AssignTeamWorkInput,
  type CreateTeamInput,
  type ReservedTeamSessionClaim,
  type SendTeamMailInput,
  type TeamCoordinatorIdKind,
} from "./team-coordinator.ts";

type JsonObject = { [key: string]: OrchestrationJson };

export interface TeamCommandServiceOptions {
  userId: string;
  actorSessionId: string;
  provisionSession(
    userId: string,
    actorSessionId: string,
    title: string,
    claim: ReservedTeamSessionClaim,
  ): { id: string } | Promise<{ id: string }>;
  retireSession(userId: string, sessionId: string): void | Promise<void>;
  onRunnable?: (userId: string) => void;
  onTeamChanged?: (userId: string, teamId: string, version: number) => void;
  onSessionsPublished?: (userId: string, sessionIds: readonly string[]) => void;
  now?: () => number;
  id?: (kind: TeamCoordinatorIdKind) => string;
}

export interface TeamListCommand {
  beforeUpdatedAt?: number;
  beforeId?: string;
  limit?: number;
}

export type ActiveTeamParent = ActiveTeamRouteLease;

export type TeamAssignCommand = Omit<
  AssignTeamWorkInput,
  "parentMailId" | "parentTaskId" | "activeParentLease"
>;

export interface TeamCommandCursor {
  at: number;
  id: string;
}

export interface TeamCommandListOptions {
  limit?: number;
  before?: TeamCommandCursor;
  status?: TeamMailDeliveryStatus;
}

export type TeamMailCommand =
  | ({ action: "list"; teamId?: string } & TeamCommandListOptions)
  | ({ action: "inbox" } & TeamCommandListOptions)
  | ({ action: "outbox" } & TeamCommandListOptions)
  | { action: "read"; mailId: string }
  | ({ action: "send" } & Omit<
      SendTeamMailInput,
      "parentMailId" | "taskId" | "activeParentLease"
    >);

type TeamMailSendCommand = Extract<TeamMailCommand, { action: "send" }>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function mailOptions(input: TeamCommandListOptions): PersistenceTeamMailListOptions {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.before === undefined ? {} : {
      before: { createdAt: input.before.at, id: input.before.id },
    }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}

function teamProjection(team: Team): JsonObject {
  return {
    id: team.id,
    ownerSessionId: team.ownerSessionId,
    rootAgentId: team.rootAgentId,
    ownerAvailable: team.ownerAvailable,
    ...(team.leadAgentId ? { leadAgentId: team.leadAgentId } : {}),
    name: team.name,
    status: team.status,
    version: team.version,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function memberProjection(member: TeamMember): JsonObject {
  return {
    id: member.id,
    teamId: member.teamId,
    sessionId: member.sessionId,
    agentId: member.agentId,
    role: member.role,
    status: member.status,
    version: member.version,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function snapshotProjection(snapshot: TeamSnapshot): JsonObject {
  return {
    team: teamProjection(snapshot.team),
    members: snapshot.members.map(memberProjection),
    queuedMail: snapshot.queuedMail,
    claimedMail: snapshot.claimedMail,
    openWork: snapshot.openWork,
  };
}

function mailProjection(mail: TeamMail | TeamMailDigest, includePayload: boolean): JsonObject {
  return {
    id: mail.id,
    teamId: mail.teamId,
    seq: mail.seq,
    sourceMemberId: mail.sourceMemberId,
    sourceSessionId: mail.sourceSessionId,
    targetMemberId: mail.targetMemberId,
    targetSessionId: mail.targetSessionId,
    kind: mail.kind,
    subject: mail.subject,
    ...(includePayload && "payload" in mail ? { payload: mail.payload } : {}),
    ...("payloadBytes" in mail ? { payloadBytes: mail.payloadBytes } : {}),
    ...(mail.parentMailId ? { parentMailId: mail.parentMailId } : {}),
    ...(mail.taskId ? { taskId: mail.taskId } : {}),
    hop: mail.hop,
    deadlineAt: mail.deadlineAt,
    ...(mail.budget ? { budget: { ...mail.budget } } : {}),
    ...(mail.childBudgetReserved ? { childBudgetReserved: { ...mail.childBudgetReserved } } : {}),
    status: mail.status,
    claimGeneration: mail.claimGeneration,
    version: mail.version,
    createdAt: mail.createdAt,
    updatedAt: mail.updatedAt,
    ...(mail.claimedAt ? { claimedAt: mail.claimedAt } : {}),
    ...(mail.claimExpiresAt ? { claimExpiresAt: mail.claimExpiresAt } : {}),
    ...(mail.acknowledgedAt ? { acknowledgedAt: mail.acknowledgedAt } : {}),
  };
}

function taskProjection(task: RuntimeTask): JsonObject {
  return {
    id: task.id,
    sessionId: task.sessionId,
    ownerSessionId: task.ownerSessionId,
    agentId: task.agentId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.teamId ? { teamId: task.teamId } : {}),
    title: task.title,
    status: task.status,
    awaitPolicy: task.awaitPolicy,
    cancelPolicy: task.cancelPolicy,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function mailListProjection(mails: readonly TeamMailDigest[]): JsonObject {
  const last = mails.at(-1);
  return {
    mails: mails.map((mail) => mailProjection(mail, false)),
    cursor: last ? { at: last.createdAt, id: last.id } : null,
  };
}

export class TeamCommandService {
  private readonly coordinator: TeamCoordinator;

  constructor(private readonly options: TeamCommandServiceOptions) {
    this.coordinator = new TeamCoordinator({
      userId: options.userId,
      actorSessionId: options.actorSessionId,
      provisionSession: async (input) => {
        const session = await options.provisionSession(
          input.userId,
          input.actorSessionId,
          input.title ?? `${input.teamName} · ${input.role}`,
          {
            teamId: input.teamId,
            reservationId: input.reservationId,
            sessionId: input.sessionId,
            generation: input.provisionGeneration,
            claimToken: input.provisionClaimToken,
          },
        );
        return { sessionId: session.id };
      },
      retireProvisionedSession: async (sessionId) => {
        await options.retireSession(options.userId, sessionId);
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.id ? { id: options.id } : {}),
    });
  }

  async create(input: CreateTeamInput, signal?: AbortSignal): Promise<OrchestrationJson> {
    throwIfAborted(signal);
    const snapshot = await this.coordinator.create(input);
    this.notifyTeam(snapshot.team.id, snapshot.team.version);
    this.notifySessions(
      snapshot.members
        .filter((member) => member.sessionId !== this.options.actorSessionId)
        .map((member) => member.sessionId),
    );
    return snapshotProjection(snapshot);
  }

  list(input: TeamListCommand = {}, signal?: AbortSignal): OrchestrationJson {
    throwIfAborted(signal);
    const teams = this.coordinator.listTeams(input);
    const last = teams.at(-1);
    return {
      teams: teams.map(teamProjection),
      cursor: last ? { at: last.updatedAt, id: last.id } : null,
    };
  }

  assign(
    input: TeamAssignCommand,
    activeParent?: ActiveTeamParent,
    signal?: AbortSignal,
  ): OrchestrationJson {
    throwIfAborted(signal);
    const {
      parentMailId: _untrustedParentMailId,
      parentTaskId: _untrustedParentTaskId,
      activeParentLease: _untrustedActiveParentLease,
      ...actorInput
    } = input as AssignTeamWorkInput;
    const assigned = this.coordinator.assignWork({
      ...actorInput,
      ...(activeParent
        ? {
            parentMailId: activeParent.mailId,
            parentTaskId: activeParent.taskId,
            activeParentLease: activeParent,
          }
        : {}),
    });
    this.notifyCurrentTeam(input.teamId);
    this.hintRunnable();
    return {
      created: assigned.created,
      task: taskProjection(assigned.task),
      mail: mailProjection(assigned.mail, false),
    };
  }

  mail(
    input: TeamMailCommand,
    activeParent?: ActiveTeamParent,
    signal?: AbortSignal,
  ): OrchestrationJson {
    throwIfAborted(signal);
    switch (input.action) {
      case "list": {
        if (!input.teamId) {
          return this.list({
            ...(input.before ? {
              beforeUpdatedAt: input.before.at,
              beforeId: input.before.id,
            } : {}),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }, signal);
        }
        const snapshot = this.coordinator.snapshot(input.teamId);
        if (!snapshot) throw new Error("Owned Team was not found");
        return {
          snapshot: snapshotProjection(snapshot),
          ...mailListProjection(this.coordinator.listTeamLedger(input.teamId, mailOptions(input))),
        };
      }
      case "inbox":
        return mailListProjection(this.coordinator.listInbox(mailOptions(input)));
      case "outbox":
        return mailListProjection(this.coordinator.listOutbox(mailOptions(input)));
      case "read": {
        const mail = this.coordinator.readMail(input.mailId);
        return { mail: mail ? mailProjection(mail, true) : null };
      }
      case "send": {
        const {
          action: _action,
          parentMailId: _untrustedParentMailId,
          taskId: _untrustedTaskId,
          parent: _untrustedParent,
          activeParentLease: _untrustedActiveParentLease,
          ...message
        } = input as TeamMailSendCommand & {
          parentMailId?: string;
          taskId?: string;
          parent?: ActiveTeamParent;
          activeParentLease?: ActiveTeamParent;
        };
        const sent = this.coordinator.send({
          ...message,
          ...(activeParent
            ? {
                parentMailId: activeParent.mailId,
                taskId: activeParent.taskId,
                activeParentLease: activeParent,
              }
            : {}),
        });
        this.notifyCurrentTeam(input.teamId);
        return {
          created: sent.created,
          mail: mailProjection(sent.mail, false),
        };
      }
    }
  }

  private hintRunnable(): void {
    try {
      this.options.onRunnable?.(this.options.userId);
    } catch {
    }
  }

  private notifyCurrentTeam(teamId: string): void {
    try {
      const snapshot = this.coordinator.snapshot(teamId);
      if (snapshot) this.notifyTeam(teamId, snapshot.team.version);
    } catch {
    }
  }

  private notifyTeam(teamId: string, version: number): void {
    try {
      this.options.onTeamChanged?.(this.options.userId, teamId, version);
    } catch {
    }
  }

  private notifySessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    try {
      this.options.onSessionsPublished?.(this.options.userId, sessionIds);
    } catch {
    }
  }
}
