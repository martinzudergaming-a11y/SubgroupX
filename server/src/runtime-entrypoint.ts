import { RUNTIME_SOCKET, ensureDirs } from "./config.ts";
import { tuneOutboundFetch } from "./transport/outbound-fetch.ts";
import { sessionManager, runtimeClient } from "./runtime/manager.ts";

tuneOutboundFetch();
import { registerMockProvider } from "./runtime/providers.ts";
import { hardenSharedDataPaths } from "./runtime/sandbox.ts";
import { recoverInterruptedSessions } from "./runtime/recovery.ts";
import { startScheduler } from "./automations/scheduler.ts";
import { startDreaming } from "./runtime/memory-dreaming.ts";
import { startRuntimeTaskDispatcher } from "./orchestration/runtime-task-dispatcher.ts";
import { startWorkflowScheduler } from "./orchestration/workflow-scheduler.ts";
import { createRuntimeHost } from "./runtime/runtime-ipc.ts";
import { attachRuntimeStreamHost } from "./runtime/runtime-stream-host.ts";
import { attachRuntimePtyHost } from "./runtime/runtime-pty-host.ts";
import { attachRuntimeConnectorHost } from "./runtime/runtime-connector-host.ts";
import { auditPrune, logAudit } from "./observability/audit-log.ts";
import { teamTaskDao } from "./persistence/index.ts";

if (!RUNTIME_SOCKET) {
  console.error(
    "[runtime] AGENT_WEB_RUNTIME_SOCKET is unset — the runtime process has no socket to serve. " +
      "Set it (and point the web process at the same path) to run split mode, or run the monolith (server/src/index.ts) instead.",
  );
  process.exit(1);
}

ensureDirs();
hardenSharedDataPaths();
registerMockProvider();
recoverInterruptedSessions();
sessionManager.reconcileTeamProvisioning(4_000);
teamTaskDao.recoverAfterRestart(Date.now(), `boot-team-${process.pid}`);
startRuntimeTaskDispatcher(sessionManager);
startWorkflowScheduler(sessionManager);
auditPrune(true);
startScheduler();
startDreaming();

const server = createRuntimeHost(runtimeClient, RUNTIME_SOCKET);
attachRuntimeStreamHost(server);
attachRuntimePtyHost(server);
attachRuntimeConnectorHost(server);

server.on("listening", () => {
  logAudit("runtime_start", { data: { socket: RUNTIME_SOCKET, version: process.env.BUILD_VERSION || "dev" } });
  console.log(`[runtime] listening on unix socket ${RUNTIME_SOCKET}`);
});
server.once("error", (e) => {
  console.error(`[runtime] failed to bind ${RUNTIME_SOCKET}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[runtime] ${signal} again during shutdown — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  sessionManager.setDraining();
  logAudit("runtime_draining", { data: { signal } });
  console.log(`[runtime] ${signal}: draining in-flight agent turns before exit…`);
  const force = setTimeout(() => {
    console.warn("[runtime] drain deadline exceeded — forcing exit");
    process.exit(0);
  }, 58_000);
  force.unref?.();
  try {
    const { finished, interrupted } = await sessionManager.drainTurns({ waitMs: 50_000, settleMs: 5_000 });
    console.log(`[runtime] drained turns: ${finished} finished, ${interrupted} interrupted`);
  } catch (e) {
    console.error("[runtime] drain error:", e instanceof Error ? e.message : e);
  }
  clearTimeout(force);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
