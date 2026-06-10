/**
 * Source sync worker (ingestion architecture §10) — peer of the Ledger's
 * normalizeWorker, owned by Raw.
 *
 * For every active connection whose adapter implements fetchIncremental, the
 * worker materializes one raw_sync_partitions row per declared object type,
 * then per partition:
 *
 *   1. claim the partition lease (run id)
 *   2. read the committed checkpoint
 *   3. fetchIncremental — ONE bounded batch from the provider
 *   4. durably commit the batch's raw artifacts (blob + row + audit)
 *   5. advance the checkpoint atomically (single UPDATE guarded by the lease)
 *   6. repeat while the provider signals more, bounded per cycle
 *
 * The checkpoint NEVER advances before step 4 completes; a crash between 4
 * and 5 re-pulls the same batch on retry and the envelope idempotency key +
 * content hash absorb the replay. Credentials are resolved narrowly per
 * partition run and never persisted by the worker.
 *
 * The source poll reads raw_sources cross-tenant (same controlled exception
 * as normalizeWorker's raw_parsed poll — BYPASSRLS/superuser in production);
 * all per-partition work runs tenant-scoped via withTenantScope.
 */

import type { Pool } from "pg";
import {
  newSourceSyncJobId,
  startManagedInterval,
  withTenantScope,
  type AuditEmitter,
  type BlobAdapter,
  type ManagedWorker,
} from "@brain/shared";
import { adapterForSourceType } from "../adapters/registry.js";
import type { SourceAdapter, SyncPartitionState } from "../adapters/types.js";
import {
  claimPartition,
  commitCheckpoint,
  ensurePartitions,
  listPartitionsForSource,
  releasePartition,
  type SyncPartitionRow,
} from "../repository/syncPartitions.js";
import { ingestMany } from "../services/ingest.js";
import type { IngestResult } from "../services/ingest.js";

export interface SyncWorkerDeps {
  pool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  /** Decrypt and return the connection's credentials, or null when absent. */
  resolveCredentials(tenantId: string, sourceId: string): Promise<object | null>;
  /** Adapter lookup. Defaults to the source adapter registry; injectable for tests. */
  adapterForType?(sourceType: string): SourceAdapter;
}

export interface SyncWorkerOptions {
  /** Polling interval in milliseconds. Default: 900 000 (15 min). */
  intervalMs?: number;
  /** Max provider batches per partition per cycle. Default: 10. */
  maxBatchesPerPartition?: number;
  /** Max active sources examined per cycle. Default: 100. */
  maxSourcesPerCycle?: number;
  /** Actor id attributed to sync audit events. */
  actor?: string;
}

export type SyncWorker = ManagedWorker;

interface ActiveSourceRow {
  id: string;
  tenant_id: string;
  type: string;
}

