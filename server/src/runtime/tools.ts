import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolKind } from "../../../shared/src/protocol.ts";
import type {
  WorkflowBudget,
  WorkflowEdgeCondition,
  WorkflowEffect,
} from "../../../shared/src/orchestration.ts";
import type { Sandbox } from "./sandbox.ts";
import { lintDiagram, type DiagramLanguage } from "./diagram-lint.ts";
import type { WorkspaceWriteLease } from "../orchestration/workspace-lease.ts";
import { createEditFileTool } from "./edit-file-tool.ts";
import { createPiWorkspaceAdapter } from "./pi-workspace-adapter.ts";
import { MAX_TOOL_OUTPUT_CHARS, truncateToolOutput } from "./tool-output.ts";

export const APPROVAL_GATED_TOOLS = new Set(["bash"]);
export const DELEGATION_TOOLS = new Set([
  "spawn_subagent",
  "spawn_agent",
  "followup_task",
  "send_message",
  "run_workflow",
]);

const BUILTIN_KINDS: Record<string, ToolKind> = {
  bash: "shell",
  read_file: "read",
  read_image: "read",
  write_file: "write",
  edit_file: "edit",
  list_files: "list",
  workflow_list_dependencies: "list",
  workflow_read_dependency: "read",
  run_workflow: "subagent",
  team_create: "subagent",
  team_assign: "subagent",
  team_mail: "subagent",
  spawn_subagent: "subagent",
  spawn_agent: "subagent",
  list_agents: "subagent",
  get_agent: "subagent",
  wait_agent: "subagent",
  send_message: "subagent",
  followup_task: "subagent",
  interrupt_agent: "subagent",
  canvas: "canvas",
  diagram_lint: "other",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "external";
  return BUILTIN_KINDS[name] ?? "other";
}

const MAX_OUTPUT = MAX_TOOL_OUTPUT_CHARS;
const truncate = truncateToolOutput;

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export type SubagentRunner = (toolCallId: string, task: string, signal?: AbortSignal) => Promise<string>;

export type AgentContextMode = "none" | "recent" | "all";

export interface AgentOrchestrationRunner {
  spawn(input: {
    taskName: string;
    message: string;
    context: AgentContextMode;
    ownerStepId?: string;
  }, signal?: AbortSignal): Promise<string>;
  list(input: { pathPrefix?: string }): Promise<string> | string;
  get(input: { target: string; ownerStepId: string }): Promise<string> | string;
  wait(input: { targets?: string[]; timeoutMs: number }, signal?: AbortSignal): Promise<string>;
  send(input: { target: string; message: string }): Promise<string> | string;
  followUp(input: { target: string; message: string; ownerStepId?: string }, signal?: AbortSignal): Promise<string>;
  interrupt(input: { target: string }): Promise<string> | string;
}

interface WorkflowRunBase {
  name: string;
  budget?: Partial<WorkflowBudget>;
}

interface WorkflowRunNode {
  id: string;
  name: string;
  message: string;
  dependencies?: Array<{ nodeId: string; condition?: WorkflowEdgeCondition }>;
  effect?: WorkflowEffect;
  maxAttempts?: number;
}

export type WorkflowRunInput = WorkflowRunBase & (
  | {
    nodes: WorkflowRunNode[];
    controller?: never;
  }
  | {
    nodes?: never;
    controller: {
      name: string;
      message: string;
      maxAttempts?: number;
    };
  }
);

export interface WorkflowRunner {
  run(input: WorkflowRunInput, signal?: AbortSignal): Promise<string> | string;
}

