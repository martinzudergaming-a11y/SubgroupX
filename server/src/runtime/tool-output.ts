export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function truncateToolOutput(s: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars of ${s.length}]`;
}

export function capToolDetails(details: unknown, max = MAX_TOOL_OUTPUT_CHARS * 2): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(details) ?? "";
  } catch {
    return { omitted: "unserializable" };
  }
  if (serialized.length <= max) return details;
  return { omitted: "oversized", bytes: serialized.length, limit: max };
}
