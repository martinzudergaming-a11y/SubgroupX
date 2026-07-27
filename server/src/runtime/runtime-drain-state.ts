import { RUNTIME_SOCKET } from "../config.ts";
import { sessionManager } from "./manager.ts";
import { readRuntimeHello } from "./runtime-ipc.ts";

const HEARTBEAT_MS = 1000;
const STALE_MS = 5000;

let remoteDraining = true;
let lastBeatAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

async function beat(): Promise<void> {
  try {
    const hello = await readRuntimeHello(RUNTIME_SOCKET);
    remoteDraining = Boolean(hello.draining);
    lastBeatAt = Date.now();
  } catch {
  }
}

export const runtimeDrainState = {
  isDraining(): boolean {
    if (!RUNTIME_SOCKET) return sessionManager.isDraining();
    if (Date.now() - lastBeatAt > STALE_MS) return true;
    return remoteDraining;
  },
  start(): void {
    if (!RUNTIME_SOCKET || timer) return;
    void beat();
    timer = setInterval(() => void beat(), HEARTBEAT_MS);
    if (typeof timer.unref === "function") timer.unref();
  },
  stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
};
