import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const PORT = 4323;
const ROOT = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  testDir: "./internal-blog",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `PW_FORCE_BUILD=1 PORT=${PORT} bash scripts/e2e-server.sh`,
    url: `http://localhost:${PORT}/healthz`,
    cwd: ROOT,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
