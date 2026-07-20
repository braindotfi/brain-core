import type { Pool } from "pg";
import {
  startManagedInterval,
  withTenantScope,
  type BlobAdapter,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import {
  claimTenantExportJob,
  findTenantExportJob,
  markTenantExportJobPurged,
  type TenantExportJobRow,
} from "./repository.js";
import type { TenantExportService } from "./service.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 5;
const WORKER_ACTOR = "tenant_export_worker";

export interface TenantExportWorkerDeps {
  scanPool: Pool;
  appPool: Pool;
  blob: BlobAdapter;
  service: TenantExportService;
  metrics?: MetricsEmitter;
  log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface TenantExportWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  purgeBatchSize?: number;
  workerId?: string;
  now?: () => Date;
}

interface PendingExportJobRow {
  id: string;
  tenant_id: string;
}

interface ExpiredExportJobRow {
  id: string;
  tenant_id: string;
  output_blob_uri: string;
}

export interface TenantExportCycleResult {
  claimed: number;
  succeeded: number;
  failed: number;
  purged: number;
}

export async function runTenantExportCycle(
  deps: TenantExportWorkerDeps,
  opts: TenantExportWorkerOptions = {},
): Promise<TenantExportCycleResult> {
  const workerId = opts.workerId ?? WORKER_ACTOR;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: TenantExportCycleResult = { claimed: 0, succeeded: 0, failed: 0, purged: 0 };

  const expired = await deps.scanPool.query<ExpiredExportJobRow>(
    `SELECT id, tenant_id, output_blob_uri
       FROM tenant_export_jobs
      WHERE status = 'succeeded'
        AND output_blob_uri IS NOT NULL
        AND purged_at IS NULL
        AND expires_at <= now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [opts.purgeBatchSize ?? batchSize],
  );
  for (const row of expired.rows) {
    try {
      await deps.blob.purgeObject(row.output_blob_uri);
      await withTenantScope(deps.appPool, row.tenant_id, (client) =>
        markTenantExportJobPurged(client, row.id),
      );
      result.purged += 1;
      deps.metrics?.increment("brain.tenant_export.purged.count");
    } catch (err) {
      deps.log?.error({ err, job_id: row.id }, "tenant export purge failed");
    }
  }

  const pending = await deps.scanPool.query<PendingExportJobRow>(
    `SELECT id, tenant_id
       FROM tenant_export_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT $1`,
    [batchSize],
  );

  for (const row of pending.rows) {
    const claimed = await withTenantScope(deps.appPool, row.tenant_id, (client) =>
      claimTenantExportJob(client, row.id, workerId),
    );
    if (claimed === null) continue;
    result.claimed += 1;
    try {
      await deps.service.assembleExport(ctxFor(row.tenant_id, workerId), claimed);
      result.succeeded += 1;
      deps.metrics?.increment("brain.tenant_export.succeeded.count");
    } catch (err) {
      deps.log?.error({ err, job_id: row.id, tenant_id: row.tenant_id }, "tenant export failed");
      await deps.service.markFailed(row.tenant_id, row.id, err);
      result.failed += 1;
      deps.metrics?.increment("brain.tenant_export.failed.count");
    }
  }

  return result;
}

export function startTenantExportWorker(
  deps: TenantExportWorkerDeps,
  opts: TenantExportWorkerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    async () => {
      await runTenantExportCycle(deps, opts);
    },
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "tenant-export",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "tenant export worker failed"),
    },
  );
}

export async function loadTenantExportJobForWorker(
  pool: Pool,
  tenantId: string,
  jobId: string,
): Promise<TenantExportJobRow | null> {
  return withTenantScope(pool, tenantId, (client) => findTenantExportJob(client, jobId));
}

function ctxFor(tenantId: string, actor: string): ServiceCallContext {
  return {
    tenantId,
    actor,
    principalType: "agent",
    scopes: ["audit:read", "execution:read", "ledger:read", "raw:read"],
  };
}
