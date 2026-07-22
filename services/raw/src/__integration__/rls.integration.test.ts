/**
 * Adversarial RLS proof (P0 fix): every other integration suite connects via
 * DATABASE_URL as the table owner ("brain"). Postgres never subjects a
 * connection's owning role to row security, regardless of FORCE ROW LEVEL
 * SECURITY, so those suites cannot detect a real RLS regression: an app-level
 * tenant filter could be deleted from a route and every owner-connected test
 * would stay green.
 *
 * This test is the missing half. It connects as brain_app (infra/db-roles.sql:
 * NOBYPASSRLS, not the table owner), the same role class the request path
 * actually runs behind in production, and proves that a brain_app connection
 * scoped to tenant A via withTenantScope returns ZERO rows belonging to
 * tenant B for two tenant-scoped raw tables. Disable the tenant_isolation
 * policy (or drop FORCE ROW LEVEL SECURITY) on either table locally and this
 * test goes red.
 *
 * Requires DATABASE_URL (owner, for the harness + seeding) and
 * DATABASE_URL_APP (brain_app, applied by .github/workflows/pr.yml's "Apply
 * DB role model" step). Skips cleanly when either is absent, matching every
 * other __integration__ suite's convention.
 */

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRawArtifactId, newTenantId, withTenantScope } from "@brain/shared";
import { buildHarness, type Harness } from "./harness.js";

const DB_URL = process.env.DATABASE_URL;
const APP_URL = process.env.DATABASE_URL_APP;
const DESCRIBE = DB_URL !== undefined && APP_URL !== undefined ? describe : describe.skip;

let h: Harness | null = null;
let appPool: Pool | null = null;
const tenantA = newTenantId();
const tenantB = newTenantId();
const artifactA = newRawArtifactId();
const artifactB = newRawArtifactId();

async function seedArtifact(tenantId: string, artifactId: string): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await withTenantScope(h.pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO raw_artifacts (
         id, tenant_id, sha256, source_type, source_ref, blob_uri, mime_type, bytes,
         ingested_by, source_schema, object_type, external_id, operation,
         effective_at, observed_at, original_source, intermediaries, source_id,
         source_version, idempotency_key
       )
       VALUES ($1, $2, $3, 'other', '{}'::jsonb, $4, 'text/plain', 5,
         'rls-test', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL, NULL, NULL)`,
      [artifactId, tenantId, Buffer.alloc(32, tenantId === tenantA ? 1 : 2), `${tenantId}/rls`],
    );
    await c.query(
      `INSERT INTO raw_interpretation_log (raw_artifact_id, tenant_id, source_schema, parsed_id, error)
       VALUES ($1, $2, 'rls_test.v1', NULL, 'seed row, not a real failure')`,
      [artifactId, tenantId],
    );
  });
}

DESCRIBE(
  "RLS adversarial proof: brain_app cannot read across tenants (requires DATABASE_URL + DATABASE_URL_APP)",
  () => {
    beforeAll(async () => {
      h = await buildHarness();
      if (h === null) return;

      // db-roles.sql's blanket grants (GRANT ... ON ALL TABLES IN SCHEMA public)
      // were applied against the "public" schema before this harness's per-run
      // schema existed, so brain_app has no privileges there yet. Grant them
      // here, scoped to this run's schema only. This mirrors, for the test
      // schema, exactly what db-roles.sql already did for "public" in CI.
      await h.pool.query(`GRANT USAGE ON SCHEMA ${h.schema} TO brain_app`);
      await h.pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO brain_app`,
      );

      await seedArtifact(tenantA, artifactA);
      await seedArtifact(tenantB, artifactB);

      appPool = new Pool({
        connectionString: APP_URL,
        max: 3,
        application_name: `rls-test-${h.schema}`,
      });
      appPool.on("connect", (c) => {
        void c.query(`SET search_path TO ${h!.schema}, public`);
      });
    }, 60_000);

    afterAll(async () => {
      if (appPool !== null) await appPool.end();
      if (h !== null) await h.cleanup();
    });

    it("brain_app scoped to tenant A sees zero tenant B raw_artifacts rows", async () => {
      if (h === null || appPool === null) return;
      const rows = await withTenantScope(appPool, tenantA, (c) =>
        c.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM raw_artifacts"),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      expect(rows.rows.some((r) => r.id === artifactB)).toBe(false);
    });

    it("brain_app scoped to tenant B sees zero tenant A raw_artifacts rows", async () => {
      if (h === null || appPool === null) return;
      const rows = await withTenantScope(appPool, tenantB, (c) =>
        c.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM raw_artifacts"),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === tenantB)).toBe(true);
      expect(rows.rows.some((r) => r.id === artifactA)).toBe(false);
    });

    it("brain_app scoped to tenant A sees zero tenant B raw_interpretation_log rows", async () => {
      if (h === null || appPool === null) return;
      const rows = await withTenantScope(appPool, tenantA, (c) =>
        c.query<{ raw_artifact_id: string; tenant_id: string }>(
          "SELECT raw_artifact_id, tenant_id FROM raw_interpretation_log",
        ),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      expect(rows.rows.some((r) => r.raw_artifact_id === artifactB)).toBe(false);
    });

    it("a direct query with no tenant scope set returns nothing for brain_app (fail closed)", async () => {
      if (h === null || appPool === null) return;
      // No withTenantScope: app.tenant_id is unset, so the tenant_isolation
      // policy's current_setting(...) comparison matches no row at all.
      const client = await appPool.connect();
      try {
        const rows = await client.query<{ id: string }>("SELECT id FROM raw_artifacts");
        expect(rows.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });
  },
);
