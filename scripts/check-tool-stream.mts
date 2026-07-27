import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-tool-stream-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "120";

const { reduceTimeline, timelineSeqAllocator } = await import("../shared/src/timeline-reducer.ts");
const { toolResultPlaceholderKey } = await import("../web/src/conversation/tools/tool-presentation-helpers.tsx");
const { shellDetailSurface } = await import("../web/src/dashboard/session/tools/shell-inspector-state.ts");
import type { TimelineItem, WireAgentEvent, ToolCallStatus } from "../shared/src/protocol.ts";

assert.equal(toolResultPlaceholderKey("committing"), "tool.phaseReady");
assert.notEqual(toolResultPlaceholderKey("committing"), "tool.running");
const shellItem = (status: ToolCallStatus, extra: Partial<Extract<TimelineItem, { kind: "tool" }>> = {}) => ({
  kind: "tool" as const,
  id: "shell_surface",
  seq: 1,
  name: "bash",
  toolKind: "shell" as const,
  arguments: { command: "printf ok" },
  status,
  ts: 1,
  ...extra,
});
assert.equal(shellDetailSurface(shellItem("ready")), "command", "ready is not execution");
assert.equal(shellDetailSurface(shellItem("error", { resultText: "provider failed" })), "details", "pre-dispatch errors are details");
assert.equal(shellDetailSurface(shellItem("running")), "output", "running proves execution");
assert.equal(shellDetailSurface(shellItem("error", { resultText: "exit 1", durationMs: 4 })), "output", "runtime errors retain output");
const enSource = fs.readFileSync(new URL("../web/src/i18n/en.ts", import.meta.url), "utf8");
const zhSource = fs.readFileSync(new URL("../web/src/i18n/zh.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  enSource,
  /"tool\.(?:cancelled|cancelledPath|phaseCancelled)":\s*"[^"]*before running/i,
  "shared cancellation chrome is phase-neutral because a running tool can already have side effects",
);
assert.doesNotMatch(
  zhSource,
  /"tool\.(?:cancelled|cancelledPath|phaseCancelled)":\s*"[^"]*运行前/,
);
assert.match(enSource, /"chat\.actWaitingModelCommit":\s*"Tool ready/);
assert.match(zhSource, /"chat\.actWaitingModelCommit":\s*"工具已就绪/);

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string, e: unknown) => {
  failed++;
  console.error(`  ✗ ${msg}: ${e instanceof Error ? e.message : e}`);
};

const RANK: Record<ToolCallStatus, number> = {
  streaming_args: 0,
  ready: 1,
  pending: 2,
  approved: 3,
  running: 4,
  success: 5,
  error: 5,
  denied: 5,
};

async function runE2E(): Promise<void> {
  const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
  const { sessionManager } = await import("../server/src/runtime/manager.ts");
  const { signup } = await import("../server/src/identity/auth.ts");
  const {
    auditEventDao,
    agentTurnDao,
    joinedTaskProgressDao,
    pendingMessageDao,
    runtimeTaskDao,
    sessionDao,
    timelineDao,
  } = await import("../server/src/persistence/index.ts");

  registerMockProvider();
  const user = await signup(`tool-stream-${process.pid}@gmail.com`, "password123");
  const session = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const rt = sessionManager.getRuntime(user.id, session.id);
  assert.ok(rt, "runtime built");

  const events: WireAgentEvent[] = [];
  const eventTimes: number[] = [];
  const done = new Promise<void>((resolve) => {
    const unsub = rt!.subscribe((ev) => {
      if (ev.type === "agent_event") {
        events.push(ev.event);
        eventTimes.push(performance.now());
        if (ev.event.t === "turn_end") {
          unsub();
          resolve();
        }
      }
    });
  });

  const content = Array.from({ length: 24 }, (_, i) => `line ${i + 1} of the streamed file`).join("\n");
  await rt!.sendMessage(`/write notes/out.txt\n${content}`);
  await done;

  const toolStart = events.find((e) => e.t === "tool_start") as Extract<WireAgentEvent, { t: "tool_start" }> | undefined;
  assert.ok(toolStart, "a tool_start was emitted");
  const callId = toolStart!.id;
  assert.equal(toolStart!.name, "write_file", "tool is write_file");

  const firstAssistantToolIdx = events.findIndex(
    (e) =>
      (e.t === "assistant_update" || e.t === "assistant_end") &&
      (e.blocks ?? []).some((b) => b.type === "toolCall" && b.id === callId),
  );
  const toolStartIdx = events.findIndex((e) => e.t === "tool_start" && e.id === callId);
  assert.ok(firstAssistantToolIdx !== -1, "a toolCall block was streamed via assistant_update/end");
  assert.ok(
    firstAssistantToolIdx <= toolStartIdx,
    `toolCall block streamed (idx ${firstAssistantToolIdx}) at/before tool_start (idx ${toolStartIdx})`,
  );

  const streamedContents: string[] = [];
  for (const e of events) {
    if (e.t === "assistant_update" || e.t === "assistant_end") {
      const blk = (e.blocks ?? []).find((b) => b.type === "toolCall" && b.id === callId) as
        | { arguments?: Record<string, unknown> }
        | undefined;
      const c = blk && typeof blk.arguments?.content === "string" ? (blk.arguments!.content as string) : undefined;
      if (c !== undefined) streamedContents.push(c);
    }
  }
  assert.ok(streamedContents.length >= 2, `content streamed across >=2 updates (got ${streamedContents.length})`);
  for (let i = 1; i < streamedContents.length; i++) {
    assert.ok(
      streamedContents[i].length >= streamedContents[i - 1].length &&
        streamedContents[i].startsWith(streamedContents[i - 1]),
      `streamed content is a growing prefix at step ${i}`,
    );
  }
  assert.equal(streamedContents[streamedContents.length - 1], content, "final streamed content == full file");

  let timeline: TimelineItem[] = [];
  const statusTrace: ToolCallStatus[] = [];
  let lastRank = -1;
  for (const e of events) {
    timeline = reduceTimeline(timeline, e);
    const toolItems = timeline.filter((t) => t.kind === "tool" && t.id === callId);
    assert.ok(toolItems.length <= 1, "never more than one tool item for the call id");
    const it = toolItems[0] as Extract<TimelineItem, { kind: "tool" }> | undefined;
    if (it) {
      const r = RANK[it.status];
      assert.ok(r >= lastRank, `status never regresses (was rank ${lastRank}, now ${it.status})`);
      if (statusTrace[statusTrace.length - 1] !== it.status) statusTrace.push(it.status);
      lastRank = r;
    }
  }

  const finalItems = timeline.filter((t) => t.kind === "tool" && t.id === callId) as Extract<
    TimelineItem,
    { kind: "tool" }
  >[];
  assert.equal(finalItems.length, 1, "exactly ONE tool timeline item for the call");
  const final = finalItems[0];
  assert.equal(final.status, "success", "final status is success");
  assert.equal(final.toolKind, "write", "toolKind projected as write");
  assert.equal(final.path, "notes/out.txt", "path projected");
  assert.equal((final.arguments as Record<string, unknown>).content, content, "final args.content complete");
  assert.equal(statusTrace[0], "streaming_args", `first observed status is streaming_args (trace: ${statusTrace.join(" -> ")})`);
  assert.ok(statusTrace.includes("ready"), "toolcall_end surfaced the arguments-ready/provider-commit phase");
  assert.ok(statusTrace.includes("running"), "passed through running");
  const runningEvent = events.find((event): event is Extract<WireAgentEvent, { t: "tool_status" }> =>
    event.t === "tool_status" && event.id === callId && event.status === "running");
  assert.ok(runningEvent, "running boundary is emitted");
  assert.ok(Number.isFinite(runningEvent.runningElapsedMs) && runningEvent.runningElapsedMs! >= 0,
    "running boundary carries a server-relative elapsed base");
  const readyIndex = events.findIndex((event) => event.t === "tool_status" && event.id === callId && event.status === "ready");
  const dispatchIndex = events.findIndex((event) => event.t === "tool_start" && event.id === callId);
  assert.ok(readyIndex >= 0 && dispatchIndex > readyIndex, "ready precedes tool dispatch");
  assert.ok(eventTimes[dispatchIndex] - eventTimes[readyIndex] >= 100, "provider terminal wait remains visible as ready for >=100ms");
  const timingAudit = auditEventDao.recent(100)
    .filter((row) => row.session_id === session.id && (row.event === "provider_stream_settled" || row.event === "provider_message_handled"));
  const settled = timingAudit.find((row) =>
    row.event === "provider_stream_settled" && JSON.parse(row.data_json).modelRound === 1);
  const handled = timingAudit.find((row) =>
    row.event === "provider_message_handled" && JSON.parse(row.data_json).modelRound === 1);
  assert.ok(settled, "provider adapter settlement is audit-visible");
  assert.ok(handled, "local message handler duration is audit-visible separately");
  const settledData = JSON.parse(settled!.data_json) as Record<string, unknown>;
  const handledData = JSON.parse(handled!.data_json) as Record<string, unknown>;
  assert.ok(Number(settledData.requestToFirstDeltaMs) >= 0, "first real delta timing is recorded");
  assert.ok(Number(settledData.lastContentEndToAdapterSettledMs) >= 100, "content-end → adapter tail is isolated");
  assert.ok(Number(handledData.handlerMs) >= 0, "local handler timing is non-negative");
  const profileOut = process.env.OIIA_TOOL_PROFILE_OUT;
  if (profileOut) {
    const keep = new Set([
      "provider_stream_settled",
      "provider_message_handled",
      "tool_arguments_ready",
      "tool_start",
      "tool_running",
      "tool_end",
      "model_round_end",
      "turn_end",
    ]);
    const audit = auditEventDao.recent(100)
      .filter((row) => row.session_id === session.id && keep.has(row.event))
      .reverse()
      .map((row) => {
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        delete data.turnId;
        delete data.toolCallId;
        return { event: row.event, data };
      });
    fs.mkdirSync(path.dirname(profileOut), { recursive: true });
    fs.writeFileSync(profileOut, `${JSON.stringify({
      statusTrace,
      readyVisibleMs: Math.round(eventTimes[dispatchIndex] - eventTimes[readyIndex]),
      audit,
    }, null, 2)}\n`);
  }
  ok(`E2E mock stream: 1 item, content streamed in ${streamedContents.length} steps, status ${statusTrace.join(" -> ")}`);

  const timedSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const timedRuntime = sessionManager.getRuntime(user.id, timedSession.id);
  assert.ok(timedRuntime);
  let resolveRunning!: () => void;
  const running = new Promise<void>((resolve) => { resolveRunning = resolve; });
  timedRuntime!.subscribe((event) => {
    if (event.type === "agent_event" && event.event.t === "tool_status" && event.event.status === "running") resolveRunning();
  });
  const timedTurn = timedRuntime!.sendMessage("/bash sleep 0.35; printf 'timer-ready\\n'");
  await running;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const runningReplay = timedRuntime!.getTimeline().find(
    (row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.status === "running",
  );
  assert.ok(runningReplay, "running tool is present in replay");
  assert.ok((runningReplay.runningElapsedMs ?? 0) >= 60, `replay elapsed base advances (${runningReplay.runningElapsedMs}ms)`);
  await timedTurn;
  const settledReplay = timedRuntime!.getTimeline().find(
    (row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool",
  );
  assert.ok(settledReplay?.durationMs != null && settledReplay.durationMs >= 300, "final duration stays server-authoritative");
  assert.equal(settledReplay?.runningElapsedMs, undefined, "terminal replay drops the transient running base");
  ok("running replay: relative timer base advances and final duration settles authoritatively");

  const turnEndSteerSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const turnEndSteerRuntime = sessionManager.getRuntime(user.id, turnEndSteerSession.id);
  assert.ok(turnEndSteerRuntime);
  let turnEndSteer: Promise<void> | null = null;
  turnEndSteerRuntime!.subscribe((event) => {
    if (event.type !== "agent_event" || event.event.t !== "turn_end" || turnEndSteer) return;
    assert.equal(turnEndSteerRuntime!.isBusy(), true);
    assert.equal(turnEndSteerRuntime!.canSteer(), false);
    turnEndSteer = turnEndSteerRuntime!.steer("LATE_AFTER_TURN_END becomes fresh");
  });
  await turnEndSteerRuntime!.sendMessage("first normal Turn");
  assert.ok(turnEndSteer);
  await turnEndSteer;
  const turnEndSteerDeadline = Date.now() + 3_000;
  while ((agentTurnDao.list(turnEndSteerSession.id).length < 2 || turnEndSteerRuntime!.isBusy()) && Date.now() < turnEndSteerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const turnEndSteerTurns = agentTurnDao.list(turnEndSteerSession.id);
  const turnEndSteerUsers = timelineDao.list(turnEndSteerSession.id)
    .filter((row): row is Extract<TimelineItem, { kind: "user" }> => row.kind === "user");
  assert.deepEqual(turnEndSteerTurns.map((turn) => turn.status), ["completed", "completed"]);
  assert.deepEqual(turnEndSteerUsers.map((row) => row.text), ["first normal Turn", "LATE_AFTER_TURN_END becomes fresh"]);
  assert.notEqual(turnEndSteerUsers[0].turnId, turnEndSteerUsers[1].turnId);
  assert.equal(pendingMessageDao.listPending(turnEndSteerSession.id).length, 0);
  ok("turn_end steer edge: queued as a fresh Agent Turn, never stranded in pi");

  const abortSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const abortRuntime = sessionManager.getRuntime(user.id, abortSession.id);
  assert.ok(abortRuntime);
  const abortEvents: WireAgentEvent[] = [];
  let interrupted = false;
  abortRuntime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    abortEvents.push(event.event);
    if (!interrupted && event.event.t === "tool_status" && event.event.status === "ready") {
      interrupted = true;
      abortRuntime!.interrupt();
    }
  });
  await abortRuntime!.sendMessage("/write stopped-before-dispatch.txt\nnever written");
  const abortReady = abortEvents.find((event) => event.t === "tool_status" && event.status === "ready");
  assert.ok(abortReady && abortReady.t === "tool_status");
  const abortEnd = abortEvents.find((event) => event.t === "tool_end" && event.id === abortReady.id) as
    | Extract<WireAgentEvent, { t: "tool_end" }>
    | undefined;
  assert.equal(abortEnd?.status, "denied", "rollback-safe v4 status is terminal denied");
  assert.equal(abortEnd?.termination, "cancelled", "v5 distinguishes cancellation from user denial");
  assert.equal(abortEnd?.isError, false, "user Stop is not a service/tool failure");
  const abortReduced = abortEvents.reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const abortReducedTool = abortReduced.find((row): row is Extract<TimelineItem, { kind: "tool" }> =>
    row.kind === "tool" && row.id === abortReady.id);
  assert.equal(abortReducedTool?.status, "denied", "live reducer reaches a rollback-safe terminal state");
  assert.equal(abortReducedTool?.termination, "cancelled");
  assert.equal(abortEvents.find((event) => event.t === "turn_end")?.t === "turn_end" &&
    (abortEvents.find((event) => event.t === "turn_end") as Extract<WireAgentEvent, { t: "turn_end" }>).status,
  "interrupted");
  assert.equal(abortEvents.some((event) => event.t === "error"), false, "Stop emits no red model error");
  const abortReplayTool = timelineDao.list(abortSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.id === abortReady.id);
  assert.equal(abortReplayTool?.status, "denied");
  assert.equal(abortReplayTool?.termination, "cancelled");
  assert.equal(agentTurnDao.list(abortSession.id).at(-1)?.status, "interrupted");
  assert.equal(sessionDao.byId(abortSession.id)?.status, "idle");
  ok("ready → Stop: terminal cancelled Step, interrupted Turn, idle Session, no error");

  const dispatchStopSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const dispatchStopRuntime = sessionManager.getRuntime(user.id, dispatchStopSession.id);
  assert.ok(dispatchStopRuntime);
  const dispatchStopEvents: WireAgentEvent[] = [];
  let stoppedAtToolStart = false;
  dispatchStopRuntime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    dispatchStopEvents.push(event.event);
    if (!stoppedAtToolStart && event.event.t === "tool_start") {
      stoppedAtToolStart = true;
      dispatchStopRuntime!.interrupt();
    }
  });
  await dispatchStopRuntime!.sendMessage("/write stop-at-dispatch.txt\nnever written");
  const dispatchStopEnd = dispatchStopEvents.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
    event.t === "tool_end" && event.termination === "cancelled");
  assert.ok(dispatchStopEnd);
  assert.equal(dispatchStopEnd.status, "denied");
  assert.equal(dispatchStopEnd.isError, false);
  assert.equal((dispatchStopEvents.find((event) => event.t === "turn_end") as Extract<WireAgentEvent, { t: "turn_end" }> | undefined)?.status, "interrupted");
  const dispatchStopReplay = timelineDao.list(dispatchStopSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.equal(dispatchStopReplay?.termination, "cancelled");
  assert.equal(dispatchStopReplay?.isError, false);
  ok("tool_start → Stop: pre-run Step cancels neutrally instead of reporting tool failure");

  const runningStopSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const runningStopRuntime = sessionManager.getRuntime(user.id, runningStopSession.id);
  assert.ok(runningStopRuntime);
  const runningStopEvents: WireAgentEvent[] = [];
  let stoppedWhileRunning = false;
  runningStopRuntime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    runningStopEvents.push(event.event);
    if (!stoppedWhileRunning && event.event.t === "tool_status" && event.event.status === "running") {
      stoppedWhileRunning = true;
      runningStopRuntime!.interrupt();
    }
  });
  await runningStopRuntime!.sendMessage("/write stop-while-running.txt\nside effects are possible");
  const runningStopEnd = runningStopEvents.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
    event.t === "tool_end" && event.termination === "cancelled");
  assert.ok(runningStopEnd);
  assert.equal(runningStopEnd.status, "denied");
  assert.equal(runningStopEnd.isError, false);
  assert.match(runningStopEnd.resultText ?? "", /while this tool was running/);
  const runningStopReplay = timelineDao.list(runningStopSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.equal(runningStopReplay?.termination, "cancelled");
  assert.equal(runningStopReplay?.isError, false);
  assert.match(runningStopReplay?.resultText ?? "", /while this tool was running/);
  ok("running → Stop: neutral cancellation without claiming the Step never ran");

  const approvalSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  });
  const approvalRuntime = sessionManager.getRuntime(user.id, approvalSession.id);
  assert.ok(approvalRuntime);
  const approvalEvents: WireAgentEvent[] = [];
  let stoppedAtApproval = false;
  approvalRuntime!.subscribe((event) => {
    if (event.type === "agent_event") approvalEvents.push(event.event);
    if (!stoppedAtApproval && event.type === "permission_request") {
      stoppedAtApproval = true;
      approvalRuntime!.interrupt();
    }
  });
  await approvalRuntime!.sendMessage("/bash echo never-run > approval-stopped.txt");
  const approvalEnd = approvalEvents.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
    event.t === "tool_end" && event.termination === "cancelled");
  assert.ok(approvalEnd, "pending approval reaches the cancelled terminal frame");
  assert.equal(approvalEnd.status, "denied", "status stays protocol-v4 compatible");
  assert.equal(approvalEnd.isError, false);
  assert.equal(approvalEnd.resultText, "Interrupted before this tool could run.");
  assert.equal((approvalEvents.find((event) => event.t === "turn_end") as Extract<WireAgentEvent, { t: "turn_end" }> | undefined)?.status, "interrupted");
  assert.equal(approvalEvents.some((event) => event.t === "error"), false);
  const approvalTool = timelineDao.list(approvalSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.equal(approvalTool?.termination, "cancelled");
  assert.equal(approvalTool?.isError, false);
  ok("pending approval → Stop: neutral cancellation, never a false user denial/failure");

  const childSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const childRuntime = sessionManager.getRuntime(user.id, childSession.id);
  assert.ok(childRuntime);
  const childEvents: WireAgentEvent[] = [];
  const childVersionBefore = childRuntime!.getTimelineVersion();
  let childRunningWireVersion = -1;
  childRuntime!.subscribe((event) => {
    if (event.type === "agent_event") {
      childEvents.push(event.event);
      if (
        event.event.t === "subagent_event" &&
        event.event.event.t === "tool_status" &&
        event.event.event.status === "running"
      ) childRunningWireVersion = event.version;
    }
  });
  await childRuntime!.sendMessage("/subagent /write nested.txt\nchild proof");
  const nested = childEvents
    .filter((event): event is Extract<WireAgentEvent, { t: "subagent_event" }> => event.t === "subagent_event")
    .map((event) => event.event);
  const childWrappers = childEvents
    .filter((event): event is Extract<WireAgentEvent, { t: "subagent_event" }> => event.t === "subagent_event");
  const childProgressFrames = childEvents
    .filter((event): event is Extract<WireAgentEvent, { t: "subagent_event" | "subagent_snapshot" }> =>
      event.t === "subagent_event" || event.t === "subagent_snapshot");
  assert.deepEqual(
    childProgressFrames.map((event) => event.t === "subagent_event" ? event.progressSeq : event.progress.lastSeq),
    childProgressFrames.map((_, index) => index + 1),
    "joined Child wire uses one exact monotonic attempt cursor",
  );
  assert.ok(childWrappers.every((event) => Number.isFinite(event.progressAt)), "every Child event carries persisted time");
  const childReady = nested.find((event) => event.t === "tool_status" && event.status === "ready");
  assert.ok(childReady && childReady.t === "tool_status", "child exposes arguments-ready");
  const childRunning = nested.find((event) => event.t === "tool_status" && event.id === childReady.id && event.status === "running");
  assert.ok(childRunning && childRunning.t === "tool_status");
  assert.equal(childRunning.runningElapsedMs, 0, "child running boundary uses the same relative timer contract");
  assert.ok(nested.some((event) => event.t === "tool_end" && event.id === childReady.id && event.status === "success"));
  const childTurnEnds = nested.filter((event): event is Extract<WireAgentEvent, { t: "turn_end" }> => event.t === "turn_end");
  assert.equal(childTurnEnds.length, 1, "normal completion publishes exactly one Child turn_end");
  assert.equal(childTurnEnds[0]?.status, "completed");
  assert.ok(childRunningWireVersion > childVersionBefore, "nested progress advances the replay version before parent Tool completion");
  const childLive = childEvents.reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const childLiveParent = childLive.find((row): row is Extract<TimelineItem, { kind: "tool" }> =>
    row.kind === "tool" && row.toolKind === "subagent");
  const childPersistedParent = timelineDao.list(childSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.toolKind === "subagent");
  assert.ok(childLiveParent?.childProgress && childPersistedParent?.childProgress);
  assert.deepEqual(childLiveParent!.childProgress, childPersistedParent!.childProgress);
  assert.deepEqual(
    childLiveParent!.children?.map((row) => [row.id, row.kind, row.kind === "tool" ? row.status : null]),
    childPersistedParent!.children?.map((row) => [row.id, row.kind, row.kind === "tool" ? row.status : null]),
    "live reducer and durable replay converge on the same nested rows",
  );
  const durableChildProgress = joinedTaskProgressDao.byTask(
    user.id,
    childPersistedParent!.childProgress!.taskId,
  );
  assert.equal(durableChildProgress?.lastSeq, childProgressFrames.length);
  assert.equal(durableChildProgress?.status, "completed");
  ok("subagent: nested ready → running → success with a balanced child Turn");

  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "500";
  const stoppedChildSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const stoppedChildRuntime = sessionManager.getRuntime(user.id, stoppedChildSession.id);
  assert.ok(stoppedChildRuntime);
  const stoppedChildEvents: WireAgentEvent[] = [];
  let childStopSent = false;
  stoppedChildRuntime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    stoppedChildEvents.push(event.event);
    if (
      !childStopSent && event.event.t === "subagent_event" &&
      event.event.event.t === "tool_status" && event.event.event.status === "ready"
    ) {
      childStopSent = true;
      stoppedChildRuntime!.interrupt();
    }
  });
  await stoppedChildRuntime!.sendMessage("/subagent /write nested-stop.txt\nnever written");
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "120";
  const stoppedNested = stoppedChildEvents
    .filter((event): event is Extract<WireAgentEvent, { t: "subagent_event" }> => event.t === "subagent_event")
    .map((event) => event.event);
  const stoppedNestedTool = stoppedNested.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
    event.t === "tool_end" && event.termination === "cancelled");
  assert.ok(stoppedNestedTool);
  assert.equal(stoppedNestedTool.status, "denied");
  assert.equal(stoppedNestedTool.isError, false);
  const stoppedChildTurnEnds = stoppedNested.filter((event): event is Extract<WireAgentEvent, { t: "turn_end" }> =>
    event.t === "turn_end");
  assert.equal(stoppedChildTurnEnds.length, 1);
  assert.equal(stoppedChildTurnEnds[0]?.status, "interrupted");
  const stoppedParent = timelineDao.list(stoppedChildSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.toolKind === "subagent");
  assert.equal(stoppedParent?.status, "denied");
  assert.equal(stoppedParent?.termination, "cancelled");
  assert.equal(stoppedParent?.isError, false);
  assert.equal((stoppedChildEvents.find((event) => event.t === "turn_end") as Extract<WireAgentEvent, { t: "turn_end" }> | undefined)?.status, "interrupted");
  ok("child ready → Stop: child + parent delegation cancel neutrally; outer Turn interrupts");

  const fencedUser = await signup(`tool-child-fence-${process.pid}@gmail.com`, "password123");
  const fencedSession = sessionManager.createSession(fencedUser, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const fencedRuntime = sessionManager.getRuntime(fencedUser.id, fencedSession.id);
  assert.ok(fencedRuntime);
  const fencedEvents: WireAgentEvent[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let fencedTaskId = "";
  let recoveryWireVersion = -1;
  fencedRuntime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    fencedEvents.push(event.event);
    if (event.event.t === "subagent_snapshot") recoveryWireVersion = event.version;
    if (
      !fencedTaskId
      && event.event.t === "subagent_event"
      && event.event.event.t === "tool_status"
      && event.event.event.status === "ready"
    ) {
      fencedTaskId = event.event.taskId!;
      const task = runtimeTaskDao.byId(fencedUser.id, fencedTaskId)!;
      assert.equal(task.status, "running");
      assert.ok(runtimeTaskDao.transition({
        id: task.id,
        userId: fencedUser.id,
        expectedVersion: task.version,
        expectedLeaseGeneration: task.leaseGeneration,
        nextStatus: "interrupted",
        at: Date.now(),
        eventType: "test:forced_fence",
        eventPayload: {},
      }));
    }
  });
  await fencedRuntime!.sendMessage("/subagent /write fenced-child.txt\nnever dispatch");
  const fencedRecoveryDeadline = Date.now() + 2_000;
  while (!fencedEvents.some((event) => event.t === "subagent_snapshot") && Date.now() < fencedRecoveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.ok(fencedTaskId, "the probe fenced the exact joined Task");
  assert.deepEqual(unhandled, [], "publishProgress=false is contained by worker/Supervisor settlement");
  assert.equal(
    fencedEvents.filter((event) => event.t === "subagent_snapshot").length,
    1,
    `recovery frames: ${fencedEvents.filter((event) => event.t.startsWith("subagent")).map((event) => event.t).join(",")}`,
  );
  assert.ok(recoveryWireVersion > 0, "recovery snapshot advances the live replay cursor");
  const fencedLive = fencedEvents.reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const fencedLiveParent = fencedLive.find((row): row is Extract<TimelineItem, { kind: "tool" }> =>
    row.kind === "tool" && row.toolKind === "subagent");
  assert.equal(fencedLiveParent?.childProgress?.source, "recovery");
  assert.equal(fencedLiveParent?.childProgress?.status, "interrupted");
  assert.ok(fencedLiveParent?.children?.every((row) =>
    row.kind !== "tool" || (row.status === "denied" && row.termination === "cancelled")));
  const fencedV5Live = fencedEvents
    .filter((event) => event.t !== "subagent_snapshot")
    .map((event): WireAgentEvent => event.t === "subagent_event"
      ? { t: "subagent_event", parentId: event.parentId, event: event.event }
      : event)
    .reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const fencedV5Parent = fencedV5Live.find((row): row is Extract<TimelineItem, { kind: "tool" }> =>
    row.kind === "tool" && row.toolKind === "subagent");
  assert.equal(fencedV5Parent?.children?.some((row) =>
    (row.kind === "assistant" && row.streaming) ||
    (row.kind === "tool" && !["success", "error", "denied"].includes(row.status))), false,
  "protocol-v5 readers ignore the snapshot but receive bounded terminal compatibility deltas");
  const fencedDurable = joinedTaskProgressDao.byTask(fencedUser.id, fencedTaskId)!;
  assert.equal(fencedDurable.source, "recovery");
  assert.equal(fencedDurable.status, "interrupted");
  const fencedPersistedParent = timelineDao.list(fencedSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.toolKind === "subagent");
  assert.equal(fencedPersistedParent?.childProgress?.lastSeq, fencedDurable.lastSeq,
    "outer tool_end cannot overwrite the recovery cursor from stale runtime state");
  assert.equal(fencedPersistedParent?.childProgress?.status, "interrupted");
  assert.equal(sessionManager.disposeUserRuntimes(fencedUser.id), 1);
  const fencedReplacement = sessionManager.getRuntime(fencedUser.id, fencedSession.id);
  const fencedReplayParent = fencedReplacement!.getTimeline()
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.toolKind === "subagent");
  assert.deepEqual(fencedReplayParent?.childProgress, fencedPersistedParent?.childProgress,
    "reconstructed runtime replays the same terminal recovery projection");
  assert.equal(fencedReplayParent?.children?.some((row) => row.kind === "tool" && row.status === "running"), false);
  ok("forced Child fence: no stale overwrite/unhandled rejection; live, replay, and rebuild converge");

  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "1";
  const partialSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const partialRuntime = sessionManager.getRuntime(user.id, partialSession.id);
  assert.ok(partialRuntime);
  const partialEvents: WireAgentEvent[] = [];
  partialRuntime!.subscribe((event) => {
    if (event.type === "agent_event") partialEvents.push(event.event);
  });
  await partialRuntime!.sendMessage("/write partial-parent.txt\ncontent never completes");
  const partialReduced = partialEvents.reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const partialTools = partialReduced.filter((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.ok(partialTools.length >= 1);
  assert.ok(partialTools.every((row) =>
    (row.status === "error" && row.isError === true) ||
    (row.status === "denied" && row.termination === "cancelled" && row.isError === false)
  ), "retry attempts cancel neutrally; the exhausted attempt fails");
  assert.ok(partialTools.some((row) => row.status === "error"), "the exhausted final attempt is an error");
  assert.equal(partialTools.some((row) => row.status === "streaming_args" || row.status === "ready"), false);
  const partialReplayTools = timelineDao.list(partialSession.id)
    .filter((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.equal(partialReplayTools.length, partialTools.length);
  assert.deepEqual(
    partialReplayTools.map((row) => [row.status, row.termination ?? null]),
    partialTools.map((row) => [row.status, row.termination ?? null]),
  );
  assert.equal((partialEvents.find((event) => event.t === "turn_end") as Extract<WireAgentEvent, { t: "turn_end" }> | undefined)?.status, "failed");
  ok("mid-arguments provider failure: parent partial Step terminal in live reducer + replay");

  const errorAdmissionSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const errorAdmissionRuntime = sessionManager.getRuntime(user.id, errorAdmissionSession.id);
  assert.ok(errorAdmissionRuntime);
  let busyAtError = false;
  let reentrantAttempt: Promise<unknown> | null = null;
  errorAdmissionRuntime!.subscribe((event) => {
    if (event.type !== "session_status" || event.status !== "error" || reentrantAttempt) return;
    busyAtError = errorAdmissionRuntime!.isBusy();
    try {
      reentrantAttempt = errorAdmissionRuntime!.sendMessage("SECOND must wait").then(
        () => null,
        (error: unknown) => error,
      );
    } catch (error) {
      reentrantAttempt = Promise.resolve(error);
    }
  });
  await errorAdmissionRuntime!.sendMessage("/write admission-race.txt\npartial provider error");
  assert.equal(busyAtError, true, "outer lifecycle remains busy on the early error status edge");
  assert.ok(reentrantAttempt);
  assert.match(String(await reentrantAttempt), /session is busy/);
  const failedAdmissionTurns = agentTurnDao.list(errorAdmissionSession.id);
  assert.deepEqual(failedAdmissionTurns.map((turn) => turn.status), ["failed"]);
  const failedAdmissionAudit = auditEventDao.recent(200)
    .find((row) => row.session_id === errorAdmissionSession.id && row.event === "turn_end");
  assert.ok(failedAdmissionAudit);
  assert.equal(
    (JSON.parse(failedAdmissionAudit!.data_json) as { turnId?: string }).turnId,
    failedAdmissionTurns[0].id,
    "rejected reentrant send cannot erase the failing Turn's audit correlation",
  );
  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "0";
  await errorAdmissionRuntime!.sendMessage("SECOND after settlement");
  assert.deepEqual(agentTurnDao.list(errorAdmissionSession.id).map((turn) => turn.status), ["failed", "completed"]);
  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "1";
  ok("error status edge: Retry admission waits for durable Agent Turn settlement");

  const lateSteerSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const lateSteerRuntime = sessionManager.getRuntime(user.id, lateSteerSession.id);
  assert.ok(lateSteerRuntime);
  let lateSteerQueued: Promise<void> | null = null;
  lateSteerRuntime!.subscribe((event) => {
    if (event.type !== "agent_event" || event.event.t !== "error" || lateSteerQueued) return;
    assert.equal(lateSteerRuntime!.canSteer(), false);
    lateSteerQueued = lateSteerRuntime!.steer("LATE_STEER becomes its own Turn");
    process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "0";
  });
  await lateSteerRuntime!.sendMessage("/write late-steer-error.txt\npartial provider error");
  assert.ok(lateSteerQueued);
  await lateSteerQueued;
  const lateSteerDeadline = Date.now() + 3_000;
  while ((agentTurnDao.list(lateSteerSession.id).length < 2 || lateSteerRuntime!.isBusy()) && Date.now() < lateSteerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const lateSteerTurns = agentTurnDao.list(lateSteerSession.id);
  const lateSteerUsers = timelineDao.list(lateSteerSession.id)
    .filter((row): row is Extract<TimelineItem, { kind: "user" }> => row.kind === "user");
  assert.deepEqual(lateSteerTurns.map((turn) => turn.status), ["failed", "completed"]);
  assert.deepEqual(lateSteerUsers.map((row) => row.text), [
    "/write late-steer-error.txt\npartial provider error",
    "LATE_STEER becomes its own Turn",
  ]);
  assert.notEqual(lateSteerUsers[0].turnId, lateSteerUsers[1].turnId);
  assert.equal(pendingMessageDao.listPending(lateSteerSession.id).length, 0);
  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "1";
  ok("late steer on failure edge: queued as a separate Agent Turn, never leaked into pi");

  const partialChildSession = sessionManager.createSession(user, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const partialChildRuntime = sessionManager.getRuntime(user.id, partialChildSession.id);
  assert.ok(partialChildRuntime);
  const partialChildEvents: WireAgentEvent[] = [];
  partialChildRuntime!.subscribe((event) => {
    if (event.type === "agent_event") partialChildEvents.push(event.event);
  });
  await partialChildRuntime!.sendMessage("/subagent /write partial-child.txt\nchild content never completes");
  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "0";
  const partialNested = partialChildEvents
    .filter((event): event is Extract<WireAgentEvent, { t: "subagent_event" }> => event.t === "subagent_event")
    .map((event) => event.event);
  const partialNestedReduced = partialNested.reduce((rows, event) => reduceTimeline(rows, event), [] as TimelineItem[]);
  const partialNestedTools = partialNestedReduced
    .filter((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool");
  assert.ok(partialNestedTools.length >= 1);
  assert.ok(partialNestedTools.every((row) => row.status === "error" ||
    (row.status === "denied" && row.termination === "cancelled")));
  assert.ok(partialNestedTools.some((row) => row.status === "error"));
  const partialChildTurnEnds = partialNested.filter((event): event is Extract<WireAgentEvent, { t: "turn_end" }> =>
    event.t === "turn_end");
  assert.equal(partialChildTurnEnds.length, 1, "failed Child publishes one terminal boundary");
  assert.equal(partialChildTurnEnds[0]?.status, "failed");
  const persistedParent = timelineDao.list(partialChildSession.id)
    .find((row): row is Extract<TimelineItem, { kind: "tool" }> => row.kind === "tool" && row.toolKind === "subagent");
  assert.ok(persistedParent?.children?.some((row) => row.kind === "tool" && row.status === "error"));
  assert.equal(persistedParent?.status, "error", "failed child propagates to the parent spawn_subagent Step");
  assert.equal(persistedParent?.isError, true);
  ok("mid-arguments provider failure: nested child + parent delegation Steps terminal in replay");

  process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "1";
  const errorDisposeUser = await signup(`tool-error-dispose-${process.pid}@gmail.com`, "password123");
  const errorDisposeSession = sessionManager.createSession(errorDisposeUser, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const errorOldRuntime = sessionManager.getRuntime(errorDisposeUser.id, errorDisposeSession.id);
  assert.ok(errorOldRuntime);
  let errorReplacement: typeof errorOldRuntime = null;
  let errorReplacementSend: Promise<void> | null = null;
  let disposedOnError = false;
  errorOldRuntime!.subscribe((event) => {
    if (event.type !== "agent_event" || event.event.t !== "error" || disposedOnError) return;
    disposedOnError = true;
    assert.equal(errorOldRuntime!.isBusy(), true);
    assert.equal(sessionManager.disposeUserRuntimes(errorDisposeUser.id), 1);
    process.env.AGENT_WEB_MOCK_PARTIAL_TOOL_ERROR = "0";
    errorReplacement = sessionManager.getRuntime(errorDisposeUser.id, errorDisposeSession.id);
    assert.ok(errorReplacement);
    errorReplacementSend = errorReplacement!.sendMessage("replacement after terminal error");
  });
  const errorOldSend = errorOldRuntime!.sendMessage("/write error-dispose.txt\npartial provider error");
  await errorOldSend;
  assert.equal(disposedOnError, true);
  assert.ok(errorReplacementSend);
  await errorReplacementSend;
  assert.deepEqual(agentTurnDao.list(errorDisposeSession.id).map((turn) => turn.status), ["failed", "completed"]);
  assert.equal(sessionDao.byId(errorDisposeSession.id)?.status, "idle");
  assert.equal(timelineDao.list(errorDisposeSession.id).some((row) => row.kind === "interrupted"), false);
  const failedDisposedTurn = agentTurnDao.list(errorDisposeSession.id)[0];
  const failedDisposedAudit = auditEventDao.recent(300)
    .find((row) => {
      if (row.session_id !== errorDisposeSession.id || row.event !== "turn_end") return false;
      return (JSON.parse(row.data_json) as { turnId?: string }).turnId === failedDisposedTurn.id;
    });
  assert.ok(failedDisposedAudit);
  assert.equal((JSON.parse(failedDisposedAudit!.data_json) as { status?: string }).status, "failed");
  ok("wire error dispose → immediate rebuild: durable failure wins without false interruption");

  const disposeUser = await signup(`tool-dispose-${process.pid}@gmail.com`, "password123");
  const disposeSession = sessionManager.createSession(disposeUser, {
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
  const oldRuntime = sessionManager.getRuntime(disposeUser.id, disposeSession.id);
  assert.ok(oldRuntime);
  let releaseDisposeReady!: () => void;
  const disposeReady = new Promise<void>((resolve) => { releaseDisposeReady = resolve; });
  oldRuntime!.subscribe((event) => {
    if (event.type === "agent_event" && event.event.t === "tool_status" && event.event.status === "ready") {
      releaseDisposeReady();
    }
  });
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "500";
  const oldSend = oldRuntime!.sendMessage("/write disposed.txt\nold runtime");
  await disposeReady;
  assert.equal(sessionManager.disposeUserRuntimes(disposeUser.id), 1);
  process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
  const replacement = sessionManager.getRuntime(disposeUser.id, disposeSession.id);
  assert.ok(replacement, "replacement runtime built immediately");
  await replacement!.sendMessage("replacement turn");
  await oldSend;
  const disposedTurns = agentTurnDao.list(disposeSession.id);
  assert.deepEqual(disposedTurns.map((turn) => turn.status), ["interrupted", "completed"]);
  assert.equal(sessionDao.byId(disposeSession.id)?.status, "idle");
  assert.ok(timelineDao.list(disposeSession.id).some((row) => row.kind === "interrupted"));
  ok("busy dispose → immediate rebuild: no unique collision; old Turn interrupted before replacement");

  rt!.close();
  turnEndSteerRuntime!.close();
  abortRuntime!.close();
  dispatchStopRuntime!.close();
  runningStopRuntime!.close();
  approvalRuntime!.close();
  childRuntime!.close();
  stoppedChildRuntime!.close();
  fencedReplacement!.close();
  partialRuntime!.close();
  partialChildRuntime!.close();
  errorAdmissionRuntime!.close();
  lateSteerRuntime!.close();
  errorReplacement!.close();
  replacement!.close();
}

function runReducerLevel(): void {
  const id = "tc_x";
  const seq: WireAgentEvent[] = [
    { t: "assistant_start", id: "a1" },
    {
      t: "assistant_update",
      id: "a1",
      blocks: [{ type: "toolCall", id, name: "write_file", toolKind: "write", path: "f.txt", arguments: { path: "f.txt", content: "he" } }],
    },
    {
      t: "assistant_update",
      id: "a1",
      blocks: [{ type: "toolCall", id, name: "write_file", toolKind: "write", path: "f.txt", arguments: { path: "f.txt", content: "hello wor" } }],
    },
    {
      t: "assistant_end",
      id: "a1",
      blocks: [{ type: "toolCall", id, name: "write_file", toolKind: "write", path: "f.txt", arguments: { path: "f.txt", content: "hello world" } }],
    },
    { t: "tool_status", id, status: "ready" },
    { t: "tool_start", id, name: "write_file", toolKind: "write", path: "f.txt", arguments: { path: "f.txt", content: "hello world" } },
    { t: "tool_status", id, status: "running", runningElapsedMs: 125 },
    { t: "tool_end", id, status: "success", resultText: "Wrote 11 bytes to f.txt", isError: false, durationMs: 3 },
  ];

  let timeline: TimelineItem[] = [];
  const contentTrace: string[] = [];
  const statusTrace: ToolCallStatus[] = [];
  let lastRank = -1;
  for (const e of seq) {
    timeline = reduceTimeline(timeline, e);
    const it = timeline.find((t) => t.kind === "tool" && t.id === id) as Extract<TimelineItem, { kind: "tool" }> | undefined;
    if (it) {
      assert.ok(RANK[it.status] >= lastRank, `monotonic status (was ${lastRank}, now ${it.status})`);
      lastRank = RANK[it.status];
      if (statusTrace[statusTrace.length - 1] !== it.status) statusTrace.push(it.status);
      const c = (it.arguments as Record<string, unknown>).content;
      if (typeof c === "string" && contentTrace[contentTrace.length - 1] !== c) contentTrace.push(c);
    }
  }

  const items = timeline.filter((t) => t.kind === "tool" && t.id === id);
  assert.equal(items.length, 1, "single in-place tool item");
  const it = items[0] as Extract<TimelineItem, { kind: "tool" }>;
  assert.equal(it.status, "success", "ends success");
  assert.deepEqual(statusTrace, ["streaming_args", "ready", "pending", "running", "success"], `status trace: ${statusTrace.join(" -> ")}`);
  assert.deepEqual(contentTrace, ["he", "hello wor", "hello world"], "content grew monotonically in place");
  assert.equal(it.runningElapsedMs, undefined, "terminal reducer state clears the running elapsed base");

  const late: WireAgentEvent = {
    t: "assistant_update",
    id: "a1",
    blocks: [{ type: "toolCall", id, name: "write_file", toolKind: "write", path: "f.txt", arguments: { path: "f.txt", content: "hello world" } }],
  };
  const after = reduceTimeline(timeline, late);
  const afterIt = after.find((t) => t.kind === "tool" && t.id === id) as Extract<TimelineItem, { kind: "tool" }>;
  assert.equal(afterIt.status, "success", "late assistant_update does NOT regress status");

  const restored: TimelineItem[] = [{
    kind: "assistant",
    id: "restored_high_seq",
    seq: 9_000_000,
    blocks: [],
    streaming: false,
    ts: 10,
  }];
  const afterRestart = reduceTimeline(restored, {
    t: "tool_start",
    id: "restart_tool",
    name: "read_file",
    toolKind: "read",
    arguments: {},
  }, 11, timelineSeqAllocator(restored));
  assert.equal(afterRestart.at(-1)?.seq, 9_000_001,
    "persisted Child allocation resumes from snapshot max after a process/module restart");
  ok(`reducer sequence: single item, ${statusTrace.join(" -> ")}, content [${contentTrace.join(", ")}], no late regression`);
}

function foldStatuses(seq: WireAgentEvent[], id: string): { trace: ToolCallStatus[]; timeline: TimelineItem[] } {
  let timeline: TimelineItem[] = [];
  const trace: ToolCallStatus[] = [];
  let lastRank = -1;
  for (const e of seq) {
    timeline = reduceTimeline(timeline, e);
    const it = timeline.find((t) => t.kind === "tool" && t.id === id) as Extract<TimelineItem, { kind: "tool" }> | undefined;
    if (it) {
      assert.ok(RANK[it.status] >= lastRank, `monotonic status (was ${lastRank}, now ${it.status})`);
      lastRank = RANK[it.status];
      if (trace[trace.length - 1] !== it.status) trace.push(it.status);
    }
  }
  assert.equal(timeline.filter((t) => t.kind === "tool" && t.id === id).length, 1, "exactly one tool item");
  return { trace, timeline };
}

function runApprovalReducer(): void {
  const approveId = "tc_appr";
  const blk = (content: string) => ({
    type: "toolCall" as const,
    id: approveId,
    name: "write_file",
    toolKind: "write" as const,
    path: "g.txt",
    arguments: { path: "g.txt", content },
  });
  const approve: WireAgentEvent[] = [
    { t: "assistant_start", id: "a1" },
    { t: "assistant_update", id: "a1", blocks: [blk("se")] },
    { t: "assistant_end", id: "a1", blocks: [blk("secret")] },
    { t: "tool_status", id: approveId, status: "ready" },
    { t: "tool_status", id: approveId, status: "pending" },
    { t: "assistant_update", id: "a1", blocks: [blk("secret")] },
    { t: "tool_status", id: approveId, status: "running" },
    { t: "tool_end", id: approveId, status: "success", resultText: "ok", isError: false, durationMs: 2 },
  ];
  const a = foldStatuses(approve, approveId);
  assert.deepEqual(a.trace, ["streaming_args", "ready", "pending", "running", "success"], `approve trace: ${a.trace.join(" -> ")}`);

  const denyId = "tc_deny";
  const deny: WireAgentEvent[] = [
    { t: "assistant_start", id: "a2" },
    { t: "assistant_update", id: "a2", blocks: [{ type: "toolCall", id: denyId, name: "bash", toolKind: "shell", arguments: { command: "rm -rf /tmp" } }] },
    { t: "assistant_end", id: "a2", blocks: [{ type: "toolCall", id: denyId, name: "bash", toolKind: "shell", arguments: { command: "rm -rf /tmp/x" } }] },
    { t: "tool_status", id: denyId, status: "ready" },
    { t: "tool_status", id: denyId, status: "pending" },
    { t: "tool_status", id: denyId, status: "denied" },
    { t: "tool_end", id: denyId, status: "denied", resultText: "", isError: true },
  ];
  const d = foldStatuses(deny, denyId);
  assert.deepEqual(d.trace, ["streaming_args", "ready", "pending", "denied"], `deny trace: ${d.trace.join(" -> ")}`);
  const denied = d.timeline.find((t) => t.kind === "tool" && t.id === denyId) as Extract<TimelineItem, { kind: "tool" }>;
  assert.equal((denied.arguments as Record<string, unknown>).command, "rm -rf /tmp/x", "deny: final streamed args preserved");
  ok("on-request approval: approve (…->pending->running->success) + deny (…->pending->denied), single item, no late regression");
}

try {
  runReducerLevel();
} catch (e) {
  fail("reducer-level sequence", e);
}
try {
  runApprovalReducer();
} catch (e) {
  fail("on-request approval reducer", e);
}
try {
  await runE2E();
} catch (e) {
  fail("E2E mock stream", e);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall tool-stream checks passed");
process.exit(0);
