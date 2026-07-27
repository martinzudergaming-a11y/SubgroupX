import { db } from "./core.ts";

export interface UserMemoryRow {
  user_id: string;
  enabled: number;
  state: string | null;
  user_notes: string | null;
  last_dreamed_at: number | null;
  dreamed_through: number | null;
  next_review_at: number | null;
  updated_at: number;
}

export interface UserMemory {
  enabled: boolean;
  state: string | null;
  userNotes: string | null;
  lastDreamedAt: number | null;
  dreamedThrough: number | null;
  nextReviewAt: number | null;
}

const DEFAULTS: UserMemory = { enabled: true, state: null, userNotes: null, lastDreamedAt: null, dreamedThrough: null, nextReviewAt: null };

function ensureRow(userId: string): void {
  db.prepare(
    "INSERT INTO user_memory (user_id, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(user_id) DO NOTHING",
  ).run(userId, Date.now());
}

export const userMemoryDao = {
  get(userId: string): UserMemory {
    const row = db.prepare("SELECT * FROM user_memory WHERE user_id = ?").get(userId) as UserMemoryRow | undefined;
    if (!row) return { ...DEFAULTS };
    return {
      enabled: row.enabled !== 0,
      state: row.state ?? null,
      userNotes: row.user_notes ?? null,
      lastDreamedAt: row.last_dreamed_at ?? null,
      dreamedThrough: row.dreamed_through ?? null,
      nextReviewAt: row.next_review_at ?? null,
    };
  },

  setEnabled(userId: string, enabled: boolean): void {
    ensureRow(userId);
    const now = Date.now();
    if (enabled) {
      db.prepare(
        "UPDATE user_memory SET enabled = 1, dreamed_through = CASE WHEN enabled = 0 THEN ? ELSE dreamed_through END, updated_at = ? WHERE user_id = ?",
      ).run(now, now, userId);
      return;
    }
    db.prepare("UPDATE user_memory SET enabled = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
  },

  setUserNotes(userId: string, notes: string): void {
    ensureRow(userId);
    db.prepare("UPDATE user_memory SET user_notes = ?, updated_at = ? WHERE user_id = ?").run(notes.trim() ? notes : null, Date.now(), userId);
  },

  setState(userId: string, state: string, dreamedThrough: number, nextReviewAt: number | null, at = Date.now()): void {
    ensureRow(userId);
    db.prepare(
      "UPDATE user_memory SET state = ?, last_dreamed_at = ?, dreamed_through = ?, next_review_at = ?, updated_at = ? WHERE user_id = ?",
    ).run(state.trim() ? state : null, at, dreamedThrough, nextReviewAt, at, userId);
  },

  advanceDreamedThrough(userId: string, dreamedThrough: number, at = Date.now()): void {
    ensureRow(userId);
    db.prepare(
      "UPDATE user_memory SET last_dreamed_at = ?, dreamed_through = ?, updated_at = ? WHERE user_id = ?",
    ).run(at, dreamedThrough, at, userId);
  },

  clearState(userId: string): void {
    ensureRow(userId);
    db.prepare(
      "UPDATE user_memory SET state = NULL, last_dreamed_at = NULL, dreamed_through = NULL, next_review_at = NULL, updated_at = ? WHERE user_id = ?",
    ).run(Date.now(), userId);
  },

  listDreamCandidates(now: number, quietMs: number, minIntervalMs: number, limit = 8): { userId: string; latestActivity: number }[] {
    const rows = db.prepare(
      `SELECT s.user_id AS user_id, MAX(s.updated_at) AS latest
         FROM sessions s
         LEFT JOIN user_memory m ON m.user_id = s.user_id
        WHERE COALESCE(m.enabled, 1) != 0
        GROUP BY s.user_id
       HAVING latest > COALESCE(MAX(m.dreamed_through), 0)
          AND latest <= ?
          AND COALESCE(MAX(m.last_dreamed_at), 0) <= ?
        ORDER BY latest ASC
        LIMIT ?`,
    ).all(now - quietMs, now - minIntervalMs, limit) as { user_id: string; latest: number }[];
    const due = rows.map((r) => ({ userId: r.user_id, latestActivity: r.latest }));
    const reviews = db.prepare(
      `SELECT user_id, COALESCE(dreamed_through, 0) AS through FROM user_memory
        WHERE enabled != 0 AND state IS NOT NULL AND next_review_at IS NOT NULL AND next_review_at <= ?
          AND COALESCE(last_dreamed_at, 0) <= ? LIMIT ?`,
    ).all(now, now - minIntervalMs, limit) as { user_id: string; through: number }[];
    for (const r of reviews) {
      if (!due.some((d) => d.userId === r.user_id)) due.push({ userId: r.user_id, latestActivity: r.through });
    }
    return due;
  },
};
