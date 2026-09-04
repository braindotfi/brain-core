import type { QueryResult } from "pg";

export const COMMERCIAL_DEMO_ROW_BATCH_SIZE = 10_000;
export const COMMERCIAL_DEMO_TENANT_BATCH_SIZE = 250;

export interface BatchDeleteClient {
  query: (sql: string, values?: unknown[]) => Promise<Pick<QueryResult, "rowCount">>;
}

export interface BatchDeleteProgress {
  event: "tenant_deletion_batch_completed";
  table: string;
  batch: number;
  batchSize: number;
  rowsDeleted: number;
  cumulativeRowsDeleted: number;
  expectedRows: number;
  elapsedMs: number;
}

export interface BatchDeleteOptions {
  table: string;
  column: "owner_id" | "tenant_id" | "brain_tenant_id" | "id";
  expectedRows: number;
  batchSize: number;
  onProgress?: (progress: BatchDeleteProgress) => void;
  /** Test seam for proving failure after one or more statements rolls back. */
  afterBatch?: (progress: BatchDeleteProgress) => Promise<void> | void;
}

export function assertNoProtectedTenantIds(
  tenantIds: ReadonlyArray<string>,
  protectedTenantIds: ReadonlySet<string>,
): void {
  const protectedMatches = tenantIds.filter((tenantId) => protectedTenantIds.has(tenantId));
  if (protectedMatches.length > 0) {
    throw new Error(`candidate-list contains protected tenant id: ${protectedMatches.join(",")}`);
  }
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe batch deletion identifier: ${value}`);
  }
  return value;
}

export function batchDeleteStatement(tableName: string, columnName: string): string {
  const table = assertIdentifier(tableName);
  const column = assertIdentifier(columnName);
  return `WITH deletion_batch AS MATERIALIZED (
    SELECT candidate.tableoid AS target_tableoid,
           candidate.ctid AS target_ctid
      FROM ${table} candidate
      JOIN retirement_targets target ON target.tenant_id = candidate.${column}
     LIMIT $1
  )
  DELETE FROM ${table} doomed
  USING deletion_batch batch
  WHERE doomed.tableoid = batch.target_tableoid
    AND doomed.ctid = batch.target_ctid`;
}

/**
 * Deletes one table in bounded statements while retaining one outer transaction.
 *
 * The materialized tableoid/ctid set is selected by every DELETE statement. It
 * is never retained across statements or computed outside the caller's active
 * transaction. The caller must compare all captured counts and commit only
 * after every table reaches its exact expected count and its final zero probe.
 */
export async function deleteTableInBatches(
  client: BatchDeleteClient,
  options: BatchDeleteOptions,
): Promise<number> {
  if (!Number.isSafeInteger(options.expectedRows) || options.expectedRows < 0) {
    throw new Error(`invalid expected row count for ${options.table}: ${options.expectedRows}`);
  }
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error(`invalid batch size for ${options.table}: ${options.batchSize}`);
  }

  const statement = batchDeleteStatement(options.table, options.column);
  let deleted = 0;
  let batch = 0;
  while (true) {
    const startedAt = Date.now();
    const result = await client.query(statement, [options.batchSize]);
    const rowsDeleted = result.rowCount ?? 0;
    batch += 1;
    deleted += rowsDeleted;
    const progress: BatchDeleteProgress = {
      event: "tenant_deletion_batch_completed",
      table: options.table,
      batch,
      batchSize: options.batchSize,
      rowsDeleted,
      cumulativeRowsDeleted: deleted,
      expectedRows: options.expectedRows,
      elapsedMs: Date.now() - startedAt,
    };
    options.onProgress?.(progress);
    await options.afterBatch?.(progress);

    if (deleted > options.expectedRows) {
      throw new Error(
        `delete count mismatch for ${options.table}: expected ${options.expectedRows}, got at least ${deleted}`,
      );
    }
    if (rowsDeleted === 0) break;
  }

  if (deleted !== options.expectedRows) {
    throw new Error(
      `delete count mismatch for ${options.table}: expected ${options.expectedRows}, got ${deleted}`,
    );
  }
  return deleted;
}
