import { WebSocketServer, WebSocket } from "ws";
import { performance } from "node:perf_hooks";
import { verifyToken, type AuthedUser } from "../identity/auth.ts";
import { socketDenial, executionDenial, tokenStillValidForUser } from "../identity/access-gate.ts";
import { runtimeDrainState } from "../runtime/runtime-drain-state.ts";
import {
  createSessionGateway,
  type SessionGateway,
  type SubscribeBindProfile,
  type SubscribeReplayProfile,
} from "../runtime/session-gateway.ts";
import { safeCloseWs } from "./ws-util.ts";
import { browserWsPerMessageDeflate } from "./ws-compression.ts";
import { PENDING_MUTATION_TYPED_PROTOCOL_VERSION, PROTOCOL_VERSION, TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION, isPendingMessageKind, type ClientOp, type PendingMutationResult, type ServerEvent, type TimelineItem, type TimelineReplayCursor, type WireAgentEvent } from "../../../shared/src/protocol.ts";
import { servedAppVersion } from "../config.ts";
import { logAudit } from "../observability/audit-log.ts";

function envNumber(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name];
  const n = raw == null || raw === "" ? fallback : Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
const SUBSCRIBE_PROFILE_RATE = envNumber("AGENT_WEB_SUBSCRIBE_PROFILE_RATE", 0.1, 0, 1);
const SUBSCRIBE_PROFILE_SLOW_MS = envNumber("AGENT_WEB_SUBSCRIBE_PROFILE_SLOW_MS", 100, 0, Number.MAX_SAFE_INTEGER);
const SUBSCRIBE_FRAME_TYPES = new Set<ServerEvent["type"]>([
  "timeline_replay",
  "pending_queue",
  "session_status",
  "recap",
  "context_usage",
  "permission_request",
]);

interface SubscribeSendTrace {
  sessionId: string;
  reqId?: string;
  resumeOffered: boolean;
  frames: number;
  jsonBytes: number;
  jsonMs: number;
  socketCallbackWaitTotalMs: number;
  firstSocketSendAt?: number;
  lastSocketCallbackAt?: number;
  pendingFlushes: number;
  flushErrors: number;
  bind?: SubscribeBindProfile;
  replay?: SubscribeReplayProfile;
  totalUntilAckMs?: number;
  finalized: boolean;
  logged: boolean;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

export function pendingMutationBrowserResponse(
  clientProtocolVersion: number,
  reqId: string | undefined,
  sessionId: string,
  result: PendingMutationResult,
): ServerEvent {
  if (result.ok || clientProtocolVersion < PENDING_MUTATION_TYPED_PROTOCOL_VERSION) {
    return { type: "ack", reqId };
  }
  return { type: "error", reqId, sessionId, code: result.code, message: result.message };
}

function downgradeTimelineItemForV4(item: TimelineItem): TimelineItem {
  if (item.kind !== "tool") return item;
  return {
    ...item,
    status: item.status === "ready" ? "streaming_args" : item.status,
    ...(item.children ? { children: item.children.map(downgradeTimelineItemForV4) } : {}),
  };
}

function downgradeWireEventForV4(event: WireAgentEvent): WireAgentEvent | null {
  if (event.t === "tool_status" && event.status === "ready") return null;
  if (event.t === "subagent_event") {
    const child = downgradeWireEventForV4(event.event);
    return child ? { ...event, event: child } : null;
  }
  return event;
}

export function shapeEventForBrowserProtocol(clientProtocolVersion: number, input: ServerEvent): ServerEvent[] {
  let ev = input;
  if (clientProtocolVersion < PENDING_MUTATION_TYPED_PROTOCOL_VERSION && ev.type === "error" && ev.code) {
    return [{ type: "ack", reqId: ev.reqId }];
  }
  if (clientProtocolVersion < TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION) {
    if (ev.type === "timeline_replay") {
      ev = { ...ev, items: ev.items.filter((item) => item.kind !== "team_assignment") };
    } else if (ev.type === "agent_event" && ev.event.t === "team_assignment") {
      return [];
    }
  }
  if (clientProtocolVersion < 5) {
    if (ev.type === "timeline_replay") {
      ev = { ...ev, items: ev.items.map(downgradeTimelineItemForV4) };
    } else if (ev.type === "agent_event") {
      const event = downgradeWireEventForV4(ev.event);
      if (!event) return [];
      ev = { ...ev, event };
    }
  }
  if (clientProtocolVersion >= 4) return [ev];
  if (ev.type === "timeline_replay") {
    const recaps = ev.items.filter((item): item is Extract<(typeof ev.items)[number], { kind: "recap" }> => item.kind === "recap");
    const replay: ServerEvent = { ...ev, items: ev.items.filter((item) => item.kind !== "recap") };
    const latest = recaps.at(-1);
    return latest
      ? [replay, { type: "recap", sessionId: ev.sessionId, text: latest.text, ts: latest.ts }]
      : [replay];
  }
  if (ev.type === "agent_event" && ev.event.t === "recap") {
    return [{ type: "recap", sessionId: ev.sessionId, text: ev.event.text, ts: ev.event.ts }];
  }
  return [ev];
}

function rewindFailureMessage(reason: string): string {
  switch (reason) {
    case "busy": return "Can't edit while the assistant is responding — stop the turn first.";
    case "compacted": return "Can't edit a message from before a context compaction.";
    case "not-rewindable": return "That message can't be edited.";
    case "not found": return "Session not found.";
    default: return reason || "Couldn't rewind the conversation.";
  }
}

function setSandboxFailureMessage(reason: string): string {
  switch (reason) {
    case "busy": return "Can't switch the workspace while the assistant is responding — stop the turn first.";
    case "e2b-unavailable": return "The E2B cloud sandbox isn't configured on this server.";
    case "e2b-capacity-unavailable": return "E2B cloud capacity is unavailable. Connect your own computer to use file uploads and execution tools.";
    case "not found": return "Session not found.";
    default: return reason || "Couldn't switch the execution target.";
  }
}

export function createWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: browserWsPerMessageDeflate(),
    maxPayload: 8 * 1024 * 1024,
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const advertisedProtocol = Number(url.searchParams.get("protocolVersion") ?? 0);
    const clientProtocolVersion = Number.isSafeInteger(advertisedProtocol) && advertisedProtocol > 0
      ? advertisedProtocol
      : 0;
    const user = verifyToken(token);
    if (!user) {
      ws.close(4001, "unauthorized");
      return;
    }
    const denial = socketDenial(user.id);
    if (denial) {
      ws.close(denial.wsCode, denial.kind);
      return;
    }
    new Connection(ws, user, token, clientProtocolVersion);
  });

  return wss;
}

