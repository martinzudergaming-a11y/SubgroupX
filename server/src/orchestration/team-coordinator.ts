import { randomUUID } from "node:crypto";
import { TEAM_PROVIDER_MIN_OUTPUT_TOKENS } from "../../../shared/src/orchestration.ts";
import type {
  OrchestrationJson,
  TaskCancelPolicy,
  Team,
  TeamMail,
  TeamMailDigest,
  TeamMember,
  TeamMemberStatus,
  TeamSnapshot,
  TeamStatus,
  TeamWorkBudget,
} from "../../../shared/src/orchestration.ts";
import type { ActiveTeamRouteLease } from "../foundation/team-route-lease.ts";
import {
  agentNodeDao,
  teamDao,
  teamMailDao,
  type NewTeamMember,
  type TeamMailListOptions,
} from "../persistence/orchestration.ts";

export type TeamCoordinatorIdKind = "team" | "member" | "agent" | "session" | "mail" | "task" | "claim" | "reservation";

const ID_PREFIX: Readonly<Record<TeamCoordinatorIdKind, string>> = Object.freeze({
  team: "team",
  member: "mem",
  agent: "agt",
  session: "s_team",
  mail: "mail",
  task: "tsk",
  claim: "claim",
  reservation: "reservation",
});

export interface ProvisionTeamSessionInput {
  userId: string;
  actorSessionId: string;
  teamId: string;
  teamName: string;
  role: string;
  sessionId: string;
  reservationId: string;
  provisionGeneration: number;
  provisionClaimToken: string;
  provisionClaimExpiresAt: number;
  title?: string;
}

export interface ProvisionedTeamSession {
  sessionId: string;
}

export interface ReservedTeamSessionClaim {
  teamId: string;
  reservationId: string;
  sessionId: string;
  generation: number;
  claimToken: string;
}

export interface TeamCoordinatorOptions {
  userId: string;
  actorSessionId: string;
  now?: () => number;
  id?: (kind: TeamCoordinatorIdKind) => string;
  provisionSession?: (input: ProvisionTeamSessionInput) => Promise<ProvisionedTeamSession>;
  retireProvisionedSession?: (sessionId: string) => Promise<void>;
}

export interface NewTeamRole {
  role: string;
  title?: string;
}

export interface CreateTeamInput {
  name: string;
  ownerRole?: string;
  idempotencyKey: string;
  roles: readonly NewTeamRole[];
}

export interface AddTeamRoleInput extends NewTeamRole {
  idempotencyKey: string;
}

export interface ExistingTeamMemberRegistration {
  sessionId: string;
  role: string;
}

export interface CreateTeamFromSessionsInput {
  name: string;
  members: readonly ExistingTeamMemberRegistration[];
  leadSessionId: string;
}

export interface SendTeamMailInput {
  teamId: string;
  targetMemberId: string;
  kind: "note" | "result" | "ack";
  subject: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  taskId?: string;
  activeParentLease?: ActiveTeamRouteLease;
  deadlineAt?: number;
}

export interface AssignTeamWorkInput {
  teamId: string;
  targetMemberId: string;
  title: string;
  payload: OrchestrationJson;
  idempotencyKey: string;
  parentMailId?: string;
  parentTaskId?: string;
  activeParentLease?: ActiveTeamRouteLease;
  ownerTurnId?: string;
  ownerStepId?: string;
  awaitPolicy?: "background";
  cancelPolicy?: TaskCancelPolicy;
  checkpointSafe?: boolean;
  deadlineAt?: number;
  budget?: TeamWorkBudget;
}

const DEFAULT_MAIL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_WORK_BUDGET: Readonly<TeamWorkBudget> = Object.freeze({
  maxModelCycles: 8,
  maxTokens: 100_000,
});

