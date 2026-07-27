import { createHash } from "node:crypto";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  OrchestrationJson,
  TeamMailDeliveryStatus,
  TeamWorkBudget,
} from "../../../shared/src/orchestration.ts";
import type { ActiveTeamRouteLease } from "../foundation/team-route-lease.ts";

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "team_create",
  "team_assign",
  "team_mail",
]);

export type TeamToolParent = ActiveTeamRouteLease;

export interface TeamToolRole {
  role: string;
  title?: string;
}

export interface TeamCreateCommand {
  name: string;
  ownerRole?: string;
  roles: readonly TeamToolRole[];
  idempotencyKey: string;
}

export interface TeamAssignCommand {
  teamId: string;
  targetMemberId: string;
  title: string;
  payload: OrchestrationJson;
  budget?: TeamWorkBudget;
  ownerTurnId?: string;
  ownerStepId: string;
  idempotencyKey: string;
}

export interface TeamToolCursor {
  at: number;
  id: string;
}

export interface TeamMailListOptions {
  limit?: number;
  before?: TeamToolCursor;
  status?: TeamMailDeliveryStatus;
}

export type TeamMailCommand =
  | (TeamMailListOptions & { action: "list"; teamId?: string })
  | (TeamMailListOptions & { action: "inbox" })
  | (TeamMailListOptions & { action: "outbox" })
  | { action: "read"; mailId: string }
  | {
      action: "send";
      teamId: string;
      targetMemberId: string;
      kind: "note" | "result" | "ack";
      subject: string;
      payload: OrchestrationJson;
      idempotencyKey: string;
    };

type MaybePromise<T> = T | Promise<T>;

export interface TeamToolCommands {
  create(input: TeamCreateCommand, signal?: AbortSignal): MaybePromise<unknown>;
  assign(input: TeamAssignCommand, parent?: TeamToolParent, signal?: AbortSignal): MaybePromise<unknown>;
  mail(input: TeamMailCommand, parent?: TeamToolParent, signal?: AbortSignal): MaybePromise<unknown>;
}

export interface TeamToolOptions {
  commands: TeamToolCommands;
  activeParent(): TeamToolParent | undefined;
  ownerTurnId(): string | undefined;
}

const MAX_ROLES = 15;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 4;
const MAX_JSON_ENTRIES = 32;
const MAX_JSON_KEY_LENGTH = 128;
const MAX_JSON_STRING_LENGTH = 16 * 1024;

const boundedText = (maxLength: number, minLength = 1) => Type.String({ minLength, maxLength });
const idSchema = boundedText(128);

const jsonScalarSchema = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  Type.String({ maxLength: MAX_JSON_STRING_LENGTH }),
]);

function makeJsonSchema(): TSchema {
  let value: TSchema = jsonScalarSchema;
  const key = Type.String({ pattern: `^[\\s\\S]{1,${MAX_JSON_KEY_LENGTH}}$` });
  for (let depth = 0; depth < MAX_JSON_DEPTH; depth += 1) {
    value = Type.Union([
      jsonScalarSchema,
      Type.Array(value, { maxItems: MAX_JSON_ENTRIES }),
      Type.Record(key, value, { maxProperties: MAX_JSON_ENTRIES }),
    ]);
  }
  return value;
}

const payloadSchema = makeJsonSchema();

const roleSchema = Type.Object({
  role: boundedText(64),
  title: Type.Optional(boundedText(256)),
}, { additionalProperties: false });

const budgetSchema = Type.Object({
  maxModelCycles: Type.Integer({ minimum: 1, maximum: 64 }),
  maxTokens: Type.Integer({ minimum: 1, maximum: 4_000_000 }),
}, { additionalProperties: false });

const cursorSchema = Type.Object({
  at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  id: idSchema,
}, { additionalProperties: false });

const mailStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("claimed"),
  Type.Literal("acknowledged"),
  Type.Literal("cancelled"),
]);

const mailActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("inbox"),
    Type.Literal("outbox"),
    Type.Literal("read"),
    Type.Literal("send"),
  ]),
  teamId: Type.Optional(idSchema),
  targetMemberId: Type.Optional(idSchema),
  mailId: Type.Optional(idSchema),
  kind: Type.Optional(Type.Union([
    Type.Literal("note"),
    Type.Literal("result"),
    Type.Literal("ack"),
  ])),
  subject: Type.Optional(boundedText(512)),
  payload: Type.Optional(payloadSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  before: Type.Optional(cursorSchema),
  status: Type.Optional(mailStatusSchema),
}, { additionalProperties: false });

