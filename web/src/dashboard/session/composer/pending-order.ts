import type { PendingMessage } from "@shared/protocol";

export function pendingOrderWithKindSlots(
  pending: readonly PendingMessage[],
  kind: PendingMessage["kind"],
  reorderedKindIds: readonly string[],
): string[] {
  const original = [...pending].sort((a, b) => a.ord - b.ord);
  const expected = original.filter((row) => row.kind === kind).map((row) => row.id);
  if (reorderedKindIds.length !== expected.length ||
      new Set(reorderedKindIds).size !== expected.length ||
      reorderedKindIds.some((id) => !expected.includes(id))) {
    return original.map((row) => row.id);
  }
  let index = 0;
  return original.map((row) => row.kind === kind ? reorderedKindIds[index++]! : row.id);
}
