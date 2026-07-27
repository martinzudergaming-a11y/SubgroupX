import type { ServerEvent, PermissionDecision, PendingMutationResult, SandboxKind, TimelineReplayCursor } from "../../../shared/src/protocol.ts";
import { performance } from "node:perf_hooks";
import { errorMessage } from "../foundation/errors.ts";
import { runtimeClient } from "./manager.ts";
import { RUNTIME_SOCKET } from "../config.ts";
import { RuntimeStreamClient, RuntimeStreamCommandError } from "./runtime-stream-client.ts";
import { RuntimeMutationRejectedError } from "./auth-epoch.ts";

export type RewindResult = { ok: true } | { ok: false; reason: string };

export interface SubscribeBindProfile {
  ok: boolean;
  topology: "local" | "remote";
  runtimeReused: boolean;
  runtimeRowLookupMs: number;
  runtimeConstructMs: number;
  runtimeResolveMs: number;
  gatewayRoundTripMs: number;
}

export interface SubscribeReplayProfile {
  topology: "local" | "remote";
  replayed: boolean;
  snapshotReadMs: number;
  timelineItems: number;
  gatewayRoundTripMs: number;
}

export interface SessionGateway {
  ensureSubscribed(sessionId: string, reqId?: string): Promise<boolean>;
  profileEnsureSubscribed(sessionId: string, reqId?: string): Promise<SubscribeBindProfile>;
  replaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<void>;
  profileReplaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<SubscribeReplayProfile>;
  subscribeUserStatus(): Promise<void>;
  submitMessage(sessionId: string, text: string, mode: "steer" | "queue" | "retry" | undefined, reqId?: string, canvasState?: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<void>;
  clearPending(sessionId: string, pendingId: string): Promise<PendingMutationResult>;
  setPendingKind(sessionId: string, pendingId: string, kind: "steer" | "queue"): Promise<PendingMutationResult>;
  setPendingText(sessionId: string, pendingId: string, text: string): Promise<PendingMutationResult>;
  reorderPending(sessionId: string, order: string[]): Promise<PendingMutationResult>;
  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  rewind(sessionId: string, toSeq: number, newText?: string): Promise<RewindResult>;
  setSandbox(sessionId: string, kind: SandboxKind, targetId?: string | null): Promise<RewindResult>;
  close(): void;
}

export class LocalSessionGateway implements SessionGateway {
  private subscriptions = new Map<string, { unsub: () => void; epoch: string }>();
  private statusUnsub: (() => void) | null = null;

  constructor(
    private userId: string,
    private onEvent: (ev: ServerEvent) => void,
    private authEpoch?: number,
  ) {}

  async ensureSubscribed(sessionId: string, reqId?: string): Promise<boolean> {
    return (await this.profileEnsureSubscribed(sessionId, reqId)).ok;
  }

  async profileEnsureSubscribed(sessionId: string, reqId?: string): Promise<SubscribeBindProfile> {
    const gatewayStarted = performance.now();
    const resolved = runtimeClient.getRuntimeProfiled(this.userId, sessionId);
    const rt = resolved.runtime;
    if (!rt) {
      this.onEvent({ type: "error", reqId, message: "session not found" });
      return {
        ok: false,
        topology: "local",
        runtimeReused: false,
        runtimeRowLookupMs: resolved.rowLookupMs,
        runtimeConstructMs: resolved.constructMs,
        runtimeResolveMs: resolved.totalMs,
        gatewayRoundTripMs: performance.now() - gatewayStarted,
      };
    }
    const existing = this.subscriptions.get(sessionId);
    if (existing && existing.epoch !== rt.getEpoch()) {
      existing.unsub();
      this.subscriptions.delete(sessionId);
      const unsub = rt.subscribe((ev) => this.onEvent(ev));
      this.subscriptions.set(sessionId, { unsub, epoch: rt.getEpoch() });
      this.onEvent({
        type: "timeline_replay",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        items: rt.getTimeline(),
        pending: rt.getPendingQueue(),
      });
      this.onEvent({ type: "session_status", sessionId, status: rt.getStatus() });
    } else if (!existing) {
      for (const [sid, sub] of [...this.subscriptions]) {
        sub.unsub();
        this.subscriptions.delete(sid);
        runtimeClient.releaseIfIdle(this.userId, sid);
      }
      const unsub = rt.subscribe((ev) => this.onEvent(ev));
      this.subscriptions.set(sessionId, { unsub, epoch: rt.getEpoch() });
    }
    return {
      ok: true,
      topology: "local",
      runtimeReused: resolved.reused,
      runtimeRowLookupMs: resolved.rowLookupMs,
      runtimeConstructMs: resolved.constructMs,
      runtimeResolveMs: resolved.totalMs,
      gatewayRoundTripMs: performance.now() - gatewayStarted,
    };
  }