function defaultNestedWorkBudget(remaining: TeamWorkBudget): TeamWorkBudget | undefined {
  const childModelCycles = remaining.maxModelCycles - 1;
  if (childModelCycles < 1) return undefined;
  const childTokens = Math.floor(remaining.maxTokens / 2);
  const continuationTokens = remaining.maxTokens - childTokens;
  if (continuationTokens <= TEAM_PROVIDER_MIN_OUTPUT_TOKENS) return undefined;
  if (childTokens <= TEAM_PROVIDER_MIN_OUTPUT_TOKENS) return undefined;
  return { maxModelCycles: childModelCycles, maxTokens: childTokens };
}

export class TeamProvisionInProgressError extends Error {
  constructor() {
    super("Team provision operation is already running");
    this.name = "TeamProvisionInProgressError";
  }
}

export class TeamCoordinator {
  private readonly now: () => number;
  private readonly makeId: (kind: TeamCoordinatorIdKind) => string;

  constructor(private readonly options: TeamCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((kind) => `${ID_PREFIX[kind]}_${randomUUID()}`);
  }

  async create(input: CreateTeamInput): Promise<TeamSnapshot> {
    if (!this.options.provisionSession || !this.options.retireProvisionedSession) {
      throw new Error("Team role creation requires provision and cleanup callbacks");
    }
    const root = this.ensureSessionRoot(this.options.actorSessionId);
    const roleInputs = input.roles.map((role, index) => ({
      reservationId: this.makeId("reservation"),
      operationKey: `create-role-${index}`,
      request: {
        role: role.role,
        ...(role.title ? { title: role.title } : {}),
      } as OrchestrationJson,
      role: role.role,
      provisionedSessionId: this.makeId("session"),
      provisionedAgentId: this.makeId("agent"),
      memberId: this.makeId("member"),
    }));
    const begun = teamDao.beginProvisioned({
      id: this.makeId("team"),
      userId: this.options.userId,
      ownerSessionId: this.options.actorSessionId,
      actorSessionId: this.options.actorSessionId,
      rootAgentId: root.id,
      ownerMember: {
        id: this.makeId("member"),
        sessionId: this.options.actorSessionId,
        agentId: root.id,
        role: input.ownerRole ?? "lead",
      },
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      request: {
        name: input.name,
        ownerRole: input.ownerRole ?? "lead",
        roles: input.roles.map((role) => ({
          role: role.role,
          ...(role.title ? { title: role.title } : {}),
        })),
      },
      roles: roleInputs,
      createdAt: this.now(),
    });
    if (begun.state === "ready") return begun.snapshot;
    if (begun.state === "failed") throw new Error("Team provision operation already failed");
    let pendingPeer = false;
    for (const reservation of begun.reservations) {
      if (reservation.status === "finalized") continue;
      if (reservation.status === "cancelled" || reservation.cleanupRequestedAt !== undefined) {
        throw new Error("Team provision operation is awaiting cleanup");
      }
      const claimed = teamDao.claimMemberProvision({
        reservationId: reservation.id,
        userId: this.options.userId,
        actorSessionId: this.options.actorSessionId,
        teamId: begun.snapshot.team.id,
        claimToken: this.makeId("claim"),
        at: this.now(),
      });
      if (claimed.state === "finalized") continue;
      if (claimed.state === "busy") {
        pendingPeer = true;
        continue;
      }
      if (claimed.state === "closed") throw new Error("Team provision operation is awaiting cleanup");
      if (claimed.state !== "claimed") continue;
      const { claim } = claimed;
      const request = claim.reservation.request;
      try {
        const created = await this.options.provisionSession({
          userId: this.options.userId,
          actorSessionId: this.options.actorSessionId,
          teamId: begun.snapshot.team.id,
          teamName: claim.teamName,
          role: claim.reservation.role,
          sessionId: claim.reservation.provisionedSessionId,
          reservationId: claim.reservation.id,
          provisionGeneration: claim.generation,
          provisionClaimToken: claim.claimToken,
          provisionClaimExpiresAt: claim.claimExpiresAt,
          ...(typeof request === "object" && request !== null && !Array.isArray(request)
            && typeof request.title === "string" ? { title: request.title } : {}),
        });
        if (created.sessionId !== claim.reservation.provisionedSessionId) {
          throw new Error("Team provisioner did not honor its reserved Session id");
        }
        const agent = this.ensureSessionRoot(created.sessionId, claim.reservation.provisionedAgentId);
        teamDao.finalizeReservedMember({
          reservationId: claim.reservation.id,
          userId: this.options.userId,
          actorSessionId: this.options.actorSessionId,
          teamId: begun.snapshot.team.id,
          generation: claim.generation,
          claimToken: claim.claimToken,
          member: {
            id: claim.reservation.memberId,
            sessionId: created.sessionId,
            agentId: agent.id,
            role: claim.reservation.role,
          },
          at: this.now(),
        });
      } catch (error) {
        let failed: ReturnType<typeof teamDao.failMemberProvisionClaim>;
        try {
          failed = teamDao.failMemberProvisionClaim({
            reservationId: claim.reservation.id,
            userId: this.options.userId,
            actorSessionId: this.options.actorSessionId,
            teamId: begun.snapshot.team.id,
            generation: claim.generation,
            claimToken: claim.claimToken,
            at: this.now(),
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Team creation failed before cleanup could be requested",
          );
        }
        if (!failed.owned) {
          pendingPeer = true;
          continue;
        }
        try {
          await this.retireReservations(failed.retire);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Team creation failed and cleanup remains pending");
        }
        throw error;
      }
    }
    try {
      return teamDao.activateProvisioned({
        userId: this.options.userId,
        actorSessionId: this.options.actorSessionId,
        teamId: begun.snapshot.team.id,
        at: this.now(),
      });
    } catch (error) {
      if (pendingPeer && error instanceof Error && /not fully provisioned/i.test(error.message)) {
        throw new TeamProvisionInProgressError();
      }
      throw error;
    }
  }

  createFromSessions(input: CreateTeamFromSessionsInput): TeamSnapshot {
    const root = this.ensureSessionRoot(this.options.actorSessionId);
    const members = input.members.map((member) => ({
      id: this.makeId("member"),
      sessionId: member.sessionId,
      agentId: this.ensureSessionRoot(member.sessionId).id,
      role: member.role,
    }));
    const lead = members.find((member) => member.sessionId === input.leadSessionId);
    if (!lead) throw new Error("Team lead Session must be registered as a member");
    return teamDao.create({
      id: this.makeId("team"),
      userId: this.options.userId,
      ownerSessionId: this.options.actorSessionId,
      actorSessionId: this.options.actorSessionId,
      rootAgentId: root.id,
      name: input.name,
      members,
      leadMemberId: lead.id,
      createdAt: this.now(),
    });
  }

  async addRole(teamId: string, role: AddTeamRoleInput): Promise<TeamMember> {
    if (!this.options.provisionSession || !this.options.retireProvisionedSession) {
      throw new Error("Team role creation requires provision and cleanup callbacks");
    }
    const reservationId = this.makeId("reservation");
    const provisionedSessionId = this.makeId("session");
    const provisionedAgentId = this.makeId("agent");
    const memberId = this.makeId("member");
    const reserved = teamDao.reserveMember({
      id: reservationId,
      operationKey: role.idempotencyKey,
      request: {
        role: role.role,
        ...(role.title ? { title: role.title } : {}),
      },
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId,
      role: role.role,
      provisionedSessionId,
      provisionedAgentId,
      memberId,
      at: this.now(),
    });
    if (reserved.reservation.cleanupRequestedAt !== undefined) {
      try {
        await this.retireReservations([{
          reservationId: reserved.reservation.id,
          userId: reserved.reservation.userId,
          sessionId: reserved.reservation.provisionedSessionId,
        }]);
      } catch (cleanupError) {
        throw new AggregateError(
          [cleanupError],
          "Team role provision operation failed and cleanup remains pending",
        );
      }
      throw new Error("Team role provision operation failed; cleanup completed");
    }
    if (reserved.reservation.status === "finalized") {
      const member = this.snapshot(teamId)?.members.find(
        (entry) => entry.id === reserved.reservation.memberId,
      );
      if (!member) throw new Error("Finalized Team role lost its member");
      return member;
    }
    const claimed = teamDao.claimMemberProvision({
      reservationId: reserved.reservation.id,
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId,
      claimToken: this.makeId("claim"),
      at: this.now(),
    });
    if (claimed.state === "finalized") {
      const member = this.snapshot(teamId)?.members.find(
        (entry) => entry.id === claimed.reservation.memberId,
      );
      if (!member) throw new Error("Finalized Team role lost its member");
      return member;
    }
    if (claimed.state === "busy") throw new TeamProvisionInProgressError();
    if (claimed.state === "closed") throw new Error("Team role provision operation is closed");
    if (claimed.state !== "claimed") throw new Error("Finalized Team role lost its member");
    const { claim } = claimed;
    try {
      const request = claim.reservation.request;
      const created = await this.options.provisionSession({
        userId: this.options.userId,
        actorSessionId: this.options.actorSessionId,
        teamId,
        teamName: claim.teamName,
        role: claim.reservation.role,
        sessionId: claim.reservation.provisionedSessionId,
        reservationId: claim.reservation.id,
        provisionGeneration: claim.generation,
        provisionClaimToken: claim.claimToken,
        provisionClaimExpiresAt: claim.claimExpiresAt,
        ...(typeof request === "object" && request !== null && !Array.isArray(request)
          && typeof request.title === "string" ? { title: request.title } : {}),
      });
      if (created.sessionId !== claim.reservation.provisionedSessionId) {
        throw new Error("Team provisioner did not honor its reserved Session id");
      }
      const member: NewTeamMember = {
        id: claim.reservation.memberId,
        sessionId: created.sessionId,
        agentId: this.ensureSessionRoot(created.sessionId, claim.reservation.provisionedAgentId).id,
        role: claim.reservation.role,
      };
      return teamDao.finalizeReservedMember({
        reservationId: claim.reservation.id,
        userId: this.options.userId,
        actorSessionId: this.options.actorSessionId,
        teamId,
        generation: claim.generation,
        claimToken: claim.claimToken,
        member,
        at: this.now(),
      });
    } catch (error) {
      let failed: ReturnType<typeof teamDao.failMemberProvisionClaim>;
      try {
        failed = teamDao.failMemberProvisionClaim({
          reservationId: claim.reservation.id,
          userId: this.options.userId,
          actorSessionId: this.options.actorSessionId,
          teamId,
          generation: claim.generation,
          claimToken: claim.claimToken,
          at: this.now(),
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Team role creation failed before cleanup could be requested",
        );
      }
      if (!failed.owned) throw new TeamProvisionInProgressError();
      if (failed.retire.length > 0) {
        try {
          await this.retireReservations(failed.retire);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Team role creation failed and cleanup remains pending");
        }
      }
      throw error;
    }
  }

  joinSession(teamId: string, registration: ExistingTeamMemberRegistration): TeamMember {
    const member: NewTeamMember = {
      id: this.makeId("member"),
      sessionId: registration.sessionId,
      agentId: this.ensureSessionRoot(registration.sessionId).id,
      role: registration.role,
    };
    return teamDao.addMember({
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId,
      member,
      at: this.now(),
    });
  }

  snapshot(teamId: string): TeamSnapshot | undefined {
    return teamDao.snapshot(this.options.userId, teamId);
  }

  listTeams(options?: { beforeUpdatedAt?: number; beforeId?: string; limit?: number }): Team[] {
    return teamDao.listForUser(this.options.userId, options);
  }

  listTeamLedger(teamId: string, options?: TeamMailListOptions): TeamMailDigest[] {
    return teamMailDao.listTeamDigests(this.options.userId, teamId, options);
  }

  send(input: SendTeamMailInput): { mail: TeamMail; created: boolean } {
    const existing = teamMailDao.byIdempotency(
      this.options.userId,
      input.teamId,
      this.options.actorSessionId,
      input.idempotencyKey,
    );
    const now = existing?.createdAt ?? this.now();
    const parent = input.parentMailId
      ? teamMailDao.byId(this.options.userId, input.parentMailId)
      : undefined;
    return teamMailDao.send({
      id: this.makeId("mail"),
      userId: this.options.userId,
      teamId: input.teamId,
      sourceSessionId: this.options.actorSessionId,
      targetMemberId: input.targetMemberId,
      kind: input.kind,
      subject: input.subject,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      ...(input.parentMailId ? { parentMailId: input.parentMailId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.activeParentLease ? { activeParentLease: input.activeParentLease } : {}),
      deadlineAt: input.deadlineAt ?? existing?.deadlineAt ?? parent?.deadlineAt ?? now + DEFAULT_MAIL_TTL_MS,
      createdAt: now,
    });
  }

  assignWork(input: AssignTeamWorkInput) {
    const existing = teamMailDao.byIdempotency(
      this.options.userId,
      input.teamId,
      this.options.actorSessionId,
      input.idempotencyKey,
    );
    const now = existing?.createdAt ?? this.now();
    const parent = input.parentMailId
      ? teamMailDao.byId(this.options.userId, input.parentMailId)
      : undefined;
    const inheritedBudget = input.parentMailId
      ? teamMailDao.remainingWorkBudget(this.options.userId, input.parentMailId)
      : undefined;
    if (!existing && input.parentMailId && (!parent || !inheritedBudget)) {
      throw new Error("Nested Team work requires an open parent work route");
    }
    const defaultChildBudget = !existing && inheritedBudget
      ? defaultNestedWorkBudget(inheritedBudget)
      : undefined;
    if (!existing && inheritedBudget && !defaultChildBudget) {
      throw new Error("Parent Team work budget cannot preserve a post-handoff model cycle");
    }
    if (
      !existing
      && input.budget
      && defaultChildBudget
      && (
        input.budget.maxModelCycles > defaultChildBudget.maxModelCycles
        || input.budget.maxTokens > defaultChildBudget.maxTokens
      )
    ) {
      throw new Error("Nested Team work budget must preserve the parent post-handoff model cycle");
    }
    return teamDao.assignWork({
      mailId: this.makeId("mail"),
      taskId: this.makeId("task"),
      userId: this.options.userId,
      teamId: input.teamId,
      sourceSessionId: this.options.actorSessionId,
      targetMemberId: input.targetMemberId,
      title: input.title,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      ...(input.parentMailId ? { parentMailId: input.parentMailId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.activeParentLease ? { activeParentLease: input.activeParentLease } : {}),
      ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
      ...(input.ownerStepId ? { ownerStepId: input.ownerStepId } : {}),
      awaitPolicy: input.awaitPolicy ?? "background",
      cancelPolicy: input.cancelPolicy ?? "detached",
      checkpointSafe: input.checkpointSafe ?? false,
      deadlineAt: input.deadlineAt ?? existing?.deadlineAt ?? parent?.deadlineAt ?? now + DEFAULT_MAIL_TTL_MS,
      budget: input.budget ?? existing?.budget ?? defaultChildBudget ?? DEFAULT_WORK_BUDGET,
      createdAt: now,
    });
  }

  handoff(input: AssignTeamWorkInput & { parentMailId: string }): ReturnType<TeamCoordinator["assignWork"]> {
    return this.assignWork(input);
  }

  listInbox(options?: TeamMailListOptions): TeamMailDigest[] {
    return teamMailDao.listInboxDigests(this.options.userId, this.options.actorSessionId, options);
  }

  listOutbox(options?: TeamMailListOptions): TeamMailDigest[] {
    return teamMailDao.listOutboxDigests(this.options.userId, this.options.actorSessionId, options);
  }

  readMail(mailId: string): TeamMail | undefined {
    const mail = teamMailDao.byId(this.options.userId, mailId);
    if (!mail) return undefined;
    if (mail.sourceSessionId !== this.options.actorSessionId && mail.targetSessionId !== this.options.actorSessionId) {
      throw new Error("Team mail is not addressed to this Session");
    }
    return mail;
  }

  claimInbox(attemptToken = this.makeId("claim"), leaseMs?: number): TeamMail | undefined {
    return teamMailDao.claimNext({
      userId: this.options.userId,
      targetSessionId: this.options.actorSessionId,
      claimToken: attemptToken,
      at: this.now(),
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
  }

  renewClaim(mail: Pick<TeamMail, "id" | "claimToken" | "claimGeneration">, leaseMs?: number): TeamMail | null {
    if (!mail.claimToken) throw new Error("Claimed Team mail requires its claim token");
    return teamMailDao.renewClaim({
      userId: this.options.userId,
      targetSessionId: this.options.actorSessionId,
      mailId: mail.id,
      claimToken: mail.claimToken,
      claimGeneration: mail.claimGeneration,
      at: this.now(),
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
  }

  acknowledge(mail: Pick<TeamMail, "id" | "claimToken" | "claimGeneration">): TeamMail | null {
    if (!mail.claimToken) throw new Error("Claimed Team mail requires its claim token");
    return teamMailDao.acknowledge({
      userId: this.options.userId,
      targetSessionId: this.options.actorSessionId,
      mailId: mail.id,
      claimToken: mail.claimToken,
      claimGeneration: mail.claimGeneration,
      at: this.now(),
    });
  }

  transitionMember(
    teamId: string,
    member: Pick<TeamMember, "id" | "version">,
    nextStatus: TeamMemberStatus,
  ): TeamMember | null {
    return teamDao.transitionMember({
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId,
      memberId: member.id,
      expectedVersion: member.version,
      nextStatus,
      at: this.now(),
    });
  }

  updateMemberRole(
    teamId: string,
    member: Pick<TeamMember, "id" | "version">,
    role: string,
  ): TeamMember | null {
    return teamDao.updateMemberRole({
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId,
      memberId: member.id,
      expectedVersion: member.version,
      role,
      at: this.now(),
    });
  }

  setLead(team: Pick<Team, "id" | "version">, memberId: string): Team | null {
    return teamDao.setLead({
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId: team.id,
      memberId,
      expectedTeamVersion: team.version,
      at: this.now(),
    });
  }

  transitionTeam(team: Pick<Team, "id" | "version">, nextStatus: TeamStatus): Team | null {
    return teamDao.transitionStatus({
      userId: this.options.userId,
      actorSessionId: this.options.actorSessionId,
      teamId: team.id,
      expectedVersion: team.version,
      nextStatus,
      at: this.now(),
    });
  }

  private ensureSessionRoot(sessionId: string, desiredId?: string) {
    const existing = agentNodeDao.rootBySession(this.options.userId, sessionId);
    if (existing) {
      if (existing.status === "closed") throw new Error("Team member Session root is closed");
      return existing;
    }
    const id = desiredId ?? this.makeId("agent");
    return agentNodeDao.create({
      id,
      userId: this.options.userId,
      sessionId,
      rootAgentId: id,
      path: "/root",
      label: "Team member session",
      kind: "session",
      purpose: "addressable",
      status: "idle",
      createdAt: this.now(),
    });
  }

  private async retireReservations(
    reservations: readonly { reservationId: string; userId: string; sessionId: string }[],
  ): Promise<void> {
    if (!this.options.retireProvisionedSession) {
      throw new Error("Team cleanup callback is unavailable");
    }
    const failures: unknown[] = [];
    for (const reservation of reservations) {
      try {
        await this.options.retireProvisionedSession(reservation.sessionId);
        teamDao.completeMemberReservationCleanup({
          ...reservation,
          at: this.now(),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Provisioned Team Session cleanup failed");
  }
}
