#!/usr/bin/env node
/* global URL, console, process */

import { readFile } from "node:fs/promises";
import pg from "../../services/api/node_modules/pg/lib/index.js";
import {
  TENANT_SCOPED_TABLES,
  tenantDeleteStatement,
} from "../../services/api/dist/tenant-deletion/service.js";
import { batchDeleteStatement } from "../../services/api/dist/tenant-deletion/batched-delete.js";
import { assertTenantDeletionPrivilegeContract } from "../../services/api/dist/tenant-deletion/privilege-contract.js";
import {
  assertDatabaseRole,
  assertRegistryCoverage,
  captureTenantCounts,
  executeOneTenant,
  parseTargetCsv,
} from "./execute-commercial-demo-retirement.mjs";

const { Pool } = pg;
const TARGET_PATH = "/tmp/commercial-demo-retirement-targets.csv";
const DIAGNOSTIC_STATEMENT_TIMEOUT = "10min";
const DIAGNOSTIC_LOCK_TIMEOUT = "10min";
const DIAGNOSTIC_IDLE_TIMEOUT = "15min";
const SLOW_STATEMENT_MS = 1_000;

class ExplainCaptured extends Error {}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function emit(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function statementOperation(sql) {
  return normalizeSql(sql).split(" ", 1)[0]?.toUpperCase() ?? "UNKNOWN";
}

function statementTable(sql) {
  const normalized = normalizeSql(sql);
  const mutation = normalized.match(/^(?:DELETE FROM|UPDATE|INSERT INTO) ([a-z_][a-z0-9_]*)/i);
  if (mutation) return mutation[1];
  const from = normalized.match(/\bFROM ([a-z_][a-z0-9_]*)/i);
  return from?.[1] ?? null;
}

function explainable(sql) {
  return /^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(normalizeSql(sql));
}

function reportRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !["sql", "values"].includes(key)),
  );
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
    rows_removed_by_filter: node["Rows Removed by Filter"] ?? 0,
    shared_hit_blocks: node["Shared Hit Blocks"] ?? 0,
    shared_read_blocks: node["Shared Read Blocks"] ?? 0,
    temp_read_blocks: node["Temp Read Blocks"] ?? 0,
    temp_written_blocks: node["Temp Written Blocks"] ?? 0,
  });
  for (const child of node.Plans ?? []) summarizeNode(child, depth + 1, rows);
  return rows;
}

