import assert from "node:assert/strict";
import { timeBudgetMs } from "./check-timing.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { AgentNode, RuntimeTask, TaskActivityCode } from "../shared/src/orchestration.ts";
import type { WireAgentEvent } from "../shared/src/protocol.ts";
import type {
  PiChildAgent,
  PiChildAgentFactory,
} from "../server/src/orchestration/pi-child-worker.ts";
import type { SupervisedAgentRun } from "../server/src/orchestration/agent-supervisor.ts";
import type { Sandbox } from "../server/src/runtime/sandbox.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-pi-child-worker-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const [workerModule, persistence, { WorkspaceWriteLease }] = await Promise.all([
  import("../server/src/orchestration/pi-child-worker.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/orchestration/workspace-lease.ts"),
]);
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const {
  AgentTranscriptConflictError,
  PiChildRunError,
  createPiChildWorkerFactory,
  projectPiChildTranscript,
  taskActivityForTool,
} = workerModule;
const {
  agentMessageDao,
  agentNodeDao,
  agentTaskDao,
  runtimeTaskDao,
  sessionDao,
  userDao,
  workflowDao,
} = persistence;

let tick = 2_000_000_000_000;
const now = () => ++tick;
const userId = "user_pi_child";
const sessionId = "session_pi_child";
const rootAgentId = "agent_root";

userDao.create({
  id: userId,
  email: "pi-child@example.invalid",
  password_hash: "x",
  created_at: now(),
});
sessionDao.create({
  id: sessionId,
  user_id: userId,
  title: "pi Child Agent contract",
  provider: "mock",
  model: "mock",
  sandbox_mode: "workspace-write",
  sandbox_kind: "local",
  sandbox_id: null,
  sandbox_target_id: null,
  e2b_snapshot_id: null,
  mode: "coding",
  approval_policy: "never",
  status: "idle",
  thinking_level: "medium",
  cwd: ".",
  created_at: now(),
  updated_at: now(),
});
agentNodeDao.create({
  id: rootAgentId,
  userId,
  sessionId,
  rootAgentId,
  path: "/root",
  kind: "session",
  status: "idle",
  createdAt: now(),
});

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost };
function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "mock",
    model: "mock-child",
    usage: zeroUsage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: now(),
  };
}

type PromptPlan = (agent: FakeAgent, signal: AbortSignal) => Promise<void> | void;

class FakeAgent implements PiChildAgent {
  readonly state: {
    messages: AgentMessage[];
    isStreaming: boolean;
    errorMessage?: string;
  };
  readonly steers: AgentMessage[] = [];
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private controller: AbortController | null = null;

  constructor(readonly options: AgentOptions, private readonly plans: PromptPlan[]) {
    this.state = {
      messages: [...(options.initialState?.messages ?? [])],
      isStreaming: false,
    };
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string): Promise<void> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state.isStreaming = true;
    const user: UserMessage = { role: "user", content: message, timestamp: now() };
    this.state.messages.push(user);
    await this.emit({ type: "agent_start" }, signal);
    await this.emit({ type: "message_start", message: user }, signal);
    try {
      const plan = this.plans.shift();
      if (!plan) throw new Error("Fake pi Agent has no PromptPlan");
      await plan(this, signal);
    } finally {
      this.state.isStreaming = false;
      await this.emit({ type: "agent_end", messages: [] }, signal);
      this.controller = null;
    }
  }

  steer(message: AgentMessage): void {
    this.steers.push(message);
  }

  abort(): void {
    this.controller?.abort(new DOMException("Fake pi abort", "AbortError"));
  }

  clearAllQueues(): void {
    this.steers.length = 0;
  }

  async tool(id: string, name: string): Promise<void> {
    const signal = this.controller!.signal;
    await this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }, signal);
    await this.emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      result: { content: [], details: {} },
      isError: false,
    }, signal);
  }

  async startToolOnly(id: string, name: string): Promise<void> {
    const signal = this.controller!.signal;
    await this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }, signal);
  }

  async toolResult(id: string, name: string, args: unknown, result: unknown): Promise<void> {
    const signal = this.controller!.signal;
    await this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args }, signal);
    await this.emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      result: result as never,
      isError: false,
    }, signal);
  }

  async finish(message: AssistantMessage): Promise<void> {
    this.state.messages.push(message);
    const signal = this.controller!.signal;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      this.state.errorMessage = message.errorMessage;
    }
    await this.emit({ type: "message_start", message }, signal);
    await this.emit({ type: "message_end", message }, signal);
    await this.emit({ type: "turn_end", message, toolResults: [] }, signal);
  }

  private async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    for (const listener of this.listeners) await listener(event, signal);
  }
}

class FakePiHarness {
  readonly plans: PromptPlan[] = [];
  readonly agents: FakeAgent[] = [];
  readonly options: AgentOptions[] = [];

  readonly createAgent: PiChildAgentFactory = (options) => {
    this.options.push(options);
    const agent = new FakeAgent(options, this.plans);
    this.agents.push(agent);
    return agent;
  };
}

function createInitialTask(input: {
  agentId: string;
  taskId: string;
  path: string;
  message: string;
  context: "none" | "recent" | "all";
}) {
  const created = agentTaskDao.create({
    agent: {
      id: input.agentId,
      userId,
      sessionId,
      rootAgentId,
      parentAgentId: rootAgentId,
      path: input.path,
      label: input.path.split("/").at(-1),
      provider: "mock",
      model: "mock",
      kind: "subagent",
      createdAt: now(),
    },
    task: {
      id: input.taskId,
      userId,
      sessionId,
      ownerSessionId: sessionId,
      agentId: input.agentId,
      kind: "delegation",
      title: input.message,
      payload: { message: input.message, context: input.context },
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: false,
      createdAt: now(),
    },
  });
  const agent = agentNodeDao.transitionStatus({
    id: created.agent.id,
    userId,
    expectedVersion: created.agent.version,
    nextStatus: "running",
    at: now(),
  })!;
  return { agent, task: startTask(created.task) };
}

function createFollowUp(agentId: string, taskId: string, message: string, resetContext = false): RuntimeTask {
  const created = runtimeTaskDao.create({
    id: taskId,
    userId,
    sessionId,
    ownerSessionId: sessionId,
    agentId,
    kind: "delegation",
    title: message,
    payload: { message, context: "none", ...(resetContext ? { resetContext: true } : {}) },
    awaitPolicy: "background",
    cancelPolicy: "detached",
    checkpointSafe: false,
    createdAt: now(),
  });
  return startTask(created);
}

