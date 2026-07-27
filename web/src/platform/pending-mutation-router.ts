import type { ClientOp, ServerEvent } from "@shared/protocol";

type PendingMutationOp = Extract<ClientOp, {
  type: "send_message" | "clear_pending" | "set_pending_kind" | "set_pending_text" | "reorder_pending";
}>;
type TypedPendingRefusal = Extract<ServerEvent, { type: "error" }> & { code: NonNullable<Extract<ServerEvent, { type: "error" }>["code"]> };

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX = 128;

export class PendingMutationRouter {
  private requests = new Map<string, { sessionId: string; expiresAt: number }>();
  private refusalRoutes = new WeakMap<ServerEvent, string>();

  constructor(
    private now: () => number = Date.now,
    private ttlMs = DEFAULT_TTL_MS,
    private max = DEFAULT_MAX,
  ) {}

  track(op: ClientOp): void {
    if (!this.isMutation(op) || !op.reqId) return;
    const now = this.now();
    this.prune(now);
    this.requests.delete(op.reqId);
    this.requests.set(op.reqId, { sessionId: op.sessionId, expiresAt: now + this.ttlMs });
    while (this.requests.size > this.max) this.requests.delete(this.requests.keys().next().value!);
  }

  observe(event: ServerEvent): void {
    this.prune(this.now());
    if ((event.type !== "ack" && event.type !== "error") || !event.reqId) return;
    const request = this.requests.get(event.reqId);
    if (!request) return;
    if (
      event.type === "error" &&
      event.code &&
      event.sessionId === request.sessionId
    ) {
      this.requests.delete(event.reqId);
      this.refusalRoutes.set(event, request.sessionId);
      return;
    }
    if (event.type === "ack") this.requests.delete(event.reqId);
  }

  sessionFor(event: TypedPendingRefusal): string | null {
    return this.refusalRoutes.get(event) ?? null;
  }

  clear(): void {
    this.requests.clear();
    this.refusalRoutes = new WeakMap();
  }

  get size(): number {
    this.prune(this.now());
    return this.requests.size;
  }

  private prune(now: number): void {
    for (const [reqId, request] of this.requests) {
      if (request.expiresAt > now) continue;
      this.requests.delete(reqId);
    }
  }

  private isMutation(op: ClientOp): op is PendingMutationOp {
    return (op.type === "send_message" && (op.mode === "steer" || op.mode === "queue")) ||
      op.type === "clear_pending" || op.type === "set_pending_kind" ||
      op.type === "set_pending_text" || op.type === "reorder_pending";
  }
}
