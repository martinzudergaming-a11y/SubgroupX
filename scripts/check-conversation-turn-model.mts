import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TimelineItem, WireAgentEvent } from "../shared/src/protocol.ts";
import { conversationItemClass, groupConversationTurns, turnRootUserIds } from "../shared/src/conversation-model.ts";
import { reduceTimeline } from "../shared/src/timeline-reducer.ts";
import { buildShareSnapshot } from "../server/src/sharing/redact.ts";
import { groupTimelineUnits } from "../web/src/dashboard/session/timeline/timeline-helpers.ts";
import { toolLabel } from "../web/src/conversation/tools/tool-presentation-helpers.tsx";

const item = (value: Partial<TimelineItem> & Pick<TimelineItem, "kind" | "id" | "seq" | "ts">): TimelineItem => value as TimelineItem;
const exact: TimelineItem[] = [
  item({ kind: "user", id: "u1", seq: 1, ts: 1, text: "start", turnId: "turn_a" }),
  item({ kind: "assistant", id: "a1", seq: 2, ts: 2, blocks: [], turnId: "turn_a" }),
  item({ kind: "tool", id: "tool1", seq: 3, ts: 3, name: "bash", toolKind: "shell", arguments: {}, status: "success", turnId: "turn_a" }),
  item({ kind: "user", id: "u2", seq: 4, ts: 4, text: "steer", turnId: "turn_a" }),
  item({ kind: "assistant", id: "a2", seq: 5, ts: 5, blocks: [], turnId: "turn_a" }),
  item({ kind: "compaction", id: "c1", seq: 6, ts: 6, compactionId: "c1", summarizedCount: 4, tokensBefore: 100, tokensAfter: 20 }),
  item({ kind: "recap", id: "r1", seq: 7, ts: 7, text: "recap", anchorSeq: 5, contractVersion: 1, source: "fallback", generatorProvider: "p", generatorModel: "m", turnProvider: "p", turnModel: "m", sourceTurnId: "turn_a" }),
  item({ kind: "user", id: "u3", seq: 8, ts: 8, text: "next", turnId: "turn_b" }),
];
const groups = groupConversationTurns(exact);
assert.equal(groups.length, 2);
assert.deepEqual(groups.map((group) => group.id), ["turn_a", "turn_b"]);
assert.deepEqual(groups[0].items.map((row) => row.id), ["u1", "a1", "tool1", "u2", "a2"]);
assert.equal(groups[0].inferred, false);
assert.equal(conversationItemClass(exact[0]), "message");
assert.equal(conversationItemClass(exact[1]), "message");
assert.equal(conversationItemClass(exact[2]), "step");
assert.equal(conversationItemClass(exact[5]), "system");
assert.equal(conversationItemClass(exact[6]), "system");
assert.deepEqual([...turnRootUserIds(exact)], ["u1", "u3"], "steer u2 is not an edit/fork root");

const teamOnly = reduceTimeline([], {
  t: "team_assignment",
  id: "team_assignment_1",
  seq: 1,
  taskId: "task_team_1",
  title: "Verify the release",
  ts: 1,
  turnId: "turn_team_1",
});
teamOnly.push(item({ kind: "assistant", id: "team_answer_1", seq: 2, ts: 2, blocks: [], turnId: "turn_team_1" }));
assert.equal(groupConversationTurns(teamOnly).length, 1, "a Team Turn does not require a fake user Message");
assert.equal(conversationItemClass(teamOnly[0]), "system");
assert.deepEqual([...turnRootUserIds(teamOnly)], []);
assert.equal(
  buildShareSnapshot(teamOnly).items.some((entry) => entry.id === "team_assignment_1"),
  false,
  "public shares omit private Team assignment metadata",
);

const legacyItems: TimelineItem[] = [
  item({ kind: "user", id: "lu1", seq: 1, ts: 1, text: "old one" }),
  item({ kind: "tool", id: "lt1", seq: 2, ts: 2, name: "bash", toolKind: "shell", arguments: {}, status: "success" }),
  item({ kind: "user", id: "lu2", seq: 3, ts: 3, text: "old two" }),
  item({ kind: "assistant", id: "la2", seq: 4, ts: 4, blocks: [] }),
];
const legacy = groupConversationTurns(legacyItems);
assert.equal(legacy.length, 2);
assert.ok(legacy.every((group) => group.inferred && group.turnId === null));
assert.deepEqual([...turnRootUserIds(legacyItems)], ["lu1", "lu2"], "each legacy user boundary remains rewindable");
console.log("  ✓ pure hierarchy: explicit steer stays in one Turn; legacy fallback is marked inferred");