function startTask(task: RuntimeTask): RuntimeTask {
  const claimed = runtimeTaskDao.claim({
    id: task.id,
    userId,
    expectedVersion: task.version,
    at: now(),
    eventPayload: {},
  })!;
  return runtimeTaskDao.transition({
    id: claimed.id,
    userId,
    expectedVersion: claimed.version,
    expectedLeaseGeneration: claimed.leaseGeneration,
    nextStatus: "running",
    activity: "model",
    at: now(),
    eventType: "test:running",
    eventPayload: {},
  })!;
}

function settleTask(task: RuntimeTask, status: "succeeded" | "failed" | "interrupted" = "succeeded"): void {
  const current = runtimeTaskDao.byId(userId, task.id)!;
  assert.ok(runtimeTaskDao.transition({
    id: current.id,
    userId,
    expectedVersion: current.version,
    expectedLeaseGeneration: current.leaseGeneration,
    nextStatus: status,
    at: now(),
    eventType: `test:${status}`,
    eventPayload: {},
  }));
}

function runInput(
  agent: AgentNode,
  task: RuntimeTask,
  signal: AbortSignal,
  activities: TaskActivityCode[] = [],
  progress: WireAgentEvent[] = [],
): SupervisedAgentRun {
  return {
    agent,
    task,
    signal,
    updateActivity: (activity) => activities.push(activity),
    publishProgress: (event) => {
      progress.push(event);
      return true;
    },
    checkpointUsage: () => true,
  };
}

async function until(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const fakeModel: Model<any> = {
  id: "mock-child",
  name: "Mock Child",
  api: "openai-responses",
  provider: "mock",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: zeroCost,
  contextWindow: 128_000,
  maxTokens: 4_096,
};
const workflowControllerPrompt = "CONTROLLER-SYSTEM-CONTRACT";
const sandbox = {} as Sandbox;
const writeLease = new WorkspaceWriteLease();
const injectedTool = { name: "injected", label: "Injected" } as AgentTool<any>;
const harness = new FakePiHarness();
const seedModes: string[] = [];
let toolResolverCalls = 0;
const lifecycle = new AbortController();
const workerFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: ({ agent }) => {
    assert.ok(agent.id.startsWith("agent_"));
    return fakeModel;
  },
  systemPrompt: "system-only sentinel",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: (input) => {
    toolResolverCalls += 1;
    assert.equal(input.sandbox, sandbox);
    assert.equal(input.workspaceWriteLease, writeLease);
    return [injectedTool];
  },
  contextSeed: ({ mode, limits }) => {
    seedModes.push(mode);
    assert.ok(limits.maxMessages > 0 && limits.maxBytes > limits.maxMessageBytes);
    return [{ role: "user", content: `seed:${mode}`, timestamp: now() }];
  },
  createAgent: harness.createAgent,
  now,
});