class Connection {
  private gateway: SessionGateway;
  private subscribeTraces = new Map<string, SubscribeSendTrace>();
  private closed = false;

  constructor(
    private ws: WebSocket,
    private user: AuthedUser,
    private token: string,
    private clientProtocolVersion: number,
  ) {
    this.gateway = createSessionGateway(
      user.id,
      user.passwordChangedAt!,
      (ev) => this.send(ev),
      (code, reason) => safeCloseWs(this.ws, code >= 4000 && code < 5000 ? code : 1011, reason),
    );
    this.send({ type: "hello", userId: user.id, protocolVersion: PROTOCOL_VERSION, appVersion: servedAppVersion() });
    ws.on("message", (data) => {
      const raw = data.toString();
      void this.onMessage(raw).catch((e) => {
        let reqId: string | undefined;
        let sessionId: string | undefined;
        try {
          const failed = JSON.parse(raw) as { reqId?: unknown; sessionId?: unknown };
          if (typeof failed.reqId === "string") reqId = failed.reqId;
          if (typeof failed.sessionId === "string") sessionId = failed.sessionId;
        } catch {  }
        try {
          this.send({
            type: "error",
            reqId,
            sessionId,
            message: e instanceof Error ? e.message : "internal error",
          });
        } catch {  }
      });
    });
    ws.on("close", () => this.close());
    ws.on("error", () => this.close());
  }

  private send(ev: ServerEvent): void {
    for (const shaped of shapeEventForBrowserProtocol(this.clientProtocolVersion, ev)) this.sendFrame(shaped);
  }

  private answerPendingMutation(reqId: string | undefined, sessionId: string, result: PendingMutationResult): void {
    this.send(pendingMutationBrowserResponse(this.clientProtocolVersion, reqId, sessionId, result));
  }

