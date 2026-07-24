import type { Pool } from "pg";
import { runInterpretCycle, UPLOAD_DOCUMENT_SCHEMA, type RawDeps } from "@brain/raw";
import {
  runLedgerAccountTransactionProjectionCycle,
  runLedgerAparProjectionCycle,
  runNormalizeCycle,
} from "@brain/ledger";
import { runProjectionCycle, type LedgerUploadProjectedEvent } from "@brain/canonical";
import type { AuditEmitter, BlobAdapter, MetricsEmitter } from "@brain/shared";
import type { WikiPageService } from "@brain/wiki";
import { regenerateWikiForUploadProjection } from "../wiki/regeneration-worker.js";

interface UploadProjectionAgentTrigger {
  handle(event: LedgerUploadProjectedEvent): Promise<void>;
}

interface PipelineLog {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

export interface UploadIngestPipelineDeps {
  rawWorkerPool: Pool;
  appPool: Pool;
  canonicalProjectorPool: Pool;
  ledgerProjectorPool: Pool;
  tenantDiscoveryPool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
  pageService: WikiPageService;
  uploadProjectionAgentTrigger: UploadProjectionAgentTrigger;
  metrics?: MetricsEmitter;
  log?: PipelineLog;
}

export function createUploadIngestPipelineDrain(
  deps: UploadIngestPipelineDeps,
): NonNullable<RawDeps["afterIngest"]> {
  return async ({ input, result }) => {
    if (result.sourceSchema !== UPLOAD_DOCUMENT_SCHEMA) {
      if (isUploadSourceType(result.sourceType)) {
        deps.log?.warn(
          {
            tenant_id: input.tenantId,
            raw_id: result.rawId,
            source_type: result.sourceType,
            source_schema: result.sourceSchema,
          },
          "upload artifact missing registered document source_schema; skipping immediate projection drain",
        );
      }
      return;
    }

    try {
      await runInterpretCycle(
        {
          pool: deps.rawWorkerPool,
          blob: deps.blob,
          audit: deps.audit,
          ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
        },
        { batchSize: 20 },
      );
      await runNormalizeCycle(
        {
          pool: deps.appPool,
          audit: deps.audit,
          ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
        },
        { batchSize: 20 },
      );
      await runProjectionCycle(
        {
          pool: deps.canonicalProjectorPool,
          audit: deps.audit,
          ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
          ...(deps.log?.debug !== undefined
            ? { log: { debug: deps.log.debug.bind(deps.log) } }
            : {}),
          onUploadProjected: async (event) => {
            await runLedgerAparProjectionCycle({
              pool: deps.ledgerProjectorPool,
              ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
            });
            await runLedgerAccountTransactionProjectionCycle({
              pool: deps.ledgerProjectorPool,
              ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
            });
            await regenerateWikiForUploadProjection(
              {
                tenantDiscoveryPool: deps.tenantDiscoveryPool,
                pageService: deps.pageService,
                audit: deps.audit,
                ...(deps.log !== undefined ? { log: deps.log } : {}),
              },
              event,
            );
            await deps.uploadProjectionAgentTrigger.handle(event);
          },
        },
        { batchSize: 20 },
      );
    } catch (err) {
      deps.log?.error(
        { err, tenant_id: input.tenantId, raw_id: result.rawId },
        "upload post-ingest projection drain failed",
      );
      throw err;
    }
  };
}

function isUploadSourceType(sourceType: string): boolean {
  return sourceType === "pdf_upload" || sourceType === "csv_upload";
}
