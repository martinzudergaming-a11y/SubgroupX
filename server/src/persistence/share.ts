import { db } from "./core.ts";

export interface ShareRow {
  token: string;
  session_id: string;
  created_by: string;
  title: string;
  snapshot_json: string;
  meta_json: string;
  created_at: number;
  revoked_at: number | null;
}

export const shareDao = {
  create(row: ShareRow): void {
    db.prepare(
      `INSERT INTO shares (token, session_id, created_by, title, snapshot_json, meta_json, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.token,
      row.session_id,
      row.created_by,
      row.title,
      row.snapshot_json,
      row.meta_json,
      row.created_at,
      row.revoked_at,
    );
  },
  byToken(token: string): ShareRow | undefined {
    return db.prepare("SELECT * FROM shares WHERE token = ?").get(token) as ShareRow | undefined;
  },
  listForSession(userId: string, sessionId: string): ShareRow[] {
    return db
      .prepare(
        "SELECT * FROM shares WHERE session_id = ? AND created_by = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(sessionId, userId) as unknown as ShareRow[];
  },
  revoke(userId: string, token: string): boolean {
    const res = db
      .prepare(
        "UPDATE shares SET revoked_at = ?, snapshot_json = '', title = '' WHERE token = ? AND created_by = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), token, userId);
    return res.changes > 0;
  },
};

export interface CompactionRow {
  id: string;
  session_id: string;
  seq: number;
  summarized_count: number;
  tokens_before: number;
  tokens_after: number;
  summary_text: string;
  archived_json: string;
  created_at: number;
}

export const compactionDao = {
  create(row: CompactionRow): void {
    db.prepare(
      `INSERT INTO compactions
         (id, session_id, seq, summarized_count, tokens_before, tokens_after, summary_text, archived_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.session_id,
      row.seq,
      row.summarized_count,
      row.tokens_before,
      row.tokens_after,
      row.summary_text,
      row.archived_json,
      row.created_at,
    );
  },
  byId(sessionId: string, id: string): CompactionRow | undefined {
    return db
      .prepare("SELECT * FROM compactions WHERE session_id = ? AND id = ?")
      .get(sessionId, id) as CompactionRow | undefined;
  },
  listForSession(sessionId: string): CompactionRow[] {
    return db
      .prepare("SELECT * FROM compactions WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as unknown as CompactionRow[];
  },
};
