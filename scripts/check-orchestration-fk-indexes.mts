import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-fk-indexes-"));
process.env.AGENT_WEB_DATA_DIR = tmp;

const { db } = await import("../server/src/persistence/index.ts");

interface SqliteTableRow {
  name: string;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
}

interface IndexListRow {
  name: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string;
}

const deletePlans = [
  "DELETE FROM sessions WHERE id = 'missing'",
  "DELETE FROM agent_nodes WHERE id = 'missing'",
  "DELETE FROM runtime_tasks WHERE id = 'missing'",
  "DELETE FROM workflows WHERE id = 'missing'",
  "DELETE FROM agent_turns WHERE session_id = 'missing' AND id = 'missing'",
];
const orchestrationScan = /\bSCAN (?:agent_|runtime_tasks\b|task_|workflow|teams?\b)/;

function assertFkIndexes(database: DatabaseSync, phase: string): number {
  const orchestrationTables = (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND (
       name LIKE 'agent_%'
       OR name LIKE 'runtime_task%'
       OR name LIKE 'task_%'
       OR name LIKE 'workflow%'
       OR name LIKE 'team%'
     )
     ORDER BY name ASC`,
  ).all() as unknown as SqliteTableRow[]).map((row) => row.name);

  const missing: string[] = [];
  for (const table of orchestrationTables) {
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all() as unknown as ForeignKeyRow[];
    const byId = new Map<number, ForeignKeyRow[]>();
    for (const row of foreignKeys) {
      const group = byId.get(row.id) ?? [];
      group.push(row);
      byId.set(row.id, group);
    }

    const indexes = (database.prepare(`PRAGMA index_list(${JSON.stringify(table)})`)
      .all() as unknown as IndexListRow[])
      .filter((row) => Number(row.partial) === 0)
      .map((row) => ({
        name: row.name,
        columns: (database.prepare(`PRAGMA index_info(${JSON.stringify(row.name)})`)
          .all() as unknown as IndexInfoRow[])
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name),
      }));

    for (const rows of byId.values()) {
      const ordered = [...rows].sort((left, right) => left.seq - right.seq);
      const childColumns = ordered.map((row) => row.from);
      const covered = indexes.some((index) =>
        childColumns.every((column, position) => index.columns[position] === column)
      );
      if (!covered) {
        missing.push(
          `${table}(${childColumns.join(",")}) -> ${ordered[0]!.table} `
          + `[indexes: ${indexes.map((index) => `${index.name}(${index.columns.join(",")})`).join("; ")}]`,
        );
      }
    }
  }

  assert.deepEqual(missing, [], `${phase}: orchestration FK child keys lack indexes:\n${missing.join("\n")}`);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], `${phase}: foreign key check`);

  for (const statement of deletePlans) {
    const plan = (database.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as unknown as Array<{ detail: string }>)
      .map((row) => row.detail);
    assert.equal(
      plan.some((detail) => orchestrationScan.test(detail)),
      false,
      `${phase}: orchestration cascade uses a full child scan:\n${statement}\n${plan.join("\n")}`,
    );
  }
  return orchestrationTables.length;
}

const tableCount = assertFkIndexes(db, "fresh schema");

const expectedUpgradeIndexes = [
  "idx_agent_nodes_session_fk",
  "idx_agent_nodes_parent_fk",
  "idx_agent_transcripts_source_task_fk",
  "idx_workflows_owner_session_fk",
  "idx_workflows_controller_agent_fk",
  "idx_teams_owner_session_fk",
  "idx_teams_lead_agent_fk",
  "idx_runtime_tasks_session_fk",
  "idx_runtime_tasks_owner_turn_fk",
  "idx_runtime_tasks_parent_task_fk",
  "idx_runtime_tasks_workflow_fk",
];
for (const index of expectedUpgradeIndexes) db.exec(`DROP INDEX ${index}`);
db.exec("ALTER TABLE pending_result_acknowledgements DROP COLUMN acknowledge_on_error");
db.close();

const coreUrl = pathToFileURL(path.resolve("server/src/persistence/core.ts")).href;
const restart = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `const { db } = await import(${JSON.stringify(coreUrl)}); db.close();`,
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_WEB_DATA_DIR: tmp },
    encoding: "utf8",
  },
);
assert.equal(
  restart.status,
  0,
  `schema restart failed:\n${restart.stdout}\n${restart.stderr}`,
);

const reopened = new DatabaseSync(path.join(tmp, "agent-web.db"));
reopened.exec("PRAGMA foreign_keys = ON;");
assert.equal(assertFkIndexes(reopened, "upgrade restart"), tableCount);
assert.ok(
  (reopened.prepare("PRAGMA table_info(pending_result_acknowledgements)").all() as unknown as Array<{ name: string }>)
    .some((column) => column.name === "acknowledge_on_error"),
  "upgrade restart restores the joined error-delivery policy column",
);
reopened.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `Orchestration FK index contract passed `
  + `(${tableCount} tables; ${deletePlans.length} cascade plans; restart repair).`,
);
