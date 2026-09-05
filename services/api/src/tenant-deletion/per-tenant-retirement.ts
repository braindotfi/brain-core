import type { Pool, PoolClient, QueryResult } from "pg";

export const COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID = "commercial-demo-retirement-2026-09-03";
export const COMMERCIAL_DEMO_TENANT_TIMEOUT_MS = 30_000;

export interface PerTenantRetirementClient {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) => Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
}

export interface TenantReconciliationTable {
  table: string;
  column: "id" | "owner_id" | "tenant_id" | "brain_tenant_id";
}

export interface RetirementProgressSeed {
  tenantId: string;
  ordinal: number;
  expectedRows: Record<string, number>;
}

export interface RetirementTenantResult {
  deletedRows: Record<string, number>;
  totalRowsDeleted: number;
  blobPurgeJobId: string | null;
  blobArtifactCount: number;
}

export interface RetirementAttemptResult {
  tenantId: string;
  status: "completed" | "failed" | "skipped";
  elapsedMs: number;
  error?: string;
  result?: RetirementTenantResult;
}

export interface RetirementProgressRow extends Record<string, unknown> {
  tenant_id: string;
  ordinal: number;
  status: "pending" | "running" | "completed" | "failed";
  candidate_list_sha256: string;
  expected_rows: Record<string, number>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedRowCounts(counts: Record<string, number>): string {
  return JSON.stringify(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid tenant reconciliation identifier: ${value}`);
  }
  return value;
}

export function tenantReconciliationCountStatement(
  tableName: string,
  columnName: TenantReconciliationTable["column"],
): string {
  const table = assertIdentifier(tableName);
  const column = assertIdentifier(columnName);
  return `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE ${column} = $1`;
}

export async function captureTenantReconciliationCounts(
  client: PerTenantRetirementClient,
  tables: readonly TenantReconciliationTable[],
  tenantId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table, column } of tables) {
    const result = await client.query<{ count: string }>(
      tenantReconciliationCountStatement(table, column),
      [tenantId],
    );
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

export async function assertTenantReconciliationEmpty(
  client: PerTenantRetirementClient,
  tables: readonly TenantReconciliationTable[],
  tenantId: string,
): Promise<Record<string, number>> {
  const counts = await captureTenantReconciliationCounts(client, tables, tenantId);
  const remaining = Object.entries(counts).filter(([, count]) => count !== 0);
  if (remaining.length > 0) {
    throw new Error(`tenant rows remain after delete: ${JSON.stringify(remaining)}`);
  }
  return counts;
}

export async function initializeRetirementProgress(
  client: PerTenantRetirementClient,
  candidateListSha256: string,
  seeds: readonly RetirementProgressSeed[],
): Promise<void> {
  await client.query(
    `INSERT INTO commercial_demo_retirement_progress
       (operation_id, tenant_id, candidate_list_sha256, ordinal, expected_rows)
     SELECT $1,
            seed.tenant_id,
            $2,
            seed.ordinal,
            seed.expected_rows
       FROM jsonb_to_recordset($3::jsonb)
         AS seed(tenant_id text, ordinal integer, expected_rows jsonb)
     ON CONFLICT (operation_id, tenant_id) DO NOTHING`,
    [
      COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
      candidateListSha256,
      JSON.stringify(
        seeds.map(({ tenantId, ordinal, expectedRows }) => ({
          tenant_id: tenantId,
          ordinal,
          expected_rows: expectedRows,
        })),
      ),
    ],
  );

  const stored = await client.query<{
    tenant_id: string;
    candidate_list_sha256: string;
    ordinal: number;
    expected_rows: Record<string, number>;
  }>(
    `SELECT tenant_id, candidate_list_sha256, ordinal, expected_rows
       FROM commercial_demo_retirement_progress
      WHERE operation_id = $1
      ORDER BY ordinal`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  const expected = seeds.map(({ tenantId, ordinal, expectedRows }) => ({
    tenant_id: tenantId,
    candidate_list_sha256: candidateListSha256,
    ordinal,
    expected_rows: expectedRows,
  }));
  const mismatch =
    stored.rows.length !== expected.length ||
    stored.rows.some((row, index) => {
      const wanted = expected[index];
      return (
        wanted === undefined ||
        row.tenant_id !== wanted.tenant_id ||
        row.candidate_list_sha256 !== wanted.candidate_list_sha256 ||
        row.ordinal !== wanted.ordinal ||
        normalizedRowCounts(row.expected_rows) !== normalizedRowCounts(wanted.expected_rows)
      );
    });
  if (mismatch) {
    throw new Error("durable retirement progress does not match the approved candidate set");
  }
}

export async function listRetirementProgress(
  client: PerTenantRetirementClient,
): Promise<RetirementProgressRow[]> {
  const result = await client.query<RetirementProgressRow>(
    `SELECT tenant_id, ordinal, status, candidate_list_sha256, expected_rows
       FROM commercial_demo_retirement_progress
      WHERE operation_id = $1
      ORDER BY ordinal`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  return result.rows;
}

async function recordFailure(pool: Pool, tenantId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE commercial_demo_retirement_progress
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            last_attempt_at = now(),
            last_error = $3,
            updated_at = now()
      WHERE operation_id = $1
        AND tenant_id = $2
        AND status <> 'completed'`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID, tenantId, message.slice(0, 4000)],
  );
}