const cold = createInitialTask({
  agentId: "agent_cold_restore",
  taskId: "task_cold_restore",
  path: "/root/cold_restore",
  message: "Continue the restored context",
  context: "none",
});
const coldDense: UserMessage = { role: "user", content: "汉".repeat(4_000), timestamp: now() };
assert.ok(agentMessageDao.replaceFromTask({
  userId,
  agentId: cold.agent.id,
  taskId: cold.task.id,
  leaseGeneration: cold.task.leaseGeneration,
  expectedVersion: 0,
  messages: [coldDense],
  savedAt: now(),
}));
const coldHarness = new FakePiHarness();
coldHarness.plans.push(async (agent) => agent.finish(assistant("Cold restore report")));
const coldFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: { ...fakeModel, contextWindow: 15_000 },
  systemPrompt: "cold",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: [],
  contextSeed: () => [],
  createAgent: coldHarness.createAgent,
  now,
});
const coldWorker = await coldFactory({
  agent: cold.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
assert.equal((await coldWorker.run(runInput(cold.agent, cold.task, new AbortController().signal))).summary, "Cold restore report");
assert.deepEqual(coldHarness.options[0]!.initialState?.messages, [coldDense]);
settleTask(cold.task);
await coldWorker.close?.();
console.log("  ✓ cold restore prepares exact counting before transcript projection");

const strictAll = createInitialTask({
  agentId: "agent_strict_all",
  taskId: "task_strict_all",
  path: "/root/strict_all",
  message: "Keep the complete parent context",
  context: "all",
});
const strictAllMessages: UserMessage[] = [
  { role: "user", content: "汉".repeat(55_000), timestamp: now() },
  { role: "user", content: "字".repeat(49_000), timestamp: now() },
];
assert.ok(agentMessageDao.replaceFromTask({
  userId,
  agentId: strictAll.agent.id,
  taskId: strictAll.task.id,
  leaseGeneration: strictAll.task.leaseGeneration,
  expectedVersion: 0,
  messages: strictAllMessages,
  savedAt: now(),
}));
const strictAllHarness = new FakePiHarness();
const strictAllFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: fakeModel,
  systemPrompt: "system-only sentinel",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: [injectedTool],
  contextSeed: () => [],
  createAgent: strictAllHarness.createAgent,
  now,
});
const strictAllWorker = await strictAllFactory({
  agent: strictAll.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
await assert.rejects(
  strictAllWorker.run(runInput(strictAll.agent, strictAll.task, new AbortController().signal)),
  /Full parent context exceeds the actual Child Agent model budget/,
);
assert.equal(strictAllHarness.agents.length, 0, "a rejected full handoff never starts pi");
assert.deepEqual(agentMessageDao.load(userId, strictAll.agent.id)?.messages, strictAllMessages);
settleTask(strictAll.task, "failed");
await strictAllWorker.close?.();
console.log("  ✓ full context fails explicitly instead of degrading to a recent suffix");

const first = createInitialTask({
  agentId: "agent_reuse",
  taskId: "task_first",
  path: "/root/reuse",
  message: "First assignment",
  context: "recent",
});
const firstGate = deferred();
harness.plans.push(async (agent) => {
  await agent.tool("call_shell", "bash");
  await firstGate.promise;
  await agent.finish(assistant("First report"));
});
const worker = await workerFactory({
  agent: first.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: lifecycle.signal,
});
assert.equal(await worker.steer?.("too early"), false);
const activities: TaskActivityCode[] = [];
const firstRun = worker.run(runInput(first.agent, first.task, new AbortController().signal, activities));
await until(() => harness.agents[0]?.state.isStreaming === true, "first fake Agent starts");
assert.equal(await worker.steer?.("Inspect the edge"), true);
assert.equal((harness.agents[0]!.steers[0] as UserMessage).content, "Inspect the edge");
firstGate.resolve();
const firstResult = await firstRun;
assert.equal(firstResult.summary, "First report");
assert.equal((firstResult.body as { report?: string }).report, "First report");
assert.equal(await worker.steer?.("too late"), false);
assert.deepEqual(activities, ["tool:shell", "model"]);
assert.deepEqual(seedModes, ["recent"]);
assert.equal(toolResolverCalls, 1);
assert.equal(harness.options.length, 1);
assert.equal(harness.options[0]!.initialState?.systemPrompt, "system-only sentinel");
assert.deepEqual(harness.options[0]!.initialState?.tools, [injectedTool]);
assert.equal(harness.options[0]!.sessionId, `${sessionId}:agent:${first.agent.id}`);
const firstSnapshot = agentMessageDao.load(userId, first.agent.id)!;
assert.equal(firstSnapshot.version, 1);
assert.equal((firstSnapshot.messages[0] as { content: string }).content, "seed:recent");
assert.equal((firstSnapshot.messages[1] as { content: string }).content, "First assignment");
assert.equal(JSON.stringify(firstSnapshot.messages).includes("system-only sentinel"), false);
settleTask(first.task);
console.log("  ✓ first assignment uses a bounded handoff, shared capability inputs, activity codes, and active-only steer");

const followUp = createFollowUp(first.agent.id, "task_followup", "Second assignment");
harness.plans.push(async (agent) => agent.finish(assistant("Second report")));
assert.equal((await worker.run(runInput(first.agent, followUp, new AbortController().signal))).summary, "Second report");
assert.equal(harness.options.length, 1, "a warm follow-up reuses one pi Agent instance");
assert.equal(agentMessageDao.load(userId, first.agent.id)?.version, 2);
assert.deepEqual(seedModes, ["recent"], "a follow-up never replays the parent handoff");
settleTask(followUp);
await worker.close?.();

const beforeRecovery = agentMessageDao.load(userId, first.agent.id)!;
const recoveredTask = createFollowUp(first.agent.id, "task_recovered", "Recovered assignment");
harness.plans.push(async (agent) => agent.finish(assistant("Recovered report")));
const recoveredLifecycle = new AbortController();
const recoveredWorker = await workerFactory({
  agent: first.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: recoveredLifecycle.signal,
});
assert.equal((await recoveredWorker.run(runInput(first.agent, recoveredTask, new AbortController().signal))).summary, "Recovered report");
assert.equal(harness.options.length, 2);
assert.deepEqual(harness.options[1]!.initialState?.messages, beforeRecovery.messages);
assert.deepEqual(seedModes, ["recent"], "durable transcript recovery supersedes a new seed");
settleTask(recoveredTask);
await recoveredWorker.close?.();
console.log("  ✓ follow-ups reuse warm context and a recreated worker restores the exact durable transcript");

const resetTask = createFollowUp(first.agent.id, "task_reset_context", "Fresh joined assignment", true);
const transcriptBeforeReset = agentMessageDao.load(userId, first.agent.id)!;
const oversizedOldContext: UserMessage = {
  role: "user",
  content: Array.from({ length: 100_000 }, (_, index) =>
    String.fromCodePoint(0x4E00 + (index % 18_000))).join(""),
  timestamp: now(),
};
assert.ok(agentMessageDao.replaceFromTask({
  userId,
  agentId: first.agent.id,
  taskId: resetTask.id,
  leaseGeneration: resetTask.leaseGeneration,
  expectedVersion: transcriptBeforeReset.version,
  messages: [oversizedOldContext],
  savedAt: now(),
}));
harness.plans.push(async (agent) => agent.finish(assistant("Fresh joined report")));
const resetWorker = await workerFactory({
  agent: first.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
assert.equal((await resetWorker.run(runInput(first.agent, resetTask, new AbortController().signal))).summary, "Fresh joined report");
assert.deepEqual(harness.options.at(-1)!.initialState?.messages, []);
const resetSnapshot = agentMessageDao.load(userId, first.agent.id)!;
assert.equal((resetSnapshot.messages[0] as { content: string }).content, "Fresh joined assignment");
settleTask(resetTask);
await resetWorker.close?.();
console.log("  ✓ reset context clears restored history before model-budget projection");

const aborted = createInitialTask({
  agentId: "agent_abort",
  taskId: "task_abort",
  path: "/root/abort",
  message: "Wait until abort",
  context: "none",
});
harness.plans.push(async (agent, signal) => {
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  await agent.finish(assistant("", "aborted", "provider stream aborted"));
});
const abortLifecycle = new AbortController();
const abortWorker = await workerFactory({
  agent: aborted.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: abortLifecycle.signal,
});
const taskAbort = new AbortController();
const abortRun = abortWorker.run(runInput(aborted.agent, aborted.task, taskAbort.signal));
await until(() => harness.agents.at(-1)?.state.isStreaming === true, "abort fake Agent starts");
taskAbort.abort(new DOMException("user interrupted", "AbortError"));
await assert.rejects(abortRun, (error: unknown) => error instanceof Error && error.name === "AbortError");
const abortSnapshot = agentMessageDao.load(userId, aborted.agent.id)!;
assert.equal((abortSnapshot.messages.at(-1) as { stopReason: string }).stopReason, "aborted");
assert.deepEqual(seedModes, ["recent"], "context none never invokes the handoff callback");
settleTask(aborted.task, "interrupted");
await abortWorker.close?.();
console.log("  ✓ AbortSignal reaches pi and an aborted terminal response is persisted before Task settlement");

const errored = createInitialTask({
  agentId: "agent_error",
  taskId: "task_error",
  path: "/root/error",
  message: "Return an error",
  context: "all",
});
harness.plans.push(async (agent) => agent.finish(assistant("partial", "error", "upstream failed")));
const errorLifecycle = new AbortController();
const errorWorker = await workerFactory({
  agent: errored.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: errorLifecycle.signal,
});
await assert.rejects(
  errorWorker.run(runInput(errored.agent, errored.task, new AbortController().signal)),
  (error: unknown) => error instanceof PiChildRunError && error.stopReason === "error" && /upstream failed/.test(error.message),
);
assert.equal((agentMessageDao.load(userId, errored.agent.id)?.messages.at(-1) as { stopReason: string }).stopReason, "error");
assert.deepEqual(seedModes, ["recent", "all"]);
settleTask(errored.task, "failed");
await errorWorker.close?.();
console.log("  ✓ pi stopReason:error is a failed Task result, not a successful partial report");

const stale = createInitialTask({
  agentId: "agent_stale",
  taskId: "task_stale",
  path: "/root/stale",
  message: "Race a transcript writer",
  context: "none",
});
const staleGate = deferred();
harness.plans.push(async (agent) => {
  await staleGate.promise;
  await agent.finish(assistant("Must lose the transcript CAS"));
});
const staleLifecycle = new AbortController();
const staleWorker = await workerFactory({
  agent: stale.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: staleLifecycle.signal,
});
const staleRun = staleWorker.run(runInput(stale.agent, stale.task, new AbortController().signal));
await until(() => harness.agents.at(-1)?.state.isStreaming === true, "stale fake Agent starts");
const external: UserMessage = { role: "user", content: "newer transcript owner", timestamp: now() };
assert.equal(agentMessageDao.replaceFromTask({
  userId,
  agentId: stale.agent.id,
  taskId: stale.task.id,
  leaseGeneration: stale.task.leaseGeneration,
  expectedVersion: 0,
  messages: [external],
  savedAt: now(),
})?.version, 1);
staleGate.resolve();
await assert.rejects(staleRun, (error: unknown) => error instanceof AgentTranscriptConflictError);
assert.deepEqual(agentMessageDao.load(userId, stale.agent.id)?.messages, [external]);
settleTask(stale.task, "failed");

const staleRecoveryTask = createFollowUp(stale.agent.id, "task_stale_recovery", "Continue from the newer owner");
harness.plans.push(async (agent) => agent.finish(assistant("Recovered after the lost CAS")));
const agentsBeforeStaleRecovery = harness.agents.length;
assert.equal(
  (await staleWorker.run(runInput(stale.agent, staleRecoveryTask, new AbortController().signal))).summary,
  "Recovered after the lost CAS",
);
assert.equal(harness.agents.length, agentsBeforeStaleRecovery + 1, "a lost CAS discards the split-brain pi cache");
assert.deepEqual(harness.options.at(-1)!.initialState?.messages, [external]);
assert.equal(agentMessageDao.load(userId, stale.agent.id)?.version, 2);
settleTask(staleRecoveryTask);
await staleWorker.close?.();
console.log("  ✓ a stale transcript CAS reloads newer durable context before the next Task");

const expired = createInitialTask({
  agentId: "agent_expired",
  taskId: "task_expired",
  path: "/root/expired",
  message: "Lose the active Task lease",
  context: "none",
});
const expiredGate = deferred();
harness.plans.push(async (agent) => {
  await expiredGate.promise;
  await agent.finish(assistant("This transcript has no active lease"));
});
const expiredWorker = await workerFactory({
  agent: expired.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
const expiredRun = expiredWorker.run(runInput(expired.agent, expired.task, new AbortController().signal));
await until(() => harness.agents.at(-1)?.state.isStreaming === true, "expired-lease fake Agent starts");
settleTask(expired.task, "interrupted");
expiredGate.resolve();
await assert.rejects(expiredRun, (error: unknown) => error instanceof AgentTranscriptConflictError);
assert.equal(agentMessageDao.load(userId, expired.agent.id)?.version, 0);
await expiredWorker.close?.();
console.log("  ✓ Task lease expiry also fences a late pi transcript writer");

const danglingProgress = createInitialTask({
  agentId: "agent_dangling_progress",
  taskId: "task_dangling_progress",
  path: "/root/dangling_progress",
  message: "Expose a malformed successful provider boundary",
  context: "none",
});
harness.plans.push(async (agent) => {
  await agent.startToolOnly("call_dangling_progress", "bash");
  await agent.finish(assistant("Provider incorrectly stopped before the Tool settled"));
});
const danglingWorker = await workerFactory({
  agent: danglingProgress.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
const danglingEvents: WireAgentEvent[] = [];
await assert.rejects(
  danglingWorker.run(runInput(
    danglingProgress.agent,
    { ...danglingProgress.task, awaitPolicy: "join", ownerStepId: "step_dangling_progress" },
    new AbortController().signal,
    [],
    danglingEvents,
  )),
  /unsettled projected Tool steps/,
);
assert.equal(
  danglingEvents.find((event): event is Extract<WireAgentEvent, { t: "turn_end" }> => event.t === "turn_end")?.status,
  "failed",
);
assert.equal(
  danglingEvents.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
    event.t === "tool_end" && event.id === "call_dangling_progress")?.status,
  "error",
);
settleTask(danglingProgress.task, "failed");
await danglingWorker.close?.();
console.log("  ✓ malformed provider success cannot produce Task success with failed Child progress");

const boundedProgress = createInitialTask({
  agentId: "agent_bounded_progress",
  taskId: "task_bounded_progress",
  path: "/root/bounded_progress",
  message: "Project a huge tool result",
  context: "none",
});
let hugeProgressBuffer = Buffer.alloc(64 * 1024 * 1024, 0x20);
hugeProgressBuffer.write("bounded-tail", hugeProgressBuffer.length - 12, "utf8");
let hugeProgressText = hugeProgressBuffer.toString("utf8");
hugeProgressBuffer = Buffer.alloc(0);
harness.plans.push(async (agent) => {
  await agent.toolResult(
    "call_huge_progress",
    "bash",
    { command: "printf bounded", content: hugeProgressText },
    {
      content: [{ type: "text", text: hugeProgressText }],
      details: {
        shell: {
          stdout: hugeProgressText,
          stderr: hugeProgressText,
          exitCode: 0,
          timedOut: false,
          truncated: false,
        },
      },
    },
  );
  await agent.finish(assistant("Bounded progress report"));
});
const boundedProgressWorker = await workerFactory({
  agent: boundedProgress.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
const boundedEvents: WireAgentEvent[] = [];
const rssBeforeProgress = process.memoryUsage().rss;
const boundedStarted = performance.now();
const boundedResult = await boundedProgressWorker.run(runInput(
  boundedProgress.agent,
  { ...boundedProgress.task, awaitPolicy: "join", ownerStepId: "step_bounded_progress" },
  new AbortController().signal,
  [],
  boundedEvents,
));
const boundedElapsedMs = performance.now() - boundedStarted;
const boundedRssDelta = process.memoryUsage().rss - rssBeforeProgress;
assert.equal(boundedResult.summary, "Bounded progress report");
assert.ok(boundedElapsedMs < timeBudgetMs(2_000), `64 MiB progress projection stays bounded (${boundedElapsedMs.toFixed(1)}ms)`);
assert.ok(boundedRssDelta < 48 * 1024 * 1024, `progress projection adds <48 MiB RSS (got ${boundedRssDelta})`);
const boundedWireBytes = Buffer.byteLength(JSON.stringify(boundedEvents), "utf8");
assert.ok(boundedWireBytes < 256 * 1024, `bounded progress wire remains small (${boundedWireBytes} bytes)`);
const boundedToolEnd = boundedEvents.find((event): event is Extract<WireAgentEvent, { t: "tool_end" }> =>
  event.t === "tool_end" && event.id === "call_huge_progress");
assert.equal(boundedToolEnd?.shell?.truncated, true);
assert.ok((boundedToolEnd?.resultText?.length ?? 0) < 40 * 1024);
hugeProgressText = "";
settleTask(boundedProgress.task);
await boundedProgressWorker.close?.();
console.log(
  `  ✓ huge strings stay bounded: ${boundedElapsedMs.toFixed(1)}ms, `
  + `RSS +${(boundedRssDelta / 1024 / 1024).toFixed(1)} MiB, wire ${boundedWireBytes} bytes`,
);

assert.equal(taskActivityForTool("read_file"), "tool:read");
assert.equal(taskActivityForTool("edit_file"), "tool:write");
assert.equal(taskActivityForTool("mcp__browser__open"), "tool:browser");
assert.equal(taskActivityForTool("mcp__exa__search"), "tool:search");
assert.equal(taskActivityForTool("unknown_capability"), "tool:other");
const oversized = Array.from({ length: 260 }, (_, index): UserMessage => ({
  role: "user",
  content: `bounded-${index}`,
  timestamp: now(),
}));
const projected = projectPiChildTranscript(oversized);
assert.equal(projected.length, 256);
assert.equal((projected[0] as { content: string }).content, "bounded-4");
const chainUser: UserMessage = { role: "user", content: "run a tool", timestamp: now() };
const toolCalling = {
  ...assistant("", "toolUse"),
  content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "fixture.txt" } }],
} as AssistantMessage;
const toolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read_file",
  content: [{ type: "text", text: "fixture" }],
  details: {},
  isError: false,
  timestamp: now(),
} as AgentMessage;
assert.deepEqual(projectPiChildTranscript([chainUser, toolCalling]), [chainUser]);
assert.deepEqual(projectPiChildTranscript([chainUser, toolCalling, toolResult]), [chainUser, toolCalling, toolResult]);
assert.deepEqual(projectPiChildTranscript([
  chainUser,
  { ...toolResult, toolCallId: "wrong_call" } as AgentMessage,
]), [chainUser]);

const warmProjectionStarted = performance.now();
const largeWarmProjection = projectPiChildTranscript([
  { role: "user", content: "汉".repeat(55_000), timestamp: now() },
  { role: "user", content: "字".repeat(49_000), timestamp: now() },
], 150_000);
assert.equal(largeWarmProjection.length, 2);
assert.ok(
  performance.now() - warmProjectionStarted < 5_000,
  "warm dense transcript projection must use bounded tokenizer chunks",
);
console.log("  ✓ Tool names collapse to closed activity codes and cache persistence keeps a coherent bounded suffix");

const real = createInitialTask({
  agentId: "agent_real_pi",
  taskId: "task_real_pi",
  path: "/root/real_pi",
  message: "Exercise the real pi Agent",
  context: "none",
});
let realStreamCalls = 0;
function deterministicStream(
  _model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  realStreamCalls += 1;
  assert.equal(context.systemPrompt, "real pi system prompt");
  assert.equal(options?.apiKey, "real-pi-key");
  const stream = createAssistantMessageEventStream();
  if (realStreamCalls === 2) {
    queueMicrotask(() => {
      const failed = assistant("partial real output", "error", "real pi upstream error");
      stream.push({ type: "start", partial: { ...failed, content: [] } });
      stream.push({ type: "error", reason: "error", error: failed });
      stream.end(failed);
    });
    return stream;
  }
  if (realStreamCalls === 3) {
    const finishAbort = () => {
      const abortedMessage = assistant("", "aborted", "real pi stream aborted");
      stream.push({ type: "start", partial: { ...abortedMessage, content: [] } });
      stream.push({ type: "error", reason: "aborted", error: abortedMessage });
      stream.end(abortedMessage);
    };
    if (options?.signal?.aborted) queueMicrotask(finishAbort);
    else options?.signal?.addEventListener("abort", finishAbort, { once: true });
    return stream;
  }
  queueMicrotask(() => {
    const done = assistant("Real pi report");
    const empty = { ...done, content: [] as AssistantMessage["content"] };
    stream.push({ type: "start", partial: empty });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...done, content: [{ type: "text", text: "" }] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Real pi report", partial: done });
    stream.push({ type: "text_end", contentIndex: 0, content: "Real pi report", partial: done });
    stream.push({ type: "done", reason: "stop", message: done });
    stream.end(done);
  });
  return stream;
}
const realFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: fakeModel,
  systemPrompt: "real pi system prompt",
  workflowControllerPrompt,
  getApiKey: () => "real-pi-key",
  tools: [],
  contextSeed: () => [],
  streamFn: deterministicStream,
  now,
});
const realWorker = await realFactory({
  agent: real.agent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
assert.equal((await realWorker.run(runInput(real.agent, real.task, new AbortController().signal))).summary, "Real pi report");
assert.equal(realStreamCalls, 1);
assert.deepEqual(agentMessageDao.load(userId, real.agent.id)?.messages.map((message) => messageRoleForTest(message)), [
  "user",
  "assistant",
]);
settleTask(real.task);

const realErrorTask = createFollowUp(real.agent.id, "task_real_pi_error", "Exercise a real pi error");
await assert.rejects(
  realWorker.run(runInput(real.agent, realErrorTask, new AbortController().signal)),
  (error: unknown) => error instanceof PiChildRunError && /real pi upstream error/.test(error.message),
);
assert.equal(
  (agentMessageDao.load(userId, real.agent.id)?.messages.at(-1) as { stopReason: string }).stopReason,
  "error",
);
settleTask(realErrorTask, "failed");

const realAbortTask = createFollowUp(real.agent.id, "task_real_pi_abort", "Exercise a real pi abort");
const realTaskAbort = new AbortController();
const realAbortRun = realWorker.run(runInput(real.agent, realAbortTask, realTaskAbort.signal));
await until(() => realStreamCalls === 3, "real pi abort stream starts");
realTaskAbort.abort(new DOMException("real task interrupted", "AbortError"));
await assert.rejects(realAbortRun, (error: unknown) => error instanceof Error && error.name === "AbortError");
assert.equal(
  (agentMessageDao.load(userId, real.agent.id)?.messages.at(-1) as { stopReason: string }).stopReason,
  "aborted",
);
settleTask(realAbortTask, "interrupted");
await realWorker.close?.();
assert.equal(realStreamCalls, 3);
console.log("  ✓ the default adapter drives real pi success, error, and abort streams with injected dependencies");

const budgetAgent = agentNodeDao.create({
  id: "agent_workflow_budget",
  userId,
  sessionId,
  rootAgentId,
  parentAgentId: rootAgentId,
  path: "/root/workflow_budget",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const workflowNode = {
  id: "budget_node",
  name: "Budget node",
  kind: "work" as const,
  payload: { message: "Use the bounded provider request" },
  effect: "workspace_read" as const,
  cachePolicy: "none" as const,
  maxAttempts: 1,
  executorAgentId: budgetAgent.id,
};
let budgetWorkflow = workflowDao.create({
  id: "workflow_pi_budget",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  name: "Pi budget",
  nodes: [workflowNode],
  edges: [],
  budget: { maxTokens: 20_000, maxCostMicros: 1_000_000, maxRuntimeMs: 5_000 },
  createdAt: now(),
});
budgetWorkflow = workflowDao.start(userId, budgetWorkflow.workflow.id, budgetWorkflow.workflow.version, now())!;
const budgetDispatch = workflowDao.claim({
  workflowId: budgetWorkflow.workflow.id,
  userId,
  nodeId: workflowNode.id,
  taskId: "task_workflow_budget",
  expectedVersion: budgetWorkflow.workflow.version,
  at: now(),
})!;
const budgetTask = startTask(budgetDispatch.task);
const budgetModel = { ...fakeModel, contextWindow: 200_000, maxTokens: 100_000 };
const readTool: AgentTool<any> = {
  name: "read_file",
  label: "Read file",
  description: "Read one test file.",
  parameters: Type.Object({ path: Type.String() }),
  async execute() {
    return { content: [{ type: "text", text: "bounded fixture" }], details: {} };
  },
};
const writeTool = { ...injectedTool, name: "write_file" } as AgentTool<any>;
const boundedRequests: Array<{
  maxTokens?: number;
  timeoutMs?: number;
  tools: string[];
  systemPromptBytes: number;
  hasControllerContract: boolean;
}> = [];
let budgetStreamCalls = 0;
const budgetFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: budgetModel,
  systemPrompt: "bounded workflow system prompt",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: [readTool, writeTool],
  contextSeed: () => [],
  prepareStreamContext: async (context) => {
    tick += 250;
    return { ...context, systemPrompt: `${context.systemPrompt}\n${"R".repeat(1_024)}` };
  },
  streamFn: (_model, context, options) => {
    budgetStreamCalls += 1;
    boundedRequests.push({
      maxTokens: options?.maxTokens,
      timeoutMs: options?.timeoutMs,
      tools: context.tools?.map((tool) => tool.name) ?? [],
      systemPromptBytes: Buffer.byteLength(context.systemPrompt, "utf8"),
      hasControllerContract: context.systemPrompt.includes(workflowControllerPrompt),
    });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const done: AssistantMessage = budgetStreamCalls === 1 ? {
        ...assistant("", "toolUse"),
        content: [{
          type: "toolCall",
          id: "call_budget_read",
          name: "read_file",
          arguments: { path: "fixture.txt" },
        }],
        usage: {
          input: 80,
          output: 43,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 123,
          cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 },
        },
      } : {
        ...assistant("Budgeted report"),
        usage: {
          input: 50,
          output: 27,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 77,
          cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 },
        },
      };
      stream.push({ type: "start", partial: { ...done, content: [] } });
      stream.push({ type: "done", reason: done.stopReason, message: done });
      stream.end(done);
    });
    return stream;
  },
  now,
});
const budgetWorker = await budgetFactory({
  agent: budgetAgent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
const budgetRun = runInput(budgetAgent, budgetTask, new AbortController().signal);
const usageCheckpoints: Array<{ tokensUsed: number; costUsedMicros: number }> = [];
budgetRun.checkpointUsage = (tokensUsed, costUsedMicros) => {
  usageCheckpoints.push({ tokensUsed, costUsedMicros });
  const current = workflowDao.snapshot(userId, budgetWorkflow.workflow.id)!;
  budgetWorkflow = workflowDao.recordUsage({
    workflowId: budgetWorkflow.workflow.id,
    userId,
    nodeId: workflowNode.id,
    taskId: budgetTask.id,
    expectedTaskLeaseGeneration: budgetTask.leaseGeneration,
    expectedVersion: current.workflow.version,
    tokensUsed,
    costUsedMicros,
    at: now(),
  })!;
  return budgetWorkflow.workflow.status !== "cancelling";
};
const budgetResult = await budgetWorker.run(budgetRun);
assert.equal(budgetResult.tokensUsed, 200);
assert.equal(budgetResult.costUsedMicros, 5);
assert.deepEqual(usageCheckpoints, [
  { tokensUsed: 123, costUsedMicros: 3 },
  { tokensUsed: 200, costUsedMicros: 5 },
]);
assert.equal(boundedRequests.length, 2);
assert.deepEqual(
  boundedRequests.map((request) => request.tools),
  [
    ["read_file", "workflow_read_dependency"],
    ["read_file", "workflow_read_dependency"],
  ],
);
assert.ok(boundedRequests.every((request) => request.systemPromptBytes > 1_024));
assert.ok(boundedRequests.every((request) => request.hasControllerContract === false));
assert.ok((boundedRequests[0]?.maxTokens ?? 0) > 0 && (boundedRequests[0]?.maxTokens ?? 0) < 20_000);
assert.ok(
  (boundedRequests[1]?.maxTokens ?? 0) > 0
    && (boundedRequests[1]?.maxTokens ?? 0) < (boundedRequests[0]?.maxTokens ?? 0),
);
assert.ok(boundedRequests.every((request) =>
  (request.timeoutMs ?? 0) > 0 && (request.timeoutMs ?? 0) < 4_800
));
budgetWorkflow = workflowDao.snapshot(userId, budgetWorkflow.workflow.id)!;
assert.equal(budgetWorkflow.workflow.tokensUsed, 200);
assert.equal(budgetWorkflow.workflow.tokensReserved, 20_000 - 200);
assert.equal(runtimeTaskDao.byId(userId, budgetTask.id)?.providerTokensUsed, 200);
assert.ok(workflowDao.settleExecution({
  id: "result_workflow_budget",
  taskId: budgetTask.id,
  userId,
  summary: budgetResult.summary,
  body: budgetResult.body ?? {},
  artifacts: budgetResult.artifacts ?? [],
  expectedTaskVersion: runtimeTaskDao.byId(userId, budgetTask.id)!.version,
  expectedLeaseGeneration: budgetTask.leaseGeneration,
  nextStatus: "succeeded",
  tokensUsed: budgetResult.tokensUsed,
  costUsedMicros: budgetResult.costUsedMicros,
  createdAt: now(),
}));
budgetWorkflow = workflowDao.snapshot(userId, budgetWorkflow.workflow.id)!;
assert.equal(budgetWorkflow.workflow.tokensReserved, 0);
assert.equal(budgetWorkflow.workflow.costReservedMicros, 0);
await budgetWorker.close?.();
console.log("  ✓ Workflow reservations cap provider requests, reduce Tools, and checkpoint each cycle");

const textOnlyControllerAgent = agentNodeDao.create({
  id: "agent_text_only_controller",
  userId,
  sessionId,
  rootAgentId,
  parentAgentId: rootAgentId,
  path: "/root/text_only_controller",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const textOnlyControllerNode = {
  id: "text_only_controller",
  name: "Text-only controller",
  kind: "controller" as const,
  payload: { message: "Plan the graph, but omit every Tool call." },
  effect: "unknown" as const,
  cachePolicy: "none" as const,
  maxAttempts: 1,
  executorAgentId: textOnlyControllerAgent.id,
};
let textOnlyWorkflow = workflowDao.create({
  id: "workflow_text_only_controller",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  controllerAgentId: textOnlyControllerAgent.id,
  name: "Text-only Controller guard",
  nodes: [textOnlyControllerNode],
  edges: [],
  graphSealed: false,
  createdAt: now(),
});
textOnlyWorkflow = workflowDao.start(
  userId,
  textOnlyWorkflow.workflow.id,
  textOnlyWorkflow.workflow.version,
  now(),
)!;
const textOnlyDispatch = workflowDao.claim({
  workflowId: textOnlyWorkflow.workflow.id,
  userId,
  nodeId: textOnlyControllerNode.id,
  taskId: "task_text_only_controller",
  expectedVersion: textOnlyWorkflow.workflow.version,
  at: now(),
})!;
const textOnlyTask = startTask(textOnlyDispatch.task);
const textOnlyPrompts: string[] = [];
const textOnlyFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: fakeModel,
  systemPrompt: "text-only controller base prompt",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: [],
  contextSeed: () => [],
  streamFn: (_model, context) => {
    textOnlyPrompts.push(context.systemPrompt);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const done = assistant("I planned the graph in prose.");
      stream.push({ type: "start", partial: { ...done, content: [] } });
      stream.push({ type: "done", reason: done.stopReason, message: done });
      stream.end(done);
    });
    return stream;
  },
  now,
});
const textOnlyWorker = await textOnlyFactory({
  agent: textOnlyControllerAgent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
await assert.rejects(
  textOnlyWorker.run(runInput(textOnlyControllerAgent, textOnlyTask, new AbortController().signal)),
  (error: unknown) => {
    assert.ok(error instanceof PiChildRunError);
    assert.match(error.message, /stopped before workflow_seal succeeded/);
    return true;
  },
);
assert.deepEqual(textOnlyPrompts, [
  `text-only controller base prompt\n\n---\n\n${workflowControllerPrompt}`,
]);
const currentTextOnlyTask = runtimeTaskDao.byId(userId, textOnlyTask.id)!;
assert.ok(workflowDao.settleExecution({
  id: "result_text_only_controller",
  taskId: currentTextOnlyTask.id,
  userId,
  summary: "Controller stopped without sealing",
  body: {},
  artifacts: [],
  expectedTaskVersion: currentTextOnlyTask.version,
  expectedLeaseGeneration: currentTextOnlyTask.leaseGeneration,
  nextStatus: "failed",
  createdAt: now(),
}));
textOnlyWorkflow = workflowDao.snapshot(userId, textOnlyWorkflow.workflow.id)!;
assert.equal(textOnlyWorkflow.workflow.status, "failed");
await textOnlyWorker.close?.();
console.log("  ✓ a text-only Controller fails immediately instead of stranding an open Workflow");

const controllerAgent = agentNodeDao.create({
  id: "agent_workflow_controller",
  userId,
  sessionId,
  rootAgentId,
  parentAgentId: rootAgentId,
  path: "/root/workflow_controller",
  provider: "mock",
  model: "mock",
  kind: "subagent",
  status: "idle",
  createdAt: now(),
});
const sourceNode = {
  id: "controller_source",
  name: "Controller source",
  kind: "work" as const,
  payload: { message: "Produce one dependency" },
  effect: "pure_readonly" as const,
  cachePolicy: "none" as const,
  maxAttempts: 1,
  executorAgentId: budgetAgent.id,
};
const controllerNode = {
  id: "dynamic_controller",
  name: "Dynamic controller",
  kind: "controller" as const,
  payload: { message: "Inspect the dependency, expand the graph, signal it, and seal it." },
  effect: "unknown" as const,
  cachePolicy: "none" as const,
  maxAttempts: 1,
  executorAgentId: controllerAgent.id,
};
let controllerWorkflow = workflowDao.create({
  id: "workflow_controller_tools",
  userId,
  ownerSessionId: sessionId,
  rootAgentId,
  controllerAgentId: controllerAgent.id,
  name: "Controller Tool execution",
  nodes: [sourceNode, controllerNode],
  edges: [{ from: sourceNode.id, to: controllerNode.id, condition: "success" }],
  graphSealed: false,
  createdAt: now(),
});
controllerWorkflow = workflowDao.start(
  userId,
  controllerWorkflow.workflow.id,
  controllerWorkflow.workflow.version,
  now(),
)!;
const sourceDispatch = workflowDao.claim({
  workflowId: controllerWorkflow.workflow.id,
  userId,
  nodeId: sourceNode.id,
  taskId: "task_controller_source",
  expectedVersion: controllerWorkflow.workflow.version,
  at: now(),
})!;
const sourceTask = startTask(sourceDispatch.task);
const sourceResultId = "result_controller_source";
assert.ok(workflowDao.settleExecution({
  id: sourceResultId,
  taskId: sourceTask.id,
  userId,
  summary: "Dependency summary",
  body: { report: "DEPENDENCY_FULL_BODY" },
  artifacts: [],
  expectedTaskVersion: runtimeTaskDao.byId(userId, sourceTask.id)!.version,
  expectedLeaseGeneration: sourceTask.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now(),
}));
controllerWorkflow = workflowDao.snapshot(userId, controllerWorkflow.workflow.id)!;
assert.equal(controllerWorkflow.nodes.find((node) => node.id === controllerNode.id)?.status, "ready");
const controllerDispatch = workflowDao.claim({
  workflowId: controllerWorkflow.workflow.id,
  userId,
  nodeId: controllerNode.id,
  taskId: "task_workflow_controller",
  expectedVersion: controllerWorkflow.workflow.version,
  at: now(),
})!;
const controllerTask = startTask(controllerDispatch.task);
const controllerCalls: string[] = [];
const controllerToolSets: string[][] = [];
const controllerSystemPrompts: string[] = [];
let controllerToolSchema = "";
let sawFullDependency = false;
let workflowMutationHints = 0;
const controllerFactory = createPiChildWorkerFactory({
  sandbox,
  workspaceWriteLease: writeLease,
  model: fakeModel,
  systemPrompt: "workflow controller system prompt",
  workflowControllerPrompt,
  getApiKey: () => "test-key",
  tools: [readTool, writeTool],
  contextSeed: () => [],
  onWorkflowMutation: (changedWorkflow) => {
    assert.equal(changedWorkflow.userId, userId);
    assert.equal(changedWorkflow.id, controllerWorkflow.workflow.id);
    workflowMutationHints += 1;
  },
  streamFn: (_model, context) => {
    const stream = createAssistantMessageEventStream();
    controllerSystemPrompts.push(context.systemPrompt);
    controllerToolSets.push(context.tools?.map((tool) => tool.name) ?? []);
    controllerToolSchema ||= JSON.stringify(context.tools?.map((tool) => tool.parameters) ?? []);
    sawFullDependency ||= JSON.stringify(context.messages).includes("DEPENDENCY_FULL_BODY");
    const plans = [
      { name: "workflow_list_dependencies", arguments: {} },
      { name: "workflow_read_dependency", arguments: { resultId: sourceResultId } },
      {
        name: "workflow_expand",
        arguments: {
          nodes: [{
            id: "dynamic_gate",
            name: "Dynamic gate",
            kind: "gate",
            payload: {},
            effect: "unknown",
            cachePolicy: "none",
            maxAttempts: 1,
            signal: "release_dynamic_gate",
          }],
          edges: [],
        },
      },
      { name: "workflow_signal", arguments: { signal: "release_dynamic_gate" } },
      { name: "workflow_seal", arguments: {} },
    ] as const;
    const plan = plans[controllerCalls.length];
    queueMicrotask(() => {
      const done: AssistantMessage = plan ? {
        ...assistant("", "toolUse"),
        content: [{
          type: "toolCall",
          id: `call_controller_${controllerCalls.length}`,
          name: plan.name,
          arguments: plan.arguments,
        }],
      } : assistant("Controller completed");
      if (plan) controllerCalls.push(plan.name);
      stream.push({ type: "start", partial: { ...done, content: [] } });
      stream.push({ type: "done", reason: done.stopReason, message: done });
      stream.end(done);
    });
    return stream;
  },
  now,
});
const controllerWorker = await controllerFactory({
  agent: controllerAgent,
  userId,
  sessionId,
  rootAgentId,
  signal: new AbortController().signal,
});
const controllerRun = runInput(controllerAgent, controllerTask, new AbortController().signal);
controllerRun.checkpointUsage = () => true;
const controllerResult = await controllerWorker.run(controllerRun);
assert.equal(controllerResult.summary, "Controller completed");
assert.deepEqual(controllerCalls, [
  "workflow_list_dependencies",
  "workflow_read_dependency",
  "workflow_expand",
  "workflow_signal",
  "workflow_seal",
]);
assert.ok(controllerSystemPrompts.length > 1, "the Controller contract survives every model cycle");
assert.ok(controllerSystemPrompts.every(
  (prompt) => prompt === `workflow controller system prompt\n\n---\n\n${workflowControllerPrompt}`,
));
assert.ok(controllerToolSets.every((tools) => tools.join(",") === [
  "workflow_expand",
  "workflow_seal",
  "workflow_list_dependencies",
  "workflow_read_dependency",
  "workflow_signal",
].join(",")));
assert.doesNotMatch(
  controllerToolSchema,
  /workflowId|controllerNodeId|actorTaskId|leaseGeneration|executorAgentId/,
);
assert.equal(sawFullDependency, true);
assert.equal(workflowMutationHints, 3);
controllerWorkflow = workflowDao.snapshot(userId, controllerWorkflow.workflow.id)!;
assert.equal(controllerWorkflow.workflow.graphSealed, true);
assert.equal(controllerWorkflow.nodes.find((node) => node.id === "dynamic_gate")?.status, "succeeded");
assert.ok(workflowDao.settleExecution({
  id: "result_workflow_controller",
  taskId: controllerTask.id,
  userId,
  summary: controllerResult.summary,
  body: controllerResult.body ?? {},
  artifacts: controllerResult.artifacts ?? [],
  expectedTaskVersion: runtimeTaskDao.byId(userId, controllerTask.id)!.version,
  expectedLeaseGeneration: controllerTask.leaseGeneration,
  nextStatus: "succeeded",
  createdAt: now(),
}));
controllerWorkflow = workflowDao.snapshot(userId, controllerWorkflow.workflow.id)!;
assert.equal(controllerWorkflow.workflow.status, "succeeded");
await controllerWorker.close?.();
console.log("  ✓ controller Tools derive the active lease and mutate a real dynamic Workflow through pi");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("pi Child Agent worker contract passed.");

function messageRoleForTest(value: unknown): unknown {
  return value !== null && typeof value === "object" ? (value as { role?: unknown }).role : undefined;
}
