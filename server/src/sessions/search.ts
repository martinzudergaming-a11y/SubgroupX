import { db } from "../persistence/index.ts";
import type { TimelineItem, SearchMatch, SearchResponse } from "../../../shared/src/protocol.ts";

function itemText(item: TimelineItem): { text: string; label: string; kind: string } {
  switch (item.kind) {
    case "user":
      return { text: item.text, label: "You", kind: "user" };
    case "assistant": {
      const parts: string[] = [];
      for (const b of item.blocks) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "thinking") parts.push(b.thinking);
        else if (b.type === "toolCall") parts.push(`${b.name} ${JSON.stringify(b.arguments)}`);
      }
      return { text: parts.join("\n"), label: "Assistant", kind: "assistant" };
    }
    case "tool": {
      const args = item.arguments ? JSON.stringify(item.arguments) : "";
      const text = [item.name, item.path ?? "", args, item.resultText ?? ""].filter(Boolean).join("\n");
      const label = item.path ? `${item.name} ${item.path}` : item.name;
      return { text, label, kind: "tool" };
    }
    case "error":
      return { text: item.message, label: "Error", kind: "error" };
    default:
      return { text: "", label: "", kind: "other" };
  }
}

function snippet(text: string, q: string): string {
  const flat = text
    .replace(/```+[a-zA-Z0-9_-]*/g, " ")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return flat.slice(0, 120) + (flat.length > 120 ? "…" : "");
  const start = Math.max(0, idx - 40);
  const end = Math.min(flat.length, idx + q.length + 80);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

export function searchSessions(userId: string, rawQuery: string, limit = 60): SearchResponse {
  const query = rawQuery.trim();
  if (query.length < 2) return { query, total: 0, matches: [] };
  const needle = query.toLowerCase();
  const like = `%${needle.replace(/[%_\\]/g, (c) => "\\" + c)}%`;

  const matches: SearchMatch[] = [];

  const titleRows = db
    .prepare(
      `SELECT id, title, updated_at FROM sessions
       WHERE user_id = ? AND lower(title) LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(userId, like) as { id: string; title: string; updated_at: number }[];
  for (const row of titleRows) {
    matches.push({
      sessionId: row.id,
      sessionTitle: row.title,
      seq: -1,
      kind: "title",
      label: "Session",
      snippet: row.title,
      ts: row.updated_at,
    });
  }

  const rows = db
    .prepare(
      `SELECT t.session_id AS sid, t.seq AS seq, t.item_json AS item_json, s.title AS title
       FROM timeline t JOIN sessions s ON s.id = t.session_id
       WHERE s.user_id = ? AND lower(t.item_json) LIKE ? ESCAPE '\\'
       ORDER BY s.updated_at DESC, t.seq DESC
       LIMIT 400`,
    )
    .all(userId, like) as { sid: string; seq: number; item_json: string; title: string }[];

  for (const row of rows) {
    if (matches.length >= limit) break;
    let item: TimelineItem;
    try {
      item = JSON.parse(row.item_json) as TimelineItem;
    } catch {
      continue;
    }
    const { text, label, kind } = itemText(item);
    if (!text || !text.toLowerCase().includes(needle)) continue;
    matches.push({
      sessionId: row.sid,
      sessionTitle: row.title,
      seq: row.seq,
      kind,
      label,
      snippet: snippet(text, query),
      ts: "ts" in item ? item.ts : Date.now(),
    });
  }

  return { query, total: matches.length, matches: matches.slice(0, limit) };
}
