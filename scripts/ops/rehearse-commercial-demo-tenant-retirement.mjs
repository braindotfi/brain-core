#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import pg from "../../services/api/node_modules/pg/lib/index.js";
import { TENANT_SCOPED_TABLES } from "../../services/api/dist/tenant-deletion/service.js";
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
const MAX_REHEARSAL_MS = 30_000;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const databaseUrl = requiredEnv("BRAIN_TENANT_DELETION_DB_URL");
  const { digest, ids } = parseTargetCsv(await readFile(TARGET_PATH));
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  let rolledBack = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '45s'");
    await assertDatabaseRole(client);
    const liveTables = await assertRegistryCoverage(client);
    await assertTenantDeletionPrivilegeContract(
      client,
      TENANT_SCOPED_TABLES.filter(({ table }) => liveTables.has(table)).map(({ table }) => table),
    );
    const candidate = await client.query(
      `SELECT candidate.tenant_id
         FROM unnest($1::text[]) candidate(tenant_id)
         LEFT JOIN proposals proposal ON proposal.tenant_id = candidate.tenant_id
        GROUP BY candidate.tenant_id
        ORDER BY COUNT(proposal.id) DESC, candidate.tenant_id
        LIMIT 1`,
      [ids],
    );
    const tenantId = candidate.rows[0]?.tenant_id;
    if (typeof tenantId !== "string") throw new Error("no rehearsal tenant was selected");
    const expectedRows = await captureTenantCounts(client, liveTables, tenantId);
    const startedAt = Date.now();
    const result = await executeOneTenant(
      client,
      tenantId,
      expectedRows,
      new Date().toISOString(),
      liveTables,
    );
    const elapsedMs = Date.now() - startedAt;
    await client.query("ROLLBACK");
    rolledBack = true;
    if (elapsedMs > MAX_REHEARSAL_MS) {
      throw new Error(
        `one-tenant retirement rehearsal exceeded ${MAX_REHEARSAL_MS}ms: ${elapsedMs}ms`,
      );
    }
    console.log(
      JSON.stringify({
        event: "commercial_demo_retirement_one_tenant_rehearsal_passed",
        candidate_list_sha256: digest,
        tenant_id: tenantId,
        elapsed_ms: elapsedMs,
        max_elapsed_ms: MAX_REHEARSAL_MS,
        total_rows_deleted: result.totalRowsDeleted,
        per_table_deleted: result.deletedRows,
        rollback_only: true,
      }),
    );
  } finally {
    if (!rolledBack) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "commercial_demo_retirement_one_tenant_rehearsal_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
