/**
 * P1.1 — storage-level adversarial vectors that need a live Postgres
 * (DATABASE_URL). Skips when unset. The logic-level vectors run DB-free in
 * src/adversarial.test.ts.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { PostgresAuditEmitter, newTenantId } from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

let pool: Pool;
let schema: string;
let appRole: string;

suite("P1.1 adversarial (integration — requires DATABASE_URL)", () => {
  beforeAll(async () => {
    schema = `adv_test_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: `adv-${schema}` });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });

    const mig = await pool.connect();
    try {
      await mig.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(new URL("../../..", import.meta.url).pathname);
      await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "adversarial-integration",
      });
      // FORCE RLS so policies apply to the schema owner too.
      const enabled = await mig.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relrowsecurity`,
        [schema],
      );
      for (const r of enabled.rows) {
        await mig.query(`ALTER TABLE ${schema}.${r.relname} FORCE ROW LEVEL SECURITY`);
      }

      // Non-owner app role: RLS is bypassed for the (super)owner, so the
      // cross-tenant probe must run as a plain role for the policy to apply.
      appRole = `${schema}_app`;
      await mig.query(`DROP ROLE IF EXISTS ${appRole}`);
      await mig.query(`CREATE ROLE ${appRole} NOLOGIN`);
      await mig.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
      await mig.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`);
    } finally {
      mig.release();
    }
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.end();
    const done = new Client({ connectionString: DB_URL });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.query(`DROP ROLE IF EXISTS ${appRole}`);
    await done.end();
  }, 60_000);

  // 1. Tenant ID swap: principal from tenant A's data is invisible to tenant B.
  it("tenant swap: tenant B cannot read tenant A's row (fails closed via RLS)", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const ev = await emitter.emit({
      tenantId: a,
      layer: "audit",
      actor: "system",
      action: "adv.tenant_swap",
      inputs: {},
      outputs: {},
    });
    // Probe as the non-owner role so RLS applies (the owner bypasses it).
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${appRole}`);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      const seenByB = await c.query(`SELECT id FROM audit_events WHERE id = $1`, [ev.id]);
      await c.query("ROLLBACK");
      expect(seenByB.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  // 3. Policy downgrade: activating a policy version older than the active one
  //    must be rejected. Requires the policy activation API + a seeded active
  //    policy; logic-level downgrade protection is asserted in services/policy.
  it.todo("policy downgrade: activating an older policy version is rejected");
});
