import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-recap-contract-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "recap-contract-secret";
process.env.AGENT_WEB_KEY_SECRET = "recap-contract-secret";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_RECAP_IDLE_MS = "500";
process.env.AGENT_WEB_JAIL_KEY = "fake-recap-key";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://recap.test/v1";
process.env.AGENT_WEB_JAIL_MODEL = "operator-model";

const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime } = await import("../server/src/runtime/agent-session.ts");
const { auditEventDao, db, messageDao, recapJobDao, sessionDao, timelineDao, userDao } = await import("../server/src/persistence/index.ts");
const { reduceTimeline } = await import("../shared/src/timeline-reducer.ts");
const { shapeEventForBrowserProtocol } = await import("../server/src/transport/ws-server.ts");
const { PROTOCOL_VERSION, TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION } = await import("../shared/src/protocol.ts");
const { buildRecapSnapshot, decodeRecapJob } = await import("../server/src/runtime/recap.ts");
import type { SessionRow } from "../server/src/persistence/index.ts";
import type { ServerEvent, TimelineItem, WireAgentEvent } from "../shared/src/protocol.ts";

registerMockProvider();
const now = Date.now();
userDao.create({ id: "u_recap_contract", email: "recap-contract@test.invalid", password_hash: "x", created_at: now });
const originalFetch = globalThis.fetch;
const recapRequests: Record<string, unknown>[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  recapRequests.push(body);
  if (body.prompt_cache_key === "s_recap_rebuild") return new Response("upstream unavailable", { status: 503 });
  return new Response(JSON.stringify({ output_text: "**Resume the implementation, then run the focused check.**" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof globalThis.fetch;

function seedSession(id: string, createdAt: number): SessionRow {
  const row: SessionRow = {
    id,
    user_id: "u_recap_contract",
    title: id,
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: tmp,
    created_at: createdAt,
    updated_at: createdAt,
  };
  sessionDao.create(row);
  return row;
}

function recapEvent(id = "recap_reducer"): Extract<WireAgentEvent, { t: "recap" }> {
  return {
    t: "recap",
    id,
    seq: 42,
    text: "Resume the implementation and run the focused check.",
    ts: now,
    anchorSeq: 41,
    contractVersion: 1,
    source: "llm",
    generatorProvider: "0AI-jail",
    generatorModel: "operator-model",
    turnProvider: "anthropic",
    turnModel: "claude-sonnet",
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not settle within ${timeoutMs}ms`);
}

try {
  const event = recapEvent();
  const once = reduceTimeline([], event);
  const twice = reduceTimeline(once, event);
  assert.equal(once.length, 1);
  assert.equal(twice, once, "duplicate Recap event should preserve the existing array");
  const reduced = once[0] as Extract<TimelineItem, { kind: "recap" }>;
  assert.equal(reduced.seq, 42);
  assert.equal(reduced.anchorSeq, 41);
  assert.equal(reduced.contractVersion, 1);
  assert.equal(reduced.generatorModel, "operator-model");
  assert.equal(reduced.turnModel, "claude-sonnet");

  const bounded = buildRecapSnapshot({
    recentRequests: ["x".repeat(1_000), "y".repeat(1_000), "latest"],
    latestRequest: "z".repeat(2_000),
    assistantReply: "a".repeat(4_000),
    activity: Array.from({ length: 80 }, (_, index) => ({
      name: `tool-${index}-` + "n".repeat(300),
      kind: "kind".repeat(20),
      path: "/tmp/" + "p".repeat(500),
    })),
    turnProvider: "provider".repeat(40),
    turnModel: "model".repeat(80),
  });
  assert.equal(bounded.previousRequests.length, 2);
  assert.ok(bounded.previousRequests.every((text) => text.length <= 240));
  assert.ok(bounded.latestRequest.length <= 600);
  assert.ok(bounded.assistantReply.length <= 907);
  assert.equal(bounded.activity.length, 40);
  assert.ok(bounded.activity.every((item) => item.name.length <= 120 && item.kind.length <= 40 && (item.path?.length ?? 0) <= 240));
  const decoded = decodeRecapJob({
    session_id: "s_untrusted",
    turn_id: "turn_untrusted",
    anchor_seq: 1,
    due_at: now,
    contract_version: 1,
    payload_json: JSON.stringify({ ...bounded, latestRequest: "q".repeat(10_000) }),
    created_at: now,
  });
  assert.ok(decoded);
  assert.ok(decoded.snapshot.latestRequest.length <= 600);

  assert.ok(PROTOCOL_VERSION >= 4, "persisted Recap rows require the v4 browser bridge or newer");
  const replay: Extract<ServerEvent, { type: "timeline_replay" }> = {
    type: "timeline_replay",
    sessionId: "s_protocol_bridge",
    epoch: "epoch_1",
    version: 42,
    items: [
      { kind: "user", id: "user_1", seq: 1, text: "Continue", ts: now - 1 },
      reduced,
    ],
    pending: [],
  };
  assert.deepEqual(shapeEventForBrowserProtocol(5, replay), [replay]);
  assert.deepEqual(shapeEventForBrowserProtocol(4, replay), [replay]);
  const assignment = {
    kind: "team_assignment" as const,
    id: "team_assignment_bridge",
    seq: 2,
    taskId: "task_bridge",
    title: "Verify the release",
    ts: now,
    turnId: "turn_bridge",
  };
  const assignmentReplay: Extract<ServerEvent, { type: "timeline_replay" }> = {
    ...replay,
    items: [replay.items[0], assignment],
  };
  const oldAssignmentReplay = shapeEventForBrowserProtocol(
    TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION - 1,
    assignmentReplay,
  )[0];
  assert.equal(oldAssignmentReplay?.type, "timeline_replay");
  assert.deepEqual(
    (oldAssignmentReplay as Extract<ServerEvent, { type: "timeline_replay" }>).items,
    [replay.items[0]],
    "an old browser must not receive an unknown Team assignment row",
  );
  assert.deepEqual(shapeEventForBrowserProtocol(PROTOCOL_VERSION, assignmentReplay), [assignmentReplay]);
  const assignmentEvent: ServerEvent = {
    type: "agent_event",
    sessionId: replay.sessionId,
    epoch: replay.epoch,
    version: 43,
    seq: assignment.seq,
    ts: assignment.ts,
    event: {
      t: "team_assignment",
      id: assignment.id,
      seq: assignment.seq,
      taskId: assignment.taskId,
      title: assignment.title,
      ts: assignment.ts,
      turnId: assignment.turnId,
    },
  };
  assert.deepEqual(
    shapeEventForBrowserProtocol(TEAM_ASSIGNMENT_TIMELINE_PROTOCOL_VERSION - 1, assignmentEvent),
    [],
  );
  assert.deepEqual(shapeEventForBrowserProtocol(PROTOCOL_VERSION, assignmentEvent), [assignmentEvent]);
  const readyEvent: ServerEvent = {
    type: "agent_event",
    sessionId: "s_protocol_bridge",
    epoch: "epoch_1",
    version: 43,
    seq: 10,
    ts: now,
    event: { t: "tool_status", id: "tool_1", status: "ready", turnId: "turn_1" },
  };
  assert.deepEqual(shapeEventForBrowserProtocol(5, readyEvent), [readyEvent]);
  assert.deepEqual(shapeEventForBrowserProtocol(4, readyEvent), []);
  const nestedReadyEvent: ServerEvent = {
    ...readyEvent,
    event: { t: "subagent_event", parentId: "parent_1", event: readyEvent.event },
  };
  assert.deepEqual(shapeEventForBrowserProtocol(5, nestedReadyEvent), [nestedReadyEvent]);
  assert.deepEqual(shapeEventForBrowserProtocol(4, nestedReadyEvent), [], "v4 must not receive nested ready either");
  const cancelledEvent: ServerEvent = {
    ...readyEvent,
    event: {
      t: "tool_end",
      id: "tool_1",
      status: "denied",
      termination: "cancelled",
      resultText: "Interrupted before this tool could run.",
      isError: false,
      turnId: "turn_1",
    },
  };
  assert.deepEqual(shapeEventForBrowserProtocol(4, cancelledEvent), [cancelledEvent],
    "rollback clients see a known terminal status and safely ignore cancellation metadata");
  const cancelledReplay: Extract<ServerEvent, { type: "timeline_replay" }> = {
    ...replay,
    items: [{
      kind: "tool",
      id: "tool_1",
      seq: 3,
      ts: now,
      name: "write_file",
      toolKind: "write",
      arguments: { path: "example.txt" },
      status: "denied",
      termination: "cancelled",
      resultText: "Interrupted before this tool could run.",
      isError: false,
      turnId: "turn_1",
    }],
  };
  assert.deepEqual(shapeEventForBrowserProtocol(4, cancelledReplay), [cancelledReplay]);
  const readyReplay: Extract<ServerEvent, { type: "timeline_replay" }> = {
    ...replay,
    items: [{
      kind: "tool",
      id: "parent_ready",
      seq: 4,
      ts: now,
      name: "spawn_subagent",
      toolKind: "subagent",
      arguments: {},
      status: "ready",
      children: [{
        kind: "tool",
        id: "child_ready",
        seq: 1,
        ts: now,
        name: "write_file",
        toolKind: "write",
        arguments: { path: "example.txt" },
        status: "ready",
      }],
    }],
  };
  const v4ReadyReplay = shapeEventForBrowserProtocol(4, readyReplay)[0] as Extract<ServerEvent, { type: "timeline_replay" }>;
  const v4ReadyParent = v4ReadyReplay.items[0] as Extract<TimelineItem, { kind: "tool" }>;
  assert.equal(v4ReadyParent.status, "streaming_args");
  assert.equal(v4ReadyParent.children?.[0]?.kind === "tool" && v4ReadyParent.children[0].status, "streaming_args");
  const legacyReplay = shapeEventForBrowserProtocol(3, replay);
  assert.equal(legacyReplay.length, 2);
  assert.deepEqual(
    (legacyReplay[0] as Extract<ServerEvent, { type: "timeline_replay" }>).items.map((item) => item.kind),
    ["user"],
  );
  assert.deepEqual(legacyReplay[1], {
    type: "recap",
    sessionId: replay.sessionId,
    text: reduced.text,
    ts: reduced.ts,
  });
  const live: Extract<ServerEvent, { type: "agent_event" }> = {
    type: "agent_event",
    sessionId: replay.sessionId,
    epoch: replay.epoch,
    version: replay.version,
    seq: reduced.seq,
    ts: reduced.ts,
    event,
  };
  assert.deepEqual(shapeEventForBrowserProtocol(3, live), [{
    type: "recap",
    sessionId: replay.sessionId,
    text: reduced.text,
    ts: reduced.ts,
  }]);

  const oldRow = seedSession("s_recap_old", Date.UTC(2022, 0, 1));
  const newRow = seedSession("s_recap_new", Date.UTC(2032, 0, 1));
  const oldRt = new AgentSessionRuntime(oldRow);
  const newRt = new AgentSessionRuntime(newRow);
  await oldRt.sendMessage("old cohort request");
  await newRt.sendMessage("new cohort request");
  const oldJob = recapJobDao.get(oldRow.id);
  const newJob = recapJobDao.get(newRow.id);
  assert.ok(oldJob && newJob);
  assert.equal(oldJob.contract_version, newJob.contract_version);
  assert.equal(oldJob.contract_version, 1);
  oldRt.close();
  newRt.close();

  const followupRow = seedSession("s_recap_followup", now);
  const followupRt = new AgentSessionRuntime(followupRow);
  await followupRt.sendMessage("first task");
  const firstJob = recapJobDao.get(followupRow.id);
  assert.ok(firstJob);
  await followupRt.sendMessage("replacement task");
  const replacementJob = recapJobDao.get(followupRow.id);
  assert.ok(replacementJob);
  assert.notEqual(replacementJob.turn_id, firstJob.turn_id);
  assert.equal((JSON.parse(replacementJob.payload_json) as { latestRequest: string }).latestRequest, "replacement task");
  followupRt.close();

  const row = seedSession("s_recap_rebuild", now);
  const rt1 = new AgentSessionRuntime(row);
  await rt1.sendMessage("Implement durable Recap scheduling");
  const pending = recapJobDao.get(row.id);
  assert.ok(pending, "completed turn should persist its pending Recap job");
  assert.equal(pending.contract_version, 1);
  const payload = JSON.parse(pending.payload_json) as { previousRequests: string[]; turnModel: string };
  assert.deepEqual(payload.previousRequests, []);
  assert.equal(payload.turnModel, MOCK_MODEL_ID);
  rt1.close();
  assert.ok(recapJobDao.get(row.id), "runtime eviction must preserve the durable job");

  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal(timelineDao.list(row.id).some((item) => item.kind === "recap"), false);

  const rt2 = new AgentSessionRuntime(row);
  const emitted: WireAgentEvent[] = [];
  const unsub = rt2.subscribe((serverEvent: ServerEvent) => {
    if (serverEvent.type === "agent_event") emitted.push(serverEvent.event);
  });
  const liveRecap = await waitFor(() => emitted.find((item): item is Extract<WireAgentEvent, { t: "recap" }> => item.t === "recap"));
  const persisted = timelineDao.list(row.id).find((item): item is Extract<TimelineItem, { kind: "recap" }> => item.kind === "recap");
  assert.ok(persisted);
  assert.equal(persisted.id, liveRecap.id);
  assert.equal(persisted.anchorSeq, pending.anchor_seq);
  assert.equal(persisted.source, "fallback");
  assert.equal(persisted.generatorModel, "recap-template-v1");
  assert.equal(persisted.turnModel, MOCK_MODEL_ID);
  assert.equal(recapJobDao.get(row.id), null, "successful generation atomically consumes the job");
  assert.equal(messageDao.list(row.id).some((message) => JSON.stringify(message).includes(persisted.id)), false);
  const upstreamAudit = auditEventDao.recent(50).find(
    (audit) => audit.event === "recap_upstream_failed" && audit.session_id === row.id,
  );
  assert.ok(upstreamAudit);
  assert.equal((JSON.parse(upstreamAudit.data_json) as { status?: number }).status, 503);
  unsub();
  rt2.close();

  const llmRow = seedSession("s_recap_llm", now);
  const llmRt = new AgentSessionRuntime(llmRow);
  await llmRt.sendMessage("Check stable generator selection");
  const llmRecap = await waitFor(() => timelineDao.list(llmRow.id).find(
    (item): item is Extract<TimelineItem, { kind: "recap" }> => item.kind === "recap",
  ));
  assert.equal(llmRecap.source, "llm");
  assert.equal(llmRecap.generatorProvider, "0AI-jail");
  assert.equal(llmRecap.generatorModel, "operator-model");
  assert.equal(llmRecap.turnProvider, MOCK_PROVIDER);
  assert.equal(llmRecap.turnModel, MOCK_MODEL_ID);
  assert.equal(llmRecap.text.includes("**"), false, "server should enforce plain-text Recaps");
  const llmRequest = recapRequests.find((request) => request.prompt_cache_key === llmRow.id);
  assert.ok(llmRequest);
  assert.equal(llmRequest.model, "operator-model");
  assert.deepEqual(llmRequest.include, ["reasoning.encrypted_content"]);
  const generationAudit = auditEventDao.recent(50).find(
    (row) => row.event === "recap_generated" && row.session_id === llmRow.id,
  );
  assert.ok(generationAudit, "generation provenance should be queryable without reading private text");
  const generationData = JSON.parse(generationAudit.data_json) as Record<string, unknown>;
  assert.equal(generationData.contractVersion, 1);
  assert.equal(generationData.generatorModel, "operator-model");
  assert.equal(generationData.turnModel, MOCK_MODEL_ID);
  assert.equal("latestRequest" in generationData, false, "audit metadata must not retain prompt text");
  llmRt.close();

  const compactedRow = seedSession("s_recap_compacted", now);
  timelineDao.append(compactedRow.id, { kind: "user", id: "u_original", seq: 1, text: "Original durable goal", ts: now }, 0);
  timelineDao.append(compactedRow.id, { kind: "user", id: "u_recent_1", seq: 2, text: "Recent context one", ts: now + 1 });
  timelineDao.append(compactedRow.id, { kind: "user", id: "u_recent_2", seq: 3, text: "Recent context two", ts: now + 2 });
  messageDao.replaceAll(compactedRow.id, [
    { role: "user", content: "[Context note] earlier content was compacted", timestamp: now },
    { role: "user", content: "Recent surviving request", timestamp: now + 1 },
  ]);
  const compactedRt = new AgentSessionRuntime(compactedRow);
  await compactedRt.sendMessage("Latest work item");
  const compactedJob = recapJobDao.get(compactedRow.id);
  assert.ok(compactedJob);
  const compactedPayload = JSON.parse(compactedJob.payload_json) as { previousRequests: string[] };
  assert.deepEqual(compactedPayload.previousRequests, ["Recent context one", "Recent context two"]);
  assert.equal(compactedPayload.previousRequests.includes("Original durable goal"), false);
  compactedRt.close();

  console.log("OK recap-contract: stable generator + turn provenance + durable rebuild + recent-task context");
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
