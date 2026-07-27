import type { ExecutorAvailability } from "@shared/protocol";
import type { ModelsResponse } from "./api.ts";
export { chooseAutomaticExecutor, type AutomaticExecutorChoice } from "@shared/executor-selection";

export function modelExecutorAvailability(response: ModelsResponse): ExecutorAvailability {
  return (
    response.executors ?? {
      local: { available: false, reason: "policy_disabled" },
      e2b: response.e2b
        ? { available: true }
        : { available: false, reason: "not_configured" },
    }
  );
}
