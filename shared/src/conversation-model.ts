import type { TimelineItem } from "./protocol.ts";

export type ConversationItemClass = "message" | "step" | "system";

export function conversationItemClass(item: TimelineItem): ConversationItemClass {
  if (item.kind === "user" || item.kind === "assistant") return "message";
  if (item.kind === "tool") return "step";
  return "system";
}

type ConversationItemLike = {
  id: string;
  kind: TimelineItem["kind"];
  ts: number;
  turnId?: string;
};

export interface ConversationTurnGroup<T extends ConversationItemLike = TimelineItem> {
  id: string;
  turnId: string | null;
  inferred: boolean;
  items: T[];
  startedAt: number;
}

const canAnchorLegacyTurn = (item: ConversationItemLike): boolean =>
  item.kind === "user"
  || item.kind === "assistant"
  || item.kind === "tool"
  || item.kind === "error"
  || item.kind === "interrupted";

export function groupConversationTurns<T extends ConversationItemLike>(items: readonly T[]): ConversationTurnGroup<T>[] {
  const groups: ConversationTurnGroup<T>[] = [];
  let current: ConversationTurnGroup<T> | null = null;

  for (const item of items) {
    if (item.turnId) {
      if (current === null || current.turnId !== item.turnId) {
        current = {
          id: item.turnId,
          turnId: item.turnId,
          inferred: false,
          items: [],
          startedAt: item.ts,
        };
        groups.push(current);
      }
      current!.items.push(item);
      continue;
    }

    if (!canAnchorLegacyTurn(item)) continue;
    if (item.kind === "user" || current === null || !current.inferred) {
      current = {
        id: `legacy:${item.id}`,
        turnId: null,
        inferred: true,
        items: [],
        startedAt: item.ts,
      };
      groups.push(current);
    }
    current.items.push(item);
  }

  return groups;
}

export function turnRootUserIds<T extends ConversationItemLike>(items: readonly T[]): Set<string> {
  const roots = new Set<string>();
  for (const turn of groupConversationTurns(items)) {
    const firstUser = turn.items.find((item) => item.kind === "user");
    if (firstUser) roots.add(firstUser.id);
  }
  return roots;
}
