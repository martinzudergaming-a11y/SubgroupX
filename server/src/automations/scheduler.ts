import { automationDao, type AutomationRow } from "../persistence/index.ts";
import { errorMessage } from "../foundation/errors.ts";
import { sessionManager } from "../runtime/manager.ts";
import { logAudit } from "../observability/audit-log.ts";

const TICK_MS = 60_000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

function fireAutomation(a: AutomationRow): boolean {
  if (sessionManager.isDraining()) return false;
  const rt = sessionManager.getRuntime(a.user_id, a.session_id);
  if (!rt) {
    console.warn(`[scheduler] automation ${a.id}: no runtime for session ${a.session_id} — skipping`);
    logAudit("automation_skip", { level: "warn", userId: a.user_id, sessionId: a.session_id, targetId: a.id, data: { reason: "missing_runtime" } });
    return false;
  }
  if (rt.isBusy()) {
    logAudit("automation_skip", { userId: a.user_id, sessionId: a.session_id, targetId: a.id, data: { reason: "busy" } });
    return false;
  }

  automationDao.setLastRun(a.id, Date.now());
  console.log(`[scheduler] firing automation ${a.id} "${a.name}" on session ${a.session_id}`);
  logAudit("automation_fire", { userId: a.user_id, sessionId: a.session_id, targetId: a.id, data: { intervalMinutes: a.interval_minutes } });
  const observeFailure = (err: unknown) => {
    console.error(`[scheduler] automation ${a.id} turn failed:`, err instanceof Error ? err.message : err);
    logAudit("automation_turn_failed", { level: "error", userId: a.user_id, sessionId: a.session_id, targetId: a.id, data: { reason: errorMessage(err) } });
  };
  try {
    const turn = rt.sendMessage(a.prompt);
    void turn.catch(observeFailure);
  } catch (err) {
    observeFailure(err);
  }
  return true;
}

function tick(): void {
  const now = Date.now();
  let due: AutomationRow[];
  try {
    due = automationDao.listDue(now);
  } catch (err) {
    console.error("[scheduler] listDue failed:", err instanceof Error ? err.message : err);
    logAudit("automation_list_due_failed", { level: "error", data: { reason: errorMessage(err) } });
    return;
  }
  if (due.length === 0) return;
  let fired = 0;
  for (const a of due) {
    try {
      if (fireAutomation(a)) fired++;
    } catch (err) {
      console.error(`[scheduler] automation ${a.id} failed:`, err instanceof Error ? err.message : err);
      logAudit("automation_fire_failed", { level: "error", userId: a.user_id, sessionId: a.session_id, targetId: a.id, data: { reason: errorMessage(err) } });
    }
  }
  if (fired > 0) {
    console.log(`[scheduler] tick fired ${fired}/${due.length} due automation(s)`);
    logAudit("automation_tick", { data: { fired, due: due.length } });
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  const jitter = Math.floor(Math.random() * 5_000);
  console.log(`[scheduler] starting — tick every ${TICK_MS / 1000}s (first in ~${Math.round(jitter / 1000)}s)`);
  logAudit("automation_scheduler_start", { data: { tickMs: TICK_MS, jitterMs: jitter } });
  setTimeout(() => {
    tick();
    timer = setInterval(tick, TICK_MS);
    if (typeof timer.unref === "function") timer.unref();
  }, jitter);
}
