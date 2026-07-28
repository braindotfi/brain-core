/**
 * Tenant deletion against a REAL Postgres, focused on the surface-gateway
 * tables (GDPR Article 17).
 *
 * The unit suite proves the DELETE statements are issued; it cannot prove the
 * rows actually go away, because the fake pool answers every DELETE with a
 * made-up rowCount. That gap is exactly what hid this bug: surface_* tables
 * were absent from TENANT_SCOPED_TABLES and, because none of them declares a
 * foreign key to `tenants`, nothing failed. The transaction committed, the
 * response reported success, and the tenant's Slack/Teams install tokens,
 * external identities and proposal payloads stayed in the database.
 *
 * So this suite does two things against a live database:
 *   1. Reproduces the pre-fix behaviour by running the OLD deletion list
 *      (today's list minus the surface_* block) and showing the surface rows
 *      survive a "successful" erasure.
 *   2. Runs the real TenantDeletionService and shows they do not.
 *
 * Requires a live Postgres via DATABASE_URL; skips otherwise, matching every
 * other __integration__ suite in the repo.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { TENANT_SCOPED_TABLES, TenantDeletionService, tenantDeleteStatement } from "./service.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  // decodeURIComponent for the same reason service.test.ts does it: pathname
  // percent-encodes spaces, so a checkout under e.g. "Brain Code" resolves to
  // a directory that does not exist and discoverMigrations quietly finds none.
  return decodeURIComponent(new URL("../../../..", import.meta.url).pathname);
}

/**
 * One INSERT per tenant-scoped surface table. Written out by hand rather than
 * generated from information_schema: several of these carry CHECK constraints
 * (`surface IN ('slack','teams','email')`, `agent IN ('invoice',...)`) that a
 * generic column-filler would violate. `$1` is the tenant id, `$2` a suffix
 * that keeps the UNIQUE(team_id)/UNIQUE(aad_tenant_id) constraints happy when
 * two tenants are seeded in the same schema.
 */
const SURFACE_SEEDS: Record<string, string> = {
  surface_external_identities: `INSERT INTO surface_external_identities (tenant_id, surface, external_id, actor_id)
     VALUES ($1, 'slack', 'U-' || $2, 'usr_seed')`,
  surface_proposals: `INSERT INTO surface_proposals (tenant_id, proposal_id, proposal, content_hash)
     VALUES ($1, 'prp_' || $2, '{"amount_cents":1000}'::jsonb, 'hash-' || $2)`,
  surface_delivered_refs: `INSERT INTO surface_delivered_refs (tenant_id, proposal_id, surface, target, ref)
     VALUES ($1, 'prp_' || $2, 'slack', 'C-CHANNEL', 'ts-' || $2)`,
  surface_decisions: `INSERT INTO surface_decisions (tenant_id, proposal_id, decision, actor_id, decided_at)
     VALUES ($1, 'prp_' || $2, 'approved', 'usr_seed', now())`,
  surface_teams_conversation_refs: `INSERT INTO surface_teams_conversation_refs (tenant_id, conversation_ref, reference)
     VALUES ($1, 'conv-' || $2, '{"serviceUrl":"https://example.invalid"}'::jsonb)`,
  surface_slack_installations: `INSERT INTO surface_slack_installations
       (tenant_id, team_id, bot_token_encrypted, credential_key_id, bot_user_id, installed_by)
     VALUES ($1, 'T-' || $2, '\\x00'::bytea, 'key-1', 'B-BOT', 'usr_seed')`,
  surface_slack_install_nonces: `INSERT INTO surface_slack_install_nonces (tenant_id, nonce, installed_by, expires_at)
     VALUES ($1, 'nonce-' || $2, 'usr_seed', now() + interval '1 hour')`,
  surface_teams_installations: `INSERT INTO surface_teams_installations (brain_tenant_id, aad_tenant_id, installed_by)
     VALUES ($1, 'aad-' || $2, 'usr_seed')`,
  surface_email_recipients: `INSERT INTO surface_email_recipients (tenant_id, email, actor_id)
     VALUES ($1, $2 || '@example.invalid', 'usr_seed')`,
  surface_email_routes: `INSERT INTO surface_email_routes (tenant_id, agent, recipients)
     VALUES ($1, 'invoice', ARRAY[$2 || '@example.invalid']::text[])`,
  surface_email_domains: `INSERT INTO surface_email_domains (tenant_id, domain)
     VALUES ($1, $2 || '.example.invalid')`,
};

