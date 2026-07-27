import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentNode,
  Workflow,
  WorkflowBudget,
  WorkflowEdgeDefinition,
  WorkflowEdgeCondition,
  WorkflowEffect,
  WorkflowNodeDefinition,
} from "../../../shared/src/orchestration.ts";
import type { NewAgentNode } from "../persistence/orchestration.ts";
import { workflowDao, type WorkflowSnapshot } from "../persistence/workflow.ts";

export const WORKFLOW_LAUNCH_NODE_LIMIT = 16;
export const WORKFLOW_LAUNCH_DEPENDENCY_LIMIT = 16;

const LAUNCH_NODE_ID = /^[a-z0-9][a-z0-9_]{0,63}$/;

export interface WorkflowLaunchDependencyInput {
  nodeId: string;
  condition?: WorkflowEdgeCondition;
}

export interface WorkflowLaunchNodeInput {
  id: string;
  name: string;
  message: string;
  dependencies?: readonly WorkflowLaunchDependencyInput[];
  effect?: WorkflowEffect;
  maxAttempts?: number;
}

export interface WorkflowLaunchRequest {
  name: string;
  nodes: readonly WorkflowLaunchNodeInput[];
  budget?: Partial<WorkflowBudget>;
  provider: string;
  model: string;
  thinkingLevel?: AgentNode["thinkingLevel"];
}

export interface WorkflowDynamicLaunchRequest {
  name: string;
  controller: {
    name: string;
    message: string;
    maxAttempts?: number;
  };
  budget?: Partial<WorkflowBudget>;
  provider: string;
  model: string;
  thinkingLevel?: AgentNode["thinkingLevel"];
}

export interface WorkflowLaunchResult {
  snapshot: WorkflowSnapshot;
  executors: Array<{ nodeId: string; agentId: string; path: string }>;
}

export interface WorkflowLaunchServiceOptions {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  maxTreeAgents: number;
  now?: () => number;
  id?: (kind: "workflow" | "agent") => string;
  onChanged?: (workflow: Workflow) => void;
}

function checkedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function checkedText(value: string, field: string, maxBytes: number): string {
  const text = String(value ?? "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new RangeError(`${field} must contain 1 to ${maxBytes} UTF-8 bytes`);
  }
  return text;
}

function workflowPathToken(workflowId: string): string {
  const token = workflowId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-12);
  return token || "workflow";
}

function stableHash(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function workflowNodePath(workflowId: string, nodeId: string): string {
  const safeNode = nodeId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48)
    || "node";
  return `/root/wf_${workflowPathToken(workflowId)}_${safeNode}_${stableHash(nodeId).slice(0, 8)}`;
}

export class WorkflowLaunchService {
  private readonly now: () => number;
  private readonly makeId: (kind: "workflow" | "agent") => string;

  constructor(private readonly options: WorkflowLaunchServiceOptions) {
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((kind) => `${kind === "workflow" ? "wfl" : "agt"}_${randomUUID()}`);
  }

