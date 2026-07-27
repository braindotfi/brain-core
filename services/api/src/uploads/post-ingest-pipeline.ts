import type { Pool } from "pg";
import { runInterpretCycle, UPLOAD_DOCUMENT_SCHEMA, type RawDeps } from "@brain/raw";
import {
  rebuildAccountTransactionProjectionFromCanonical,
  rebuildAparProjectionFromCanonical,
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
  info?(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

const UPLOAD_PROJECTION_STEP_TIMEOUT_MS = 30_000;
const UPLOAD_PROJECTION_WIKI_SETTLE_DELAY_MS = 250;

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
  wikiSettleDelayMs?: number;
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
          ...(deps.log !== undefined
            ? {
                log: {
                  debug: deps.log.debug?.bind(deps.log) ?? ((): void => {}),
                  warn: deps.log.warn.bind(deps.log),
                },
              }
            : {}),
          onUploadProjected: async (event) => {
            await runUploadProjectionSideEffects(deps, event);
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

export async function runUploadProjectionSideEffects(
  deps: Pick<
    UploadIngestPipelineDeps,
    | "ledgerProjectorPool"
    | "audit"
    | "tenantDiscoveryPool"
    | "pageService"
    | "uploadProjectionAgentTrigger"
    | "wikiSettleDelayMs"
    | "log"
  >,
  event: LedgerUploadProjectedEvent,
  timeoutMs = UPLOAD_PROJECTION_STEP_TIMEOUT_MS,
): Promise<void> {
  await runUploadProjectionStep(deps.log, event, "ledger_apar_rebuild", timeoutMs, () =>
    rebuildAparProjectionFromCanonical(deps.ledgerProjectorPool, deps.audit, {
      tenantId: event.tenantId,
      actor: "sys_upload_projection",
    }),
  );
  await runUploadProjectionStep(
    deps.log,
    event,
    "ledger_account_transaction_rebuild",
    timeoutMs,
    () =>
      rebuildAccountTransactionProjectionFromCanonical(deps.ledgerProjectorPool, event.tenantId),
  );
  const wikiSettleDelayMs = deps.wikiSettleDelayMs ?? UPLOAD_PROJECTION_WIKI_SETTLE_DELAY_MS;
  if (wikiSettleDelayMs > 0) {
    await runUploadProjectionStep(deps.log, event, "wiki_visibility_settle", timeoutMs, () =>
      delay(wikiSettleDelayMs),
    );
  }
  await runUploadProjectionStep(deps.log, event, "wiki_regeneration", timeoutMs, () =>
    regenerateWikiForUploadProjection(
      {
        tenantDiscoveryPool: deps.tenantDiscoveryPool,
        pageService: deps.pageService,
        audit: deps.audit,
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      },
      event,
    ),
  );
  await runUploadProjectionStep(deps.log, event, "agent_trigger", timeoutMs, () =>
    deps.uploadProjectionAgentTrigger.handle(event),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runUploadProjectionStep<T>(
  log: PipelineLog | undefined,
  event: LedgerUploadProjectedEvent,
  step: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const fields = {
    step,
    tenant_id: event.tenantId,
    raw_artifact_id: event.rawArtifactId,
    raw_parsed_id: event.rawParsedId,
    projector: event.projector,
    timeout_ms: timeoutMs,
  };
  log?.info?.(fields, "upload projection side effect starting");
  try {
    const result = await withTimeout(fn(), timeoutMs, step);
    log?.info?.(
      {
        ...fields,
        duration_ms: Date.now() - startedAt,
      },
      "upload projection side effect completed",
    );
    return result;
  } catch (err) {
    log?.warn(
      {
        ...fields,
        duration_ms: Date.now() - startedAt,
        err,
      },
      err instanceof UploadProjectionStepTimeoutError
        ? "upload projection side effect timed out"
        : "upload projection side effect failed",
    );
    throw err;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new UploadProjectionStepTimeoutError(step, timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

class UploadProjectionStepTimeoutError extends Error {
  public constructor(
    public readonly step: string,
    public readonly timeoutMs: number,
  ) {
    super(`upload projection side effect timed out: ${step} after ${timeoutMs}ms`);
    this.name = "UploadProjectionStepTimeoutError";
  }
}

function isUploadSourceType(sourceType: string): boolean {
  return sourceType === "pdf_upload" || sourceType === "csv_upload";
}