  async replaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<void> {
    await this.profileReplaySubscribed(sessionId, resume);
  }

  async profileReplaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<SubscribeReplayProfile> {
    const gatewayStarted = performance.now();
    const rt = runtimeClient.getRuntime(this.userId, sessionId);
    if (!rt) {
      return { topology: "local", replayed: false, snapshotReadMs: 0, timelineItems: 0, gatewayRoundTripMs: performance.now() - gatewayStarted };
    }
    const existing = this.subscriptions.get(sessionId);
    if (!existing || existing.epoch !== rt.getEpoch()) {
      existing?.unsub();
      const unsub = rt.subscribe((ev) => this.onEvent(ev));
      this.subscriptions.set(sessionId, { unsub, epoch: rt.getEpoch() });
    }
    const replayed = resume?.epoch !== rt.getEpoch() || resume.version !== rt.getTimelineVersion();
    let snapshotReadMs = 0;
    let timelineItems = 0;
    if (replayed) {
      const readStarted = performance.now();
      const items = rt.getTimeline();
      const pending = rt.getPendingQueue();
      snapshotReadMs = performance.now() - readStarted;
      timelineItems = items.length;
      this.onEvent({
        type: "timeline_replay",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        items,
        pending,
      });
    } else {
      const pending = rt.getPendingQueue();
      this.onEvent({
        type: "pending_queue",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        pending,
      });
    }
    this.onEvent({ type: "session_status", sessionId, status: rt.getStatus() });
    this.onEvent({ type: "context_usage", sessionId, ...rt.getContextUsage() });
    for (const request of rt.pendingPermissionRequests()) {
      this.onEvent({ type: "permission_request", sessionId, request });
    }
    return {
      topology: "local",
      replayed,
      snapshotReadMs,
      timelineItems,
      gatewayRoundTripMs: performance.now() - gatewayStarted,
    };
  }

  async subscribeUserStatus(): Promise<void> {
    if (!this.statusUnsub) {
      this.statusUnsub = runtimeClient.subscribeUserStatus(this.userId, (ev) => this.onEvent(ev));
    }
    for (const { sessionId, status } of runtimeClient.liveSessionStatuses(this.userId)) {
      this.onEvent({ type: "session_status", sessionId, status });
    }
    this.onEvent({
      type: "session_activity_snapshot",
      activities: runtimeClient.liveSessionActivities(this.userId),
    });
  }

  async submitMessage(sessionId: string, text: string, mode: "steer" | "queue" | "retry" | undefined, reqId?: string, canvasState?: string): Promise<boolean> {
    const rt = runtimeClient.getRuntime(this.userId, sessionId);
    if (!rt) {
      this.onEvent({ type: "error", reqId, message: "session not found" });
      return false;
    }
    const busy = rt.isBusy();
    const action: "steer" | "queue" | "send" | "retry" =
      mode === "retry"
        ? "retry"
        : busy && mode === "steer"
        ? rt.canSteer() ? "steer" : "queue"
        : busy && mode === "queue"
          ? "queue"
          : "send";
    if ((action === "send" || action === "retry") && mode !== undefined) {
      this.onEvent({
        type: "pending_queue",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        pending: rt.getPendingQueue(),
      });
    }
    if ((action === "send" || action === "retry") && runtimeClient.isDraining()) {
      this.onEvent({ type: "error", reqId, sessionId, message: "server is restarting" });
      return false;
    }
    let run: Promise<void>;
    try {
      run = action === "steer"
        ? rt.steer(text, this.authEpoch)
        : action === "queue"
          ? rt.queueFollowUp(text, this.authEpoch)
          : action === "retry"
            ? rt.retryModelResponse(this.authEpoch)
            : rt.sendMessage(text, canvasState, undefined, this.authEpoch);
    } catch (error) {
      const refusal = error instanceof RuntimeMutationRejectedError ? error.result : null;
      this.onEvent({
        type: "error",
        reqId,
        sessionId,
        ...(refusal ? { code: refusal.code } : {}),
        message: refusal?.message ?? errorMessage(error),
      });
      return false;
    }
    run.catch((err) => {
      this.onEvent({ type: "error", reqId, message: errorMessage(err) });
    });
    return true;
  }