const compactSteps: TimelineItem[] = [
  item({ kind: "tool", id: "ok1", seq: 11, ts: 11, name: "bash", toolKind: "shell", arguments: {}, status: "success" }),
  item({ kind: "tool", id: "ok2", seq: 12, ts: 12, name: "bash", toolKind: "shell", arguments: {}, status: "success" }),
  item({ kind: "tool", id: "failed", seq: 13, ts: 13, name: "write_file", toolKind: "write", path: "report.txt", arguments: {}, status: "error", resultText: "failed before tool could run" }),
  item({ kind: "tool", id: "denied", seq: 14, ts: 14, name: "bash", toolKind: "shell", arguments: {}, status: "denied" }),
  item({ kind: "tool", id: "cancelled", seq: 15, ts: 15, name: "write_file", toolKind: "write", arguments: {}, status: "denied", termination: "cancelled" }),
  item({ kind: "tool", id: "ok3", seq: 16, ts: 16, name: "read_file", toolKind: "read", arguments: {}, status: "success" }),
  item({ kind: "tool", id: "ok4", seq: 17, ts: 17, name: "read_file", toolKind: "read", arguments: {}, status: "success" }),
];
const compactUnits = groupTimelineUnits(compactSteps, true);
assert.deepEqual(
  compactUnits.map((unit) => unit.tools?.map((tool) => tool.id) ?? unit.item?.id),
  [["ok1", "ok2"], "failed", "denied", "cancelled", ["ok3", "ok4"]],
);
const failedStep = compactSteps.find((step) => step.id === "failed");
assert.ok(failedStep?.kind === "tool");
const keyT = ((key: string) => key) as Parameters<typeof toolLabel>[1];
assert.equal(toolLabel(failedStep, keyT), "tool.failedPath");
console.log("  ✓ compact Steps: only successful runs aggregate; error/denied/cancelled stay exact");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-turn-model-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { sessionManager } = await import("../server/src/runtime/manager.ts");
const { signup } = await import("../server/src/identity/auth.ts");
const { agentTurnDao, timelineDao, db } = await import("../server/src/persistence/index.ts");
registerMockProvider();
const user = await signup(`turn-model-${process.pid}@gmail.com`, "password123");
const session = sessionManager.createSession(user, {
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
});
const runtime = sessionManager.getRuntime(user.id, session.id);
assert.ok(runtime);
const events: WireAgentEvent[] = [];
const completed = new Promise<void>((resolve) => {
  const unsub = runtime!.subscribe((event) => {
    if (event.type !== "agent_event") return;
    events.push(event.event);
    if (event.event.t === "turn_end") { unsub(); resolve(); }
  });
});
await runtime!.sendMessage("/write proof.txt\nturn hierarchy proof");
await completed;
const starts = events.filter((event): event is Extract<WireAgentEvent, { t: "turn_start" }> => event.t === "turn_start");
const ends = events.filter((event): event is Extract<WireAgentEvent, { t: "turn_end" }> => event.t === "turn_end");
assert.equal(starts.length, 1, "one outer turn_start despite multiple model rounds");
assert.equal(ends.length, 1, "one outer turn_end despite multiple model rounds");
assert.equal(ends[0].turnId, starts[0].turnId);
assert.equal(ends[0].status, "completed");
const rows = timelineDao.list(session.id).filter((row) => row.kind !== "recap" && row.kind !== "compaction");
assert.ok(rows.length >= 4);
assert.ok(rows.every((row) => row.turnId === starts[0].turnId), "every turn-scoped item carries exact membership");
const turns = agentTurnDao.list(session.id);
assert.equal(turns.length, 1);
assert.equal(turns[0].id, starts[0].turnId);
assert.equal(turns[0].status, "completed");
assert.ok(turns[0].startSeq != null && turns[0].endSeq != null && turns[0].endSeq! >= turns[0].startSeq!);
assert.ok(events.some((event) => event.t === "tool_status" && event.status === "ready"), "tool arguments-ready phase is visible");
const publicSnapshot = buildShareSnapshot(rows);
assert.ok(publicSnapshot.items.every((row) => row.kind === "compaction" || row.turnId === starts[0].turnId));
assert.equal(groupConversationTurns(publicSnapshot.items).length, 1, "public redaction preserves exact Turn grouping");
console.log("  ✓ runtime hierarchy: 1 Session Turn, multiple Messages/Steps/model rounds, durable exact turnId");

const queuedSession = sessionManager.createSession(user, {
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
});
const queuedRuntime = sessionManager.getRuntime(user.id, queuedSession.id);
assert.ok(queuedRuntime);
const queuedEvents: WireAgentEvent[] = [];
let resolveReady!: () => void;
const argumentsReady = new Promise<void>((resolve) => { resolveReady = resolve; });
queuedRuntime!.subscribe((event) => {
  if (event.type !== "agent_event") return;
  queuedEvents.push(event.event);
  if (event.event.t === "tool_status" && event.event.status === "ready") resolveReady();
});
process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "180";
const firstQueuedBoundaryTurn = queuedRuntime!.sendMessage("/write boundary.txt\nfirst outer turn");
await argumentsReady;
await queuedRuntime!.queueFollowUp("second outer turn");
await firstQueuedBoundaryTurn;
process.env.AGENT_WEB_MOCK_TOOL_COMMIT_DELAY_MS = "0";
const queuedDeadline = Date.now() + 3_000;
while ((agentTurnDao.list(queuedSession.id).length < 2 || queuedRuntime!.isBusy()) && Date.now() < queuedDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const queuedTurns = agentTurnDao.list(queuedSession.id);
const queuedUsers = timelineDao.list(queuedSession.id)
  .filter((row): row is Extract<TimelineItem, { kind: "user" }> => row.kind === "user");
assert.equal(queuedTurns.length, 2);
assert.deepEqual(queuedTurns.map((turn) => turn.status), ["completed", "completed"]);
assert.equal(new Set(queuedUsers.map((row) => row.turnId)).size, 2);
assert.deepEqual(queuedUsers.map((row) => row.text), ["/write boundary.txt\nfirst outer turn", "second outer turn"]);
assert.equal(queuedEvents.filter((event) => event.t === "turn_start").length, 2);
assert.equal(queuedEvents.filter((event) => event.t === "turn_end").length, 2);
console.log("  ✓ queued boundary: each follow-up is a fresh durable/wire Agent Turn");

runtime!.close();
queuedRuntime!.close();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
