import type {
  ServerEvent,
  PermissionDecision,
  PendingMutationFailureCode,
  PendingMutationResult,
  SandboxKind,
  TimelineReplayCursor,
} from "../../../shared/src/protocol.ts";

export const RUNTIME_STREAM_PROTOCOL_VERSION = 5;

export const PENDING_MUTATION_ADMISSION_CAPABILITY = "pending_mutation_admission.v1" as const;
export type RuntimeStreamCapability = typeof PENDING_MUTATION_ADMISSION_CAPABILITY;

export const TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY = "team_assignment_timeline.v1" as const;
export type RuntimeStreamWebCapability = typeof TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY;

export type ReplayMode = "always" | "none" | "epoch_rebind";

export interface RuntimeResolveProfile {
  reused: boolean;
  rowLookupMs: number;
  constructMs: number;
  totalMs: number;
}

export interface RuntimeReplayProfile {
  replayed: boolean;
  snapshotReadMs: number;
  timelineItems: number;
}

export type RuntimeStreamCommand =
  | { kind: "subscribe_session"; reqId: string; userId: string; sessionId: string; replay: ReplayMode; capabilities?: RuntimeStreamWebCapability[] }
  | { kind: "replay_session"; reqId: string; userId: string; sessionId: string; resume?: TimelineReplayCursor; capabilities?: RuntimeStreamWebCapability[] }
  | { kind: "unsubscribe_session"; reqId?: string; userId: string; sessionId: string; releaseIfIdle?: boolean }
  | { kind: "subscribe_user_status"; reqId: string; userId: string }
  | { kind: "unsubscribe_user_status"; reqId?: string; userId: string }
  | { kind: "submit_message"; reqId: string; userId: string; sessionId: string; text: string; mode?: "steer" | "queue" | "retry"; canvasState?: string; authEpoch?: number }
  | { kind: "interrupt"; reqId: string; userId: string; sessionId: string; authEpoch?: number }
  | { kind: "clear_pending"; reqId: string; userId: string; sessionId: string; pendingId: string; authEpoch?: number }
  | { kind: "set_pending_kind"; reqId: string; userId: string; sessionId: string; pendingId: string; pendingKind: "steer" | "queue"; authEpoch?: number }
  | { kind: "set_pending_text"; reqId: string; userId: string; sessionId: string; pendingId: string; text: string; authEpoch?: number }
  | { kind: "reorder_pending"; reqId: string; userId: string; sessionId: string; order: string[]; authEpoch?: number }
  | { kind: "resolve_permission"; reqId: string; userId: string; sessionId: string; requestId: string; decision: PermissionDecision; authEpoch?: number }
  | { kind: "rewind"; reqId: string; userId: string; sessionId: string; toSeq: number; newText?: string; authEpoch?: number }
  | { kind: "set_sandbox"; reqId: string; userId: string; sessionId: string; sandboxKind: SandboxKind; targetId?: string | null; authEpoch?: number }
  | { kind: "ping"; reqId?: string };

export type SubscribeResult =
  | {
      topic: "session";
      sessionId: string;
      epoch: string;
      runtimeProfile?: RuntimeResolveProfile;
      replayProfile?: RuntimeReplayProfile;
    }
  | { topic: "user_status" };

export type RewindStreamResult =
  | { topic: "rewind"; sessionId: string; ok: true }
  | { topic: "rewind"; sessionId: string; ok: false; reason: string };

export type SetSandboxStreamResult =
  | { topic: "set_sandbox"; sessionId: string; ok: true }
  | { topic: "set_sandbox"; sessionId: string; ok: false; reason: string };

export type RuntimeStreamEnvelope =
  | {
      kind: "runtime_hello";
      runtimeProtocolVersion: number;
      streamProtocolVersion: number;
      ts: number;
      capabilities?: RuntimeStreamCapability[];
    }
  | { kind: "ack"; reqId: string; result?: SubscribeResult | RewindStreamResult | SetSandboxStreamResult | PendingMutationResult | { found?: boolean; action?: "send" | "steer" | "queue" | "retry"; epoch?: string } }
  | { kind: "event"; event: ServerEvent }
  | {
      kind: "error";
      reqId?: string;
      code: "bad_protocol" | "not_found" | "forbidden" | "busy" | "internal" | PendingMutationFailureCode;
      message: string;
    }
  | { kind: "pong"; reqId?: string };
