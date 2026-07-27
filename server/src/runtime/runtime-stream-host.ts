import http from "node:http";
import { performance } from "node:perf_hooks";
import { errorMessage } from "../foundation/errors.ts";
import { WebSocketServer, WebSocket } from "ws";
import { sessionManager } from "./manager.ts";
import { RUNTIME_PROTOCOL_VERSION } from "./runtime-ipc.ts";
import {
  PENDING_MUTATION_ADMISSION_CAPABILITY,
  RUNTIME_STREAM_PROTOCOL_VERSION,
  TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY,
  type RuntimeStreamCommand,
  type RuntimeStreamEnvelope,
  type RuntimeReplayProfile,
} from "./runtime-stream-protocol.ts";
import type { AgentSessionRuntime } from "./agent-session.ts";
import { isPendingMessageKind, type PendingMutationResult, type ServerEvent, type TimelineReplayCursor } from "../../../shared/src/protocol.ts";
import { startWsHeartbeat, RUNTIME_HEARTBEAT_MS } from "../transport/ws-util.ts";
import { AUTH_EPOCH_REVOKED_MESSAGE, AuthEpochRevokedError, RuntimeMutationRejectedError } from "./auth-epoch.ts";

const STREAM_PATH = "/runtime/stream";
const BACKPRESSURE_BYTES = 8 * 1024 * 1024;

export function shapeEventForRuntimeStreamWebPeer(
  event: ServerEvent,
  supportsTeamAssignmentTimeline: boolean,
): ServerEvent | null {
  if (supportsTeamAssignmentTimeline) return event;
  if (event.type === "timeline_replay") {
    return { ...event, items: event.items.filter((item) => item.kind !== "team_assignment") };
  }
  if (event.type === "agent_event" && event.event.t === "team_assignment") return null;
  return event;
}

export function attachRuntimeStreamHost(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== STREAM_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => new RuntimeStreamConn(ws));
  startWsHeartbeat(wss, RUNTIME_HEARTBEAT_MS);
  return wss;
}

class RuntimeStreamConn {
  private sessionSubs = new Map<string, {
    unsub: () => void;
    userId: string;
    epoch: string;
    teamAssignmentTimeline: boolean;
  }>();
  private statusUnsub: (() => void) | null = null;

  constructor(private ws: WebSocket) {
    this.sendEnv({
      kind: "runtime_hello",
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      streamProtocolVersion: RUNTIME_STREAM_PROTOCOL_VERSION,
      ts: Date.now(),
      capabilities: [PENDING_MUTATION_ADMISSION_CAPABILITY],
    });
    ws.on("message", (d) => {
      try {
        this.onCommand(d.toString());
      } catch (e) {
        this.sendEnv({ kind: "error", code: "internal", message: errorMessage(e) });
      }
    });
    ws.on("close", () => this.cleanup());
    ws.on("error", () => this.cleanup());
  }

