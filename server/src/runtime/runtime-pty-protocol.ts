export const RUNTIME_PTY_PROTOCOL_VERSION = 1;

export type RuntimePtyClientControl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

export type RuntimePtyServerControl =
  | { type: "hello"; runtimePtyProtocolVersion: number }
  | { type: "ready" }
  | { type: "no_terminal" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };
