/**
 * WikiPageService — implements the page-rendering side of
 * IWikiMemoryService for /memory/* endpoints.
 *
 * Phase 5 ships:
 *   - listPages         — read from wiki_pages
 *   - getPage           — read by slug or id
 *   - regenerate        — render via the appropriate generator + upsert
 *
 * Phase 5 does NOT add embeddings to pages; /memory/search is a lexical
 * fallback for now. Embedding population is a follow-up that pairs with
 * a chosen embedding policy (per-page, per-section, etc.).
 */

import {
  brainError,
  newWikiPageId,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
  type WikiPage,
} from "@brain/api/shared";
import type { Pool } from "pg";
import { AccountPageGenerator } from "./account.js";
import { CounterpartyPageGenerator } from "./counterparty.js";
import { ObligationPageGenerator } from "./obligation.js";
import { MonthlySummaryPageGenerator } from "./monthly-summary.js";
import { InvoicePageGenerator } from "./invoice.js";
import { AgentPageGenerator } from "./agent.js";
import { PolicyPageGenerator } from "./policy.js";
import { CashFlowPageGenerator } from "./cash-flow.js";
import type { PageGenerator } from "./types.js";

export interface WikiPageServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
}

interface PageRow {
  id: string;
  page_type: string;
  subject_id: string | null;
  slug: string;
  body_md: string;
  rendered_at: Date;
  source_revision: string;
}

export class WikiPageService {
  private readonly generators: PageGenerator[];

  public constructor(private readonly deps: WikiPageServiceDeps) {
    this.generators = [
      new AccountPageGenerator(),
      new CounterpartyPageGenerator(),
      new ObligationPageGenerator(),
      new MonthlySummaryPageGenerator(),
      new InvoicePageGenerator(),
      new AgentPageGenerator(),
      new PolicyPageGenerator(),
      new CashFlowPageGenerator(),
    ];
  }

  public async listPages(
    ctx: ServiceCallContext,
    f: { page_type?: WikiPage["page_type"]; q?: string; limit?: number },
  ): Promise<{ pages: WikiPage[] }> {
    const limit = Math.min(f.limit ?? 50, 200);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const where: string[] = [];
      const values: unknown[] = [];
      if (f.page_type !== undefined) {
        values.push(f.page_type);
        where.push(`page_type = $${values.length}`);
      }
      if (f.q !== undefined && f.q.length > 0) {
        values.push(`%${f.q.toLowerCase()}%`);
        where.push(`LOWER(body_md) LIKE $${values.length}`);
      }
      values.push(limit);
      const limitIdx = values.length;
      const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
      const result = await c.query<PageRow>(
        `SELECT id, page_type, subject_id, slug, body_md, rendered_at, source_revision
           FROM wiki_pages ${whereSql}
          ORDER BY rendered_at DESC
          LIMIT $${limitIdx}`,
        values,
      );
      return result.rows;
    });
    return { pages: rows.map(toPage) };
  }

  public async getPage(ctx: ServiceCallContext, slugOrId: string): Promise<WikiPage | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const { rows } = await c.query<PageRow>(
        `SELECT id, page_type, subject_id, slug, body_md, rendered_at, source_revision
           FROM wiki_pages
          WHERE slug = $1 OR id = $1
          LIMIT 1`,
        [slugOrId],
      );
      return rows[0] ?? null;
    });
    return row === null ? null : toPage(row);
  }

  public async search(
    ctx: ServiceCallContext,
    q: string,
    limit: number,
  ): Promise<Array<{ page: WikiPage; score: number }>> {
    // Phase 5 lexical search. Embedding-based scoring lands when the
    // generator pipeline starts populating body_embedding.
    const result = await this.listPages(ctx, { q, limit: Math.min(limit, 100) });
    return result.pages.map((page) => ({ page, score: scoreLexical(page.body_md, q) }));
  }

  public async regenerate(ctx: ServiceCallContext, slugOrId: string): Promise<WikiPage> {
    const target = this.dispatch(slugOrId);
    if (target === null) {
      throw brainError("wiki_page_not_found", "no generator owns this slug", {
        details: { slug_or_id: slugOrId },
      });
    }
    const { generator, resolved } = target;

    const output = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) =>
      generator.render({ ctx, client: c }, resolved),
    );

    const stored = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const { rows: existing } = await c.query<{ id: string }>(
        `SELECT id FROM wiki_pages WHERE slug = $1 LIMIT 1`,
        [output.slug],
      );
      if (existing[0] !== undefined) {
        const { rows } = await c.query<PageRow>(
          `UPDATE wiki_pages
              SET page_type = $1, subject_id = $2, body_md = $3,
                  rendered_at = now(), source_revision = $4
            WHERE id = $5
            RETURNING id, page_type, subject_id, slug, body_md, rendered_at, source_revision`,
          [
            output.page_type,
            output.subject_id,
            output.body_md,
            output.source_revision,
            existing[0].id,
          ],
        );
        return rows[0]!;
      }
      const { rows } = await c.query<PageRow>(
        `INSERT INTO wiki_pages (id, tenant_id, page_type, subject_id, slug, body_md, source_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, page_type, subject_id, slug, body_md, rendered_at, source_revision`,
        [
          newWikiPageId(),
          ctx.tenantId,
          output.page_type,
          output.subject_id,
          output.slug,
          output.body_md,
          output.source_revision,
        ],
      );
      return rows[0]!;
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "wiki",
      actor: ctx.actor,
      action: "wiki.page.regenerated",
      inputs: {
        slug: output.slug,
        page_type: output.page_type,
        subject_id: output.subject_id,
      },
      outputs: { page_id: stored.id, source_revision: stored.source_revision },
    });

    return toPage(stored);
  }

  private dispatch(
    slugOrId: string,
  ): { generator: PageGenerator; resolved: { subjectId: string | null; slug: string } } | null {
    for (const g of this.generators) {
      const r = g.resolveSlug(slugOrId);
      if (r !== null) return { generator: g, resolved: r };
    }
    return null;
  }
}

function toPage(row: PageRow): WikiPage {
  return {
    id: row.id,
    page_type: row.page_type as WikiPage["page_type"],
    subject_id: row.subject_id,
    slug: row.slug,
    body_md: row.body_md,
    rendered_at: row.rendered_at.toISOString(),
    source_revision: row.source_revision,
  };
}

function scoreLexical(body: string, q: string): number {
  if (q.length === 0) return 0;
  const lower = body.toLowerCase();
  const needle = q.toLowerCase();
  let score = 0;
  let from = 0;
  while (true) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    score += 1;
    from = idx + needle.length;
  }
  return Math.min(score / 5, 1);
}