export function createTools(
  sandbox: Sandbox,
  subagentRunner?: SubagentRunner,
  workspaceWriteLease?: WorkspaceWriteLease,
  agentRunner?: AgentOrchestrationRunner,
  workflowRunner?: WorkflowRunner,
): AgentTool<any>[] {
  const write = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    workspaceWriteLease ? workspaceWriteLease.run(operation, signal) : operation();
  const workspaceFiles = createPiWorkspaceAdapter(sandbox, write);
  const bash: AgentTool<any> = {
    name: "bash",
    label: "Run shell command",
    description:
      "Run a shell command inside the session's isolated workspace. Use for builds, tests, git, scaffolding. " +
      "Working directory is the workspace root; paths are relative to it.",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to execute (bash -lc)." }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 60)." })),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const { stdout, stderr, exitCode, timedOut } = await write(
        () => sandbox.exec(params.command, {
          timeoutMs: (params.timeout ?? 60) * 1000,
          signal,
        }),
        signal,
      );
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      let body = parts.join("\n").trim() || "(no output)";
      if (timedOut) body += "\n[command timed out]";
      body += `\n[exit code: ${exitCode}]`;
      const capOut = stdout.length > MAX_OUTPUT;
      const capErr = stderr.length > MAX_OUTPUT;
      const shell = {
        stdout: capOut ? stdout.slice(0, MAX_OUTPUT) : stdout,
        stderr: capErr ? stderr.slice(0, MAX_OUTPUT) : stderr,
        exitCode,
        timedOut,
        truncated: capOut || capErr,
      };
      return textResult(truncate(body), { exitCode, timedOut, shell });
    },
  };

  const readFile: AgentTool<any> = {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
    }),
    executionMode: "parallel",
    async execute(_id: string, params: any) {
      const content = await sandbox.readFile(params.path);
      return textResult(truncate(content), { path: params.path, bytes: content.length });
    },
  };

  const writeFile: AgentTool<any> = {
    name: "write_file",
    label: "Write file",
    description: "Create or overwrite a UTF-8 text file in the workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      content: Type.String({ description: "Full file contents." }),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      await workspaceFiles.writeFile(params.path, params.content, signal);
      return textResult(`Wrote ${params.content.length} bytes to ${params.path}`, { path: params.path });
    },
  };

  const editFile = createEditFileTool(workspaceFiles);

  const listFiles: AgentTool<any> = {
    name: "list_files",
    label: "List files",
    description: "List files and directories in a workspace directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Workspace-relative directory (default '.')." })),
    }),
    executionMode: "parallel",
    async execute(_id: string, params: any) {
      const entries = await sandbox.listDir(params.path ?? ".");
      const lines = entries.map(
        (e) => `${e.kind === "directory" ? "d" : "-"} ${e.path}${e.kind === "file" ? ` (${e.size}b)` : "/"}`,
      );
      return textResult(lines.join("\n") || "(empty)", { count: entries.length });
    },
  };

  const diagramLint: AgentTool<any> = {
    name: "diagram_lint",
    label: "Lint a diagram",
    description:
      "Compile an exact Mermaid or D2 source before placing it in a fenced reply. " +
      "A valid result proves the syntax (and the full D2 SVG render). An invalid result returns a " +
      "precise compiler diagnostic: fix the source and call this tool again. Do not change the " +
      "source after a valid result unless you lint the changed source again.",
    parameters: Type.Object({
      language: Type.Union([Type.Literal("mermaid"), Type.Literal("d2")], {
        description: "Diagram fence language: mermaid or d2.",
      }),
      source: Type.String({ description: "The exact source that will appear inside the fenced block." }),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const language = String(params.language ?? "") as DiagramLanguage;
      const source = String(params.source ?? "");
      const result = await lintDiagram(language, source, signal);
      if (!result.valid) {
        return textResult(
          `INVALID ${language} diagram:\n${result.error}\nFix the source and call diagram_lint again before showing it.`,
          result,
        );
      }
      const summary = language === "d2"
        ? `${result.details.shapes ?? 0} shapes, ${result.details.connections ?? 0} connections, ${result.details.svgBytes ?? 0} SVG bytes`
        : `type ${result.details.diagramType ?? "unknown"}`;
      return textResult(
        `VALID ${language} diagram (${summary}). Show the exact linted source in a \`\`\`${language} fence.`,
        result,
      );
    },
  };

  const readImage: AgentTool<any> = {
    name: "read_image",
    label: "Read image",
    description:
      "Read an image file (png/jpg/jpeg/gif/webp/bmp) from the workspace and return it so you can see it directly. " +
      "Use this for user-uploaded images/screenshots under uploads/.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative image path." }),
    }),
    executionMode: "parallel",
    async execute(_id: string, params: any) {
      const ext = String(params.path).split(".").pop()?.toLowerCase() ?? "";
      const mime: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
      };
      const mimeType = mime[ext];
      if (!mimeType) throw new Error(`unsupported image type: ${params.path}`);
      const bytes = await sandbox.readFileBytes(params.path);
      if (bytes.length > 8 * 1024 * 1024) throw new Error(`image too large (${bytes.length} bytes; max 8MB)`);
      const data = Buffer.from(bytes).toString("base64");
      return {
        content: [
          { type: "text", text: `[image: ${params.path} · ${bytes.length} bytes]` },
          { type: "image", data, mimeType },
        ],
        details: { path: params.path, bytes: bytes.length, mimeType },
      } as AgentToolResult<unknown>;
    },
  };

  const canvas: AgentTool<any> = {
    name: "canvas",
    label: "Render an inline canvas",
    description:
      "Render a self-contained HTML document as a live, collapsible card INLINE in the conversation " +
      "(it scrolls with your message). Use it to SHOW rather than describe — a chart, a small " +
      "interactive component demo, a computed or animated visualization, a formatted table, a diagram, " +
      "a short form or note widget. " +
      "REQUIREMENTS: `html` must be a COMPLETE, self-contained document — inline ALL CSS and JS, embed " +
      "any data directly, and use NO external network resources (no CDN scripts, web fonts, or remote " +
      "images; the card runs in a sandbox with no network access, so external references silently fail). " +
      "Images must be inline data: URIs. The card renders about 360px tall in a column ~640px wide by " +
      "default (design responsively — the user can expand it to a full side panel). Prefer to compute " +
      "the data and draft the code with your other tools FIRST, then pass the finished document here.\n" +
      "THEMES (recommended): set `theme` to a preset design foundation instead of improvising colours. " +
      "Options — broadsheet (warm editorial serif document: notes, long-form), console (cool minimal " +
      "dashboard with tabular numbers: KPIs/stats), terminal (dark mono technical: logs/code/widgets), " +
      "bureau (clean neutral form/widget: forms, settings, inputs). A theme injects a CSS-variable " +
      "contract [--bg --surface --fill --border --border-strong --text --text-muted --accent " +
      "--accent-text --font-ui --font-mono --font-serif --radius --shadow] plus a quiet base reset, " +
      "both with light+dark. STYLE BY REFERENCING THE VARIABLES (color:var(--text); " +
      "background:var(--surface); border:1px solid var(--border)); do NOT hardcode colours. Keep it " +
      "restrained: one neutral family + one accent used sparingly, borders over shadows, real type " +
      "hierarchy. AVOID 'AI slop' — no rainbow/violet→pink gradients, no emoji headers, no neon glows, " +
      "no everything-centred, no drop-shadow haze.\n" +
      "INTERACTIVE + READ-BACK: canvases may be interactive (inputs, toggle buttons with aria-pressed, " +
      "selects, <details>, contenteditable notes). When the user edits one and then sends a message, a " +
      "COMPACT DIFF of what they changed (control label → old → new) is delivered to you automatically " +
      "inside a <canvas-interaction> block — so you can build a widget, let the user fill it in, and act " +
      "on their actual input on the next turn. You do NOT need to ask them to copy values back.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title shown on the card header." }),
      html: Type.String({ description: "A complete, self-contained HTML document. Inline CSS/JS, data: URIs only, no external resources." }),
      height: Type.Optional(Type.Number({ description: "Preferred card height in px (default 360, clamped 120–720)." })),
      theme: Type.Optional(Type.String({ description: "Preset theme foundation: broadsheet | console | terminal | bureau. Style using its CSS variables; omit for none." })),
    }),
    async execute(_id: string, params: any) {
      const html = String(params.html ?? "");
      const title = String(params.title ?? "Canvas").slice(0, 200);
      const height = Math.min(720, Math.max(120, Math.round(Number(params.height) || 360)));
      const THEMES = ["broadsheet", "console", "terminal", "bureau"];
      const rawTheme = String(params.theme ?? "").toLowerCase();
      const theme = THEMES.includes(rawTheme) ? rawTheme : undefined;
      if (!html.trim()) return textResult("canvas: `html` was empty — nothing to render.", { kind: "canvas", error: "empty" });
      return textResult(`Rendered canvas "${title}" (${html.length} bytes). The card is shown inline to the user.`, {
        kind: "canvas",
        title,
        html,
        height,
        theme,
      });
    },
  };

  const tools = [bash, readFile, readImage, writeFile, editFile, listFiles, diagramLint, canvas];

  if (subagentRunner) {
    const spawnSubagent: AgentTool<any> = {
      name: "spawn_subagent",
      label: "Delegate to subagent",
      description:
        "Run one durable joined Task in the same workspace and return its report to this Turn. " +
        "It does not create an addressable Agent. Use spawn_agent for background work with reusable Agent history.",
      parameters: Type.Object({
        task: Type.String({ description: "The task to delegate, written as a full instruction." }),
        description: Type.Optional(Type.String({ description: "Short label for the delegated work." })),
      }),
      async execute(toolCallId: string, params: any, signal?: AbortSignal) {
        const summary = await subagentRunner(toolCallId, params.task, signal);
        return textResult(truncate(summary || "(subagent finished)"), { delegated: true });
      },
    };
    tools.push(spawnSubagent);
  }

  if (agentRunner) {
    tools.push(
      {
        name: "spawn_agent",
        label: "Start a background agent",
        description:
          "Start an addressable background Agent for one bounded task. The Tool returns immediately " +
          "with a stable target. Use wait_agent or followup_task instead of spawning a duplicate.",
        parameters: Type.Object({
          task_name: Type.String({ description: "Stable lowercase task name: letters, digits, and underscores." }),
          message: Type.String({ description: "Complete task instruction." }),
          context: Type.Optional(Type.Union([
            Type.Literal("none"),
            Type.Literal("recent"),
            Type.Literal("all"),
          ], { description: "Parent context handoff. recent is the bounded default; all must be explicit." })),
        }),
        async execute(id: string, params: any, signal?: AbortSignal) {
          return textResult(await agentRunner.spawn({
            taskName: String(params.task_name ?? ""),
            message: String(params.message ?? ""),
            context: params.context === "none" || params.context === "all" ? params.context : "recent",
            ownerStepId: id,
          }, signal));
        },
      },
      {
        name: "list_agents",
        label: "List agents",
        description: "List the bounded live and durable Agent roster. Use get_agent for detail.",
        executionMode: "parallel",
        parameters: Type.Object({
          path_prefix: Type.Optional(Type.String({ description: "Optional canonical task-path prefix." })),
        }),
        async execute(_id: string, params: any) {
          return textResult(await agentRunner.list({
            pathPrefix: typeof params.path_prefix === "string" ? params.path_prefix : undefined,
          }));
        },
      },
      {
        name: "get_agent",
        label: "Inspect an agent",
        description: "Read one Agent's bounded status, latest activity, and result reference.",
        executionMode: "parallel",
        parameters: Type.Object({
          target: Type.String({ description: "Agent id, alias, or canonical task path." }),
        }),
        async execute(id: string, params: any) {
          return textResult(await agentRunner.get({ target: String(params.target ?? ""), ownerStepId: id }));
        },
      },
      {
        name: "wait_agent",
        label: "Wait for agent activity",
        description:
          "Wait for a roster change or completion. It returns changed targets, not full result bodies.",
        parameters: Type.Object({
          targets: Type.Optional(Type.Array(Type.String(), { maxItems: 16, description: "Targets to watch. Omit for any Agent." })),
          timeout_ms: Type.Optional(Type.Number({ description: "Wait time in milliseconds, clamped to 1–30000." })),
        }),
        async execute(_id: string, params: any, signal?: AbortSignal) {
          const targets = Array.isArray(params.targets)
            ? params.targets.slice(0, 16).map((target: unknown) => String(target))
            : undefined;
          const timeoutMs = Math.max(1, Math.min(30_000, Math.round(Number(params.timeout_ms) || 10_000)));
          return textResult(await agentRunner.wait({ targets, timeoutMs }, signal));
        },
      },
      {
        name: "send_message",
        label: "Message an active agent",
        description:
          "Queue a message for an Agent's next safe model boundary. This does not start an idle Agent Turn.",
        parameters: Type.Object({
          target: Type.String({ description: "Agent id, alias, or canonical task path." }),
          message: Type.String({ description: "Message to deliver." }),
        }),
        async execute(_id: string, params: any) {
          return textResult(await agentRunner.send({
            target: String(params.target ?? ""),
            message: String(params.message ?? ""),
          }));
        },
      },
      {
        name: "followup_task",
        label: "Give an agent a follow-up",
        description:
          "Give an existing Agent a new task. It starts a new child Turn when idle or queues behind its active Turn.",
        parameters: Type.Object({
          target: Type.String({ description: "Agent id, alias, or canonical task path." }),
          message: Type.String({ description: "Complete follow-up instruction." }),
        }),
        async execute(id: string, params: any, signal?: AbortSignal) {
          return textResult(await agentRunner.followUp({
            target: String(params.target ?? ""),
            message: String(params.message ?? ""),
            ownerStepId: id,
          }, signal));
        },
      },
      {
        name: "interrupt_agent",
        label: "Interrupt an agent",
        description: "Interrupt an Agent's active Turn. Its durable identity and completed context remain available.",
        parameters: Type.Object({
          target: Type.String({ description: "Agent id, alias, or canonical task path." }),
        }),
        async execute(_id: string, params: any) {
          return textResult(await agentRunner.interrupt({ target: String(params.target ?? "") }));
        },
      },
    );
  }

  if (workflowRunner) {
    const dependencySchema = Type.Object({
      node_id: Type.String({
        minLength: 1,
        maxLength: 64,
        description: "Upstream node id.",
      }),
      condition: Type.Optional(Type.Union([
        Type.Literal("success"),
        Type.Literal("settled"),
      ], {
        description: "success requires success. settled also accepts a failed or cancelled upstream node.",
      })),
    });
    tools.push({
      name: "run_workflow",
      label: "Run a workflow",
      description:
        "Start one bounded, durable background Workflow. Supply nodes for a known DAG, or one controller " +
        "for a dynamic DAG. An explicit controller selects dynamic mode and overrides stray nodes. " +
        "Each work node gets a trusted fresh Agent. The Tool returns immediately. " +
        "Use Agent status Tools for detail; do not poll in a loop.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 256, description: "Short Workflow name." }),
        nodes: Type.Optional(Type.Array(Type.Object({
          id: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z0-9][a-z0-9_]*$",
            description: "Stable lowercase node id.",
          }),
          name: Type.String({ minLength: 1, maxLength: 256, description: "Short node name." }),
          message: Type.String({
            minLength: 1,
            maxLength: 32 * 1024,
            description: "Complete instruction for this fresh Agent.",
          }),
          dependencies: Type.Optional(Type.Array(dependencySchema, {
            maxItems: 16,
            description: "Upstream nodes. Omit to run as soon as capacity is available.",
          })),
          effect: Type.Optional(Type.Union([
            Type.Literal("pure_readonly"),
            Type.Literal("workspace_read"),
            Type.Literal("workspace_write"),
            Type.Literal("network"),
            Type.Literal("unknown"),
          ], {
            description: "Capability profile. Omit for the full unknown-effect Tool set.",
          })),
          max_attempts: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 4,
            description: "Maximum attempts for this node. Default 1.",
          })),
        }), {
          minItems: 1,
          maxItems: 16,
          description: "Known DAG work nodes. Used only when controller is absent.",
        })),
        controller: Type.Optional(Type.Object({
          name: Type.String({ minLength: 1, maxLength: 256, description: "Short controller name." }),
          message: Type.String({
            minLength: 1,
            maxLength: 32 * 1024,
            description: "Complete goal and planning constraints for the dynamic controller.",
          }),
          max_attempts: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 4,
            description: "Maximum controller attempts. Default 1.",
          })),
        }, {
          description: "Dynamic DAG controller. When present, this field selects dynamic mode.",
        })),
        budget: Type.Optional(Type.Object({
          max_nodes: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 16,
            description: "Whole-Workflow node limit. Dynamic default 16.",
          })),
          max_edges: Type.Optional(Type.Integer({
            minimum: 0,
            maximum: 256,
            description: "Whole-Workflow edge limit.",
          })),
          max_depth: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 16,
            description: "Dynamic expansion depth limit. Default 8.",
          })),
          max_attempts: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 128,
            description: "Whole-Workflow attempt limit.",
          })),
          max_runtime_minutes: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 1_440,
            description: "Whole-Workflow deadline in minutes. Default 60.",
          })),
          max_tokens: Type.Optional(Type.Integer({
            minimum: 1_000,
            maximum: 2_000_000,
            description: "Whole-Workflow provider token budget.",
          })),
          max_cost_usd: Type.Optional(Type.Number({
            minimum: 0.01,
            maximum: 1_000,
            description: "Whole-Workflow provider cost budget in USD.",
          })),
        })),
      }),
      async execute(_id: string, params: any, signal?: AbortSignal) {
        const hasNodes = Array.isArray(params.nodes) && params.nodes.length > 0;
        const hasController = params.controller !== null
          && typeof params.controller === "object"
          && !Array.isArray(params.controller);
        if (!hasNodes && !hasController) {
          throw new Error("run_workflow requires nodes or one controller");
        }
        const budget = params.budget && typeof params.budget === "object"
          ? {
            ...(Number.isSafeInteger(params.budget.max_nodes)
              ? { maxNodes: params.budget.max_nodes }
              : {}),
            ...(Number.isSafeInteger(params.budget.max_edges)
              ? { maxEdges: params.budget.max_edges }
              : {}),
            ...(Number.isSafeInteger(params.budget.max_depth)
              ? { maxDepth: params.budget.max_depth }
              : {}),
            ...(Number.isSafeInteger(params.budget.max_attempts)
              ? { maxAttempts: params.budget.max_attempts }
              : {}),
            ...(Number.isSafeInteger(params.budget.max_runtime_minutes)
              ? { maxRuntimeMs: params.budget.max_runtime_minutes * 60_000 }
              : {}),
            ...(Number.isSafeInteger(params.budget.max_tokens)
              ? { maxTokens: params.budget.max_tokens }
              : {}),
            ...(typeof params.budget.max_cost_usd === "number" && Number.isFinite(params.budget.max_cost_usd)
              ? { maxCostMicros: Math.round(params.budget.max_cost_usd * 1_000_000) }
              : {}),
          }
          : undefined;
        return textResult(await workflowRunner.run({
          name: String(params.name ?? ""),
          ...(hasNodes && !hasController ? { nodes: params.nodes.map((node: any) => ({
            id: String(node.id ?? ""),
            name: String(node.name ?? ""),
            message: String(node.message ?? ""),
            ...(Array.isArray(node.dependencies) ? {
              dependencies: node.dependencies.map((dependency: any) => ({
                nodeId: String(dependency.node_id ?? ""),
                ...(dependency.condition === "settled" ? { condition: "settled" as const } : {}),
              })),
            } : {}),
            ...(["pure_readonly", "workspace_read", "workspace_write", "network", "unknown"].includes(node.effect)
              ? { effect: node.effect as WorkflowEffect }
              : {}),
            ...(Number.isSafeInteger(node.max_attempts) ? { maxAttempts: node.max_attempts } : {}),
          })) } : {}),
          ...(hasController ? {
            controller: {
              name: String(params.controller.name ?? ""),
              message: String(params.controller.message ?? ""),
              ...(Number.isSafeInteger(params.controller.max_attempts)
                ? { maxAttempts: params.controller.max_attempts }
                : {}),
            },
          } : {}),
          ...(budget && Object.keys(budget).length > 0 ? { budget } : {}),
        }, signal));
      },
    });
  }

  return tools;
}

export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return `Run command: ${String(args.command)}`;
    case "write_file":
      return `Write file: ${String(args.path)}`;
    case "edit_file":
      return `Edit file: ${String(args.path)}`;
    case "read_file":
      return `Read file: ${String(args.path)}`;
    case "list_files":
      return `List directory: ${String(args.path ?? ".")}`;
    case "spawn_subagent":
      return `Delegate to subagent: ${String(args.task ?? "").split("\n")[0]}`;
    case "spawn_agent":
      return `Start background Agent: ${String(args.task_name ?? "agent")}`;
    case "followup_task":
      return `Assign follow-up to Agent: ${String(args.target ?? "agent")}`;
    case "run_workflow":
      return `Run Workflow: ${String(args.name ?? "workflow")}`;
    case "team_create":
      return `Create Team: ${String(args.name ?? "team")}`;
    case "team_assign":
      return `Assign Team work: ${String(args.title ?? "work")}`;
    case "team_mail":
      return `Use Team mail: ${String(args.action ?? "action")}`;
    case "diagram_lint":
      return `Lint ${String(args.language ?? "diagram")} source`;
    default:
      return `${name}(${JSON.stringify(args).slice(0, 120)})`;
  }
}
