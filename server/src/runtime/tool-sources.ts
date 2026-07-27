import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { capToolDetails, truncateToolOutput } from "./tool-output.ts";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { ROOT, type McpServerConfig } from "../config.ts";
import {
  createTools,
  type AgentOrchestrationRunner,
  type SubagentRunner,
  type WorkflowRunner,
} from "./tools.ts";
import type { Sandbox } from "./sandbox.ts";
import type { WorkspaceWriteLease } from "../orchestration/workspace-lease.ts";

export interface ToolSource {
  readonly id: string;
  listTools(): Promise<AgentTool<any>[]>;
  close?(): Promise<void>;
}

export function builtinToolSource(
  sandbox: Sandbox,
  subagentRunner?: SubagentRunner,
  workspaceWriteLease?: WorkspaceWriteLease,
  agentRunner?: AgentOrchestrationRunner,
  workflowRunner?: WorkflowRunner,
): ToolSource {
  return {
    id: "builtin",
    async listTools() {
      return createTools(sandbox, subagentRunner, workspaceWriteLease, agentRunner, workflowRunner);
    },
  };
}

export function mcpToolSource(config: McpServerConfig): ToolSource {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  let closed = false;

  async function closeClient(c: Client | null): Promise<void> {
    if (!c) return;
    try {
      await c.close();
    } catch {
    }
  }

  async function ensure(): Promise<Client> {
    if (closed) throw new Error(`MCP source "${config.id}" is closed`);
    if (client) return client;
    if (!connecting) {
      connecting = (async () => {
        const c = new Client({ name: "agent-web", version: "0.1.0" }, { capabilities: {} });
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
          cwd: config.cwd ?? ROOT,
        });
        try {
          await c.connect(transport);
        } catch (e) {
          await closeClient(c);
          throw e;
        }
        if (closed) {
          await closeClient(c);
          throw new Error(`MCP source "${config.id}" closed while connecting`);
        }
        client = c;
        return c;
      })().finally(() => {
        connecting = null;
      });
    }
    return await connecting;
  }

  return {
    id: `mcp:${config.id}`,
    async listTools() {
      const c = await ensure();
      const { tools } = await c.listTools();
      return tools.map((t) => mcpToolToAgentTool(config.id, t, ensure));
    },
    async close() {
      closed = true;
      const active = client;
      const pending = connecting;
      client = null;
      await closeClient(active);
      if (pending) {
        try {
          const connected = await pending;
          if (connected !== active) await closeClient(connected);
        } catch {
        }
      }
    },
  };
}

function mcpToolToAgentTool(
  serverId: string,
  tool: { name: string; title?: string; description?: string; inputSchema?: unknown },
  getClient: () => Promise<Client>,
): AgentTool<any> {
  return {
    name: `mcp__${serverId}__${tool.name}`,
    label: tool.title ?? tool.name,
    description: `${tool.description ?? tool.name} (via MCP server "${serverId}")`,
    parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const client = await getClient();
      const res: any = await client.callTool({ name: tool.name, arguments: params ?? {} }, undefined, { signal });
      const text =
        (res?.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n") || "(no output)";
      const result: AgentToolResult<unknown> = {
        content: [{ type: "text", text: truncateToolOutput(text) }],
        details: capToolDetails(res),
      };
      return result;
    },
  };
}

export async function composeTools(sources: ToolSource[]): Promise<AgentTool<any>[]> {
  const all: AgentTool<any>[] = [];
  for (const s of sources) {
    try {
      all.push(...(await s.listTools()));
    } catch (e) {
      console.error(`[tool-source ${s.id}] failed to list tools:`, e instanceof Error ? e.message : e);
    }
  }
  return all;
}
