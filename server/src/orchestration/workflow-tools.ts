import { Type } from "@earendil-works/pi-ai";
import { truncateToolOutput } from "../runtime/tool-output.ts";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  OrchestrationJson,
  Workflow,
  WorkflowEdgeDefinition,
} from "../../../shared/src/orchestration.ts";
import { workflowDao, type WorkflowSnapshot } from "../persistence/workflow.ts";
import type { WorkflowExpansionNodeInput } from "./workflow-launch.ts";

export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workflow_expand",
  "workflow_seal",
  "workflow_list_dependencies",
  "workflow_read_dependency",
  "workflow_signal",
]);

export interface WorkflowToolActor {
  userId: string;
  taskId: string;
  taskLeaseGeneration: number;
  expectedWorkflowId: string;
  expectedNodeId: string;
  nodeKind: "work" | "controller";
}

export interface WorkflowToolOptions {
  nodeKind: "work" | "controller";
  actor(): WorkflowToolActor | undefined;
  now?: () => number;
  onMutation?: (workflow: Workflow) => void;
  expand?: (input: {
    actor: WorkflowToolActor;
    workflowId: string;
    controllerNodeId: string;
    expectedGraphRevision: number;
    mutationKey: string;
    nodes: readonly WorkflowExpansionNodeInput[];
    edges: readonly WorkflowEdgeDefinition[];
    at: number;
  }) => WorkflowSnapshot | null;
}

function textResult(value: OrchestrationJson): AgentToolResult<OrchestrationJson> {
  return {
    content: [{ type: "text", text: truncateToolOutput(JSON.stringify(value)) }],
    details: value,
  };
}

function mutationProjection(snapshot: WorkflowSnapshot): Record<string, OrchestrationJson> {
  return {
    workflowId: snapshot.workflow.id,
    status: snapshot.workflow.status,
    graphRevision: snapshot.workflow.graphRevision,
    runRevision: snapshot.workflow.runRevision,
    graphSealed: snapshot.workflow.graphSealed,
    nodes: snapshot.nodes.length,
  };
}

function activeActor(options: WorkflowToolOptions, controllerOnly = false) {
  const expected = options.actor();
  if (!expected) throw new Error("Workflow Tool has no active Task actor");
  if (controllerOnly && expected.nodeKind !== "controller") {
    throw new Error("Workflow graph mutation requires a controller Task");
  }
  const target = workflowDao.toolActorTarget({
    userId: expected.userId,
    taskId: expected.taskId,
    expectedTaskLeaseGeneration: expected.taskLeaseGeneration,
  });
  if (
    !target
    || target.workflowId !== expected.expectedWorkflowId
    || target.nodeId !== expected.expectedNodeId
    || target.nodeKind !== expected.nodeKind
  ) throw new Error("Workflow Tool actor lease is no longer active");
  if (controllerOnly && target.nodeKind !== "controller") {
    throw new Error("Workflow graph mutation requires a controller Task");
  }
  if (controllerOnly && target.taskStatus !== "running") {
    throw new Error("Workflow graph mutation requires a running controller Task");
  }
  return { expected, target };
}

function hint(options: WorkflowToolOptions, workflow: Workflow): void {
  try {
    options.onMutation?.(workflow);
  } catch {
  }
}

const nodeSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Union([
    Type.Literal("work"),
    Type.Literal("controller"),
    Type.Literal("join"),
    Type.Literal("gate"),
  ]),
  payload: Type.Any(),
  effect: Type.Union([
    Type.Literal("pure_readonly"),
    Type.Literal("workspace_read"),
    Type.Literal("workspace_write"),
    Type.Literal("network"),
    Type.Literal("unknown"),
  ]),
  cachePolicy: Type.Union([Type.Literal("none"), Type.Literal("evidence")]),
  maxAttempts: Type.Integer({ minimum: 1, maximum: 16 }),
  signal: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

const edgeSchema = Type.Object({
  from: Type.String({ minLength: 1, maxLength: 128 }),
  to: Type.String({ minLength: 1, maxLength: 128 }),
  condition: Type.Union([Type.Literal("success"), Type.Literal("settled")]),
});