  private sendEnv(env: RuntimeStreamEnvelope): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > BACKPRESSURE_BYTES) {
      this.ws.close(1013, "runtime stream backpressure");
      return;
    }
    this.ws.send(JSON.stringify(env));
  }
  private emitEvent(ev: ServerEvent): void {
    this.sendEnv({ kind: "event", event: ev });
  }
  private emitSessionEvent(ev: ServerEvent, teamAssignmentTimeline: boolean): void {
    const shaped = shapeEventForRuntimeStreamWebPeer(ev, teamAssignmentTimeline);
    if (shaped) this.emitEvent(shaped);
  }

  private cleanup(): void {
    this.statusUnsub?.();
    this.statusUnsub = null;
    const subs = [...this.sessionSubs.entries()];
    this.sessionSubs.clear();
    for (const [sid, { unsub, userId }] of subs) {
      unsub();
      sessionManager.releaseIfIdle(userId, sid);
    }
  }

  private onCommand(raw: string): void {
    let cmd: RuntimeStreamCommand;
    try {
      cmd = JSON.parse(raw) as RuntimeStreamCommand;
    } catch {
      this.sendEnv({ kind: "error", code: "bad_protocol", message: "invalid JSON" });
      return;
    }
    switch (cmd.kind) {
      case "ping":
        this.sendEnv({ kind: "pong", reqId: cmd.reqId });
        return;
      case "subscribe_session":
        return this.subscribeSession(cmd);
      case "replay_session":
        return this.replaySession(cmd);
      case "unsubscribe_session":
        return this.unsubscribeSession(cmd);
      case "rewind":
        return this.rewind(cmd);
      case "set_sandbox":
        return this.setSandbox(cmd);
      case "subscribe_user_status":
        return this.subscribeUserStatus(cmd);
      case "unsubscribe_user_status":
        this.statusUnsub?.();
        this.statusUnsub = null;
        if (cmd.reqId) this.sendEnv({ kind: "ack", reqId: cmd.reqId });
        return;
      case "submit_message":
        return this.submit(cmd);
      case "interrupt":
        return this.interrupt(cmd);
      case "clear_pending":
        return this.clearPending(cmd);
      case "set_pending_kind":
        return this.setPendingKind(cmd);
      case "set_pending_text":
        return this.setPendingText(cmd);
      case "reorder_pending":
        return this.reorderPending(cmd);
      case "resolve_permission":
        return this.resolvePermission(cmd);
      default:
        this.sendEnv({ kind: "error", code: "bad_protocol", message: "unknown command" });
    }
  }

  private requireAuthEpoch(cmd: { reqId: string; authEpoch?: number }): number | null {
    if (Number.isSafeInteger(cmd.authEpoch)) return cmd.authEpoch!;
    this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "forbidden", message: AUTH_EPOCH_REVOKED_MESSAGE });
    return null;
  }

  private emitPendingTruth(sessionId: string, rt: AgentSessionRuntime): void {
    this.emitEvent({
      type: "pending_queue",
      sessionId,
      epoch: rt.getEpoch(),
      version: rt.getTimelineVersion(),
      pending: rt.getPendingQueue(),
    });
  }

  private pendingAuthEpochWithTruth(
    cmd: { reqId: string; userId: string; sessionId: string; authEpoch?: number },
    rt: AgentSessionRuntime | null,
  ): number | null {
    if (Number.isSafeInteger(cmd.authEpoch)) return cmd.authEpoch!;
    if (rt) this.emitPendingTruth(cmd.sessionId, rt);
    const result: PendingMutationResult = {
      ok: false, code: "auth_revoked", message: AUTH_EPOCH_REVOKED_MESSAGE,
    };
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result });
    return null;
  }

  private emitFullReplay(
    sessionId: string,
    rt: AgentSessionRuntime,
    teamAssignmentTimeline: boolean,
    resume?: TimelineReplayCursor,
  ): RuntimeReplayProfile {
    const replayed = resume?.epoch !== rt.getEpoch() || resume.version !== rt.getTimelineVersion();
    let snapshotReadMs = 0;
    let timelineItems = 0;
    if (replayed) {
      const readStarted = performance.now();
      const storedItems = rt.getTimeline();
      const items = teamAssignmentTimeline
        ? storedItems
        : storedItems.filter((item) => item.kind !== "team_assignment");
      const pending = rt.getPendingQueue();
      snapshotReadMs = performance.now() - readStarted;
      timelineItems = items.length;
      this.emitSessionEvent({
        type: "timeline_replay",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        items,
        pending,
      }, teamAssignmentTimeline);
    } else {
      const pending = rt.getPendingQueue();
      this.emitSessionEvent({
        type: "pending_queue",
        sessionId,
        epoch: rt.getEpoch(),
        version: rt.getTimelineVersion(),
        pending,
      }, teamAssignmentTimeline);
    }
    this.emitSessionEvent({ type: "session_status", sessionId, status: rt.getStatus() }, teamAssignmentTimeline);
    this.emitSessionEvent({ type: "context_usage", sessionId, ...rt.getContextUsage() }, teamAssignmentTimeline);
    for (const request of rt.pendingPermissionRequests()) {
      this.emitSessionEvent({ type: "permission_request", sessionId, request }, teamAssignmentTimeline);
    }
    return { replayed, snapshotReadMs, timelineItems };
  }

  private bindListener(
    userId: string,
    sessionId: string,
    rt: AgentSessionRuntime,
    teamAssignmentTimeline: boolean,
  ): void {
    this.sessionSubs.get(sessionId)?.unsub();
    const unsub = rt.subscribe((ev) => this.emitSessionEvent(ev, teamAssignmentTimeline));
    this.sessionSubs.set(sessionId, { unsub, userId, epoch: rt.getEpoch(), teamAssignmentTimeline });
  }

  private subscribeSession(cmd: Extract<RuntimeStreamCommand, { kind: "subscribe_session" }>): void {
    const resolved = sessionManager.getRuntimeProfiled(cmd.userId, cmd.sessionId);
    const rt = resolved.runtime;
    if (!rt) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "not_found", message: "session not found" });
      return;
    }
    const teamAssignmentTimeline = cmd.capabilities?.includes(TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY) ?? false;
    let replayProfile: RuntimeReplayProfile | undefined;
    if (cmd.replay === "epoch_rebind") {
      const existing = this.sessionSubs.get(cmd.sessionId);
      if (existing && (existing.epoch !== rt.getEpoch()
        || existing.teamAssignmentTimeline !== teamAssignmentTimeline)) {
        this.bindListener(cmd.userId, cmd.sessionId, rt, teamAssignmentTimeline);
        this.emitSessionEvent({
          type: "timeline_replay",
          sessionId: cmd.sessionId,
          epoch: rt.getEpoch(),
          version: rt.getTimelineVersion(),
          items: rt.getTimeline(),
          pending: rt.getPendingQueue(),
        }, teamAssignmentTimeline);
        this.emitSessionEvent(
          { type: "session_status", sessionId: cmd.sessionId, status: rt.getStatus() },
          teamAssignmentTimeline,
        );
      } else if (!existing) {
        this.bindListener(cmd.userId, cmd.sessionId, rt, teamAssignmentTimeline);
      }
    } else {
      this.bindListener(cmd.userId, cmd.sessionId, rt, teamAssignmentTimeline);
      if (cmd.replay === "always") {
        replayProfile = this.emitFullReplay(cmd.sessionId, rt, teamAssignmentTimeline);
      }
    }
    this.sendEnv({
      kind: "ack",
      reqId: cmd.reqId,
      result: {
        topic: "session",
        sessionId: cmd.sessionId,
        epoch: rt.getEpoch(),
        runtimeProfile: {
          reused: resolved.reused,
          rowLookupMs: resolved.rowLookupMs,
          constructMs: resolved.constructMs,
          totalMs: resolved.totalMs,
        },
        replayProfile,
      },
    });
  }

  private replaySession(cmd: Extract<RuntimeStreamCommand, { kind: "replay_session" }>): void {
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    if (!rt) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "not_found", message: "session not found" });
      return;
    }
    const teamAssignmentTimeline = cmd.capabilities?.includes(TEAM_ASSIGNMENT_TIMELINE_WEB_CAPABILITY) ?? false;
    const existing = this.sessionSubs.get(cmd.sessionId);
    if (!existing || existing.epoch !== rt.getEpoch()
      || existing.teamAssignmentTimeline !== teamAssignmentTimeline) {
      this.bindListener(cmd.userId, cmd.sessionId, rt, teamAssignmentTimeline);
    }
    const replayProfile = this.emitFullReplay(cmd.sessionId, rt, teamAssignmentTimeline, cmd.resume);
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result: { topic: "session", sessionId: cmd.sessionId, epoch: rt.getEpoch(), replayProfile } });
  }

  private unsubscribeSession(cmd: Extract<RuntimeStreamCommand, { kind: "unsubscribe_session" }>): void {
    const sub = this.sessionSubs.get(cmd.sessionId);
    sub?.unsub();
    this.sessionSubs.delete(cmd.sessionId);
    if (cmd.releaseIfIdle && sub) sessionManager.releaseIfIdle(sub.userId, cmd.sessionId);
    if (cmd.reqId) this.sendEnv({ kind: "ack", reqId: cmd.reqId });
  }

  private subscribeUserStatus(cmd: Extract<RuntimeStreamCommand, { kind: "subscribe_user_status" }>): void {
    if (!this.statusUnsub) {
      this.statusUnsub = sessionManager.subscribeUserStatus(cmd.userId, (ev) => this.emitEvent(ev));
    }
    for (const { sessionId, status } of sessionManager.liveSessionStatuses(cmd.userId)) {
      this.emitEvent({ type: "session_status", sessionId, status });
    }
    this.emitEvent({
      type: "session_activity_snapshot",
      activities: sessionManager.liveSessionActivities(cmd.userId),
    });
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result: { topic: "user_status" } });
  }

  private submit(cmd: Extract<RuntimeStreamCommand, { kind: "submit_message" }>): void {
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    if (!rt) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "not_found", message: "session not found" });
      return;
    }
    const busy = rt.isBusy();
    const action: "steer" | "queue" | "send" | "retry" =
      cmd.mode === "retry"
        ? "retry"
        : busy && cmd.mode === "steer"
        ? rt.canSteer() ? "steer" : "queue"
        : busy && cmd.mode === "queue"
          ? "queue"
          : "send";
    const missingAuthEpoch = !Number.isSafeInteger(cmd.authEpoch);
    if (cmd.mode !== undefined && (action === "send" || action === "retry" || missingAuthEpoch)) {
      this.emitPendingTruth(cmd.sessionId, rt);
    }
    if (missingAuthEpoch) {
      this.sendEnv({
        kind: "error",
        reqId: cmd.reqId,
        code: action === "send" || action === "retry" ? "forbidden" : "auth_revoked",
        message: AUTH_EPOCH_REVOKED_MESSAGE,
      });
      return;
    }
    const authEpoch = cmd.authEpoch!;
    if ((action === "send" || action === "retry") && sessionManager.isDraining()) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "busy", message: "server is restarting" });
      return;
    }
    let run: Promise<void>;
    try {
      run = action === "steer"
        ? rt.steer(cmd.text, authEpoch)
        : action === "queue"
          ? rt.queueFollowUp(cmd.text, authEpoch)
          : action === "retry"
            ? rt.retryModelResponse(authEpoch)
            : rt.sendMessage(cmd.text, cmd.canvasState, undefined, authEpoch);
    } catch (error) {
      const pendingCode = error instanceof RuntimeMutationRejectedError ? error.result.code : null;
      this.sendEnv({
        kind: "error",
        reqId: cmd.reqId,
        code: pendingCode ?? (error instanceof AuthEpochRevokedError ? "forbidden" : "internal"),
        message: errorMessage(error),
      });
      return;
    }
    run.catch((err) => this.emitEvent({ type: "error", message: errorMessage(err) }));
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result: { action, epoch: rt.getEpoch() } });
  }

  private interrupt(cmd: Extract<RuntimeStreamCommand, { kind: "interrupt" }>): void {
    const authEpoch = this.requireAuthEpoch(cmd);
    if (authEpoch === null) return;
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    try {
      rt?.interrupt(false, false, authEpoch);
    } catch (error) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "forbidden", message: errorMessage(error) });
      return;
    }
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result: { found: Boolean(rt) } });
  }

  private setPendingKind(cmd: Extract<RuntimeStreamCommand, { kind: "set_pending_kind" }>): void {
    if (!isPendingMessageKind(cmd.pendingKind)) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "bad_protocol", message: "invalid pending message kind" });
      return;
    }
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    const authEpoch = this.pendingAuthEpochWithTruth(cmd, rt);
    if (authEpoch === null) return;
    const result = rt?.setPendingKind(cmd.pendingId, cmd.pendingKind, authEpoch) ?? { ok: true as const };
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result });
  }

  private setPendingText(cmd: Extract<RuntimeStreamCommand, { kind: "set_pending_text" }>): void {
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    const authEpoch = this.pendingAuthEpochWithTruth(cmd, rt);
    if (authEpoch === null) return;
    const result = rt?.setPendingText(cmd.pendingId, cmd.text, authEpoch) ?? { ok: true as const };
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result });
  }

  private reorderPending(cmd: Extract<RuntimeStreamCommand, { kind: "reorder_pending" }>): void {
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    const authEpoch = this.pendingAuthEpochWithTruth(cmd, rt);
    if (authEpoch === null) return;
    const result = rt?.reorderPending(cmd.order, authEpoch) ?? { ok: true as const };
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result });
  }

  private clearPending(cmd: Extract<RuntimeStreamCommand, { kind: "clear_pending" }>): void {
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    const authEpoch = this.pendingAuthEpochWithTruth(cmd, rt);
    if (authEpoch === null) return;
    const result = rt?.clearPending(cmd.pendingId, authEpoch) ?? { ok: true as const };
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result });
  }

  private resolvePermission(cmd: Extract<RuntimeStreamCommand, { kind: "resolve_permission" }>): void {
    const authEpoch = this.requireAuthEpoch(cmd);
    if (authEpoch === null) return;
    const rt = sessionManager.getRuntime(cmd.userId, cmd.sessionId);
    try {
      rt?.resolvePermission(cmd.requestId, cmd.decision, authEpoch);
    } catch (error) {
      this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "forbidden", message: errorMessage(error) });
      return;
    }
    this.sendEnv({ kind: "ack", reqId: cmd.reqId, result: { found: Boolean(rt) } });
  }

  private rewind(cmd: Extract<RuntimeStreamCommand, { kind: "rewind" }>): void {
    const authEpoch = this.requireAuthEpoch(cmd);
    if (authEpoch === null) return;
    void sessionManager
      .rewind(cmd.userId, cmd.sessionId, cmd.toSeq, cmd.newText, authEpoch)
      .then((res) => {
        if (res.ok) {
          this.sessionSubs.get(cmd.sessionId)?.unsub();
          this.sessionSubs.delete(cmd.sessionId);
        }
        this.sendEnv({
          kind: "ack",
          reqId: cmd.reqId,
          result: res.ok
            ? { topic: "rewind", sessionId: cmd.sessionId, ok: true }
            : { topic: "rewind", sessionId: cmd.sessionId, ok: false, reason: res.reason },
        });
      })
      .catch((err) => {
        this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "internal", message: errorMessage(err) });
      });
  }

  private setSandbox(cmd: Extract<RuntimeStreamCommand, { kind: "set_sandbox" }>): void {
    const authEpoch = this.requireAuthEpoch(cmd);
    if (authEpoch === null) return;
    void sessionManager
      .setSandbox(cmd.userId, cmd.sessionId, cmd.sandboxKind, cmd.targetId, authEpoch)
      .then((res) => {
        if (res.ok) {
          this.sessionSubs.get(cmd.sessionId)?.unsub();
          this.sessionSubs.delete(cmd.sessionId);
        }
        this.sendEnv({
          kind: "ack",
          reqId: cmd.reqId,
          result: res.ok
            ? { topic: "set_sandbox", sessionId: cmd.sessionId, ok: true }
            : { topic: "set_sandbox", sessionId: cmd.sessionId, ok: false, reason: res.reason },
        });
      })
      .catch((err) => {
        this.sendEnv({ kind: "error", reqId: cmd.reqId, code: "internal", message: errorMessage(err) });
      });
  }
}