  launch(request: WorkflowLaunchRequest): WorkflowLaunchResult {
    const name = checkedText(request.name, "Workflow name", 256);
    if (request.nodes.length < 1 || request.nodes.length > WORKFLOW_LAUNCH_NODE_LIMIT) {
      throw new RangeError(`Workflow launch requires 1 to ${WORKFLOW_LAUNCH_NODE_LIMIT} work nodes`);
    }
    const provider = checkedText(request.provider, "Workflow provider", 128);
    const model = checkedText(request.model, "Workflow model", 256);
    const workflowId = this.makeId("workflow");
    const pathToken = workflowPathToken(workflowId);
    const createdAt = this.now();
    const nodeIds = new Set<string>();
    const executors: WorkflowLaunchResult["executors"] = [];
    const agents: NewAgentNode[] = [];
    const nodes: WorkflowNodeDefinition[] = [];

    request.nodes.forEach((input) => {
      if (!LAUNCH_NODE_ID.test(input.id)) {
        throw new RangeError("Workflow node id must use lowercase letters, digits, and underscores");
      }
      if (nodeIds.has(input.id)) throw new Error(`Duplicate Workflow node ${input.id}`);
      nodeIds.add(input.id);
      const nodeName = checkedText(input.name, `Workflow node ${input.id} name`, 256);
      const message = checkedText(input.message, `Workflow node ${input.id} message`, 32 * 1024);
      const agentId = this.makeId("agent");
      const path = `/root/wf_${pathToken}_${input.id}`;
      if (path.length > 512) throw new RangeError("Workflow executor path is too long");
      executors.push({ nodeId: input.id, agentId, path });
      agents.push({
        id: agentId,
        userId: this.options.userId,
        sessionId: this.options.sessionId,
        rootAgentId: this.options.rootAgentId,
        parentAgentId: this.options.rootAgentId,
        path,
        label: nodeName,
        provider,
        model,
        ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        kind: "subagent",
        purpose: "addressable",
        status: "idle",
        createdAt,
      });
      nodes.push({
        id: input.id,
        name: nodeName,
        kind: "work",
        payload: { message },
        effect: input.effect ?? "unknown",
        cachePolicy: "none",
        maxAttempts: checkedInteger(input.maxAttempts ?? 1, `Workflow node ${input.id} maxAttempts`, 1, 4),
        executorAgentId: agentId,
      });
    });

    const edges = request.nodes.flatMap((node) => {
      const dependencies = node.dependencies ?? [];
      if (dependencies.length > WORKFLOW_LAUNCH_DEPENDENCY_LIMIT) {
        throw new RangeError(
          `Workflow node ${node.id} exceeds ${WORKFLOW_LAUNCH_DEPENDENCY_LIMIT} dependencies`,
        );
      }
      return dependencies.map((dependency) => {
        if (!nodeIds.has(dependency.nodeId)) {
          throw new Error(`Workflow dependency ${dependency.nodeId} does not exist`);
        }
        return {
          from: dependency.nodeId,
          to: node.id,
          condition: dependency.condition ?? "success" as const,
        };
      });
    });
    const attempts = nodes.reduce((sum, node) => sum + node.maxAttempts, 0);
    const snapshot = workflowDao.launch({
      id: workflowId,
      userId: this.options.userId,
      ownerSessionId: this.options.sessionId,
      rootAgentId: this.options.rootAgentId,
      name,
      nodes,
      edges,
      graphSealed: true,
      executors: agents,
      maxTreeAgents: this.options.maxTreeAgents,
      budget: {
        maxNodes: request.budget?.maxNodes ?? nodes.length,
        maxEdges: request.budget?.maxEdges ?? edges.length,
        maxDepth: request.budget?.maxDepth ?? 16,
        maxAttempts: request.budget?.maxAttempts ?? attempts,
        maxRuntimeMs: request.budget?.maxRuntimeMs ?? 60 * 60 * 1_000,
        maxTokens: request.budget?.maxTokens ?? Math.min(2_000_000, nodes.length * 256_000),
        maxCostMicros: request.budget?.maxCostMicros
          ?? Math.min(1_000_000_000, nodes.length * 50_000_000),
      },
      createdAt,
    });
    try {
      this.options.onChanged?.(snapshot.workflow);
    } catch {
    }
    return { snapshot, executors };
  }

  launchDynamic(request: WorkflowDynamicLaunchRequest): WorkflowLaunchResult {
    const name = checkedText(request.name, "Workflow name", 256);
    const controllerName = checkedText(request.controller.name, "Workflow controller name", 256);
    const controllerMessage = checkedText(
      request.controller.message,
      "Workflow controller message",
      32 * 1024,
    );
    const provider = checkedText(request.provider, "Workflow provider", 128);
    const model = checkedText(request.model, "Workflow model", 256);
    const workflowId = this.makeId("workflow");
    const controllerAgentId = this.makeId("agent");
    const createdAt = this.now();
    const path = workflowNodePath(workflowId, "controller");
    const maxNodes = checkedInteger(
      request.budget?.maxNodes ?? WORKFLOW_LAUNCH_NODE_LIMIT,
      "Workflow maxNodes",
      1,
      WORKFLOW_LAUNCH_NODE_LIMIT,
    );
    const maxEdges = checkedInteger(
      request.budget?.maxEdges ?? Math.min(256, maxNodes * WORKFLOW_LAUNCH_DEPENDENCY_LIMIT),
      "Workflow maxEdges",
      0,
      256,
    );
    const controllerAttempts = checkedInteger(
      request.controller.maxAttempts ?? 1,
      "Workflow controller maxAttempts",
      1,
      4,
    );
    const agent: NewAgentNode = {
      id: controllerAgentId,
      userId: this.options.userId,
      sessionId: this.options.sessionId,
      rootAgentId: this.options.rootAgentId,
      parentAgentId: this.options.rootAgentId,
      path,
      label: controllerName,
      provider,
      model,
      ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
      kind: "subagent",
      purpose: "addressable",
      status: "idle",
      createdAt,
    };
    const snapshot = workflowDao.launchDynamic({
      id: workflowId,
      userId: this.options.userId,
      ownerSessionId: this.options.sessionId,
      rootAgentId: this.options.rootAgentId,
      controllerAgentId,
      name,
      nodes: [{
        id: "controller",
        name: controllerName,
        kind: "controller",
        payload: { message: controllerMessage },
        effect: "pure_readonly",
        cachePolicy: "none",
        maxAttempts: controllerAttempts,
        executorAgentId: controllerAgentId,
      }],
      edges: [],
      graphSealed: false,
      executors: [agent],
      maxTreeAgents: this.options.maxTreeAgents,
      budget: {
        maxNodes,
        maxEdges,
        maxDepth: checkedInteger(request.budget?.maxDepth ?? 8, "Workflow maxDepth", 1, 16),
        maxAttempts: checkedInteger(
          request.budget?.maxAttempts ?? Math.min(128, maxNodes * 4),
          "Workflow maxAttempts",
          controllerAttempts,
          128,
        ),
        maxRuntimeMs: request.budget?.maxRuntimeMs ?? 60 * 60 * 1_000,
        maxTokens: request.budget?.maxTokens ?? Math.min(2_000_000, maxNodes * 256_000),
        maxCostMicros: request.budget?.maxCostMicros
          ?? Math.min(1_000_000_000, maxNodes * 50_000_000),
      },
      createdAt,
    });
    try {
      this.options.onChanged?.(snapshot.workflow);
    } catch {
    }
    return {
      snapshot,
      executors: [{ nodeId: "controller", agentId: controllerAgentId, path }],
    };
  }
}

