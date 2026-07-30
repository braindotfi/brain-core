/**
 * Adversarial RLS proof for the OAuth core (Phase 2a), mirroring
 * services/raw/src/__integration__/rls.integration.test.ts.
 *
 * Every other suite in this package connects via DATABASE_URL as the table
 * owner ("brain"), which Postgres never subjects to row security regardless
 * of FORCE ROW LEVEL SECURITY. This is the suite that actually proves the
 * tenant_isolation policy works: it connects as brain_app (NOBYPASSRLS, not
 * the table owner -- the same role class brain_auth will run behind once
 * Phase 2a wires the AS's own DATABASE_URL), scopes to tenant A via
 * withTenantScope, and asserts zero rows belonging to tenant B come back for
 * oauth_authorization_codes.
 *
 * A separate test proves the deliberately-non-tenant-scoped oauth_clients
 * table is invisible to a role that is not "brain_auth" -- the accepted
 * "RLS on every table" deviation actually holds at the database, not just in
 * the migration comment.
 *
 * Requires DATABASE_URL (owner, for the harness) and DATABASE_URL_APP
 * (brain_app, applied by .github/workflows/pr.yml's "Apply DB role model"
 * step). Skips cleanly when either is absent.
 */

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenantId, withTenantScope } from "@brain/shared";
import { buildAuthHarness, type AuthHarness } from "./harness.js";

const DB_URL = process.env.DATABASE_URL;
const APP_URL = process.env.DATABASE_URL_APP;
const DESCRIBE = DB_URL !== undefined && APP_URL !== undefined ? describe : describe.skip;

let h: AuthHarness | null = null;
let appPool: Pool | null = null;
const tenantA = newTenantId();
const tenantB = newTenantId();

async function seedCode(tenantId: string, codeHash: string): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
  await h.pool.query(
    `INSERT INTO oauth_authorization_codes (
       code_hash, client_id, tenant_id, agent_id, member_id, grant_id,
       scopes, redirect_uri, code_challenge, code_challenge_method, expires_at
     ) VALUES ($1, 'oacl_test', $2, 'agent_test', 'mem_test', 'ogr_test',
       ARRAY['ledger:read'], 'https://example.test/cb', 'challenge-value',
       'S256', now() + interval '60 seconds')`,
    [codeHash, tenantId],
  );
}

DESCRIBE(
  "RLS adversarial proof: brain_app cannot read across tenants on oauth_authorization_codes (requires DATABASE_URL + DATABASE_URL_APP)",
  () => {
    const codeA = `code-a-${tenantA}`;
    const codeB = `code-b-${tenantB}`;

    beforeAll(async () => {
      h = await buildAuthHarness();
      if (h === null) return;

      // db-roles.sql's blanket grants target the "public" schema, applied
      // before this harness's per-run schema existed. Grant brain_app the
      // same footprint scoped to this run's schema, mirroring what
      // db-roles.sql already does for "public" in CI.
      await h.pool.query(`GRANT USAGE ON SCHEMA ${h.schema} TO brain_app`);
      await h.pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO brain_app`,
      );

      await seedCode(tenantA, codeA);
      await seedCode(tenantB, codeB);

      appPool = new Pool({
        connectionString: APP_URL,
        max: 3,
        application_name: `auth-rls-test-${h.schema}`,
      });
      appPool.on("connect", (c) => {
        void c.query(`SET search_path TO ${h!.schema}, public`);
      });
    }, 60_000);

    afterAll(async () => {
      if (appPool !== null) await appPool.end();
      if (h !== null) await h.cleanup();
    });

    it("brain_app scoped to tenant A sees zero tenant B rows", async () => {
      if (h === null || appPool === null) return;
      const rows = await withTenantScope(appPool, tenantA, (c) =>
        c.query<{ code_hash: string; tenant_id: string }>(
          "SELECT code_hash, tenant_id FROM oauth_authorization_codes",
        ),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      expect(rows.rows.some((r) => r.code_hash === codeB)).toBe(false);
    });

    it("brain_app scoped to tenant B sees zero tenant A rows", async () => {
      if (h === null || appPool === null) return;
      const rows = await withTenantScope(appPool, tenantB, (c) =>
        c.query<{ code_hash: string; tenant_id: string }>(
          "SELECT code_hash, tenant_id FROM oauth_authorization_codes",
        ),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === tenantB)).toBe(true);
      expect(rows.rows.some((r) => r.code_hash === codeA)).toBe(false);
    });

    it("a direct query with no tenant scope set returns nothing (fail closed)", async () => {
      if (h === null || appPool === null) return;
      const client = await appPool.connect();
      try {
        const rows = await client.query<{ code_hash: string }>(
          "SELECT code_hash FROM oauth_authorization_codes",
        );
        expect(rows.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    it("brain_app (not brain_auth) sees zero rows on oauth_clients, even with table-level grants", async () => {
      if (h === null || appPool === null) return;
      await h.pool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types)
         VALUES ('oacl_probe', 'probe client', ARRAY['https://example.test/cb'],
           ARRAY['authorization_code'], ARRAY['code'])`,
      );
      const client = await appPool.connect();
      try {
        const rows = await client.query<{ client_id: string }>(
          "SELECT client_id FROM oauth_clients",
        );
        expect(rows.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });
  },
);
