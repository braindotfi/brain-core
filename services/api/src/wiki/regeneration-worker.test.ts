import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { newTenantId } from "@brain/shared";
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

    await regenerateWikiForUploadProjection(
      {
        tenantDiscoveryPool: pool,
        pageService: {
          listPages: async () => ({ pages: [] }),
          regenerate: async (_ctx, slug) => {
            regenerated.push(slug);
            return null as never;
          },
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
      },
    });

    expect(regenerated).toEqual(["/monthly-summaries/2026-06", "/cash-flow/2026-06"]);
  });

  it("logs the configured interval on startup", () => {
    const messages: unknown[] = [];
    const worker = startWikiRegenerationWorker(
      {
        tenantDiscoveryPool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        pageService: {
          listPages: async () => ({ pages: [] }),
          regenerate: async () => null as never,
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