export type WorkflowExpansionNodeInput = Omit<WorkflowNodeDefinition, "executorAgentId">;

export interface WorkflowExpansionRequest {
  workflowId: string;
  controllerNodeId: string;
  actorTaskId: string;
  actorLeaseGeneration: number;
  expectedGraphRevision: number;
  mutationKey: string;
  nodes: readonly WorkflowExpansionNodeInput[];
  edges: readonly WorkflowEdgeDefinition[];
  at: number;
}

export interface WorkflowExpansionServiceOptions {
  userId: string;
  controllerAgent: Pick<AgentNode,
    | "id"
    | "sessionId"
    | "rootAgentId"
    | "path"
    | "provider"
    | "model"
    | "thinkingLevel"
    | "kind"
    | "purpose"
  >;
  maxTreeAgents: number;
}

export class WorkflowExpansionService {
  constructor(private readonly options: WorkflowExpansionServiceOptions) {}

  expand(request: WorkflowExpansionRequest): WorkflowSnapshot | null {
    const controller = this.options.controllerAgent;
    if (
      controller.kind !== "subagent"
      || controller.purpose !== "addressable"
      || !controller.sessionId
      || !controller.provider
      || !controller.model
    ) {
      throw new Error("Dynamic Workflow expansion requires its addressable controller Agent");
    }
    const mutationKey = checkedText(request.mutationKey, "Workflow expansion mutation key", 256);
    const executors: NewAgentNode[] = [];
    const nodes = request.nodes.map((input): WorkflowNodeDefinition => {
      const { executorAgentId: _ignored, ...node } = input as WorkflowNodeDefinition;
      if (node.kind === "work") {
        const identity = stableHash(
          request.workflowId,
          request.actorTaskId,
          String(request.actorLeaseGeneration),
          mutationKey,
          node.id,
        );
        const agentId = `agt_wfx_${identity.slice(0, 32)}`;
        const path = workflowNodePath(request.workflowId, node.id);
        executors.push({
          id: agentId,
          userId: this.options.userId,
          sessionId: controller.sessionId,
          rootAgentId: controller.rootAgentId,
          parentAgentId: controller.id,
          path,
          label: checkedText(node.name, `Workflow node ${node.id} name`, 256),
          provider: controller.provider,
          model: controller.model,
          ...(controller.thinkingLevel === undefined ? {} : { thinkingLevel: controller.thinkingLevel }),
          kind: "subagent",
          purpose: "addressable",
          status: "idle",
          createdAt: request.at,
        });
        return { ...node, executorAgentId: agentId };
      }
      if (node.kind === "controller") {
        return { ...node, executorAgentId: controller.id };
      }
      return node;
    });
    return workflowDao.expand({
      workflowId: request.workflowId,
      userId: this.options.userId,
      controllerNodeId: request.controllerNodeId,
      actorTaskId: request.actorTaskId,
      actorLeaseGeneration: request.actorLeaseGeneration,
      expectedGraphRevision: request.expectedGraphRevision,
      nodes,
      edges: request.edges,
      executors,
      maxTreeAgents: this.options.maxTreeAgents,
      mutationId: `expand-tool:${stableHash(
        request.workflowId,
        request.actorTaskId,
        String(request.actorLeaseGeneration),
        mutationKey,
      )}`,
      at: request.at,
    });
  }
}