const surfaceEntries = TENANT_SCOPED_TABLES.filter((t) => t.table.startsWith("surface_"));

async function seedSurfaceRows(pool: Pool, tenantId: string, suffix: string): Promise<void> {
  await pool.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
  for (const sql of Object.values(SURFACE_SEEDS)) {
    await pool.query(sql, [tenantId, suffix]);
  }
}

/** Rows still present for `tenantId`, per surface table. */
async function surfaceCounts(pool: Pool, tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table, column } of surfaceEntries) {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`,
      [tenantId],
    );
    counts[table] = Number(res.rows[0]?.n ?? "0");
  }
  return counts;
}

// Deliberately NOT inside `suite`: this is a pure comparison of two in-memory
// constants, and it is the guard that stops the DB-backed tests below from
// passing vacuously. Gating it on DATABASE_URL would drop the cheapest
// protection on exactly the machines that skip everything else.
describe("tenant deletion — surface seed coverage", () => {
  it("seeds every surface table the deletion list claims to cover (drift guard)", () => {
    expect(new Set(Object.keys(SURFACE_SEEDS))).toEqual(
      new Set(surfaceEntries.map((t) => t.table)),
    );
    expect(surfaceEntries.length).toBeGreaterThan(10);
  });
});

suite("tenant deletion — surface-gateway tables (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `tenant_del_surface_${createHash("sha1")
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
        appliedBy: "tenant-deletion-surface-integration",
      });
    } finally {
      migrator.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  }, 60_000);

  it("PRE-FIX: the old deletion list commits successfully and orphans every surface row", async () => {
    const tenant = newTenantId();
    await seedSurfaceRows(pool, tenant, "prefix");
    expect(Object.values(await surfaceCounts(pool, tenant))).toEqual(surfaceEntries.map(() => 1));

    // Replay the list as it stood before this fix: identical, minus the
    // surface_* block. Nothing here raises — no surface table has an FK to
    // `tenants`, so Postgres never gets the chance to complain.
    const preFixTables = TENANT_SCOPED_TABLES.filter((t) => !t.table.startsWith("surface_"));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const { table, column } of preFixTables) {
        await client.query(tenantDeleteStatement(table, column), [tenant]);
      }
      await client.query(tenantDeleteStatement("tenants", "id"), [tenant]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // The tenant registry row is gone, so the erasure "succeeded" ...
    const tenants = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenant]);
    expect(tenants.rowCount).toBe(0);
    // ... while every surface row it owned is still readable. That is the bug.
    expect(await surfaceCounts(pool, tenant)).toEqual(
      Object.fromEntries(surfaceEntries.map((t) => [t.table, 1])),
    );
  });

  it("erases every surface row for the target tenant and leaves other tenants intact", async () => {
    const tenant = newTenantId();
    const bystander = newTenantId();
    await seedSurfaceRows(pool, tenant, "target");
    await seedSurfaceRows(pool, bystander, "bystander");

    const svc = new TenantDeletionService({
      privilegedPool: pool,
      audit: new InMemoryAuditEmitter(),
    });
    const result = await svc.deleteTenant({ tenantId: tenant, actor: newUserId() }, tenant);

    // Every surface table reported exactly the one seeded row ...
    for (const { table } of surfaceEntries) {
      expect(result.deletedRows[table], `${table} row count`).toBe(1);
    }
    // ... and re-reading confirms it, including surface_teams_installations,
    // whose predicate column is brain_tenant_id rather than tenant_id.
    expect(await surfaceCounts(pool, tenant)).toEqual(
      Object.fromEntries(surfaceEntries.map((t) => [t.table, 0])),
    );
    expect(result.deletedRows.tenants).toBe(1);

    // Tenant isolation: the deletion predicate did not reach past its tenant.
    expect(await surfaceCounts(pool, bystander)).toEqual(
      Object.fromEntries(surfaceEntries.map((t) => [t.table, 1])),
    );
  });
});
