import { RUNTIME_SOCKET } from "../config.ts";
import { runtimeClient } from "./manager.ts";
import { BOUNDED_OPS, makeRuntimeHttpClient, type BoundedRuntimeClient } from "./runtime-ipc.ts";

export const runtimeUsesIpc = Boolean(RUNTIME_SOCKET);

function inProcessBoundedClient(): BoundedRuntimeClient {
  const c = {} as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const op of BOUNDED_OPS) {
    c[op] = async (...args) =>
      (runtimeClient as unknown as Record<string, (...a: unknown[]) => unknown>)[op](...args);
  }
  return c as unknown as BoundedRuntimeClient;
}

export const boundedRuntimeClient: BoundedRuntimeClient = RUNTIME_SOCKET
  ? makeRuntimeHttpClient(RUNTIME_SOCKET)
  : inProcessBoundedClient();

export async function disposeUserRuntimesEverywhere(userId: string): Promise<number> {
  return boundedRuntimeClient.disposeUserRuntimes(userId);
}
