#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "../../services/api/node_modules/pg/lib/index.js";
import { TENANT_SCOPED_TABLES } from "../../services/api/dist/tenant-deletion/service.js";

const { Pool } = pg;

const EXPECTED_TARGET_SHA256 =
  "bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8";
const EXPECTED_TARGET_COUNT = 1519;
const TARGET_PATH = "/tmp/commercial-demo-retirement-targets.csv";
const PLAN_LIMIT = 100;

function emit(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function assertIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQL identifier: ${value}`);
  }
  return value;
}

function parseTargets(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EXPECTED_TARGET_SHA256) {
    throw new Error(`candidate-list hash mismatch: ${digest}`);
  }
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.shift() !== "tenant_id") {
    throw new Error("candidate-list header mismatch");
  }
  const ids = lines.map((line) => line.replace(/\r$/, ""));
  if (ids.length !== EXPECTED_TARGET_COUNT || new Set(ids).size !== ids.length) {
    throw new Error(`candidate-list count or uniqueness mismatch: ${ids.length}`);
  }
  return { digest, ids };
}

async function installTargets(client, ids) {
  await client.query(
    "CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY) ON COMMIT DROP",
  );
  const placeholders = ids.map((_, index) => `($${index + 1})`).join(",");
  await client.query(`INSERT INTO retirement_targets (tenant_id) VALUES ${placeholders}`, ids);
}

function summarizeNode(node, depth = 0, rows = []) {
  rows.push({
    depth,
    node_type: node["Node Type"],
    relation: node["Relation Name"] ?? null,
    index: node["Index Name"] ?? null,
    actual_total_time_ms: node["Actual Total Time"] ?? null,
    actual_rows: node["Actual Rows"] ?? null,
    actual_loops: node["Actual Loops"] ?? null,
    shared_hit_blocks: node["Shared Hit Blocks"] ?? 0,
    shared_read_blocks: node["Shared Read Blocks"] ?? 0,
    shared_dirtied_blocks: node["Shared Dirtied Blocks"] ?? 0,
  });
  for (const child of node.Plans ?? []) summarizeNode(child, depth + 1, rows);
  return rows;
}

async function catalogReport(client, deletionOrder) {
  const foreignKeys = await client.query(`
    SELECT constraint_row.conname AS constraint_name,
           child.relname AS referencing_table,
           parent.relname AS referenced_table,
           referencing_columns.columns AS referencing_columns,
           referenced_columns.columns AS referenced_columns,
           constraint_row.confdeltype AS delete_action,
           constraint_row.condeferrable AS deferrable,
           constraint_row.condeferred AS initially_deferred,
           EXISTS (
             SELECT 1
               FROM pg_index index_row
              WHERE index_row.indrelid = constraint_row.conrelid
                AND index_row.indisvalid
                AND index_row.indisready
                AND index_row.indnkeyatts >= cardinality(constraint_row.conkey)
                AND NOT EXISTS (
                  SELECT 1
                    FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, position)
                   WHERE index_row.indkey[(key_column.position - 1)::integer] <> key_column.attnum
                )
           ) AS referencing_columns_indexed
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      CROSS JOIN LATERAL (
        SELECT array_agg(attribute.attname ORDER BY key_column.position) AS columns
          FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attnum
      ) referencing_columns
      CROSS JOIN LATERAL (
        SELECT array_agg(attribute.attname ORDER BY key_column.position) AS columns
          FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attnum
      ) referenced_columns
     WHERE constraint_row.contype = 'f'
       AND child_namespace.nspname = 'public'
       AND parent_namespace.nspname = 'public'
     ORDER BY child.relname, constraint_row.conname
  `);

  const position = new Map(deletionOrder.map((entry, index) => [entry.table, index]));
  const relevantForeignKeys = foreignKeys.rows
    .map((row) => ({
      ...row,
      referencing_position: position.get(row.referencing_table) ?? null,
      referenced_position: position.get(row.referenced_table) ?? null,
    }))
    .filter(
      (row) =>
        row.referenced_table === "proposals" ||
        (row.referencing_position !== null &&
          row.referenced_position !== null &&
          row.referenced_position > row.referencing_position),
    );
  emit("commercial_demo_retirement_relevant_foreign_keys", {
    foreign_keys: relevantForeignKeys,
  });

  const triggers = await client.query(`
    SELECT trigger_row.tgname AS trigger_name,
           trigger_row.tgisinternal AS internal,
           trigger_row.tgenabled AS enabled,
           function_row.proname AS function_name,
           pg_get_triggerdef(trigger_row.oid, true) AS definition
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'proposals'
     ORDER BY trigger_row.tgisinternal, trigger_row.tgname
  `);
  emit("commercial_demo_retirement_proposals_triggers", { triggers: triggers.rows });

  const tableStats = await client.query(`
    SELECT stat.relname AS table,
           stat.n_live_tup::bigint AS estimated_live_rows,
           stat.n_dead_tup::bigint AS estimated_dead_rows,
           pg_relation_size(stat.relid)::bigint AS heap_bytes,
           pg_total_relation_size(stat.relid)::bigint AS total_bytes
      FROM pg_stat_user_tables stat
     ORDER BY stat.relname
  `);
  emit("commercial_demo_retirement_table_stats", { tables: tableStats.rows });
}

async function explainBatch(client, ids, entry) {
  const table = assertIdentifier(entry.table);
  const column = assertIdentifier(entry.column);
  const startedAt = Date.now();
  let result;
  let error = null;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '3min'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
    await installTargets(client, ids);
    result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING, SUMMARY, FORMAT JSON)
       WITH deletion_batch AS MATERIALIZED (
         SELECT candidate.tableoid AS target_tableoid,
                candidate.ctid AS target_ctid
           FROM ${table} candidate
           JOIN retirement_targets target ON target.tenant_id = candidate.${column}
          LIMIT $1
       )
       DELETE FROM ${table} doomed
       USING deletion_batch batch
       WHERE doomed.tableoid = batch.target_tableoid
         AND doomed.ctid = batch.target_ctid`,
      [PLAN_LIMIT],
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await client.query("ROLLBACK");
  }

  if (error !== null) {
    emit("commercial_demo_retirement_batch_plan_failed", {
      table,
      column,
      limit: PLAN_LIMIT,
      elapsed_ms: Date.now() - startedAt,
      error,
    });
    return;
  }

  const explain = result.rows[0]["QUERY PLAN"][0];
  const summary = {
    table,
    column,
    limit: PLAN_LIMIT,
    planning_time_ms: explain["Planning Time"],
    execution_time_ms: explain["Execution Time"],
    triggers: explain.Triggers ?? [],
    nodes: summarizeNode(explain.Plan),
  };
  emit("commercial_demo_retirement_batch_plan", summary);
  if (table === "proposals") {
    emit("commercial_demo_retirement_proposals_full_plan", { plan: explain });
  }
}

