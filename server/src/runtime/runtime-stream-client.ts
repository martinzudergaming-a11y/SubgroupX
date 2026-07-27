import { WebSocket } from "ws";
import { errorMessage } from "../foundation/errors.ts";
import {
  PENDING_MUTATION_ADMISSION_CAPABILITY,
  RUNTIME_STREAM_PROTOCOL_VERSION,
  TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY,
  type ReplayMode,
  type RuntimeStreamCommand,
  type RuntimeStreamEnvelope,
  type RewindStreamResult,
  type SetSandboxStreamResult,
  type SubscribeResult,
  type RuntimeResolveProfile,
  type RuntimeReplayProfile,
} from "./runtime-stream-protocol.ts";
import { RUNTIME_PROTOCOL_VERSION, toError } from "./runtime-ipc.ts";
import type { ServerEvent, PermissionDecision, PendingMutationResult, SandboxKind, TimelineReplayCursor } from "../../../shared/src/protocol.ts";

type AckResult = NonNullable<Extract<RuntimeStreamEnvelope, { kind: "ack" }>["result"]>;
type CommandErrorCode = Extract<RuntimeStreamEnvelope, { kind: "error" }>["code"];

export class RuntimeStreamCommandError extends Error {
  constructor(readonly code: CommandErrorCode, message: string) {
    super(message);
    this.name = "RuntimeStreamCommandError";
  }
}

export interface RuntimeStreamClientOpts {
  socketPath: string;
  onEvent: (ev: ServerEvent) => void;
  onClose: (code: number, reason: string) => void;
  handshakeMs?: number;
}

