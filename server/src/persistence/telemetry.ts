import { db } from "./core.ts";

export interface AuditEventRow {
  id: string;
  ts: number;
  level: string;
  event: string;
  user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  target_id: string | null;
  data_json: string;
}

export const auditEventDao = {
  add(row: AuditEventRow): void {
    db.prepare(
      `INSERT INTO audit_events (id, ts, level, event, user_id, session_id, request_id, target_id, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.ts,
      row.level,
      row.event,
      row.user_id,
      row.session_id,
      row.request_id,
      row.target_id,
      row.data_json,
    );
  },
  prune(olderThan: number, maxRows: number): { oldRows: number; overflowRows: number } {
    const oldRows = Number(db.prepare("DELETE FROM audit_events WHERE ts < ?").run(olderThan).changes);
    let overflowRows = 0;
    if (maxRows > 0) {
      overflowRows = Number(
        db
          .prepare(
            `DELETE FROM audit_events
             WHERE rowid IN (
               SELECT rowid FROM audit_events
               ORDER BY ts DESC, rowid DESC
               LIMIT -1 OFFSET ?
             )`,
          )
          .run(maxRows).changes,
      );
    }
    return { oldRows, overflowRows };
  },
  recent(limit: number): AuditEventRow[] {
    return db
      .prepare("SELECT * FROM audit_events ORDER BY ts DESC, rowid DESC LIMIT ?")
      .all(limit) as unknown as AuditEventRow[];
  },
};

export interface StatusSampleRow {
  id: string;
  ts: number;
  component: string;
  ok: number;
  latency_ms: number | null;
  detail_json: string;
}

export interface PerfSampleRow {
  ts: number;
  provider: string;
  model: string;
  ttft_ms: number | null;
  total_ms: number | null;
  ok: number;
}

export interface StatusIncidentRow {
  id: string;
  component: string;
  started_at: number;
  resolved_at: number | null;
  severity: string;
  summary: string;
}

export const statusSampleDao = {
  add(row: StatusSampleRow): void {
    db.prepare(
      `INSERT INTO status_samples (id, ts, component, ok, latency_ms, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.ts, row.component, row.ok, row.latency_ms, row.detail_json);
  },
  latestPerComponent(): StatusSampleRow[] {
    return db
      .prepare(
        `SELECT s.* FROM status_samples s
         JOIN (SELECT component, MAX(ts) AS mx FROM status_samples GROUP BY component) m
           ON s.component = m.component AND s.ts = m.mx`,
      )
      .all() as unknown as StatusSampleRow[];
  },
  uptimeSince(component: string, sinceTs: number): { ok: number; total: number } {
    const row = db
      .prepare(
        `SELECT SUM(ok) AS ok, COUNT(*) AS total FROM status_samples WHERE component = ? AND ts >= ?`,
      )
      .get(component, sinceTs) as { ok: number | null; total: number };
    return { ok: Number(row?.ok ?? 0), total: Number(row?.total ?? 0) };
  },
  dailyBuckets(component: string, sinceTs: number): { day: string; ok: number; total: number }[] {
    return db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
                SUM(ok) AS ok, COUNT(*) AS total
         FROM status_samples WHERE component = ? AND ts >= ?
         GROUP BY day ORDER BY day ASC`,
      )
      .all(component, sinceTs) as unknown as { day: string; ok: number; total: number }[];
  },
  prune(olderThan: number, maxRows: number): number {
    let removed = Number(db.prepare("DELETE FROM status_samples WHERE ts < ?").run(olderThan).changes);
    if (maxRows > 0) {
      removed += Number(
        db
          .prepare(
            `DELETE FROM status_samples WHERE rowid IN (
               SELECT rowid FROM status_samples ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?
             )`,
          )
          .run(maxRows).changes,
      );
    }
    return removed;
  },
};

export const perfSampleDao = {
  add(row: PerfSampleRow): void {
    db.prepare(
      `INSERT INTO perf_samples (ts, provider, model, ttft_ms, total_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.ts, row.provider, row.model, row.ttft_ms, row.total_ms, row.ok);
  },
  since(sinceTs: number, limit: number): PerfSampleRow[] {
    return db
      .prepare("SELECT * FROM perf_samples WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
      .all(sinceTs, limit) as unknown as PerfSampleRow[];
  },
  prune(olderThan: number, maxRows: number): number {
    let removed = Number(db.prepare("DELETE FROM perf_samples WHERE ts < ?").run(olderThan).changes);
    if (maxRows > 0) {
      removed += Number(
        db
          .prepare(
            `DELETE FROM perf_samples WHERE rowid IN (
               SELECT rowid FROM perf_samples ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?
             )`,
          )
          .run(maxRows).changes,
      );
    }
    return removed;
  },
};

export const statusIncidentDao = {
  openFor(component: string): StatusIncidentRow | null {
    return (db
      .prepare("SELECT * FROM status_incidents WHERE component = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(component) as StatusIncidentRow | undefined) ?? null;
  },
  open(row: StatusIncidentRow): void {
    db.prepare(
      `INSERT INTO status_incidents (id, component, started_at, resolved_at, severity, summary)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(row.id, row.component, row.started_at, row.severity, row.summary);
  },
  resolve(id: string, resolvedAt: number): void {
    db.prepare("UPDATE status_incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(resolvedAt, id);
  },
  recent(limit: number): StatusIncidentRow[] {
    return db
      .prepare("SELECT * FROM status_incidents ORDER BY started_at DESC LIMIT ?")
      .all(limit) as unknown as StatusIncidentRow[];
  },
  prune(olderThan: number): number {
    return Number(
      db.prepare("DELETE FROM status_incidents WHERE resolved_at IS NOT NULL AND started_at < ?").run(olderThan).changes,
    );
  },
};

export interface RequestCaptureRow {
  session_id: string;
  message_id: string;
  seq: number;
  provider: string;
  model: string;
  request_json: string;
  response_meta_json: string | null;
  response_msg_json: string | null;
  created_at: number;
}

export interface RequestCaptureMeta {
  messageId: string;
  seq: number;
  provider: string;
  model: string;
  status: number | null;
  createdAt: number;
}

const CAPTURE_RING_MAX = 50;
export const CAPTURE_RING_MAX_FOR_TEST = CAPTURE_RING_MAX;

export const requestCaptureDao = {
  append(row: RequestCaptureRow): void {
    db.prepare(
      `INSERT OR REPLACE INTO request_captures
         (session_id, message_id, seq, provider, model, request_json, response_meta_json, response_msg_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.session_id,
      row.message_id,
      row.seq,
      row.provider,
      row.model,
      row.request_json,
      row.response_meta_json,
      row.response_msg_json,
      row.created_at,
    );
    db.prepare(
      `DELETE FROM request_captures
        WHERE session_id = ?
          AND message_id NOT IN (
            SELECT message_id FROM request_captures
             WHERE session_id = ?
             ORDER BY seq DESC
             LIMIT ?
          )`,
    ).run(row.session_id, row.session_id, CAPTURE_RING_MAX);
  },
  listMeta(sessionId: string): RequestCaptureMeta[] {
    const rows = db
      .prepare(
        `SELECT message_id, seq, provider, model, response_meta_json, created_at
           FROM request_captures WHERE session_id = ? ORDER BY seq DESC`,
      )
      .all(sessionId) as {
      message_id: string;
      seq: number;
      provider: string;
      model: string;
      response_meta_json: string | null;
      created_at: number;
    }[];
    return rows.map((r) => {
      let status: number | null = null;
      if (r.response_meta_json) {
        try {
          const meta = JSON.parse(r.response_meta_json) as { status?: number };
          status = typeof meta.status === "number" ? meta.status : null;
        } catch {
        }
      }
      return { messageId: r.message_id, seq: r.seq, provider: r.provider, model: r.model, status, createdAt: r.created_at };
    });
  },
  get(sessionId: string, messageId: string): RequestCaptureRow | undefined {
    return db
      .prepare("SELECT * FROM request_captures WHERE session_id = ? AND message_id = ?")
      .get(sessionId, messageId) as RequestCaptureRow | undefined;
  },
  truncateFrom(sessionId: string, toSeq: number): void {
    db.prepare(
      `DELETE FROM request_captures
        WHERE session_id = ?
          AND message_id IN (
            SELECT json_extract(item_json, '$.id') FROM timeline WHERE session_id = ? AND seq >= ?
          )`,
    ).run(sessionId, sessionId, toSeq);
  },
};
