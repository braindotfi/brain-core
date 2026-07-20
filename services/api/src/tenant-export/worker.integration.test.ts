import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  InMemoryAuditEmitter,
  MemoryBlobAdapter,
  newAccountId,
  newAgentId,
  newAuditEventId,
  newProposalId,
  newSourceId,
  newTenantId,
  newTenantExportJobId,
  withTenantScope,
} from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { enqueueTenantExportJob } from "./repository.js";
import { TenantExportService } from "./service.js";
import { runTenantExportCycle } from "./worker.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("tenant export worker integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let blob: MemoryBlobAdapter;
  let audit: InMemoryAuditEmitter;
  const tenant = newTenantId();
  const otherTenant = newTenantId();

  beforeAll(async () => {
    schema = `tenant_export_${createHash("sha1")
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
        appliedBy: "tenant-export-integration",
      });
    } finally {
      migrator.release();
    }

    blob = new MemoryBlobAdapter();
    audit = new InMemoryAuditEmitter();
    await seedTenant(pool, tenant, "export");
    await seedTenant(pool, otherTenant, "other");
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

  it("exports only the requesting tenant data and emits tenant.exported", async () => {
    const job = await withTenantScope(pool, tenant, (client) =>
      enqueueTenantExportJob(client, {
        tenantId: tenant,
        requestedBy: "user_export",
        expiresAt: new Date("2026-07-27T00:00:00Z"),
      }),
    );
    const service = new TenantExportService({ pool, blob, audit });

    await runTenantExportCycle(
      { scanPool: pool, appPool: pool, blob, service },
      { batchSize: 1, workerId: "tenant_export_test" },
    );

    const saved = await withTenantScope(pool, tenant, (client) =>
      client.query<{
        status: string;
        output_blob_uri: string;
        byte_size: string;
        error: Record<string, unknown> | null;
      }>(
        `SELECT status, output_blob_uri, byte_size, error
           FROM tenant_export_jobs
          WHERE id = $1`,
        [job.row.id],
      ),
    );
    expect(saved.rows[0]?.error).toBeNull();
    expect(saved.rows[0]).toMatchObject({ status: "succeeded" });
    expect(Number(saved.rows[0]?.byte_size)).toBeGreaterThan(0);

    const archive = await readBlob(blob, saved.rows[0]!.output_blob_uri);
    const rows = archive
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entity_type: string; data: Record<string, unknown> });
    expect(rows.map((row) => row.entity_type)).toEqual(
      expect.arrayContaining(["ledger_account", "member", "source", "proposal", "audit_event"]),
    );
    expect(JSON.stringify(rows)).toContain(tenant);
    expect(JSON.stringify(rows)).not.toContain(otherTenant);
    expect(audit.events.map((event) => event.action)).toEqual(["tenant.exported"]);
  });

  it("purges an expired export archive and leaves other tenant blobs intact", async () => {
    const expiredJobId = newTenantExportJobId();
    const expiredPath = `${tenant}/exports/expired.ndjson`;
    await blob.put(expiredPath, Buffer.from("expired"), {
      contentType: "application/x-ndjson",
      immutable: false,
    });
    await blob.put(`${tenant}/2026/07/20/raw`, Buffer.from("raw"), {
      contentType: "application/octet-stream",
      immutable: true,
    });
    await withTenantScope(pool, tenant, (client) =>
      client.query(
        `INSERT INTO tenant_export_jobs
           (id, tenant_id, status, requested_by, expires_at, output_blob_uri, byte_size, finished_at)
         VALUES ($1, $2, 'succeeded', 'user_export', '2020-01-01T00:00:00Z', $3, 7, now())`,
        [expiredJobId, tenant, expiredPath],
      ),
    );

    const service = new TenantExportService({ pool, blob, audit });
    const result = await runTenantExportCycle(
      { scanPool: pool, appPool: pool, blob, service },
      { batchSize: 1 },
    );

    expect(result.purged).toBe(1);
    await expect(blob.get(expiredPath)).rejects.toThrow();
    await expect(readBlob(blob, `${tenant}/2026/07/20/raw`)).resolves.toBe("raw");
  });
});

async function seedTenant(pool: Pool, tenantId: string, label: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, institution, external_account_id, account_type, name, currency,
         current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Test Bank', $1, 'bank_checking', $3, 'USD',
         100, 100, 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [newAccountId(), tenantId, `Operating ${label}`],
    );
    await client.query(
      `INSERT INTO members (
         tenant_id, id, email, display_name, role, active, approval_domains,
         per_item_limit_cents, requires_second_approver_above_cents
       )
       VALUES ($1, $2, $3, $4, 'admin', true,
         ARRAY['ap','ar','treasury','payroll','reconciliation']::text[], 100000, NULL)`,
      [tenantId, `user_${label}`, `${label}@example.com`, `Admin ${label}`],
    );
    await client.query(
      `INSERT INTO raw_sources (
         id, tenant_id, type, status, metadata, external_account_ids,
         last_synced_at, error_message, is_stub
       )
       VALUES ($1, $2, 'pdf_upload', 'active', $3::jsonb, ARRAY[]::text[],
         now(), NULL, true)`,
      [newSourceId(), tenantId, JSON.stringify({ label })],
    );
    const agentId = newAgentId();
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ($1, $2, 'internal', 'collections', $3, 'active', now())`,
      [agentId, tenantId, `Agent ${label}`],
    );
    await client.query(
      `INSERT INTO proposals (
         id, tenant_id, proposing_agent, action, policy_version, policy_decision,
         policy_trace, required_approvers, status, approvers_signed
       )
       VALUES ($1, $2, $3, $4::jsonb, 1, 'allow', '[]'::jsonb,
         ARRAY[]::text[], 'pending', ARRAY[]::text[])`,
      [
        newProposalId(),
        tenantId,
        agentId,
        JSON.stringify({ type: "collections", narrative: `Collect ${label}`, mode: "propose" }),
      ],
    );
    await client.query(
      `INSERT INTO audit_events (
         id, tenant_id, layer, actor, action, inputs, outputs, policy_version,
         event_hash, prev_event_hash, created_at
       )
       VALUES ($1, $2, 'audit', $3, 'seed.event', '{}'::jsonb, '{}'::jsonb,
         NULL, $4, NULL, now())`,
      [
        newAuditEventId(),
        tenantId,
        `user_${label}`,
        createHash("sha256").update(`${tenantId}:${label}`).digest(),
      ],
    );
  });
}

async function readBlob(blob: MemoryBlobAdapter, path: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await blob.get(path)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
