import type { Pool } from "pg";
import {
  startManagedInterval,
  withTenantScope,
  type ManagedWorker,
  type ServiceCallContext,
} from "@brain/shared";
import type { LedgerUploadProjectedEvent } from "@brain/canonical";
import type { WikiPageService } from "@brain/wiki";

export const DEFAULT_WIKI_REGENERATION_INTERVAL_MS = 15 * 60 * 1000;

const ACTOR = "system:wiki-regeneration-worker";
const DEFAULT_TENANT_BATCH_SIZE = 50;
const DEFAULT_PAGE_BATCH_SIZE = 100;

type WikiPageServicePort = Pick<WikiPageService, "listPages" | "regenerate">;

interface Logger {
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface WikiRegenerationDeps {
  readonly tenantDiscoveryPool: Pool;
  readonly pageService: WikiPageServicePort;
  readonly log?: Logger;
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
  for (const tenantId of tenantIds) {
    const ctx = ctxFor(tenantId);
    const pages = await deps.pageService.listPages(ctx, {
      limit: opts.pageBatchSize ?? DEFAULT_PAGE_BATCH_SIZE,
    });
    for (const page of pages.pages) {
      await regenerateSlug(deps, ctx, page.slug);
    }
  }
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
  for (const slug of slugs) {
    await regenerateSlug(deps, ctx, slug, event);
  }
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
): Promise<void> {
  try {
    await deps.pageService.regenerate(ctx, slug);
  } catch (err) {
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
  }
}

function ctxFor(tenantId: string): ServiceCallContext {
  return { tenantId, actor: ACTOR };
}