async function main() {
  const databaseUrl = process.env.BRAIN_TENANT_DELETION_DB_URL;
  if (!databaseUrl) throw new Error("BRAIN_TENANT_DELETION_DB_URL is required");
  const { digest, ids } = parseTargets(await readFile(TARGET_PATH));
  const deletionOrder = [
    ...TENANT_SCOPED_TABLES,
    { table: "tenants", column: "id" },
  ];
  const proposalsPosition = deletionOrder.findIndex((entry) => entry.table === "proposals");
  if (proposalsPosition < 0) throw new Error("proposals is absent from deletion order");
  const remainingOrder = deletionOrder.slice(proposalsPosition);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query(`
      SELECT current_user AS role,
             role_row.rolsuper AS superuser,
             pg_get_userbyid(class_row.relowner) = current_user AS owns_proposals
        FROM pg_roles role_row
        JOIN pg_class class_row ON class_row.relname = 'proposals'
       WHERE role_row.rolname = current_user
       LIMIT 1
    `);
    if (
      identity.rows[0]?.role !== "brain_tenant_deletion" ||
      identity.rows[0]?.superuser !== false ||
      identity.rows[0]?.owns_proposals !== false
    ) {
      throw new Error(`unexpected diagnostic role: ${JSON.stringify(identity.rows[0])}`);
    }
    emit("commercial_demo_retirement_performance_diagnostic_started", {
      candidate_list_sha256: digest,
      target_count: ids.length,
      identity: identity.rows[0],
      deletion_order: deletionOrder.map((entry, index) => ({ index, ...entry })),
      analyzed_order: remainingOrder.map((entry, offset) => ({
        index: proposalsPosition + offset,
        ...entry,
      })),
    });
    await catalogReport(client, deletionOrder);
    for (const entry of remainingOrder) {
      await explainBatch(client, ids, entry);
    }
    emit("commercial_demo_retirement_performance_diagnostic_complete", {
      analyzed_tables: remainingOrder.length,
      rollback_only: true,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "commercial_demo_retirement_performance_diagnostic_aborted",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
