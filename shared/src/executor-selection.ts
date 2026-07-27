import type { ExecutorAvailability, SandboxKind } from "./protocol.ts";

export interface AutomaticExecutorChoice {
  kind: SandboxKind;
  targetId: string | null;
}

export function chooseAutomaticExecutor(
  executors: ExecutorAvailability,
  connectors: readonly { id: string; online: boolean }[],
): AutomaticExecutorChoice | null {
  if (executors.local.available) return { kind: "local", targetId: null };
  if (executors.e2b.available) return { kind: "e2b", targetId: null };
  const connector = connectors.find((candidate) => candidate.online);
  return connector ? { kind: "connector", targetId: connector.id } : null;
}
