import { setGlobalDispatcher, Agent } from "undici";

let applied = false;
export function tuneOutboundFetch(): void {
  if (applied) return;
  applied = true;
  try {
    setGlobalDispatcher(
      new Agent({
        connect: { timeout: 30_000 },
        headersTimeout: 300_000,
        bodyTimeout: 600_000,
      }),
    );
  } catch {
  }
}
