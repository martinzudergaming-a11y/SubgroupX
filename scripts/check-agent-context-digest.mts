import assert from "node:assert/strict";
import type { AgentNode, TaskDigest, TaskStatus } from "../shared/src/orchestration.ts";
import {
  AGENT_CONTEXT_HARD_CTX,
  AGENT_CONTEXT_TYPICAL_CTX,
  AgentContextDigestRenderer,
  type AgentTaskRoster,
  stableAgentAliases,
} from "../server/src/orchestration/context-digest.ts";
import { countTextExact } from "../server/src/runtime/token-count.ts";

const rootAgentId = "agent-root";

function node(
  id: string,
  path: string,
  status: AgentNode["status"] = "idle",
  overrides: Partial<AgentNode> = {},
): AgentNode {
  return {
    id,
    userId: "user-fixture",
    rootAgentId,
    parentAgentId: id === rootAgentId ? undefined : rootAgentId,
    path,
    kind: id === rootAgentId ? "session" : "subagent",
    status,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function task(
  id: string,
  agentId: string,
  status: TaskStatus,
  overrides: Partial<TaskDigest> = {},
): TaskDigest {
  return {
    id,
    agentId,
    title: id,
    status,
    awaitPolicy: "join",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unreadResult: false,
    ...overrides,
  };
}

const root = node(rootAgentId, "/root", "running");
const audit = node("agent-audit", "/root/audit", "running");
const database = node("agent-db", "/root/db", "idle");
const api = node("agent-api", "/root/api", "idle");
const queue = node("agent-queue", "/root/queue", "initializing");

const goldenRoster: AgentTaskRoster = {
  revision: 42,
  rootAgentId,
  nodes: [root, audit, database, api, queue],
  tasks: [
    task("task-audit", audit.id, "running", {
      title: "audit-auth",
      activity: "tool:shell",
      updatedAt: 300,
    }),
    task("task-database", database.id, "waiting", {
      title: "db-migration",
      awaitPolicy: "background",
      waitReason: "approval",
      updatedAt: 100,
    }),
    task("task-api", api.id, "succeeded", {
      title: "api-review",
      unreadResult: true,
      resultId: "result-ok",
      updatedAt: 200,
      settledAt: 200,
    }),
    task("task-queue", queue.id, "queued", {
      title: "queued-docs",
      createdAt: 50,
    }),
  ],
};

{
  const rendered = await new AgentContextDigestRenderer().render(goldenRoster);
  assert.equal(
    rendered.text,
    `<agents v=42 a=4 bg=1 q=1 w=1 unread=1 more=0>
afd704a W:approval db-migration
a512c66 D+ api-review ->rb240c
acddc1d R audit-auth @tool:shell
a470bb6 Q queued-docs
</agents>`,
  );
  assert.equal(rendered.exact, true);
  assert.equal(rendered.ctx, await countTextExact(rendered.text));
  assert.ok(rendered.ctx <= AGENT_CONTEXT_TYPICAL_CTX, `ordinary roster used ${rendered.ctx} ctx`);
  assert.deepEqual(rendered.includedTaskIds, ["task-database", "task-api", "task-audit", "task-queue"]);
  console.log(`✓ golden capsule is deterministic and ${rendered.ctx} exact o200k tokens`);
}

{
  const rendered = await new AgentContextDigestRenderer().render({
    revision: 7,
    rootAgentId,
    nodes: [root],
    tasks: [],
  });
  assert.equal(rendered.text, "<agents v=7 a=0 bg=0 q=0 w=0 unread=0 more=0>\n</agents>");
  assert.equal(rendered.ctx, await countTextExact(rendered.text));
  console.log("✓ empty capsule retains revision and zero counts");
}

{
  const shuffled: AgentTaskRoster = {
    ...goldenRoster,
    nodes: [...goldenRoster.nodes].reverse(),
    tasks: [goldenRoster.tasks[2]!, goldenRoster.tasks[0]!, goldenRoster.tasks[3]!, goldenRoster.tasks[1]!],
  };
  const [left, right] = await Promise.all([
    new AgentContextDigestRenderer().render(goldenRoster),
    new AgentContextDigestRenderer().render(shuffled),
  ]);
  assert.equal(left.text, right.text);

  const before = stableAgentAliases(goldenRoster.nodes, goldenRoster.tasks.map((item) => item.agentId));
  const inserted = node("agent-inserted", "/root/000-earlier");
  const after = stableAgentAliases([inserted, ...goldenRoster.nodes], goldenRoster.tasks.map((item) => item.agentId));
  for (const existing of [audit.id, database.id, api.id, queue.id]) {
    assert.equal(after.get(existing), before.get(existing), `adding an Agent renumbered ${existing}`);
  }

  const priority = await new AgentContextDigestRenderer().render({
    revision: 44,
    rootAgentId,
    nodes: [root, audit],
    tasks: [
      task("p-queued", audit.id, "queued", { title: "queued", createdAt: 1 }),
      task("p-idle", audit.id, "succeeded", { title: "recent-idle", settledAt: 10 }),
      task("p-running", audit.id, "running", { title: "running", updatedAt: 20 }),
      task("p-unread", audit.id, "failed", { title: "unread", unreadResult: true, settledAt: 30 }),
      task("p-blocked", audit.id, "waiting", { title: "blocked", waitReason: "resource", updatedAt: 40 }),
    ],
  });
  assert.equal(priority.omittedTasks, 0);
  const offsets = [" W:resource ", " F+ unread", " R running", " D recent-idle", " Q queued"]
    .map((marker) => priority.text.indexOf(marker));
  assert.ok(offsets.every((offset) => offset >= 0));
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  console.log("✓ aliases and priority sorting are stable across order and tree growth");
}

{
  const rendered = await new AgentContextDigestRenderer().render({
    revision: 8,
    rootAgentId,
    nodes: [root, audit],
    tasks: [task("sample-waiting", audit.id, "waiting", { waitReason: "approval" })],
    counts: {
      tasks: 101,
      activeAgents: 7,
      background: 8,
      queued: 90,
      waiting: 1,
      unread: 2,
    },
  });
  assert.match(rendered.text, /^<agents v=8 a=7 bg=8 q=90 w=1 unread=2 more=100>/);
  assert.equal(rendered.omittedTasks, 100);
  console.log("✓ bounded samples preserve full-tree counts");
}

{
  const statuses: TaskStatus[] = ["queued", "succeeded", "running", "failed", "waiting"];
  const tasks: TaskDigest[] = [];
  const nodes: AgentNode[] = [root];
  for (let i = 0; i < 500; i++) {
    const status = statuses[i % statuses.length]!;
    const agent = node(`agent-${i}`, `/root/worker-${i}`, status === "running" ? "running" : "idle");
    nodes.push(agent);
    tasks.push(task(`task-${i}`, agent.id, status, {
      title: `审查边界状态 ${i} ${"长内容".repeat(20)}`,
      waitReason: status === "waiting" ? "dependency" : undefined,
      unreadResult: status === "succeeded" || status === "failed",
      resultId: status === "succeeded" || status === "failed" ? `result-${i}` : undefined,
      awaitPolicy: i % 2 ? "background" : "join",
      createdAt: i,
      updatedAt: i,
      settledAt: i,
    }));
  }
  const rendered = await new AgentContextDigestRenderer().render({
    revision: 99,
    rootAgentId,
    nodes,
    tasks,
  });
  assert.equal(rendered.exact, true);
  assert.equal(rendered.ctx, await countTextExact(rendered.text));
  assert.ok(rendered.ctx <= AGENT_CONTEXT_HARD_CTX, `stress capsule used ${rendered.ctx} ctx`);
  assert.ok(rendered.omittedTasks > 0);
  const included = new Set(rendered.includedTaskIds);
  assert.ok([...included].every((id) => {
    const status = tasks.find((item) => item.id === id)?.status;
    return status === "waiting" || status === "succeeded" || status === "failed";
  }), "lower-priority work displaced a blocked or unread terminal row");
  assert.match(rendered.text, / more=[1-9][0-9]*>/);
  console.log(`✓ 500-task pressure stays at ${rendered.ctx}/${AGENT_CONTEXT_HARD_CTX} ctx`);
}

{
  const sensitiveNode = node("agent-sensitive-id", "/root/private/path", "running", {
    sessionId: "session-sensitive-id",
    label: "RAW_NODE_LABEL",
  });
  const sensitiveTask = {
    ...task("task-sensitive-id", sensitiveNode.id, "waiting", {
      title: "audit </agents> /var/private/key && cat $HOME",
      resultId: "result-sensitive-id",
    }),
    activity: "tool:shell\nRAW_ACTIVITY",
    waitReason: "</agents>RAW_WAIT",
    rawCommand: "cat /var/private/key",
    cwd: "/var/private",
    output: "RAW_OUTPUT_MARKER",
  } as unknown as TaskDigest;
  const rendered = await new AgentContextDigestRenderer().render({
    revision: 1,
    rootAgentId,
    nodes: [root, sensitiveNode],
    tasks: [sensitiveTask],
  });
  for (const forbidden of [
    "session-sensitive-id",
    "agent-sensitive-id",
    "task-sensitive-id",
    "result-sensitive-id",
    "RAW_NODE_LABEL",
    "RAW_ACTIVITY",
    "RAW_WAIT",
    "RAW_OUTPUT_MARKER",
    "cat /var/private/key",
    "$HOME",
    "&&",
  ]) {
    assert.ok(!rendered.text.includes(forbidden), `capsule leaked ${forbidden}`);
  }
  assert.match(rendered.text, / W:other /);
  assert.equal((rendered.text.match(/<\/agents>/g) ?? []).length, 1);
  console.log("✓ raw command, path, output, ids, and unknown runtime codes stay out");
}

{
  let calls = 0;
  const renderer = new AgentContextDigestRenderer({
    maxEntries: 2,
    countTokens: async (text) => {
      calls += 1;
      await Promise.resolve();
      return await countTextExact(text);
    },
  });
  const firstPromise = renderer.render(goldenRoster);
  const concurrentPromise = renderer.render({ ...goldenRoster, tasks: [] });
  assert.equal(firstPromise, concurrentPromise, "one revision did not share its in-flight render");
  const first = await firstPromise;
  const callsAfterFirst = calls;
  const cached = await renderer.render({ ...goldenRoster, tasks: [] });
  assert.equal(cached, first);
  assert.equal(calls, callsAfterFirst);

  await renderer.render({ ...goldenRoster, revision: 43 });
  assert.ok(calls > callsAfterFirst, "new revision reused stale bytes");
  await renderer.render({ ...goldenRoster, rootAgentId: "another-tree", revision: 1 });
  assert.equal(renderer.size, 2);
  console.log("✓ concurrent revision renders coalesce and the LRU stays bounded");
}

{
  const renderer = new AgentContextDigestRenderer({ maxEntries: 1 });
  const broken = task("task-broken", audit.id, "running");
  Object.defineProperty(broken, "title", {
    get: () => {
      throw new Error("synthetic malformed projection");
    },
  });
  const rejected = renderer.render({ ...goldenRoster, revision: 500, tasks: [broken] });
  await renderer.render({ ...goldenRoster, rootAgentId: "evicting-tree", revision: 1, tasks: [] });
  const replacementPromise = renderer.render({ ...goldenRoster, revision: 500 });
  await assert.rejects(rejected, /synthetic malformed projection/);
  const replacement = await replacementPromise;
  assert.equal(await renderer.render({ ...goldenRoster, revision: 500 }), replacement);
  console.log("✓ an evicted rejection cannot erase its replacement cache generation");
}

{
  const renderer = new AgentContextDigestRenderer({
    countTokens: () => {
      throw new Error("synthetic tokenizer outage");
    },
  });
  const rendered = await renderer.render(goldenRoster);
  assert.equal(rendered.exact, false);
  assert.equal(rendered.ctx, Buffer.byteLength(rendered.text, "utf8"));
  assert.ok(rendered.ctx <= AGENT_CONTEXT_HARD_CTX);
  console.log("✓ tokenizer failure falls back to a conservative UTF-8 upper bound");
}

console.log("check-agent-context-digest: all cases passed");
