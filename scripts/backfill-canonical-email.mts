import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb } from "../server/src/persistence/index.ts";
import { canonicalizeEmailForUniqueness, isGmailDomain, emailDomain } from "../server/src/identity/auth.ts";

export interface DuplicateCluster {
  canonical: string;
  members: { id: string; email: string; created_at: number }[];
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  skippedInvalid: number;
  duplicates: DuplicateCluster[];
  indexCreated: boolean;
}

export function runBackfill(db: DatabaseSync): BackfillResult {
  const rows = db.prepare("SELECT id, email, canonical_email FROM users").all() as {
    id: string;
    email: string;
    canonical_email: string | null;
  }[];

  let updated = 0;
  let skippedInvalid = 0;
  for (const r of rows) {
    const email = r.email.toLowerCase();
    if (!isGmailDomain(emailDomain(email))) {
      if (r.canonical_email !== null) {
        db.prepare("UPDATE users SET canonical_email = NULL WHERE id = ?").run(r.id);
        updated++;
      }
      continue;
    }
    const canonical = canonicalizeEmailForUniqueness(email);
    if (canonical === null) {
      skippedInvalid++;
      continue;
    }
    if (canonical !== r.canonical_email) {
      db.prepare("UPDATE users SET canonical_email = ? WHERE id = ?").run(canonical, r.id);
      updated++;
    }
  }

  const dupeKeys = db
    .prepare(
      `SELECT canonical_email AS canonical, COUNT(*) AS n
         FROM users
        WHERE canonical_email IS NOT NULL
        GROUP BY canonical_email
       HAVING COUNT(*) > 1
        ORDER BY n DESC`,
    )
    .all() as { canonical: string; n: number }[];

  const duplicates: DuplicateCluster[] = dupeKeys.map((d) => ({
    canonical: d.canonical,
    members: db
      .prepare("SELECT id, email, created_at FROM users WHERE canonical_email = ? ORDER BY created_at ASC")
      .all(d.canonical) as { id: string; email: string; created_at: number }[],
  }));

  let indexCreated = false;
  if (duplicates.length === 0) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_email ON users(canonical_email) WHERE canonical_email IS NOT NULL;",
    );
    indexCreated = true;
  }

  return { scanned: rows.length, updated, skippedInvalid, duplicates, indexCreated };
}

function isMain(): boolean {
  return Boolean(process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href);
}

if (isMain()) {
  const res = runBackfill(defaultDb);
  console.log(
    `backfill: scanned ${res.scanned} rows, updated ${res.updated}, skipped-invalid ${res.skippedInvalid}`,
  );
  if (res.duplicates.length > 0) {
    console.error(`\nFOUND ${res.duplicates.length} duplicate Gmail-inbox cluster(s) among existing accounts:`);
    for (const d of res.duplicates) {
      console.error(`  ${d.canonical}  (${d.members.length} accounts):`);
      for (const m of d.members) {
        console.error(`    - ${m.id}  ${m.email}  created=${new Date(m.created_at).toISOString()}`);
      }
    }
    console.error(
      "\nThe UNIQUE index was NOT created because it would fail on these clusters. Resolve them\n" +
        "manually (merge/disable the duplicate accounts), then re-run this script. Until then, alias\n" +
        "dedup is enforced only for NEW signups via the app-level check.",
    );
    process.exit(2);
  }
  console.log("created UNIQUE partial index idx_users_canonical_email on users(canonical_email)");
  console.log("done — Gmail alias dedup is now enforced for both existing and new accounts.");
}
