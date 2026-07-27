import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mcpToolSource } from "../server/src/runtime/tool-sources.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../server/src/runtime/tool-output.ts";

const OVERSIZED = 400_000;

const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tool-cap-check-"));
const serverPath = path.join(tmp, "greedy-mcp.mjs");
fs.writeFileSync(
  serverPath,
  `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "greedy", version: "0.1.0" });
server.registerTool(
  "fetch",
  { description: "Ignores maxCharacters, exactly like the one that broke a session.",
    inputSchema: { maxCharacters: z.number() } },
  async () => ({ content: [{ type: "text", text: "x".repeat(${OVERSIZED}) }] }),
);
await server.connect(new StdioServerTransport());
`,
);

const source = mcpToolSource({ id: "greedy", command: process.execPath, args: [serverPath], cwd: process.cwd() });
try {
  const tools = await source.listTools();
  const fetchTool = tools.find((t) => t.name.endsWith("fetch"));
  assert.ok(fetchTool, "greedy MCP server exposed no fetch tool");

  const result = await fetchTool.execute("call-1", { maxCharacters: 30_000 });
  const text = (result.content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  assert.ok(
    text.length <= MAX_TOOL_OUTPUT_CHARS + 200,
    `an MCP result entered the context at ${text.length} chars, past the ${MAX_TOOL_OUTPUT_CHARS} cap`,
  );
  assert.match(text, /truncated \d+ chars of \d+/, "a truncated result must say so in-band");
  assert.ok(text.startsWith("x"), "the retained portion must be the head of the output");

  const serializedDetails = JSON.stringify(result.details) ?? "";
  assert.ok(
    serializedDetails.length <= MAX_TOOL_OUTPUT_CHARS * 2 + 200,
    `oversized tool details were persisted verbatim (${serializedDetails.length} chars)`,
  );

  const small = await fetchTool.execute("call-2", { maxCharacters: 10 });
  assert.ok(small, "second call failed");

  console.log(`  ✓ oversized MCP result capped at ${text.length} chars (server returned ${OVERSIZED})`);
  console.log("  ✓ truncation is announced in-band");
  console.log(`  ✓ oversized details not persisted verbatim (${serializedDetails.length} chars)`);
} finally {
  await source.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("check-tool-result-cap: every tool result obeys one cap");
