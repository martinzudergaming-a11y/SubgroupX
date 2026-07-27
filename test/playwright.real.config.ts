import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PORT = 4321;
const ROOT = path.resolve(import.meta.dirname, "..");

function realSecrets(): Record<string, string> {
  const file = path.join(ROOT, "data/secrets.json");
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of [
      "AGENT_WEB_JAIL_KEY",
      "AGENT_WEB_JAIL_BASE_URL",
      "AGENT_WEB_JAIL_API",
      "AGENT_WEB_JAIL_MODEL",
      "AGENT_WEB_JAIL_MODELS",
    ]) {
      if (typeof raw[k] === "string") out[k] = raw[k] as string;
    }
    return out;
  } catch {
    return {};
  }
}

export default defineConfig({
  testDir: "./e2e-real",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "cd web && npm run build && cd .. && rm -rf /tmp/agentweb-pw-real && npx tsx server/src/index.ts",
    url: `http://localhost:${PORT}/healthz`,
    cwd: ROOT,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      AGENT_WEB_DATA_DIR: "/tmp/agentweb-pw-real",
      AGENT_WEB_SECRET: "pw-secret",
      AGENT_WEB_KEY_SECRET: "pw-secret",
      ...realSecrets(),
    },
  },
});
