/**
 * raw_sync_partitions repository (ingestion architecture §10).
 *
 * Tenant-scoped via withTenantScope like every raw repository. The lease
 * protocol keeps two workers off the same partition:
 *
 *   claim    — set pending_run_id where free (or the lease is stale)
 *   commit   — advance committed_checkpoint ONLY where pending_run_id still
 *              matches the claiming run, releasing the lease in the same
 *              UPDATE (atomic checkpoint advance)
 *   release  — give the lease back without advancing (failure path)
 */

import { newSourceSyncPartitionId, type TenantScopedClient } from "@brain/shared";
import type { SyncCheckpointType, SyncObjectTypeSpec } from "../adapters/types.js";

export interface SyncPartitionRow {
  id: string;
  tenant_id: string;
  source_id: string;
  resource_id: string;
  object_type: string;
  checkpoint_type: SyncCheckpointType;
  committed_checkpoint: unknown;
  pending_run_id: string | null;
  last_successful_sync_at: Date | null;
  backfill_status: "not_started" | "running" | "complete" | "failed";
  error_message: string | null;
}

/** Lease older than this is considered abandoned and may be re-claimed. */
const STALE_LEASE_MINUTES = 15;

/** Materialize one partition row per declared object type. Idempotent. */
export async function ensurePartitions(
  client: TenantScopedClient,
  tenantId: string,
  sourceId: string,
  specs: ReadonlyArray<SyncObjectTypeSpec>,
  resourceId = "",
): Promise<void> {
  for (const spec of specs) {
    await client.query(
      `INSERT INTO raw_sync_partitions
         (id, tenant_id, source_id, resource_id, object_type, checkpoint_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, source_id, resource_id, object_type) DO NOTHING`,
      [
        newSourceSyncPartitionId(),
        tenantId,
        sourceId,
        resourceId,
        spec.objectType,
        spec.checkpointType,
      ],
    );
  }
}

export async function listPartitionsForSource(
  client: TenantScopedClient,
  sourceId: string,
): Promise<SyncPartitionRow[]> {
  const { rows } = await client.query<SyncPartitionRow>(
    `SELECT * FROM raw_sync_partitions WHERE source_id = $1 ORDER BY object_type, resource_id`,
    [sourceId],
  );
  return rows;
}

/** Claim the partition for `runId`. Returns the claimed row, or null if held. */
export async function claimPartition(
  client: TenantScopedClient,
  partitionId: string,
  runId: string,
): Promise<SyncPartitionRow | null> {
  const { rows } = await client.query<SyncPartitionRow>(
    `UPDATE raw_sync_partitions
        SET pending_run_id = $2,
            backfill_status = CASE WHEN backfill_status = 'not_started' THEN 'running'
                                   ELSE backfill_status END,
            updated_at = now()
      WHERE id = $1
        AND (pending_run_id IS NULL
             OR updated_at < now() - make_interval(mins => $3))
      RETURNING *`,
    [partitionId, runId, STALE_LEASE_MINUTES],
  );
  return rows[0] ?? null;
}

/**
 * Atomically advance the checkpoint and release the lease — single UPDATE,
 * guarded by the run lease, executed only AFTER the batch's artifacts are
 * durably committed by the caller.
 */
export async function commitCheckpoint(
  client: TenantScopedClient,
  partitionId: string,
  runId: string,
  checkpoint: unknown,
  opts: { backfillComplete: boolean; releaseLease: boolean },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE raw_sync_partitions
        SET committed_checkpoint = $3::jsonb,
            pending_run_id = CASE WHEN $4 THEN NULL ELSE pending_run_id END,
            last_successful_sync_at = now(),
            backfill_status = CASE WHEN $5 THEN 'complete' ELSE backfill_status END,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1 AND pending_run_id = $2`,
    [
      partitionId,
      runId,
      JSON.stringify(checkpoint ?? null),
      opts.releaseLease,
      opts.backfillComplete,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Release the lease WITHOUT advancing the checkpoint (failure path). */
export async function releasePartition(
  client: TenantScopedClient,
  partitionId: string,
  runId: string,
  errorMessage: string | null,
): Promise<void> {
  await client.query(
    `UPDATE raw_sync_partitions
        SET pending_run_id = NULL,
            error_message = $3,
            backfill_status = CASE WHEN backfill_status = 'running' AND $3 IS NOT NULL
                                   THEN 'failed' ELSE backfill_status END,
            updated_at = now()
      WHERE id = $1 AND pending_run_id = $2`,
    [partitionId, runId, errorMessage],
  );
}
