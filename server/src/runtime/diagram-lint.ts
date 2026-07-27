import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type DiagramLanguage = "mermaid" | "d2";
export type DiagramLintResult =
  | { valid: true; language: DiagramLanguage; details: Record<string, unknown> }
  | { valid: false; language: DiagramLanguage; error: string };

const COMPILER = fileURLToPath(new URL("./diagram-compiler-worker.mjs", import.meta.url));
const MAX_SOURCE_BYTES = 48 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 15_000;
const compilerWaiters: Array<{
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}> = [];
let compilerActive = false;

function acquireCompiler(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("diagram lint cancelled"));
  return new Promise((resolve, reject) => {
    const waiter = { signal, resolve, reject } as (typeof compilerWaiters)[number];
    const release = () => {
      if (!compilerActive) return;
      compilerActive = false;
      while (compilerWaiters.length) {
        const next = compilerWaiters.shift()!;
        next.signal?.removeEventListener("abort", next.onAbort!);
        if (next.signal?.aborted) {
          next.reject(next.signal.reason ?? new Error("diagram lint cancelled"));
          continue;
        }
        compilerActive = true;
        next.resolve(release);
        break;
      }
    };
    if (!compilerActive) {
      compilerActive = true;
      resolve(release);
      return;
    }
    waiter.onAbort = () => {
      const index = compilerWaiters.indexOf(waiter);
      if (index >= 0) compilerWaiters.splice(index, 1);
      reject(signal?.reason ?? new Error("diagram lint cancelled"));
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    compilerWaiters.push(waiter);
  });
}

export async function lintDiagram(
  language: DiagramLanguage,
  source: string,
  signal?: AbortSignal,
): Promise<DiagramLintResult> {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    return { valid: false, language, error: "diagram source exceeds 48 KiB" };
  }
  if (!source.trim()) return { valid: false, language, error: "diagram source is empty" };

  const release = await acquireCompiler(signal);
  try {
    return await runCompiler(language, source, signal);
  } finally {
    release();
  }
}

function runCompiler(
  language: DiagramLanguage,
  source: string,
  signal?: AbortSignal,
): Promise<DiagramLintResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("diagram lint cancelled"));
      return;
    }

    const child = spawn(process.execPath, [COMPILER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal?.reason ?? new Error("diagram lint cancelled")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => resolve({ valid: false, language, error: "diagram compiler timed out after 15 seconds" }));
    }, TIMEOUT_MS);

    const settleFromOutput = (code: number | null) => {
      try {
        const parsed = JSON.parse(stdout.toString("utf8")) as {
          valid?: boolean;
          details?: Record<string, unknown>;
          error?: unknown;
        };
        finish(() => {
          child.kill("SIGKILL");
          if (parsed.valid) resolve({ valid: true, language, details: parsed.details ?? {} });
          else resolve({ valid: false, language, error: String(parsed.error || "diagram compiler rejected the source").slice(0, 4_000) });
        });
      } catch {
        if (code == null) return;
        finish(() => {
          const diagnostic = stderr.toString("utf8").trim();
          resolve({
            valid: false,
            language,
            error: `diagram compiler exited ${code ?? "without a status"}${diagnostic ? `: ${diagnostic}` : ""}`.slice(0, 4_000),
          });
        });
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_OUTPUT_BYTES);
      if (stdout.includes(0x0a)) settleFromOutput(null);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr = Buffer.concat([stderr, chunk]).subarray(0, 4_096);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => settleFromOutput(code));
    child.stdin.end(JSON.stringify({ language, source }));
  });
}