export function createWorkflowTools(options: WorkflowToolOptions): AgentTool<any>[] {
  const now = options.now ?? Date.now;
  const expand: AgentTool<any> = {
    name: "workflow_expand",
    label: "Expand workflow",
    description: "Add bounded nodes and edges to the active Workflow. New edges must target a new node.",
    parameters: Type.Object({
      nodes: Type.Array(nodeSchema, { minItems: 1, maxItems: 64 }),
      edges: Type.Array(edgeSchema, { maxItems: 256 }),
    }),
    executionMode: "sequential",
    async execute(id, rawParams: unknown, signal) {
      const params = rawParams as {
        nodes: WorkflowExpansionNodeInput[];
        edges: WorkflowEdgeDefinition[];
      };
      if (signal?.aborted) throw signal.reason;
      const { expected, target } = activeActor(options, true);
      if (!options.expand) throw new Error("Workflow controller has no trusted expansion allocator");
      const snapshot = options.expand({
        actor: expected,
        workflowId: target.workflowId,
        controllerNodeId: target.nodeId,
        expectedGraphRevision: target.graphRevision,
        mutationKey: id,
        nodes: params.nodes,
        edges: params.edges,
        at: now(),
      });
      if (!snapshot) throw new Error("Workflow graph changed before expansion committed");
      hint(options, snapshot.workflow);
      return textResult(mutationProjection(snapshot));
    },
  };
  const seal: AgentTool<any> = {
    name: "workflow_seal",
    label: "Seal workflow",
    description: "Seal the active Workflow graph. No controller can add nodes after this operation.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw signal.reason;
      const { expected, target } = activeActor(options, true);
      const snapshot = workflowDao.sealGraph({
        workflowId: target.workflowId,
        userId: expected.userId,
        controllerNodeId: target.nodeId,
        actorTaskId: expected.taskId,
        actorLeaseGeneration: expected.taskLeaseGeneration,
        expectedGraphRevision: target.graphRevision,
        at: now(),
      });
      if (!snapshot) throw new Error("Workflow graph changed before sealing committed");
      hint(options, snapshot.workflow);
      return textResult(mutationProjection(snapshot));
    },
  };
  const listDependencies: AgentTool<any> = {
    name: "workflow_list_dependencies",
    label: "List workflow dependencies",
    description: "List bounded upstream result handles for the active Workflow node.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw signal.reason;
      const { expected } = activeActor(options);
      const dependencies = workflowDao.listDependencyHandlesForActor({
        userId: expected.userId,
        taskId: expected.taskId,
        expectedTaskLeaseGeneration: expected.taskLeaseGeneration,
      });
      if (!dependencies) throw new Error("Workflow dependency actor lease is no longer active");
      return textResult({
        dependencies: dependencies.handles.map((dependency): OrchestrationJson => ({ ...dependency })),
        omitted: dependencies.omitted,
      });
    },
  };
  const readDependency: AgentTool<any> = {
    name: "workflow_read_dependency",
    label: "Read workflow dependency",
    description: "Read one upstream result by a handle returned to the active Workflow node.",
    parameters: Type.Object({
      resultId: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    async execute(_id, rawParams: unknown, signal) {
      const params = rawParams as { resultId: string };
      if (signal?.aborted) throw signal.reason;
      const { expected, target } = activeActor(options);
      const result = workflowDao.readDependencyResult({
        workflowId: target.workflowId,
        userId: expected.userId,
        actorTaskId: expected.taskId,
        actorLeaseGeneration: expected.taskLeaseGeneration,
        resultId: params.resultId,
      });
      if (!result) throw new Error("Workflow dependency result is unavailable to this Task");
      return textResult({
        resultId: result.id,
        taskId: result.taskId,
        summary: result.summary,
        body: result.body,
        artifacts: result.artifacts,
      });
    },
  };
  const signal: AgentTool<any> = {
    name: "workflow_signal",
    label: "Signal workflow",
    description: "Commit one named signal to the active Workflow. Repeated signals are idempotent.",
    parameters: Type.Object({
      signal: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    executionMode: "sequential",
    async execute(_id, rawParams: unknown, abortSignal) {
      const params = rawParams as { signal: string };
      if (abortSignal?.aborted) throw abortSignal.reason;
      const { expected, target } = activeActor(options, true);
      const result = workflowDao.signal(
        expected.userId,
        target.workflowId,
        params.signal,
        target.workflowVersion,
        now(),
      );
      if (!result) throw new Error("Workflow changed before the signal committed");
      hint(options, result.snapshot.workflow);
      return textResult({ accepted: result.accepted, ...mutationProjection(result.snapshot) });
    },
  };
  return options.nodeKind === "controller"
    ? [expand, seal, listDependencies, readDependency, signal]
    : [readDependency];
}
