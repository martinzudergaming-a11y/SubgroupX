import type { ServerEvent } from "@shared/protocol";

type ServerErrorEvent = Extract<ServerEvent, { type: "error" }>;

export function isPendingMutationRefusal(
  event: ServerErrorEvent,
  sessionId: string,
): event is ServerErrorEvent & { code: NonNullable<ServerErrorEvent["code"]>; sessionId: string } {
  return Boolean(event.code) && event.sessionId === sessionId;
}
