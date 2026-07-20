import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Client, Pool } from "pg";
import {
  errorHandlerPlugin,
  newAccountId,
  newCounterpartyId,
  newInvoiceId,
  newObligationId,
  newProposalId,
  newRawArtifactId,
  newRawExtractionJobId,
  newSourceId,
  newSourceSyncJobId,
  newTenantExportJobId,
  newTenantId,
  newTransactionId,
  newUserId,
  withTenantScope,
  MemoryBlobAdapter,
  type Principal,
} from "@brain/shared";
import { LedgerService } from "../../../ledger/src/service/LedgerService.js";
import { registerProposalReadRoutes } from "../../../execution/src/proposals/routes.js";
import { registerEvidenceResolveRoutes } from "../../../execution/src/evidence/routes.js";
import { registerLedgerRoutes } from "../../../ledger/src/routes/index.js";
import { registerRawExtractRoute } from "../raw-extract/route.js";
import { registerTenantExportRoute } from "../tenant-export/route.js";
import { PostgresSourceRepository } from "../../../raw/src/sources/PostgresSourceRepository.js";
import { SourceService } from "../../../raw/src/sources/SourceService.js";
import { registerSourceRoutes } from "../../../raw/src/sources/routes.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("tenant isolation contract (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let app: FastifyInstance;
  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const actorB = newUserId();
  const ids = {
    account: newAccountId(),
    counterparty: newCounterpartyId(),
    transaction: newTransactionId(),
    obligation: newObligationId(),
    invoice: newInvoiceId(),
    proposal: newProposalId(),
    raw: newRawArtifactId(),
    extractionJob: newRawExtractionJobId(),
    source: newSourceId(),
    syncJob: newSourceSyncJobId(),
    exportJob: newTenantExportJobId(),
  };

  beforeAll(async () => {
    schema = `tenant_isolation_${createHash("sha1")
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
        appliedBy: "tenant-isolation-contract",
      });
    } finally {
      migrator.release();
    }

    await seedTenantA(pool, tenantA, ids);
    await seedTenantShell(pool, tenantB, actorB);
    app = await buildApp(pool, principal(tenantB, actorB));
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (pool !== undefined) await pool.end();
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  }, 60_000);

  it("denies tenant B reads of tenant A proposal ids", async () => {
    const res = await app.inject({ method: "GET", url: `/proposals/${ids.proposal}` });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(tenantA);
  });

  it("resolves tenant A evidence refs as not found for tenant B", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/evidence/resolve",
      payload: { refs: [{ kind: "counterparty", ref: ids.counterparty }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({
      kind: "counterparty",
      ref: ids.counterparty,
      resolvable: true,
      not_found: true,
    });
  });

  it("denies tenant B ledger id reads of tenant A rows", async () => {
    const checks = [
      `/ledger/accounts/${ids.account}`,
      `/ledger/transactions/${ids.transaction}`,
      `/ledger/counterparties/${ids.counterparty}`,
      `/ledger/obligations/${ids.obligation}`,
      `/ledger/invoices/${ids.invoice}`,
    ];
    for (const url of checks) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(tenantA);
    }
  });

  it("denies tenant B tenant-export access to tenant A", async () => {
    const create = await app.inject({ method: "POST", url: `/tenants/${tenantA}/export` });
    expect(create.statusCode).toBe(403);
    const status = await app.inject({
      method: "GET",
      url: `/tenants/${tenantA}/export/${ids.exportJob}`,
    });
    expect(status.statusCode).toBe(403);
  });

  it("denies tenant B raw extraction and source sync status reads of tenant A rows", async () => {
    const extraction = await app.inject({
      method: "GET",
      url: `/raw/${ids.raw}/extraction`,
    });
    expect(extraction.statusCode).toBe(404);
    expect(extraction.body).not.toContain(tenantA);

    const sync = await app.inject({
      method: "GET",
      url: `/sources/${ids.source}/sync/${ids.syncJob}`,
    });
    expect(sync.statusCode).toBe(404);
    expect(sync.body).not.toContain(tenantA);
  });
});

async function buildApp(pool: Pool, principalValue: Principal): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = principalValue;
  });
  const audit = { emit: async () => ({ id: "audit_test" }) };
  const ledger = new LedgerService({ pool, audit: audit as never });
  const sourceRepo = new PostgresSourceRepository({ pool });
  const sourceService = new SourceService(sourceRepo, sourceRepo, audit as never, sourceRepo);
  await registerProposalReadRoutes(app, { pool });
  await registerEvidenceResolveRoutes(app, { pool });
  await registerLedgerRoutes(app, ledger);
  await registerTenantExportRoute(app, { pool, blob: new MemoryBlobAdapter() });
  await registerRawExtractRoute(app, { pool });
  await registerSourceRoutes(app, sourceService);
  return app;
}

function principal(tenantId: string, actor: string): Principal {
  return {
    id: actor,
    type: "user",
    tenantId,
    scopes: ["ledger:read", "raw:read", "execution:read"],
    tokenId: "tok_01TENANTISOLATION000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function seedTenantShell(pool: Pool, tenantId: string, memberId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
    await client.query(
      `INSERT INTO members (
         tenant_id, id, email, display_name, role, status, active, approval_domains,
         per_item_limit_cents, requires_second_approver_above_cents
       )
       VALUES ($1, $2, $3, 'Tenant B', 'admin', 'active', true,
         ARRAY['ap','ar','treasury','payroll','reconciliation']::text[],
         100000, NULL)`,
      [tenantId, memberId, `${memberId}@example.com`],
    );
  });
}

async function seedTenantA(
  pool: Pool,
  tenantId: string,
  seed: {
    account: string;
    counterparty: string;
    transaction: string;
    obligation: string;
    invoice: string;
    proposal: string;
    raw: string;
    extractionJob: string;
    source: string;
    syncJob: string;
    exportJob: string;
  },
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
    await client.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, institution, external_account_id, account_type, name, currency,
         current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Test Bank', $1, 'bank_checking', 'Tenant A Operating', 'USD',
         1000, 1000, 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [seed.account, tenantId],
    );
    await client.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, aliases, linked_accounts,
         source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Tenant A Vendor', 'tenant a vendor', 'vendor',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [seed.counterparty, tenantId],
    );
    await client.query(
      `INSERT INTO ledger_transactions (
         id, owner_id, account_id, external_transaction_id, amount, currency,
         direction, transaction_date, posted_date, counterparty_id, category_id,
         status, description_raw, description_normalized, source_ids, evidence_ids,
         reconciliation_status, provenance, confidence
       )
       VALUES ($1, $2, $3, $1, 100, 'USD', 'outflow',
         '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z',
         $4, NULL, 'posted', 'tenant a tx', 'tenant a tx',
         ARRAY[]::text[], ARRAY[]::text[], 'unreconciled', 'human_confirmed', 1)`,
      [seed.transaction, tenantId, seed.account, seed.counterparty],
    );
    await client.query(
      `INSERT INTO ledger_obligations (
         id, owner_id, counterparty_id, type, amount_due, currency,
         due_date, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, 'invoice', 100, 'USD',
         '2026-08-01T00:00:00.000Z', 'due',
         ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [seed.obligation, tenantId, seed.counterparty],
    );
    await client.query(
      `INSERT INTO ledger_invoices (
         id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
         currency, issue_date, due_date, status, linked_document_ids,
         linked_transaction_ids, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'A-1', $3, 100, 0, 'USD',
         '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'sent',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [seed.invoice, tenantId, seed.counterparty],
    );
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('collections', $1, 'internal', 'collections', 'Collections', 'active', now())`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO proposals (
         id, tenant_id, proposing_agent, action, policy_version, policy_decision,
         policy_trace, required_approvers, status, approvers_signed
       )
       VALUES ($1, $2, 'collections', $3::jsonb, 1, 'allow', '[]'::jsonb,
         ARRAY[]::text[], 'pending', ARRAY[]::text[])`,
      [
        seed.proposal,
        tenantId,
        JSON.stringify({
          type: "collections",
          narrative: "Tenant A private proposal",
          mode: "propose",
          evidence_refs: [{ kind: "counterparty", ref: seed.counterparty }],
        }),
      ],
    );
    const sha = Buffer.alloc(32, 1);
    await client.query(
      `INSERT INTO raw_artifacts (
         id, tenant_id, sha256, source_type, source_ref, blob_uri, mime_type, bytes,
         ingested_by, source_schema, object_type, external_id, operation,
         effective_at, observed_at, original_source, intermediaries, source_id,
         source_version, idempotency_key
       )
       VALUES ($1, $2, $3, 'pdf_upload', '{}'::jsonb, 'tenant-a/raw', 'application/pdf', 12,
         'tester', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL, NULL, NULL)`,
      [seed.raw, tenantId, sha],
    );
    await client.query(
      `INSERT INTO extraction_jobs (
         id, tenant_id, raw_id, content_sha256, status, requested_by
       )
       VALUES ($1, $2, $3, $4, 'queued', 'tester')`,
      [seed.extractionJob, tenantId, seed.raw, sha],
    );
    await client.query(
      `INSERT INTO raw_sources (
         id, tenant_id, type, status, metadata, external_account_ids,
         last_synced_at, error_message, is_stub
       )
       VALUES ($1, $2, 'pdf_upload', 'active', '{}'::jsonb, ARRAY[]::text[],
         now(), NULL, true)`,
      [seed.source, tenantId],
    );
    await client.query(
      `INSERT INTO raw_source_sync_jobs (job_id, tenant_id, source_id, status)
       VALUES ($1, $2, $3, 'enqueued')`,
      [seed.syncJob, tenantId, seed.source],
    );
    await client.query(
      `INSERT INTO tenant_export_jobs (id, tenant_id, status, requested_by, expires_at)
       VALUES ($1, $2, 'succeeded', 'tester', now() + interval '7 days')`,
      [seed.exportJob, tenantId],
    );
  });
}
