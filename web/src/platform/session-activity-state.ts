import type { SessionStatus } from "@shared/protocol";

export type RunningSessionState = Readonly<Record<string, true>>;

export function applySessionActivity(
  current: RunningSessionState,
  sessionId: string,
  activity: SessionStatus,
): RunningSessionState {
  const running = activity === "running";
  if (running === Boolean(current[sessionId])) return current;
  const next = { ...current };
  if (running) next[sessionId] = true;
  else delete next[sessionId];
  return next;
}

export function replaceSessionActivities(
  current: RunningSessionState,
  activities: ReadonlyArray<{ sessionId: string; activity: SessionStatus }>,
): RunningSessionState {
  const next: Record<string, true> = {};
  for (const item of activities) {
    if (item.activity === "running") next[item.sessionId] = true;
  }
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  if (currentIds.length === nextIds.length && nextIds.every((id) => current[id])) return current;
  return next;
}

export function removeSessionActivity(
  current: RunningSessionState,
  sessionId: string,
): RunningSessionState {
  if (!current[sessionId]) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}
