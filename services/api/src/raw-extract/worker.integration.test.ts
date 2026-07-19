import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  InMemoryAuditEmitter,
  MemoryBlobAdapter,
  newRawParsedId,
  newTenantId,
  newUserId,
  withTenantScope,
  type ServiceCallContext,
} from "@brain/shared";
import { ingestOne } from "@brain/raw";
import { runDocumentExtractionCycle, type DocumentExtractPort } from "./worker.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("document extraction jobs integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let blob: MemoryBlobAdapter;
  const audit = new InMemoryAuditEmitter();
  const tenant = newTenantId();

  beforeAll(async () => {
    schema = `doc_extract_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: schema });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}, public`);
    });

    const migrator = await pool.connect();
    try {
      await migrator.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(migrator as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "document-extraction-integration",
      });
    } finally {
      migrator.release();
    }

    await withTenantScope(pool, tenant, async (c) => {
      await c.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenant]);
      await c.query(
        `INSERT INTO raw_tenant_settings (tenant_id, auto_extract_documents)
         VALUES ($1, TRUE)`,
        [tenant],
      );
    });
    blob = new MemoryBlobAdapter();
  }, 60_000);

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  }, 60_000);

  it("auto-enqueues one job, runs the worker, and records capped success status", async () => {
    const result = await ingestOne(
      {
        pool,
        blob,
        audit,
        extractionJobs: { documentExtractorConfigured: true },
      },
      {
        tenantId: tenant,
        actor: newUserId(),
        sourceType: "pdf_upload",
        sourceRef: { filename: "invoice.pdf" },
        body: Buffer.from("invoice"),
        mimeType: "application/pdf",
      },
    );

    expect(result.extractionJob).toMatchObject({ raw_id: result.rawId, status: "queued" });

    const before = await jobCount(result.rawId);
    expect(before).toBe(1);

    const client: DocumentExtractPort = {
      extract: async (ctx: ServiceCallContext, input) => {
        const parsedId = newRawParsedId();
        await withTenantScope(pool, ctx.tenantId, (c) =>
          c.query(
            `INSERT INTO raw_parsed
               (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
             VALUES ($1, $2, $3, 'doc_obligation_v1', '1', $4, 0.91)`,
            [
              parsedId,
              input.rawId,
              ctx.tenantId,
              JSON.stringify({ obligations: [{ amount: "12.00", currency: "USD" }] }),
            ],
          ),
        );
        return { parsed_id: parsedId, confidence: 0.91 };
      },
    };

    await runDocumentExtractionCycle(
      { scanPool: pool, appPool: pool, blob, client },
      { batchSize: 1 },
    );

    const rows = await withTenantScope(pool, tenant, (c) =>
      c.query<{ status: string; parsed_id: string | null; confidence: number | null }>(
        `SELECT status, parsed_id, confidence
           FROM extraction_jobs
          WHERE raw_id = $1`,
        [result.rawId],
      ),
    );
    expect(rows.rows).toEqual([
      {
        status: "succeeded",
        parsed_id: expect.stringMatching(/^prs_/),
        confidence: 0.5,
      },
    ]);
    expect(await jobCount(result.rawId)).toBe(1);
  });

  it("marks a queued job failed when the extractor client is missing", async () => {
    const result = await ingestOne(
      {
        pool,
        blob,
        audit,
        extractionJobs: { documentExtractorConfigured: true },
      },
      {
        tenantId: tenant,
        actor: newUserId(),
        sourceType: "pdf_upload",
        sourceRef: { filename: "missing-agent.pdf" },
        body: Buffer.from("different invoice"),
        mimeType: "application/pdf",
      },
    );

    await runDocumentExtractionCycle({ scanPool: pool, appPool: pool, blob }, { batchSize: 1 });

    const rows = await withTenantScope(pool, tenant, (c) =>
      c.query<{ status: string; error: Record<string, unknown> }>(
        `SELECT status, error
           FROM extraction_jobs
          WHERE raw_id = $1`,
        [result.rawId],
      ),
    );
    expect(rows.rows[0]).toMatchObject({
      status: "failed",
      error: { code: "dependency_unavailable" },
    });
  });

  async function jobCount(rawId: string): Promise<number> {
    const count = await withTenantScope(pool, tenant, (c) =>
      c.query<{ n: string }>(`SELECT count(*)::text AS n FROM extraction_jobs WHERE raw_id = $1`, [
        rawId,
      ]),
    );
    return Number(count.rows[0]?.n ?? 0);
  }
});
