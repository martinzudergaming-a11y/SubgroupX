import type {
  ExecutorAvailability,
  ExecutorStatus,
  ExecutorUnavailableReason,
} from "../../../shared/src/protocol.ts";

const E2B_DISABLED_REASON_ENV = "AGENT_WEB_E2B_NEW_SESSION_DISABLED_REASON";

let observedE2BCapacityFailure = false;

function configuredE2BReason(): ExecutorUnavailableReason | undefined {
  const raw = (process.env[E2B_DISABLED_REASON_ENV] ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (["capacity", "quota", "billing", "credits", "capacity_unavailable"].includes(raw)) {
    return "capacity_unavailable";
  }
  return "policy_disabled";
}

export function e2bExecutorStatus(): ExecutorStatus {
  const configuredReason = configuredE2BReason();
  if (configuredReason) return { available: false, reason: configuredReason };
  if (observedE2BCapacityFailure) return { available: false, reason: "capacity_unavailable" };
  if (!process.env.AGENT_WEB_E2B_KEY) return { available: false, reason: "not_configured" };
  return { available: true };
}

export function executorAvailability(): ExecutorAvailability {
  return {
    local:
      process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL === "1"
        ? { available: true }
        : { available: false, reason: "policy_disabled" },
    e2b: e2bExecutorStatus(),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.toLowerCase();
  return String(error).toLowerCase();
}

export function isE2BCapacityError(error: unknown): boolean {
  const text = errorText(error);
  return (
    /team is blocked[^\n]*(?:payment|billing|credit|quota)/.test(text) ||
    /(?:missing|invalid|failed|declined)[^\n]{0,40}payment method/.test(text) ||
    /(?:insufficient|not enough|exhausted|depleted|out of)[^\n]{0,40}(?:credit|quota)/.test(text) ||
    /(?:credit|quota)[^\n]{0,40}(?:insufficient|exhausted|depleted|exceeded|used up)/.test(text) ||
    /(?:billing|spending)[^\n]{0,40}(?:blocked|disabled|limit|quota)/.test(text)
  );
}

export function observeE2BCapacityError(error: unknown): boolean {
  if (!isE2BCapacityError(error)) return false;
  if (!observedE2BCapacityFailure) {
    console.error("[e2b] new-environment admission closed after a provider capacity/billing failure");
  }
  observedE2BCapacityFailure = true;
  return true;
}

export class ExecutorUnavailableError extends Error {
  readonly executor: "e2b" | "local";
  readonly reason: ExecutorUnavailableReason;

  constructor(executor: "e2b" | "local", reason: ExecutorUnavailableReason, options?: ErrorOptions) {
    const message =
      executor === "e2b" && reason === "capacity_unavailable"
        ? "E2B cloud capacity is unavailable. Connect your own computer to use file uploads and execution tools."
        : executor === "e2b"
          ? "E2B is unavailable. Connect your own computer to use file uploads and execution tools."
          : "The shared local executor is disabled. Connect your own computer to use file uploads and execution tools.";
    super(message, options);
    this.name = "ExecutorUnavailableError";
    this.executor = executor;
    this.reason = reason;
  }
}

export function assertE2BNewEnvironmentAvailable(): void {
  const status = e2bExecutorStatus();
  if (!status.available) throw new ExecutorUnavailableError("e2b", status.reason ?? "policy_disabled");
}

export function resetObservedE2BCapacityFailureForTest(): void {
  observedE2BCapacityFailure = false;
}