export class RuntimeStreamClient {
  private ws: WebSocket;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<string, { resolve: (r: AckResult | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private hsTimer: ReturnType<typeof setTimeout> | undefined;
  private handshook = false;
  private pendingMutationAdmission = false;
  private closed = false;
  private explicitClose = false;

  constructor(private opts: RuntimeStreamClientOpts) {
    this.ws = new WebSocket(`ws+unix://${opts.socketPath}:/runtime/stream`, { perMessageDeflate: false });
    this.ready = new Promise<void>((resolve, reject) => {
      this.hsTimer = setTimeout(() => {
        reject(new Error("runtime stream handshake timeout"));
        this.shutdown(1006, "handshake timeout");
      }, opts.handshakeMs ?? 5000);
      this.ws.on("message", (d) => {
        let env: RuntimeStreamEnvelope;
        try { env = JSON.parse(d.toString()) as RuntimeStreamEnvelope; } catch { return; }
        if (!this.handshook) {
          if (env.kind !== "runtime_hello") return;
          clearTimeout(this.hsTimer);
          if (env.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION || env.streamProtocolVersion !== RUNTIME_STREAM_PROTOCOL_VERSION) {
            reject(new Error("runtime protocol mismatch"));
            this.shutdown(1002, "protocol mismatch");
            return;
          }
          this.pendingMutationAdmission = env.capabilities?.includes(PENDING_MUTATION_ADMISSION_CAPABILITY) ?? false;
          this.handshook = true;
          resolve();
          return;
        }
        this.onEnvelope(env);
      });
      this.ws.on("error", (e) => {
        if (!this.handshook) reject(toError(e));
        this.shutdown(1006, errorMessage(e));
      });
      this.ws.on("close", (code, reason) => this.shutdown(code || 1006, reason.toString()));
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  supportsPendingMutationAdmission(): boolean {
    return this.pendingMutationAdmission;
  }

  private onEnvelope(env: RuntimeStreamEnvelope): void {
    switch (env.kind) {
      case "event":
        try { this.opts.onEvent(env.event); } catch {  }
        return;
      case "ack": {
        const p = this.pending.get(env.reqId);
        if (p) { clearTimeout(p.timer); this.pending.delete(env.reqId); p.resolve(env.result); }
        return;
      }
      case "error": {
        if (env.reqId) {
          const p = this.pending.get(env.reqId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(env.reqId);
            p.reject(new RuntimeStreamCommandError(env.code, env.message));
          }
          return;
        }
        this.shutdown(1011, env.message);
        return;
      }
      case "pong":
      case "runtime_hello":
        return;
    }
  }

  private shutdown(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hsTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("runtime stream closed")); }
    this.pending.clear();
    try { this.ws.close(code, reason); } catch {  }
    if (this.handshook && !this.explicitClose) this.opts.onClose(code, reason);
  }

  private send(cmd: RuntimeStreamCommand): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  private call(make: (reqId: string) => RuntimeStreamCommand, timeoutMs = 15000): Promise<AckResult | undefined> {
    if (this.closed) return Promise.reject(new Error("runtime stream closed"));
    const reqId = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error("runtime stream command timeout")); }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(make(reqId));
    });
  }

  async subscribeSession(userId: string, sessionId: string, replay: ReplayMode): Promise<{ epoch: string; runtimeProfile?: RuntimeResolveProfile }> {
    const r = (await this.call((reqId) => ({
      kind: "subscribe_session",
      reqId,
      userId,
      sessionId,
      replay,
      capabilities: [TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY],
    }))) as Extract<SubscribeResult, { topic: "session" }>;
    return { epoch: r.epoch, runtimeProfile: r.runtimeProfile };
  }
  async replaySession(userId: string, sessionId: string, resume?: TimelineReplayCursor): Promise<{ epoch: string; replayProfile?: RuntimeReplayProfile }> {
    const r = (await this.call((reqId) => ({
      kind: "replay_session",
      reqId,
      userId,
      sessionId,
      resume,
      capabilities: [TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY],
    }))) as Extract<SubscribeResult, { topic: "session" }>;
    return { epoch: r.epoch, replayProfile: r.replayProfile };
  }
  unsubscribeSession(userId: string, sessionId: string, releaseIfIdle = true): void {
    this.send({ kind: "unsubscribe_session", userId, sessionId, releaseIfIdle });
  }
  async subscribeUserStatus(userId: string): Promise<void> {
    await this.call((reqId) => ({ kind: "subscribe_user_status", reqId, userId }));
  }
  async submitMessage(userId: string, sessionId: string, text: string, mode?: "steer" | "queue" | "retry", canvasState?: string, authEpoch?: number): Promise<{ action?: string; epoch?: string }> {
    return ((await this.call((reqId) => ({ kind: "submit_message", reqId, userId, sessionId, text, mode, canvasState, authEpoch }))) ?? {}) as { action?: string; epoch?: string };
  }
  async interrupt(userId: string, sessionId: string, authEpoch?: number): Promise<void> {
    await this.call((reqId) => ({ kind: "interrupt", reqId, userId, sessionId, authEpoch }));
  }
  async clearPending(userId: string, sessionId: string, pendingId: string, authEpoch?: number): Promise<PendingMutationResult> {
    const result = await this.call((reqId) => ({ kind: "clear_pending", reqId, userId, sessionId, pendingId, authEpoch }));
    return this.pendingMutationAdmission ? this.requirePendingMutationResult(result) : { ok: true };
  }

  async setPendingKind(userId: string, sessionId: string, pendingId: string, pendingKind: "steer" | "queue", authEpoch?: number): Promise<PendingMutationResult> {
    const result = await this.call((reqId) => ({ kind: "set_pending_kind", reqId, userId, sessionId, pendingId, pendingKind, authEpoch }));
    return this.pendingMutationAdmission ? this.requirePendingMutationResult(result) : { ok: true };
  }

  async setPendingText(userId: string, sessionId: string, pendingId: string, text: string, authEpoch?: number): Promise<PendingMutationResult> {
    const result = await this.call((reqId) => ({ kind: "set_pending_text", reqId, userId, sessionId, pendingId, text, authEpoch }));
    return this.pendingMutationAdmission ? this.requirePendingMutationResult(result) : { ok: true };
  }

  async reorderPending(userId: string, sessionId: string, order: string[], authEpoch?: number): Promise<PendingMutationResult> {
    const result = await this.call((reqId) => ({ kind: "reorder_pending", reqId, userId, sessionId, order, authEpoch }));
    return this.pendingMutationAdmission ? this.requirePendingMutationResult(result) : { ok: true };
  }

  private requirePendingMutationResult(result: AckResult | undefined): PendingMutationResult {
    if (result && "ok" in result && typeof result.ok === "boolean") {
      if (result.ok) return { ok: true };
      if (
        "message" in result &&
        "code" in result &&
        typeof result.message === "string" &&
        (result.code === "suspended" || result.code === "email_verification_required" || result.code === "draining" ||
          result.code === "auth_revoked" || result.code === "pending_mutation_failed")
      ) return { ok: false, code: result.code, message: result.message };
    }
    throw new Error("runtime returned an invalid pending mutation result");
  }
  async resolvePermission(userId: string, sessionId: string, requestId: string, decision: PermissionDecision, authEpoch?: number): Promise<void> {
    await this.call((reqId) => ({ kind: "resolve_permission", reqId, userId, sessionId, requestId, decision, authEpoch }));
  }
  async rewind(userId: string, sessionId: string, toSeq: number, newText?: string, authEpoch?: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = (await this.call((reqId) => ({ kind: "rewind", reqId, userId, sessionId, toSeq, newText, authEpoch }))) as RewindStreamResult;
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  async setSandbox(userId: string, sessionId: string, sandboxKind: SandboxKind, targetId?: string | null, authEpoch?: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const r = (await this.call((reqId) => ({ kind: "set_sandbox", reqId, userId, sessionId, sandboxKind, targetId, authEpoch }))) as SetSandboxStreamResult;
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  close(): void {
    this.explicitClose = true;
    this.shutdown(1000, "client closing");
  }
}
