import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { brainError, InMemoryAuditEmitter, newTenantId } from "@brain/shared";
import type { MetricsEmitter } from "@brain/shared";
import type { LedgerUploadProjectedEvent } from "@brain/canonical";
import {
  regenerateWikiForUploadProjection,
  runWikiRegenerationCycle,
  startWikiRegenerationWorker,
} from "./regeneration-worker.js";

describe("wiki regeneration worker", () => {
  it("regenerates upload-affected pages through the wiki service", async () => {
    const tenantId = newTenantId();
    const queries: string[] = [];
    const pool = poolWithScopedRows(
      [
        { slug: "/cash-flow/2026-06" },
        { slug: "/counterparties/cp_1" },
        { slug: "/monthly-summaries/2026-06" },
        { slug: "/obligations/obl_1" },
      ],
      queries,
    );
    const regenerated: string[] = [];
    const audit = new InMemoryAuditEmitter();

    await regenerateWikiForUploadProjection(
      {
        tenantDiscoveryPool: pool,
        audit,
        pageService: {
          listPages: async () => ({ pages: [] }),
          regenerate: async (_ctx, slug) => {
            regenerated.push(slug);
            return null as never;
          },
          deletePage: async () => false,
        },
      },
      eventFor(tenantId),
    );

    expect(queries).toContain("BEGIN");
    expect(queries.some((q) => q.includes("SELECT set_config('app.tenant_id'"))).toBe(true);
    expect(regenerated).toEqual([
      "/cash-flow/2026-06",
      "/counterparties/cp_1",
      "/monthly-summaries/2026-06",
      "/obligations/obl_1",
    ]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId,
      layer: "wiki",
      eventType: "system_activity",
      severity: "info",
      actor: "system:wiki-regeneration-worker",
      action: "wiki.pages.regenerated",
      outputs: {
        pages_regenerated: 4,
        page_candidates: 4,
      },
    });
  });

  it("warns and audits when upload-triggered regeneration produces zero pages", async () => {
    const tenantId = newTenantId();
    const warnings: unknown[] = [];
    const audit = new InMemoryAuditEmitter();

    await regenerateWikiForUploadProjection(
      {
        tenantDiscoveryPool: poolWithScopedRows([], []),
        audit,
        pageService: {
          listPages: async () => ({ pages: [] }),
          regenerate: async () => null as never,
          deletePage: async () => false,
        },
        log: {
          warn: (obj) => warnings.push(obj),
          error: () => undefined,
        },
      },
      eventFor(tenantId),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      tenantId,
      rawArtifactId: "raw_01K0RAWARTIFACT000000000000",
      pageCandidates: 0,
    });
    expect(audit.events[0]).toMatchObject({
      action: "wiki.pages.regenerated",
      outputs: {
        pages_regenerated: 0,
        page_candidates: 0,
        slugs: [],
      },
    });
  });

  it("refreshes existing pages on the scheduled cycle", async () => {
    const tenantId = newTenantId();
    const pool = {
      query: async () => ({ rows: [{ tenant_id: tenantId }], rowCount: 1 }),
    } as unknown as Pool;
    const regenerated: string[] = [];

    await runWikiRegenerationCycle({
      tenantDiscoveryPool: pool,
      pageService: {
        listPages: async () => ({
          pages: [page("/monthly-summaries/2026-06"), page("/cash-flow/2026-06")],
        }),
        regenerate: async (_ctx, slug) => {
          regenerated.push(slug);
          return null as never;
        },
        deletePage: async () => false,
      },
    });

    expect(regenerated).toEqual(["/monthly-summaries/2026-06", "/cash-flow/2026-06"]);
  });

  it("prunes a page whose subject is gone instead of retrying it forever", async () => {
    const tenantId = newTenantId();
    const deleted: string[] = [];
    const warnings: unknown[] = [];
    const infos: unknown[] = [];
    const audit = new InMemoryAuditEmitter();
    const metrics: MetricSample[] = [];

    await runWikiRegenerationCycle({
      tenantDiscoveryPool: {
        query: async () => ({ rows: [{ tenant_id: tenantId }], rowCount: 1 }),
      } as unknown as Pool,
      pageService: {
        listPages: async () => ({
          pages: [page("/obligations/obl_gone"), page("/cash-flow/2026-06")],
        }),
        regenerate: async (_ctx, slug) => {
          if (slug === "/obligations/obl_gone") {
            throw brainError("wiki_subject_not_found", "obligation obl_gone not found", {
              details: { page_type: "obligation", subject_id: "obl_gone" },
            });
          }
          return null as never;
        },
        deletePage: async (_ctx, slug) => {
          deleted.push(slug);
          return true;
        },
      },
      audit,
      log: {
        info: (obj) => infos.push(obj),
        warn: (obj) => warnings.push(obj),
        error: () => undefined,
      },
      metrics: metricsSpy(metrics),
    });

    expect(deleted).toEqual(["/obligations/obl_gone"]);
    // The whole point: a permanently unresolvable slug must not warn on every
    // cycle and drown out actionable worker failures.
    expect(warnings).toEqual([]);
    expect(metrics).toEqual([
      { name: "brain.wiki.regeneration.page_pruned.count", tags: { page_type: "obligation" } },
    ]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId,
      layer: "wiki",
      action: "wiki.page.pruned",
      inputs: { slug: "/obligations/obl_gone", page_type: "obligation" },
      outputs: { reason: "subject_not_found" },
    });
    expect(infos.at(-1)).toMatchObject({ pages: 2, regenerated: 1, pruned: 1, failed: 0 });
  });

  it("keeps warning and never deletes when the failure is not a missing subject", async () => {
    const tenantId = newTenantId();
    const deleted: string[] = [];
    const warnings: unknown[] = [];
    const metrics: MetricSample[] = [];

    await runWikiRegenerationCycle({
      tenantDiscoveryPool: {
        query: async () => ({ rows: [{ tenant_id: tenantId }], rowCount: 1 }),
      } as unknown as Pool,
      pageService: {
        listPages: async () => ({ pages: [page("/obligations/obl_1")] }),
        regenerate: async () => {
          throw new Error("embedding provider unavailable");
        },
        deletePage: async (_ctx, slug) => {
          deleted.push(slug);
          return true;
        },
      },
      log: {
        info: () => undefined,
        warn: (obj) => warnings.push(obj),
        error: () => undefined,
      },
      metrics: metricsSpy(metrics),
    });

    expect(deleted).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(metrics).toEqual([
      { name: "brain.wiki.regeneration.failed.count", tags: { reason: "unknown" } },
    ]);
  });

  it("logs the configured interval on startup", () => {
    const messages: unknown[] = [];
    const worker = startWikiRegenerationWorker(
      {
        tenantDiscoveryPool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        pageService: {
          listPages: async () => ({ pages: [] }),
          regenerate: async () => null as never,
          deletePage: async () => false,
        },
        log: {
          info: (obj) => messages.push(obj),
          error: () => undefined,
        },
      },
      { intervalMs: 123_000 },
    );
    worker.stop();

    expect(messages).toEqual([{ intervalMs: 123_000 }]);
  });
});

