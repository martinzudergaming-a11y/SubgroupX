import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
const serverEntry = path.join(root, "server", "src", "index.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { reject(new Error("no port")); return; }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function spawnServer(
  extraEnv: Record<string, string>,
  dataDir: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const stderrChunks: Buffer[] = [];
    const child = spawn(tsxBin, [serverEntry], {
      cwd: root,
      env: {
        ...process.env,
        AGENT_WEB_DATA_DIR: dataDir,
        AGENT_WEB_MCP: "[]",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("close", (code) => {
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
    setTimeout(() => { try { child.kill("SIGTERM"); } catch {  } }, 8_000);
  });
}

const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-secrets-check-a-"));
try {
  const { code, stderr } = await spawnServer(
    { NODE_ENV: "production" },
    tmpA,
  );
  assert.ok(code !== 0, `Expected nonzero exit but got ${code}`);
  assert.ok(
    stderr.includes("required in production"),
    `Expected "required in production" in stderr; got:\n${stderr}`,
  );
  console.log("  ✓ (a) production + no secret exits nonzero with 'required in production'");
} finally {
  fs.rmSync(tmpA, { recursive: true, force: true });
}

const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-secrets-check-b-"));
const port = await freePort();
const serverProc = spawn(tsxBin, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_WEB_DATA_DIR: tmpB,
    AGENT_WEB_MCP: "[]",
    NODE_ENV: "production",
    AGENT_WEB_SECRET: "secrets-check-prod-secret-32chars!!",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/healthz`).catch(() => null);
    if (res?.ok) { healthy = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(healthy, "/healthz did not return 200 within 10 s (production + secret set)");
  console.log("  ✓ (b) production + secret set → /healthz 200");
} finally {
  try { process.kill(-serverProc.pid!, "SIGTERM"); } catch { serverProc.kill("SIGTERM"); }
  fs.rmSync(tmpB, { recursive: true, force: true });
}

console.log("\nall secret-config checks passed");