function operationKey(kind: "create" | "assign" | "mail", toolCallId: string): string {
  return `team-${kind}:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertPayload(value: unknown): asserts value is OrchestrationJson {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || Math.abs(current.value) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Team payload contains an out-of-range number");
      }
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_JSON_STRING_LENGTH) {
        throw new RangeError("Team payload contains an oversized string");
      }
      continue;
    }
    if (typeof current.value !== "object") throw new TypeError("Team payload must contain JSON values only");
    if (visited.has(current.value)) throw new TypeError("Team payload must not contain a cycle");
    visited.add(current.value);
    if (current.depth >= MAX_JSON_DEPTH) throw new RangeError("Team payload nesting is too deep");
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_ENTRIES) throw new RangeError("Team payload array is too large");
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(current.value);
    if (entries.length > MAX_JSON_ENTRIES) throw new RangeError("Team payload object is too large");
    for (const [key, entry] of entries) {
      if (key.length < 1 || key.length > MAX_JSON_KEY_LENGTH) {
        throw new RangeError("Team payload key length is out of range");
      }
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || utf8Bytes(encoded) > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Team payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
}

function boundedResult(value: unknown): AgentToolResult<OrchestrationJson> {
  let encoded: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new TypeError("Command result is not JSON");
    encoded = candidate;
  } catch (error) {
    throw new TypeError("Team command returned a non-JSON result", { cause: error });
  }
  if (utf8Bytes(encoded) <= MAX_RESULT_BYTES) {
    const details = JSON.parse(encoded) as OrchestrationJson;
    return { content: [{ type: "text", text: encoded }], details };
  }
  let preview = encoded.slice(0, Math.floor(MAX_RESULT_BYTES / 4));
  let details: OrchestrationJson = {
    truncated: true,
    originalBytes: utf8Bytes(encoded),
    preview,
  };
  let text = JSON.stringify(details);
  while (utf8Bytes(text) > MAX_RESULT_BYTES && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
    details = { truncated: true, originalBytes: utf8Bytes(encoded), preview };
    text = JSON.stringify(details);
  }
  return { content: [{ type: "text", text }], details };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} is required`);
  return value;
}

export function createTeamTools(options: TeamToolOptions): AgentTool<any>[] {
  const create: AgentTool<any> = {
    name: "team_create",
    label: "Create team",
    description: "Create a Team with one real Session for each bounded role.",
    executionMode: "sequential",
    parameters: Type.Object({
      name: boundedText(256),
      ownerRole: Type.Optional(boundedText(64)),
      roles: Type.Array(roleSchema, { minItems: 1, maxItems: MAX_ROLES }),
    }, { additionalProperties: false }),
    async execute(id, rawParams: unknown, signal) {
      throwIfAborted(signal);
      if (options.activeParent()) throw new Error("A Team work Turn cannot create another Team");
      const params = rawParams as { name: string; ownerRole?: string; roles: TeamToolRole[] };
      const result = await options.commands.create({
        name: params.name,
        ...(params.ownerRole ? { ownerRole: params.ownerRole } : {}),
        roles: params.roles,
        idempotencyKey: operationKey("create", id),
      }, signal);
      return boundedResult(result);
    },
  };

  const assign: AgentTool<any> = {
    name: "team_assign",
    label: "Assign team work",
    description: "Assign bounded background work to one Team member Session.",
    executionMode: "sequential",
    parameters: Type.Object({
      teamId: idSchema,
      targetMemberId: idSchema,
      title: boundedText(512),
      payload: payloadSchema,
      budget: Type.Optional(budgetSchema),
    }, { additionalProperties: false }),
    async execute(id, rawParams: unknown, signal) {
      throwIfAborted(signal);
      const params = rawParams as {
        teamId: string;
        targetMemberId: string;
        title: string;
        payload: unknown;
        budget?: TeamWorkBudget;
      };
      assertPayload(params.payload);
      const parent = options.activeParent();
      const ownerTurnId = options.ownerTurnId();
      const result = await options.commands.assign({
        teamId: params.teamId,
        targetMemberId: params.targetMemberId,
        title: params.title,
        payload: params.payload,
        ...(params.budget ? { budget: params.budget } : {}),
        ...(ownerTurnId ? { ownerTurnId } : {}),
        ownerStepId: id,
        idempotencyKey: operationKey("assign", id),
      }, parent, signal);
      return boundedResult(result);
    },
  };

  const mail: AgentTool<any> = {
    name: "team_mail",
    label: "Use team mail",
    description: "List, read, or send durable Team mail without adding conversation Messages.",
    executionMode: "sequential",
    parameters: mailActionSchema,
    async execute(id, rawParams: unknown, signal) {
      throwIfAborted(signal);
      const params = rawParams as Record<string, unknown>;
      const action = requiredString(params.action, "action") as TeamMailCommand["action"];
      let command: TeamMailCommand;
      const page: TeamMailListOptions = {
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        ...(params.before ? { before: params.before as TeamToolCursor } : {}),
        ...(typeof params.status === "string" ? { status: params.status as TeamMailDeliveryStatus } : {}),
      };
      switch (action) {
        case "list":
          command = {
            action,
            ...(typeof params.teamId === "string" && params.teamId.length > 0
              ? { teamId: params.teamId }
              : {}),
            ...page,
          };
          break;
        case "inbox":
        case "outbox":
          command = { action, ...page };
          break;
        case "read":
          command = { action, mailId: requiredString(params.mailId, "mailId") };
          break;
        case "send": {
          const payload = params.payload;
          assertPayload(payload);
          const kind = requiredString(params.kind, "kind");
          if (kind !== "note" && kind !== "result" && kind !== "ack") {
            throw new TypeError("kind must be note, result, or ack");
          }
          command = {
            action,
            teamId: requiredString(params.teamId, "teamId"),
            targetMemberId: requiredString(params.targetMemberId, "targetMemberId"),
            kind,
            subject: requiredString(params.subject, "subject"),
            payload,
            idempotencyKey: operationKey("mail", id),
          };
          break;
        }
        default:
          throw new TypeError("action must be list, inbox, outbox, read, or send");
      }
      return boundedResult(await options.commands.mail(command, options.activeParent(), signal));
    },
  };

  return [create, assign, mail];
}