function eventFor(tenantId: string): LedgerUploadProjectedEvent {
  return {
    event: "ledger.upload.projected",
    tenantId,
    rawArtifactId: "raw_01K0RAWARTIFACT000000000000",
    rawParsedId: "rps_01K0RAWPARSED0000000000000",
    projector: "ledger_document_upload",
    summary: {
      accounts: 0,
      transactions: 19,
      receivables: 1,
      obligations: 1,
      newCounterparties: 1,
    },
  };
}

interface MetricSample {
  name: string;
  tags: Record<string, unknown> | undefined;
}

function metricsSpy(sink: MetricSample[]): MetricsEmitter {
  return {
    increment: (name: string, tags?: Record<string, unknown>) => sink.push({ name, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
    duration: () => undefined,
    close: async () => undefined,
  } as unknown as MetricsEmitter;
}

function poolWithScopedRows(rows: Array<{ slug: string }>, queries: string[]): Pool {
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("WITH tx AS")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
  } as unknown as Pool;
}

function page(slug: string) {
  return {
    id: `wpg_${slug.replace(/[^a-z0-9]/gi, "")}`,
    page_type: "monthly_summary" as const,
    subject_id: null,
    slug,
    body_md: "",
    rendered_at: new Date(0).toISOString(),
    source_revision: "test",
  };
}
