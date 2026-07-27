import path from "node:path";
import type { EditOperations } from "@earendil-works/pi-coding-agent";
import type { Sandbox } from "./sandbox.ts";

export type WorkspaceMutation = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

export interface PiWorkspaceAdapter {
  readonly cwd: string;
  readonly editOperations: EditOperations;
  runMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  writeFile(relativePath: string, content: string, signal?: AbortSignal): Promise<void>;
}

const virtualRoots = new WeakMap<object, string>();
let nextVirtualRoot = 0;

function virtualRootFor(sandbox: Sandbox): string {
  const existing = virtualRoots.get(sandbox);
  if (existing) return existing;
  const root = path.resolve("/__oiia_workspace__", String(++nextVirtualRoot));
  virtualRoots.set(sandbox, root);
  return root;
}

export function createPiWorkspaceAdapter(sandbox: Sandbox, mutate: WorkspaceMutation): PiWorkspaceAdapter {
  const cwd = virtualRootFor(sandbox);
  const toSandboxPath = (absolutePath: string): string => {
    const relative = path.relative(cwd, absolutePath);
    const isInside =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    if (!isInside) throw new Error("Tool path must stay inside the workspace.");
    return relative || ".";
  };

  const editOperations: EditOperations = {
    async access(absolutePath) {
      const relative = toSandboxPath(absolutePath);
      const entry = await sandbox.statFile(relative);
      if (!entry) {
        const error = new Error("File does not exist") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (entry.kind !== "file") {
        const error = new Error("Path is not a file") as NodeJS.ErrnoException;
        error.code = "EISDIR";
        throw error;
      }
    },
    async readFile(absolutePath) {
      return Buffer.from(await sandbox.readFile(toSandboxPath(absolutePath)), "utf8");
    },
    async writeFile(absolutePath, content) {
      await sandbox.writeFile(toSandboxPath(absolutePath), content);
    },
  };

  return {
    cwd,
    editOperations,
    runMutation: mutate,
    writeFile(relativePath, content, signal) {
      return mutate(() => sandbox.writeFile(relativePath, content), signal);
    },
  };
}