function tracingClient(client, records, options) {
  let ordinal = 0;
  return {
    async query(sql, values = []) {
      const text = typeof sql === "string" ? sql : sql.text;
      ordinal += 1;
      if (options.explainOrdinal === ordinal) {
        const result = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING, SUMMARY, FORMAT JSON) ${text}`,
          values,
        );
        options.capturePlan(result.rows[0]["QUERY PLAN"][0]);
        throw new ExplainCaptured(`captured statement ${ordinal}`);
      }

      const startedAt = process.hrtime.bigint();
      try {
        const result = await client.query(sql, values);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const record = {
          ordinal,
          phase: options.phase,
          role: options.role(),
          operation: statementOperation(text),
          table: statementTable(text),
          statement_shape: normalizeSql(text),
          rows_affected: result.rowCount ?? null,
          reported_count:
            result.rows?.length === 1 && result.rows[0]?.count !== undefined
              ? Number(result.rows[0].count)
              : null,
          duration_ms: Number(durationMs.toFixed(3)),
          error: null,
        };
        records.push({ ...record, sql: text, values });
        emit("commercial_demo_retirement_statement_timing", record);
        return result;
      } catch (error) {
        if (error instanceof ExplainCaptured) throw error;
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const record = {
          ordinal,
          phase: options.phase,
          role: options.role(),
          operation: statementOperation(text),
          table: statementTable(text),
          statement_shape: normalizeSql(text),
          rows_affected: null,
          reported_count: null,
          duration_ms: Number(durationMs.toFixed(3)),
          error: error instanceof Error ? error.message : String(error),
        };
        records.push({ ...record, sql: text, values });
        emit("commercial_demo_retirement_statement_timing", record);
        throw error;
      }
    },
  };
}

async function beginDiagnosticTransaction(client) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query(`SET LOCAL statement_timeout = '${DIAGNOSTIC_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL lock_timeout = '${DIAGNOSTIC_LOCK_TIMEOUT}'`);
  await client.query(
    `SET LOCAL idle_in_transaction_session_timeout = '${DIAGNOSTIC_IDLE_TIMEOUT}'`,
  );
  const owner = await client.query(
    `SELECT current_user, session_user, role.rolsuper
       FROM pg_roles role
      WHERE role.rolname = current_user`,
  );
  if (
    owner.rows[0]?.current_user !== "brain" ||
    owner.rows[0]?.session_user !== "brain" ||
    owner.rows[0]?.rolsuper !== true
  ) {
    throw new Error(`unexpected owner session: ${JSON.stringify(owner.rows[0])}`);
  }
}

async function selectRehearsalTenant(client, ids) {
  const result = await client.query(
    `SELECT candidate.tenant_id,
            COUNT(proposal.id)::int AS proposal_count
       FROM unnest($1::text[]) candidate(tenant_id)
       LEFT JOIN proposals proposal ON proposal.tenant_id = candidate.tenant_id
      GROUP BY candidate.tenant_id
      ORDER BY COUNT(proposal.id) DESC, candidate.tenant_id
      LIMIT 1`,
    [ids],
  );
  const tenantId = result.rows[0]?.tenant_id;
  if (typeof tenantId !== "string") throw new Error("no rehearsal tenant was selected");
  return { tenantId, proposalCount: Number(result.rows[0].proposal_count) };
}

async function runRehearsalStatements(client, context, options = {}) {
  const role = { current: "brain" };
  const records = [];
  const traced = tracingClient(client, records, {
    phase: "timed_rehearsal",
    explainOrdinal: options.explainOrdinal,
    capturePlan: options.capturePlan ?? (() => undefined),
    role: () => role.current,
  });

  await traced.query(
    `UPDATE agents
        SET state = 'quarantined'
      WHERE tenant_id = $1
        AND state <> 'quarantined'`,
    [context.tenantId],
  );
  await traced.query("SET LOCAL ROLE brain_tenant_deletion");
  role.current = "brain_tenant_deletion";
  await assertDatabaseRole(traced);
  await assertTenantDeletionPrivilegeContract(
    traced,
    TENANT_SCOPED_TABLES.filter(({ table }) => context.liveTables.has(table)).map(
      ({ table }) => table,
    ),
  );
  const result = await executeOneTenant(
    traced,
    context.tenantId,
    context.expectedRows,
    context.fenceStartedAt,
    context.liveTables,
  );
  return { records, result };
}

async function tenantFilterIndexReport(client) {
  const deletionOrder = [...TENANT_SCOPED_TABLES, { table: "tenants", column: "id" }];
  const result = await client.query(
    `WITH target_columns AS (
       SELECT target.table_name, target.column_name, target.ordinal
         FROM jsonb_to_recordset($1::jsonb)
           AS target(table_name text, column_name text, ordinal integer)
     )
     SELECT target.table_name,
            target.column_name,
            target.ordinal,
            COALESCE(stats.n_live_tup, 0)::bigint AS estimated_live_rows,
            EXISTS (
              SELECT 1
                FROM pg_index index_row
                JOIN pg_attribute attribute
                  ON attribute.attrelid = relation.oid
                 AND attribute.attname = target.column_name
               WHERE index_row.indrelid = relation.oid
                 AND index_row.indisvalid
                 AND index_row.indisready
                 AND index_row.indnkeyatts >= 1
                 AND index_row.indkey[0] = attribute.attnum
            ) AS tenant_filter_indexed,
            COALESCE((
              SELECT json_agg(index_class.relname ORDER BY index_class.relname)
                FROM pg_index index_row
                JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
                JOIN pg_attribute attribute
                  ON attribute.attrelid = relation.oid
                 AND attribute.attname = target.column_name
               WHERE index_row.indrelid = relation.oid
                 AND index_row.indisvalid
                 AND index_row.indisready
                 AND index_row.indnkeyatts >= 1
                 AND index_row.indkey[0] = attribute.attnum
            ), '[]'::json) AS matching_indexes
       FROM target_columns target
       JOIN pg_class relation ON relation.relname = target.table_name
       JOIN pg_namespace namespace
         ON namespace.oid = relation.relnamespace
        AND namespace.nspname = 'public'
       LEFT JOIN pg_stat_user_tables stats ON stats.relid = relation.oid
      ORDER BY target.ordinal`,
    [
      JSON.stringify(
        deletionOrder.map(({ table, column }, ordinal) => ({
          table_name: table,
          column_name: column,
          ordinal,
        })),
      ),
    ],
  );
  emit("commercial_demo_retirement_tenant_filter_indexes", {
    tables: result.rows,
    unindexed_tables: result.rows.filter((row) => !row.tenant_filter_indexed),
  });
  emit("commercial_demo_retirement_path_comparison", {
    order_identical: true,
    deletion_order: deletionOrder.map(({ table, column }, ordinal) => ({
      ordinal,
      table,
      column,
    })),
    per_tenant_shape: tenantDeleteStatement("example_table", "tenant_id"),
    batched_shape: batchDeleteStatement("example_table", "tenant_id"),
  });
}

async function main() {
  const deletionDatabaseUrl = new URL(requiredEnv("BRAIN_TENANT_DELETION_DB_URL"));
  deletionDatabaseUrl.username = "brain";
  deletionDatabaseUrl.password = requiredEnv("POSTGRES_PASSWORD");
  const fenceStartedAt = requiredEnv("FENCE_STARTED_AT");
  const { digest, ids } = parseTargetCsv(await readFile(TARGET_PATH));
  const pool = new Pool({ connectionString: deletionDatabaseUrl.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await beginDiagnosticTransaction(client);
    const setupRecords = [];
    const setupClient = tracingClient(client, setupRecords, {
      phase: "setup",
      role: () => "brain",
      capturePlan: () => undefined,
    });
    const selected = await selectRehearsalTenant(setupClient, ids);
    const liveTables = await assertRegistryCoverage(setupClient);
    const expectedRows = await captureTenantCounts(setupClient, liveTables, selected.tenantId);
    const context = {
      tenantId: selected.tenantId,
      proposalCount: selected.proposalCount,
      liveTables,
      expectedRows,
      fenceStartedAt,
    };
    emit("commercial_demo_retirement_timed_rehearsal_started", {
      candidate_list_sha256: digest,
      target_count: ids.length,
      tenant_id: context.tenantId,
      proposal_count: context.proposalCount,
      statement_timeout: DIAGNOSTIC_STATEMENT_TIMEOUT,
      lock_timeout: DIAGNOSTIC_LOCK_TIMEOUT,
      rollback_only: true,
    });
    const firstPass = await runRehearsalStatements(client, context);
    await client.query("ROLLBACK");

    const timedRecords = [...setupRecords, ...firstPass.records];
    const slowRecords = timedRecords
      .filter((record) => record.duration_ms > SLOW_STATEMENT_MS)
      .sort((left, right) => right.duration_ms - left.duration_ms);
    const slowest = [...firstPass.records]
      .filter((record) => explainable(record.sql))
      .sort((left, right) => right.duration_ms - left.duration_ms)[0];
    if (!slowest) throw new Error("no explainable rehearsal statement was captured");
    emit("commercial_demo_retirement_slow_statements", {
      threshold_ms: SLOW_STATEMENT_MS,
      statements: slowRecords.map(reportRecord),
    });
    emit("commercial_demo_retirement_slowest_statement", {
      ...reportRecord(slowest),
    });

    let capturedPlan = null;
    await beginDiagnosticTransaction(client);
    try {
      await runRehearsalStatements(client, context, {
        explainOrdinal: slowest.ordinal,
        capturePlan: (plan) => {
          capturedPlan = plan;
        },
      });
      throw new Error("EXPLAIN replay completed without capturing the target statement");
    } catch (error) {
      if (!(error instanceof ExplainCaptured)) throw error;
    } finally {
      await client.query("ROLLBACK");
    }
    if (!capturedPlan) throw new Error("slowest statement EXPLAIN plan was not captured");
    const nodes = summarizeNode(capturedPlan.Plan);
    emit("commercial_demo_retirement_slowest_statement_plan", {
      statement: reportRecord(slowest),
      planning_time_ms: capturedPlan["Planning Time"],
      execution_time_ms: capturedPlan["Execution Time"],
      triggers: capturedPlan.Triggers ?? [],
      sequential_scans: nodes.filter((node) => node.node_type === "Seq Scan"),
      nodes,
      full_plan: capturedPlan,
    });

    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL ROLE brain_tenant_deletion");
    await tenantFilterIndexReport(client);
    await client.query("ROLLBACK");
    emit("commercial_demo_retirement_timed_rehearsal_complete", {
      tenant_id: context.tenantId,
      total_rows_deleted: firstPass.result.totalRowsDeleted,
      statement_count: firstPass.records.length,
      slow_statement_count: slowRecords.length,
      rollback_only: true,
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  emit("commercial_demo_retirement_timed_rehearsal_aborted", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
