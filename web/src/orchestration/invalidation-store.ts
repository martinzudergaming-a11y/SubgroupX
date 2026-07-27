import { useSyncExternalStore } from "react";
import type {
  OrchestrationInvalidation,
  OrchestrationInvalidationSnapshot,
} from "@shared/orchestration";

export type OrchestrationInvalidationKey =
  | "activity"
  | "workflows"
  | "teams"
  | `session:${string}`
  | `workflow:${string}`
  | `team:${string}`;

interface PendingInvalidation {
  version: number;
  force: boolean;
}

const generations = new Map<OrchestrationInvalidationKey, number>();
const serverVersions = new Map<OrchestrationInvalidationKey, number>();
const listeners = new Map<OrchestrationInvalidationKey, Set<() => void>>();
const pending = new Map<OrchestrationInvalidationKey, PendingInvalidation>();
let flushQueued = false;

function queue(key: OrchestrationInvalidationKey, version: number, force = false): void {
  const current = pending.get(key);
  pending.set(key, {
    version: Math.max(current?.version ?? 0, version),
    force: Boolean(current?.force || force),
  });
}

function flush(): void {
  flushQueued = false;
  for (const [key, incoming] of pending) {
    const knownVersion = serverVersions.get(key) ?? 0;
    if (!incoming.force && incoming.version <= knownVersion) continue;
    serverVersions.set(key, Math.max(knownVersion, incoming.version));
    generations.set(key, (generations.get(key) ?? 0) + 1);
    for (const listener of listeners.get(key) ?? []) listener();
  }
  pending.clear();
}

function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

export function publishOrchestrationInvalidation(event: OrchestrationInvalidation): void {
  switch (event.resource) {
    case "activity":
      queue("activity", event.revision);
      break;
    case "session_run":
      queue(`session:${event.sessionId}`, event.revision);
      break;
    case "workflow":
      queue(`workflow:${event.workflowId}`, event.version);
      queue("workflows", 0, true);
      break;
    case "team":
      queue(`team:${event.teamId}`, event.version);
      queue("teams", 0, true);
      break;
  }
  scheduleFlush();
}

export function publishOrchestrationInvalidationSnapshot(
  snapshot: OrchestrationInvalidationSnapshot,
): void {
  queue("activity", snapshot.activityRevision, true);
  const runRevisions = new Map(snapshot.sessionRuns.map((entry) => [entry.sessionId, entry.revision]));
  for (const entry of snapshot.sessionRuns) {
    queue(`session:${entry.sessionId}`, entry.revision, true);
  }
  for (const key of listeners.keys()) {
    if (key.startsWith("session:")) {
      const sessionId = key.slice("session:".length);
      queue(key, runRevisions.get(sessionId) ?? serverVersions.get(key) ?? 0, true);
    } else if (key === "workflows" || key === "teams" || key.startsWith("workflow:") || key.startsWith("team:")) {
      queue(key, serverVersions.get(key) ?? 0, true);
    }
  }
  scheduleFlush();
}

export function subscribeOrchestrationInvalidation(
  key: OrchestrationInvalidationKey,
  listener: () => void,
): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function readOrchestrationInvalidation(key: OrchestrationInvalidationKey): number {
  return generations.get(key) ?? 0;
}

export function useOrchestrationInvalidation(key: OrchestrationInvalidationKey): number {
  return useSyncExternalStore(
    (listener) => subscribeOrchestrationInvalidation(key, listener),
    () => readOrchestrationInvalidation(key),
    () => 0,
  );
}