  private sendFrame(ev: ServerEvent): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const sessionId = "sessionId" in ev && typeof ev.sessionId === "string" ? ev.sessionId : null;
      const trace = sessionId && SUBSCRIBE_FRAME_TYPES.has(ev.type) ? this.subscribeTraces.get(sessionId) : undefined;
      if (!trace) {
        this.ws.send(JSON.stringify(ev));
        return;
      }
      const stringifyStarted = performance.now();
      const payload = JSON.stringify(ev);
      const jsonMs = performance.now() - stringifyStarted;
      trace.frames++;
      trace.jsonBytes += Buffer.byteLength(payload);
      trace.jsonMs += jsonMs;
      trace.pendingFlushes++;
      const flushStarted = performance.now();
      trace.firstSocketSendAt ??= flushStarted;
      this.ws.send(payload, (error) => {
        const callbackAt = performance.now();
        trace.socketCallbackWaitTotalMs += callbackAt - flushStarted;
        trace.lastSocketCallbackAt = callbackAt;
        if (error) trace.flushErrors++;
        trace.pendingFlushes--;
        this.maybeLogSubscribeTrace(trace);
      });
    }
  }

  private beginSubscribeTrace(sessionId: string, reqId: string | undefined, resumeOffered: boolean): SubscribeSendTrace {
    const prior = this.subscribeTraces.get(sessionId);
    if (prior && !prior.logged) {
      prior.finalized = true;
      this.maybeLogSubscribeTrace(prior, true);
    }
    const trace: SubscribeSendTrace = {
      sessionId,
      reqId,
      resumeOffered,
      frames: 0,
      jsonBytes: 0,
      jsonMs: 0,
      socketCallbackWaitTotalMs: 0,
      pendingFlushes: 0,
      flushErrors: 0,
      finalized: false,
      logged: false,
    };
    this.subscribeTraces.set(sessionId, trace);
    return trace;
  }

  private finishSubscribeTrace(
    trace: SubscribeSendTrace,
    bind: SubscribeBindProfile,
    replay: SubscribeReplayProfile,
    totalUntilAckMs: number,
  ): void {
    trace.bind = bind;
    trace.replay = replay;
    trace.totalUntilAckMs = totalUntilAckMs;
    trace.finalized = true;
    trace.fallbackTimer = setTimeout(() => this.maybeLogSubscribeTrace(trace, true), 5_000);
    trace.fallbackTimer.unref?.();
    this.maybeLogSubscribeTrace(trace);
  }

  private maybeLogSubscribeTrace(trace: SubscribeSendTrace, force = false): void {
    if (trace.logged || !trace.finalized || !trace.bind || !trace.replay) return;
    if (!force && trace.pendingFlushes > 0) return;
    trace.logged = true;
    if (trace.fallbackTimer) clearTimeout(trace.fallbackTimer);
    if (this.subscribeTraces.get(trace.sessionId) === trace) this.subscribeTraces.delete(trace.sessionId);
    const slow = (trace.totalUntilAckMs ?? 0) >= SUBSCRIBE_PROFILE_SLOW_MS;
    if (!trace.replay.replayed && !slow && Math.random() >= SUBSCRIBE_PROFILE_RATE) return;
    const runtimeWorkerOverheadMs = trace.bind.topology === "remote"
      ? Math.max(0, trace.bind.gatewayRoundTripMs - trace.bind.runtimeResolveMs)
      : 0;
    const socketCallbackWallMs = trace.firstSocketSendAt === undefined
      ? 0
      : Math.max(0, (trace.lastSocketCallbackAt ?? performance.now()) - trace.firstSocketSendAt);
    logAudit("session_subscribe_profile", {
      userId: this.user.id,
      sessionId: trace.sessionId,
      requestId: trace.reqId,
      data: {
        topology: trace.bind.topology,
        resumeOffered: trace.resumeOffered,
        replayed: trace.replay.replayed,
        runtimeReused: trace.bind.runtimeReused,
        runtimeRowLookupMs: trace.bind.runtimeRowLookupMs,
        runtimeConstructMs: trace.bind.runtimeConstructMs,
        runtimeResolveMs: trace.bind.runtimeResolveMs,
        runtimeWorkerOverheadMs,
        bindGatewayMs: trace.bind.gatewayRoundTripMs,
        snapshotReadMs: trace.replay.snapshotReadMs,
        replayGatewayMs: trace.replay.gatewayRoundTripMs,
        serverJsonMs: trace.jsonMs,
        socketCallbackWallMs,
        socketCallbackWaitTotalMs: trace.socketCallbackWaitTotalMs,
        totalUntilAckMs: trace.totalUntilAckMs,
        timelineItems: trace.replay.timelineItems,
        frames: trace.frames,
        jsonBytes: trace.jsonBytes,
        flushErrors: trace.flushErrors,
        flushIncomplete: trace.pendingFlushes > 0,
      },
    });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const trace of this.subscribeTraces.values()) {
      this.maybeLogSubscribeTrace(trace, true);
      if (trace.fallbackTimer) clearTimeout(trace.fallbackTimer);
      trace.logged = true;
    }
    this.subscribeTraces.clear();
    this.gateway.close();
  }

  private async onMessage(raw: string): Promise<void> {
    const denial = socketDenial(this.user.id);
    if (denial) {
      this.ws.close(denial.wsCode, denial.kind);
      return;
    }
    if (!tokenStillValidForUser(this.token, this.user.id)) {
      this.ws.close(4001, "unauthorized");
      return;
    }
    let op: ClientOp;
    try {
      op = JSON.parse(raw) as ClientOp;
    } catch {
      this.send({ type: "error", message: "invalid JSON" });
      return;
    }

    switch (op.type) {
      case "ping":
        this.send({ type: "pong", reqId: op.reqId });
        break;

      case "subscribe":
        await this.doSubscribe(op.sessionId, op.reqId, op.resume);
        break;

      case "subscribe_status":
        await this.gateway.subscribeUserStatus();
        this.send({ type: "ack", reqId: op.reqId });
        break;

      case "send_message": {
        if (!(await this.gateway.ensureSubscribed(op.sessionId, op.reqId))) return;
        const canvasState = typeof op.canvasState === "string" ? op.canvasState : undefined;
        const accepted = await this.gateway.submitMessage(op.sessionId, op.text, op.mode, op.reqId, canvasState);
        if (!accepted) break;
        this.send({ type: "ack", reqId: op.reqId });
        break;
      }

      case "interrupt":
        await this.gateway.interrupt(op.sessionId);
        this.send({ type: "ack", reqId: op.reqId });
        break;

      case "clear_pending":
        this.answerPendingMutation(
          op.reqId,
          op.sessionId,
          await this.gateway.clearPending(op.sessionId, op.pendingId),
        );
        break;

      case "set_pending_kind":
        if (!isPendingMessageKind(op.kind)) {
          this.send({ type: "error", reqId: op.reqId, message: "invalid pending message kind" });
          break;
        }
        this.answerPendingMutation(
          op.reqId,
          op.sessionId,
          await this.gateway.setPendingKind(op.sessionId, op.pendingId, op.kind),
        );
        break;

      case "set_pending_text":
        this.answerPendingMutation(
          op.reqId,
          op.sessionId,
          await this.gateway.setPendingText(op.sessionId, op.pendingId, op.text),
        );
        break;

      case "reorder_pending":
        this.answerPendingMutation(
          op.reqId,
          op.sessionId,
          await this.gateway.reorderPending(op.sessionId, op.order),
        );
        break;

      case "rewind": {
        const rewindDenial = op.newText
          ? executionDenial(this.user.id, { includeDraining: true })
          : runtimeDrainState.isDraining()
            ? ({ message: "The server is restarting — try again in a moment." } as const)
            : null;
        if (rewindDenial) {
          this.send({ type: "error", reqId: op.reqId, message: rewindDenial.message });
          break;
        }
        const res = await this.gateway.rewind(op.sessionId, op.toSeq, op.newText);
        if (!res.ok) {
          this.send({ type: "error", reqId: op.reqId, message: rewindFailureMessage(res.reason) });
          await this.doSubscribe(op.sessionId);
          break;
        }
        await this.doSubscribe(op.sessionId, op.reqId);
        break;
      }

      case "set_sandbox": {
        if (runtimeDrainState.isDraining()) {
          this.send({ type: "error", reqId: op.reqId, message: "The server is restarting — try again in a moment." });
          break;
        }
        const res = await this.gateway.setSandbox(op.sessionId, op.kind, op.targetId);
        if (!res.ok) {
          this.send({ type: "error", reqId: op.reqId, message: setSandboxFailureMessage(res.reason) });
          await this.doSubscribe(op.sessionId);
          break;
        }
        await this.doSubscribe(op.sessionId, op.reqId);
        break;
      }

      case "permission_response":
        await this.gateway.resolvePermission(op.sessionId, op.requestId, op.decision);
        this.send({ type: "ack", reqId: op.reqId });
        break;

      default:
        this.send({ type: "error", message: "unknown op" });
    }
  }

  private async doSubscribe(sessionId: string, reqId?: string, resume?: TimelineReplayCursor): Promise<void> {
    const started = performance.now();
    const trace = this.beginSubscribeTrace(sessionId, reqId, Boolean(resume));
    try {
      const bind = await this.gateway.profileEnsureSubscribed(sessionId, reqId);
      if (!bind.ok) {
        if (this.subscribeTraces.get(sessionId) === trace) this.subscribeTraces.delete(sessionId);
        return;
      }
      const replay = await this.gateway.profileReplaySubscribed(sessionId, resume);
      this.send({ type: "ack", reqId });
      this.finishSubscribeTrace(trace, bind, replay, performance.now() - started);
    } catch (error) {
      if (trace.fallbackTimer) clearTimeout(trace.fallbackTimer);
      trace.logged = true;
      if (this.subscribeTraces.get(sessionId) === trace) this.subscribeTraces.delete(sessionId);
      throw error;
    }
  }
}