  async interrupt(sessionId: string): Promise<void> {
    runtimeClient.getRuntime(this.userId, sessionId)?.interrupt(false, false, this.authEpoch);
  }

  async clearPending(sessionId: string, pendingId: string): Promise<PendingMutationResult> {
    return runtimeClient.getRuntime(this.userId, sessionId)?.clearPending(pendingId, this.authEpoch) ?? { ok: true };
  }

  async setPendingKind(sessionId: string, pendingId: string, kind: "steer" | "queue"): Promise<PendingMutationResult> {
    return runtimeClient.getRuntime(this.userId, sessionId)?.setPendingKind(pendingId, kind, this.authEpoch) ?? { ok: true };
  }

  async setPendingText(sessionId: string, pendingId: string, text: string): Promise<PendingMutationResult> {
    return runtimeClient.getRuntime(this.userId, sessionId)?.setPendingText(pendingId, text, this.authEpoch) ?? { ok: true };
  }

  async reorderPending(sessionId: string, order: string[]): Promise<PendingMutationResult> {
    return runtimeClient.getRuntime(this.userId, sessionId)?.reorderPending(order, this.authEpoch) ?? { ok: true };
  }

  async resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    runtimeClient.getRuntime(this.userId, sessionId)?.resolvePermission(requestId, decision, this.authEpoch);
  }

  async rewind(sessionId: string, toSeq: number, newText?: string): Promise<RewindResult> {
    const res = await runtimeClient.rewind(this.userId, sessionId, toSeq, newText, this.authEpoch);
    if (res.ok) {
      const old = this.subscriptions.get(sessionId);
      if (old) { old.unsub(); this.subscriptions.delete(sessionId); }
      return { ok: true };
    }
    return { ok: false, reason: res.reason };
  }

  async setSandbox(sessionId: string, kind: SandboxKind, targetId?: string | null): Promise<RewindResult> {
    const res = await runtimeClient.setSandbox(this.userId, sessionId, kind, targetId ?? null, this.authEpoch);
    if (res.ok) {
      const old = this.subscriptions.get(sessionId);
      if (old) { old.unsub(); this.subscriptions.delete(sessionId); }
      return { ok: true };
    }
    return { ok: false, reason: res.reason };
  }

  close(): void {
    this.statusUnsub?.();
    this.statusUnsub = null;
    const sessionIds = [...this.subscriptions.keys()];
    for (const { unsub } of this.subscriptions.values()) unsub();
    this.subscriptions.clear();
    for (const sid of sessionIds) runtimeClient.releaseIfIdle(this.userId, sid);
  }
}

export class RemoteSessionGateway implements SessionGateway {
  private client: RuntimeStreamClient;
  private ready: Promise<void>;
  private closed = false;
  private bound = new Set<string>();

  constructor(
    private userId: string,
    private onEvent: (ev: ServerEvent) => void,
    onClose: (code: number, reason: string) => void,
    socketPath: string,
    private authEpoch?: number,
  ) {
    const fireClose = (code: number, reason: string) => {
      if (this.closed) return;
      this.closed = true;
      onClose(code, reason);
    };
    this.client = new RuntimeStreamClient({
      socketPath,
      onEvent: (ev) => this.onEvent(ev),
      onClose: fireClose,
    });
    this.ready = this.client.whenReady();
    this.ready.catch((e) => fireClose(1011, e instanceof Error ? e.message : "runtime stream unavailable"));
  }

  async ensureSubscribed(sessionId: string, reqId?: string): Promise<boolean> {
    return (await this.profileEnsureSubscribed(sessionId, reqId)).ok;
  }

  async profileEnsureSubscribed(sessionId: string, reqId?: string): Promise<SubscribeBindProfile> {
    const gatewayStarted = performance.now();
    await this.ready;
    try {
      const subscribed = await this.client.subscribeSession(this.userId, sessionId, "epoch_rebind");
      const runtime = subscribed.runtimeProfile;
      for (const other of this.bound) {
        if (other !== sessionId) this.client.unsubscribeSession(this.userId, other, true);
      }
      this.bound = new Set([sessionId]);
      return {
        ok: true,
        topology: "remote",
        runtimeReused: runtime?.reused ?? false,
        runtimeRowLookupMs: runtime?.rowLookupMs ?? 0,
        runtimeConstructMs: runtime?.constructMs ?? 0,
        runtimeResolveMs: runtime?.totalMs ?? 0,
        gatewayRoundTripMs: performance.now() - gatewayStarted,
      };
    } catch (e) {
      this.onEvent({ type: "error", reqId, message: e instanceof Error ? e.message : "session not found" });
      return {
        ok: false,
        topology: "remote",
        runtimeReused: false,
        runtimeRowLookupMs: 0,
        runtimeConstructMs: 0,
        runtimeResolveMs: 0,
        gatewayRoundTripMs: performance.now() - gatewayStarted,
      };
    }
  }