export async function runRetirementTenantAttempt(
  pool: Pool,
  tenantId: string,
  execute: (
    client: PoolClient,
    expectedRows: Record<string, number>,
  ) => Promise<RetirementTenantResult>,
  options: { maxDurationMs?: number } = {},
): Promise<RetirementAttemptResult> {
  const startedAt = Date.now();
  const maxDurationMs = options.maxDurationMs ?? COMMERCIAL_DEMO_TENANT_TIMEOUT_MS;
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '45s'");
    const progress = await client.query<RetirementProgressRow>(
      `SELECT tenant_id, ordinal, status, candidate_list_sha256, expected_rows
         FROM commercial_demo_retirement_progress
        WHERE operation_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID, tenantId],
    );
    const row = progress.rows[0];
    if (row === undefined) throw new Error(`retirement progress is absent for ${tenantId}`);
    if (row.status === "completed") {
      await client.query("ROLLBACK");
      return { tenantId, status: "skipped", elapsedMs: Date.now() - startedAt };
    }
    await client.query(
      `UPDATE commercial_demo_retirement_progress
          SET status = 'running',
              attempt_count = attempt_count + 1,
              first_started_at = COALESCE(first_started_at, now()),
              last_attempt_at = now(),
              last_error = NULL,
              updated_at = now()
        WHERE operation_id = $1 AND tenant_id = $2`,
      [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID, tenantId],
    );
    const result = await execute(client, row.expected_rows);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > maxDurationMs) {
      throw new Error(`tenant retirement exceeded ${maxDurationMs}ms: ${elapsedMs}ms`);
    }
    await client.query(
      `UPDATE commercial_demo_retirement_progress
          SET status = 'completed',
              deleted_rows = $3::jsonb,
              total_rows_deleted = $4,
              blob_purge_job_id = $5,
              blob_artifact_count = $6,
              committed_at = now(),
              last_error = NULL,
              updated_at = now()
        WHERE operation_id = $1 AND tenant_id = $2`,
      [
        COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
        tenantId,
        JSON.stringify(result.deletedRows),
        result.totalRowsDeleted,
        result.blobPurgeJobId,
        result.blobArtifactCount,
      ],
    );
    await client.query("COMMIT");
    return { tenantId, status: "completed", elapsedMs, result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = errorMessage(error);
    await recordFailure(pool, tenantId, message);
    return { tenantId, status: "failed", elapsedMs: Date.now() - startedAt, error: message };
  } finally {
    client.release();
  }
}