/** One full sync cycle over every due source. Exported for tests; startSyncWorker schedules it. */
export async function runSyncCycle(deps: SyncWorkerDeps, opts?: SyncWorkerOptions): Promise<void> {
  const maxBatches = opts?.maxBatchesPerPartition ?? 10;
  const maxSources = opts?.maxSourcesPerCycle ?? 100;
  const actor = opts?.actor ?? "sys_sync_worker";

  async function syncPartition(
    source: ActiveSourceRow,
    adapter: SourceAdapter,
    partition: SyncPartitionRow,
  ): Promise<void> {
    const runId = newSourceSyncJobId();
    const claimed = await withTenantScope(deps.pool, source.tenant_id, (c) =>
      claimPartition(c, partition.id, runId),
    );
    if (claimed === null) return; // another run holds the lease

    try {
      const credentials = await deps.resolveCredentials(source.tenant_id, source.id);
      if (credentials === null) {
        await withTenantScope(deps.pool, source.tenant_id, (c) =>
          releasePartition(c, partition.id, runId, "credentials unavailable"),
        );
        return;
      }

      let committedCheckpoint: unknown = claimed.committed_checkpoint;
      for (let batch = 0; batch < maxBatches; batch++) {
        const state: SyncPartitionState = {
          sourceId: source.id,
          resourceId: claimed.resource_id,
          objectType: claimed.object_type,
          checkpointType: claimed.checkpoint_type,
          committedCheckpoint,
        };
        const result = await adapter.fetchIncremental!({
          tenantId: source.tenant_id,
          credentials: credentials as Record<string, unknown>,
          partition: state,
        });

        // Durably commit raw artifacts FIRST (blob + row + audit each).
        const ingested: IngestResult[] = await ingestMany(
          deps,
          result.artifacts.map((a) => ({
            tenantId: source.tenant_id,
            actor,
            sourceType: adapter.sourceType,
            sourceRef: a.sourceRef,
            body: a.body,
            mimeType: a.mimeType,
            envelope: { ...(a.envelope ?? {}), sourceId: source.id },
          })),
        );

        // THEN advance the checkpoint, atomically, lease-guarded. The lease
        // is released only when this cycle stops pulling this partition.
        const isLastBatch = !result.hasMore || batch === maxBatches - 1;
        const advanced = await withTenantScope(deps.pool, source.tenant_id, (c) =>
          commitCheckpoint(c, partition.id, runId, result.nextCheckpoint, {
            backfillComplete: !result.hasMore,
            releaseLease: isLastBatch,
          }),
        );
        if (!advanced) {
          // Lease lost (stale-lease takeover). Stop without further writes.
          return;
        }
        committedCheckpoint = result.nextCheckpoint;

        // Batch manifest — §1 principle 4 (identifiers and counts only).
        await deps.audit.emit({
          tenantId: source.tenant_id,
          layer: "raw",
          actor,
          action: "raw.sync.batch",
          inputs: {
            source_id: source.id,
            source_type: adapter.sourceType,
            object_type: claimed.object_type,
            run_id: runId,
            has_more: result.hasMore,
          },
          outputs: {
            artifacts: ingested.length,
            deduplicated: ingested.filter((r) => r.deduplicated).length,
            raw_ids: ingested.slice(0, 20).map((r) => r.rawId),
          },
        });

        if (!result.hasMore) break;
      }

      await withTenantScope(deps.pool, source.tenant_id, async (c) => {
        await c.query(
          `UPDATE raw_sources SET last_synced_at = now(), updated_at = now() WHERE id = $1`,
          [source.id],
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[syncWorker] partition ${partition.id} (${source.id}) failed:`, message);
      try {
        await withTenantScope(deps.pool, source.tenant_id, (c) =>
          releasePartition(c, partition.id, runId, message),
        );
      } catch (releaseErr) {
        console.error(`[syncWorker] failed to release partition ${partition.id}:`, releaseErr);
      }
    }
  }

  {
    let sources: ActiveSourceRow[];
    try {
      // Cross-tenant poll — requires BYPASSRLS or superuser in production.
      const result = await deps.pool.query<ActiveSourceRow>(
        `SELECT id, tenant_id, type
           FROM raw_sources
          WHERE status = 'active'
          ORDER BY last_synced_at ASC NULLS FIRST
          LIMIT $1`,
        [maxSources],
      );
      sources = result.rows;
    } catch (err) {
      console.error("[syncWorker] source poll failed:", err);
      return;
    }

    const adapterFor = deps.adapterForType ?? adapterForSourceType;
    for (const source of sources) {
      let adapter: SourceAdapter;
      try {
        adapter = adapterFor(source.type);
      } catch {
        continue; // unknown type — nothing to pull
      }
      if (adapter.fetchIncremental === undefined || adapter.syncObjectTypes === undefined) {
        continue; // push-only or stub source
      }

      try {
        const partitions = await withTenantScope(deps.pool, source.tenant_id, async (c) => {
          await ensurePartitions(c, source.tenant_id, source.id, adapter.syncObjectTypes!);
          return listPartitionsForSource(c, source.id);
        });
        for (const partition of partitions) {
          await syncPartition(source, adapter, partition);
        }
      } catch (err) {
        console.error(`[syncWorker] source ${source.id} failed:`, err);
      }
    }
  }
}

export function startSyncWorker(deps: SyncWorkerDeps, opts?: SyncWorkerOptions): SyncWorker {
  const intervalMs = opts?.intervalMs ?? 900_000;
  return startManagedInterval(() => runSyncCycle(deps, opts), intervalMs, {
    name: "source-sync",
    runImmediately: true,
    onError: (err) => console.error("[syncWorker] cycle failed:", err),
  });
}
