import type { Pool } from "pg";
import {
  isBrainError,
  startManagedInterval,
  withTenantScope,
  type AuditEmitter,
  type BrainError,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { LedgerUploadProjectedEvent } from "@brain/canonical";
import type { WikiPageService } from "@brain/wiki";

export const DEFAULT_WIKI_REGENERATION_INTERVAL_MS = 15 * 60 * 1000;

const ACTOR = "system:wiki-regeneration-worker";
const DEFAULT_TENANT_BATCH_SIZE = 50;
const DEFAULT_PAGE_BATCH_SIZE = 100;

type WikiPageServicePort = Pick<WikiPageService, "listPages" | "regenerate" | "deletePage">;

/**
 * Outcome of one slug. `pruned` is deliberately not `failed`: the page was a
 * projection of a Ledger row that no longer exists, so removing it is the
 * projection converging, not an error an operator needs to act on.
 */
type SlugOutcome = "regenerated" | "pruned" | "failed";

interface Logger {
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface WikiRegenerationDeps {
  readonly tenantDiscoveryPool: Pool;
  readonly pageService: WikiPageServicePort;
  readonly audit?: AuditEmitter;
  readonly log?: Logger;
  readonly metrics?: MetricsEmitter;
}

export interface WikiRegenerationOptions {
  readonly intervalMs?: number;
  readonly tenantBatchSize?: number;
  readonly pageBatchSize?: number;
}

interface TenantRow {
  readonly tenant_id: string;
}

interface SlugRow {
  readonly slug: string;
}

export function startWikiRegenerationWorker(
  deps: WikiRegenerationDeps,
  opts: WikiRegenerationOptions = {},
): ManagedWorker {
  const intervalMs = opts.intervalMs ?? DEFAULT_WIKI_REGENERATION_INTERVAL_MS;
  deps.log?.info?.({ intervalMs }, "wiki regeneration worker started");
  return startManagedInterval(() => runWikiRegenerationCycle(deps, opts), intervalMs, {
    name: "wiki-regeneration-worker",
    runImmediately: false,
    onError: (err) => deps.log?.error({ err }, "wiki regeneration worker failed"),
  });
}

export async function runWikiRegenerationCycle(
  deps: WikiRegenerationDeps,
  opts: WikiRegenerationOptions = {},
): Promise<void> {
  const tenantIds = await listTenantsWithWikiPages(
    deps.tenantDiscoveryPool,
    opts.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE,
  );
  const totals: Record<SlugOutcome, number> = { regenerated: 0, pruned: 0, failed: 0 };
  let pageCount = 0;
  for (const tenantId of tenantIds) {
    const ctx = ctxFor(tenantId);
    const pages = await deps.pageService.listPages(ctx, {
      limit: opts.pageBatchSize ?? DEFAULT_PAGE_BATCH_SIZE,
    });
    pageCount += pages.pages.length;
    for (const page of pages.pages) {
      totals[await regenerateSlug(deps, ctx, page.slug)] += 1;
    }
  }
  // One bounded line per cycle. Per-page detail stays on the prune and failure
  // paths so a healthy cycle costs a single log entry.
  deps.log?.info?.(
    { tenants: tenantIds.length, pages: pageCount, ...totals },
    "wiki regeneration cycle complete",
  );
}

export async function regenerateWikiForUploadProjection(
  deps: WikiRegenerationDeps,
  event: LedgerUploadProjectedEvent,
  opts: Pick<WikiRegenerationOptions, "pageBatchSize"> = {},
): Promise<void> {
  const slugs = await listUploadProjectionSlugs(
    deps.tenantDiscoveryPool,
    event,
    opts.pageBatchSize ?? DEFAULT_PAGE_BATCH_SIZE,
  );
  const ctx = ctxFor(event.tenantId);
  let regeneratedCount = 0;
  for (const slug of slugs) {
    if ((await regenerateSlug(deps, ctx, slug, event)) === "regenerated") regeneratedCount += 1;
  }
  if (regeneratedCount === 0) {
    deps.log?.warn?.(
      {
        tenantId: event.tenantId,
        rawArtifactId: event.rawArtifactId,
        rawParsedId: event.rawParsedId,
        projector: event.projector,
        projectionSummary: event.summary,
        pageCandidates: slugs.length,
      },
      "upload-triggered wiki regeneration produced zero pages",
    );
  }
  await deps.audit?.emit({
    tenantId: event.tenantId,
    layer: "wiki",
    eventType: "system_activity",
    severity: "info",
    actor: ACTOR,
    action: "wiki.pages.regenerated",
    inputs: {
      trigger: event.event,
      raw_artifact_id: event.rawArtifactId,
      raw_parsed_id: event.rawParsedId,
      projector: event.projector,
      projection_summary: event.summary,
    },
    outputs: {
      pages_regenerated: regeneratedCount,
      page_candidates: slugs.length,
      slugs,
    },
  });
}

async function listTenantsWithWikiPages(pool: Pool, limit: number): Promise<string[]> {
  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id
       FROM wiki_pages
      GROUP BY tenant_id
      ORDER BY max(rendered_at) ASC, tenant_id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.tenant_id);
}

async function listUploadProjectionSlugs(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
  limit: number,
): Promise<string[]> {
  return withTenantScope(pool, event.tenantId, async (client) => {
    const { rows } = await client.query<SlugRow>(
      `WITH tx AS (
         SELECT id, counterparty_id, transaction_date
           FROM ledger_transactions
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND $1 = ANY(source_ids)
       ),
       obls AS (
         SELECT id, counterparty_id, due_date
           FROM ledger_obligations
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND $1 = ANY(source_ids)
       ),
       invs AS (
         SELECT id, counterparty_id, COALESCE(due_date, issue_date) AS relevant_date
           FROM ledger_invoices
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND $1 = ANY(source_ids)
       ),
       months AS (
         SELECT to_char(transaction_date, 'YYYY-MM') AS month, true AS has_transactions FROM tx
         UNION ALL
         SELECT to_char(due_date, 'YYYY-MM') AS month, false AS has_transactions FROM obls
         UNION ALL
         SELECT to_char(relevant_date, 'YYYY-MM') AS month, false AS has_transactions FROM invs
       ),
       counterparties AS (
         SELECT counterparty_id FROM tx WHERE counterparty_id IS NOT NULL
         UNION
         SELECT counterparty_id FROM obls WHERE counterparty_id IS NOT NULL
         UNION
         SELECT counterparty_id FROM invs WHERE counterparty_id IS NOT NULL
       )
       SELECT DISTINCT slug
         FROM (
           SELECT '/cash-flow/' || month AS slug
             FROM months
            WHERE has_transactions
           UNION ALL
           SELECT '/monthly-summaries/' || month AS slug
             FROM months
           UNION ALL
           SELECT '/obligations/' || id AS slug
             FROM obls
           UNION ALL
           SELECT '/invoices/' || id AS slug
             FROM invs
           UNION ALL
           SELECT '/counterparties/' || counterparty_id AS slug
             FROM counterparties
         ) s
        WHERE slug IS NOT NULL
        ORDER BY slug
        LIMIT $2`,
      [event.rawArtifactId, limit],
    );
    return rows.map((row) => row.slug);
  });
}

async function regenerateSlug(
  deps: WikiRegenerationDeps,
  ctx: ServiceCallContext,
  slug: string,
  event?: LedgerUploadProjectedEvent,
): Promise<SlugOutcome> {
  try {
    await deps.pageService.regenerate(ctx, slug);
    return "regenerated";
  } catch (err) {
    // Only a missing subject prunes. Any other failure (an embedding outage, a
    // DB blip) must leave the page alone and stay a warning, so a transient
    // fault can never delete memory.
    if (isBrainError(err) && err.code === "wiki_subject_not_found") {
      return prunePage(deps, ctx, slug, pageTypeOf(err));
    }
    deps.log?.warn?.(
      {
        err,
        tenantId: ctx.tenantId,
        slug,
        rawArtifactId: event?.rawArtifactId,
        rawParsedId: event?.rawParsedId,
      },
      "wiki page regeneration failed",
    );
    // Tagged by error code, not slug or tenant: those are unbounded cardinality.
    deps.metrics?.increment("brain.wiki.regeneration.failed.count", {
      reason: isBrainError(err) ? err.code : "unknown",
    });
    return "failed";
  }
}

async function prunePage(
  deps: WikiRegenerationDeps,
  ctx: ServiceCallContext,
  slug: string,
  pageType: string,
): Promise<SlugOutcome> {
  try {
    const deleted = await deps.pageService.deletePage(ctx, slug);
    // Bounded by construction: a page prunes at most once, so this is not a
    // stream the way the retried warning was.
    deps.log?.info?.({ tenantId: ctx.tenantId, slug, pageType, deleted }, "wiki page pruned");
    deps.metrics?.increment("brain.wiki.regeneration.page_pruned.count", { page_type: pageType });
    if (deleted) {
      await deps.audit?.emit({
        tenantId: ctx.tenantId,
        layer: "wiki",
        eventType: "system_activity",
        severity: "info",
        actor: ACTOR,
        action: "wiki.page.pruned",
        inputs: { slug, page_type: pageType },
        outputs: { reason: "subject_not_found" },
      });
    }
    return "pruned";
  } catch (err) {
    deps.log?.warn?.({ err, tenantId: ctx.tenantId, slug }, "wiki page prune failed");
    deps.metrics?.increment("brain.wiki.regeneration.failed.count", { reason: "prune_failed" });
    return "failed";
  }
}

function pageTypeOf(err: BrainError): string {
  const pageType = err.details?.["page_type"];
  return typeof pageType === "string" ? pageType : "unknown";
}

function ctxFor(tenantId: string): ServiceCallContext {
  return { tenantId, actor: ACTOR };
}
