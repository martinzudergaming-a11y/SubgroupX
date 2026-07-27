import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath: string): any =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));

const root = readJson("package.json");
const web = readJson("web/package.json");
const lock = readJson("package-lock.json");
const supportedNode = ">=22.19.0 <25";

for (const [name, manifest] of [["root", root], ["web", web]] as const) {
  assert.equal(manifest.engines?.node, supportedNode, `${name} must use the deployment Node range`);
}

const piPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;
const declaredPiVersions = new Set(piPackages.map((name) => root.dependencies?.[name]));
assert.equal(declaredPiVersions.size, 1, "all direct pi packages must use one release line");
const piRange = [...declaredPiVersions][0];
assert.match(piRange, /^\^\d+\.\d+\.\d+$/, "pi packages must use one explicit caret range");
const piVersion = piRange.slice(1);

const piLockPaths = [
  ...piPackages.map((name) => `node_modules/${name}`),
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
];
for (const packagePath of piLockPaths) {
  assert.equal(lock.packages?.[packagePath]?.version, piVersion, `${packagePath} drifted from ${piVersion}`);
}

assert.equal(lock.packages?.["node_modules/undici"]?.engines?.node, ">=22.19.0");
assert.equal(lock.packages?.["node_modules/@homebridge/node-pty-prebuilt-multiarch"]?.engines?.node, ">=18.0.0 <25.0.0");

const exaOverride = root.overrides?.["exa-mcp-server"];
assert.equal(exaOverride?.agnost?.uuid, "14.0.1", "keep Exa's vulnerable uuid edge overridden");
assert.equal(exaOverride?.whoami?.shelljs, "0.10.0", "keep Exa's vulnerable shelljs edge overridden");
assert.equal(lock.packages?.["node_modules/uuid"]?.version, "14.0.1");
assert.equal(lock.packages?.["node_modules/shelljs"]?.version, "0.10.0");

assert.match(root.devDependencies?.typescript, /^\^7\./, "application typechecks should use TypeScript 7");
assert.match(root.devDependencies?.["typescript-compiler-api"], /^npm:typescript@\^6\./, "layout parser must use the explicit TS6 compatibility alias");


const appCss = fs.readFileSync(path.join(ROOT, "web/src/index.css"), "utf8");
const markdownCss = fs.readFileSync(path.join(ROOT, "web/src/conversation/markdown/code-theme.css"), "utf8");
const classDarkVariant = "@custom-variant dark (&:where(.dark, .dark *));";
assert.ok(appCss.includes(`@import "tailwindcss";\n${classDarkVariant}`), "Tailwind's class-driven dark variant must live in the compiled root stylesheet");
assert.ok(!markdownCss.includes("@custom-variant"), "component CSS must not leak raw Tailwind directives into the browser bundle");

const withTimeout = async <T>(label: string, operation: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const exaBin = path.join(ROOT, "node_modules/exa-mcp-server/smithery/stdio/index.cjs");
assert.ok(fs.existsSync(exaBin), "install dependencies before running the dependency contract");
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [exaBin],
  env: { ...env, EXA_API_KEY: "dependency-contract-placeholder" },
  cwd: ROOT,
  stderr: "pipe",
});
const client = new Client({ name: "oiia-dependency-contract", version: "1.0.0" }, { capabilities: {} });
try {
  await withTimeout("Exa MCP connect", client.connect(transport));
  const listed = await withTimeout("Exa MCP listTools", client.listTools());
  assert.ok(listed.tools.some((tool) => tool.name === "web_search_exa"), "Exa MCP core tool missing");
} finally {
  await client.close().catch(() => undefined);
}

console.log(`OK dependency-contract: pi ${piVersion}; Node ${supportedNode}; Exa override handshake`);