  async replaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<void> {
    await this.profileReplaySubscribed(sessionId, resume);
  }

  async profileReplaySubscribed(sessionId: string, resume?: TimelineReplayCursor): Promise<SubscribeReplayProfile> {
    const gatewayStarted = performance.now();
    await this.ready;
    try {
      const effectiveResume = this.client.supportsPendingMutationAdmission() ? resume : undefined;
      const replay = await this.client.replaySession(this.userId, sessionId, effectiveResume);
      return {
        topology: "remote",
        replayed: replay.replayProfile?.replayed ?? false,
        snapshotReadMs: replay.replayProfile?.snapshotReadMs ?? 0,
        timelineItems: replay.replayProfile?.timelineItems ?? 0,
        gatewayRoundTripMs: performance.now() - gatewayStarted,
      };
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) {
        return { topology: "remote", replayed: false, snapshotReadMs: 0, timelineItems: 0, gatewayRoundTripMs: performance.now() - gatewayStarted };
      }
      throw e;
    }
  }

  async subscribeUserStatus(): Promise<void> {
    await this.ready;
    await this.client.subscribeUserStatus(this.userId);
  }

  async submitMessage(sessionId: string, text: string, mode: "steer" | "queue" | "retry" | undefined, reqId?: string, canvasState?: string): Promise<boolean> {
    await this.ready;
    try {
      await this.client.submitMessage(this.userId, sessionId, text, mode, canvasState, this.authEpoch);
      return true;
    } catch (error) {
      const code = error instanceof RuntimeStreamCommandError &&
        (error.code === "suspended" || error.code === "email_verification_required" ||
          error.code === "draining" || error.code === "auth_revoked" ||
          error.code === "pending_mutation_failed")
        ? error.code
        : undefined;
      this.onEvent({ type: "error", reqId, sessionId, ...(code ? { code } : {}), message: errorMessage(error) });
      return false;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.ready;
    await this.client.interrupt(this.userId, sessionId, this.authEpoch);
  }

  async clearPending(sessionId: string, pendingId: string): Promise<PendingMutationResult> {
    await this.ready;
    return await this.client.clearPending(this.userId, sessionId, pendingId, this.authEpoch);
  }

  async setPendingKind(sessionId: string, pendingId: string, kind: "steer" | "queue"): Promise<PendingMutationResult> {
    await this.ready;
    return await this.client.setPendingKind(this.userId, sessionId, pendingId, kind, this.authEpoch);
  }

  async setPendingText(sessionId: string, pendingId: string, text: string): Promise<PendingMutationResult> {
    await this.ready;
    return await this.client.setPendingText(this.userId, sessionId, pendingId, text, this.authEpoch);
  }

  async reorderPending(sessionId: string, order: string[]): Promise<PendingMutationResult> {
    await this.ready;
    return await this.client.reorderPending(this.userId, sessionId, order, this.authEpoch);
  }

  async resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.ready;
    await this.client.resolvePermission(this.userId, sessionId, requestId, decision, this.authEpoch);
  }

  async rewind(sessionId: string, toSeq: number, newText?: string): Promise<RewindResult> {
    await this.ready;
    try {
      return await this.client.rewind(this.userId, sessionId, toSeq, newText, this.authEpoch);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "rewind failed" };
    }
  }

  async setSandbox(sessionId: string, kind: SandboxKind, targetId?: string | null): Promise<RewindResult> {
    await this.ready;
    try {
      return await this.client.setSandbox(this.userId, sessionId, kind, targetId ?? null, this.authEpoch);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "set_sandbox failed" };
    }
  }

  close(): void {
    this.closed = true;
    this.bound.clear();
    this.client.close();
  }
}

export function createSessionGateway(
  userId: string,
  authEpoch: number,
  onEvent: (ev: ServerEvent) => void,
  onClose: (code: number, reason: string) => void,
): SessionGateway {
  return RUNTIME_SOCKET
    ? new RemoteSessionGateway(userId, onEvent, onClose, RUNTIME_SOCKET, authEpoch)
    : new LocalSessionGateway(userId, onEvent, authEpoch);
}
