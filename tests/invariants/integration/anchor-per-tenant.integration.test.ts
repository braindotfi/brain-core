/**
 * Regression: the audit anchor publisher must scope events per-tenant.
 *
 * Bug (pre-fix): the background anchor worker in services/api/src/main.ts called
 * `publishAnchor(privilegedPool, ...)`. publishAnchor scopes events through
 * `withTenantScope(tenantId)` + RLS, but `listEventsForAnchor` filters ONLY by
 * `created_at` (no explicit tenant_id) and relies on the row-level-security
 * policy to do the scoping. The brain_privileged role is BYPASSRLS, so the scope
 * was inert: every tenant's events landed in every tenant's anchor — inflated
 * `event_count` and a Merkle root mixed across tenants. (Discovered while the
 * demo anchor endpoint reported event_count 25545 for a fresh tenant.)
 *
 * Fix: the worker enumerates tenants via the privileged pool (cross-tenant needs
 * BYPASSRLS) but PUBLISHES per-tenant through the RLS-enforced app pool
 * (NOBYPASSRLS, FORCE RLS), so withTenantScope actually isolates — exactly like
 * the manual POST /v1/audit/anchor/publish route already does.
 *
 * This test drives the REAL publishAnchor over a non-owner app role with two
 * tenants' events in the same window and asserts each tenant's anchor counts
 * only its own events. It also pins the bug: the same listEventsForAnchor query
 * run over a BYPASSRLS (owner) connection returns BOTH tenants' events, proving
 * RLS — not the query — is what scopes, and so the pool choice is load-bearing.
 *
 * Hermetic: skips entirely when DATABASE_URL is absent so `pnpm test` stays
 * DB-free. Run via `pnpm -C tests/invariants run test:integration`.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { newTenantId, withTenantScope } from "@brain/shared";
import { publishAnchor, type AnchorBroadcaster } from "@brain/audit";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

// Mirrors services/audit/src/repository.ts:listEventsForAnchor verbatim. We
// inline it rather than export an internal repo helper just for this test; the
// point is to show the query's tenant scoping comes entirely from RLS, not SQL.
const LIST_EVENTS_FOR_ANCHOR_SQL =
  "SELECT * FROM audit_events WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC, id ASC";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

// Window wide enough to span every seeded event regardless of clock; each
// tenant is unique per test, and RLS scopes the query, so a wide window only
// ever matches the tenant under scope.
const PERIOD_START = new Date("2020-01-01T00:00:00Z");
const PERIOD_END = new Date("2100-01-01T00:00:00Z");

// Deterministic broadcaster — no live RPC. Confirms with a fixed tx so the
// publisher reaches its terminal `confirmed` state (exercising the UPDATE path).
const fakeBroadcaster: AnchorBroadcaster = async () => ({
  txHash: Buffer.alloc(32, 0x11),
  blockNumber: 1n,
  status: "confirmed",
});

let adminPool: Pool;
let appPool: Pool;
let schema: string;
let appRole: string;

suite(
  "Audit anchor publisher scopes events per-tenant (integration -- requires DATABASE_URL)",
  () => {
    beforeAll(async () => {
      schema = `anchorpt_${createHash("sha1")
        .update(String(process.pid) + String(Date.now()))
        .digest("hex")
        .slice(0, 12)}`;
      appRole = `${schema}_app`;

      const bootstrap = new Client({ connectionString: DB_URL });
      await bootstrap.connect();
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await bootstrap.end();

      // Owner pool: runs migrations + seeds cross-tenant rows (bypasses RLS).
      adminPool = new Pool({
        connectionString: DB_URL,
        max: 5,
        application_name: `anchorpt-${schema}`,
      });
      adminPool.on("connect", (c) => {
        void c.query(`SET search_path TO ${schema}, public`);
      });

      const mig = await adminPool.connect();
      try {
        await mig.query(`SET search_path TO ${schema}, public`);
        const discovered = await discoverMigrations(repoRoot());
        await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
          appliedBy: "anchor-per-tenant-integration",
        });

        // FORCE RLS on every RLS-enabled table so policies apply to the owner too.
        const enabled = await mig.query<{ relname: string }>(
          `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relrowsecurity`,
          [schema],
        );
        for (const r of enabled.rows) {
          await mig.query(`ALTER TABLE ${schema}.${r.relname} FORCE ROW LEVEL SECURITY`);
        }

        // Non-owner app role mirroring brain_app: NOBYPASSRLS, full DML on the
        // audit tables (the publisher SELECTs events and INSERT/UPDATEs anchors).
        await mig.query(`DROP ROLE IF EXISTS ${appRole}`);
        await mig.query(`CREATE ROLE ${appRole} NOLOGIN`);
        await mig.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
        await mig.query(
          `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`,
        );
      } finally {
        mig.release();
      }

      // App pool: every connection runs as the non-owner role, so withTenantScope
      // inside publishAnchor is RLS-enforced (the production brain_app shape).
      appPool = new Pool({
        connectionString: DB_URL,
        max: 5,
        application_name: `anchorpt-app-${schema}`,
      });
      appPool.on("connect", (c) => {
        // One simple query (two statements) so we don't issue a second query while
        // the first is still in flight on this fresh connection.
        void c.query(`SET search_path TO ${schema}, public; SET ROLE ${appRole}`);
      });
    }, 60_000);

    afterAll(async () => {
      if (appPool !== undefined) await appPool.end();
      if (adminPool !== undefined) await adminPool.end();
      const done = new Client({ connectionString: DB_URL });
      await done.connect();
      await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await done.query(`DROP ROLE IF EXISTS ${appRole}`);
      await done.end();
    }, 60_000);

    /** Seed `n` audit_events for `tenant` as the schema OWNER (RLS bypass). */
    async function seedEvents(tenant: string, n: number, tag: string): Promise<void> {
      const c = await adminPool.connect();
      try {
        await c.query(`SET search_path TO ${schema}, public`);
        for (let i = 0; i < n; i++) {
          const id = `evt_${createHash("sha1").update(`${tenant}:${tag}:${i}`).digest("hex").slice(0, 26)}`;
          const hash = createHash("sha256").update(`${tenant}:${tag}:${i}`).digest();
          await c.query(
            `INSERT INTO audit_events (id, tenant_id, layer, actor, action, event_hash)
           VALUES ($1, $2, 'audit', 'user_seed', 'seed.event', $3)`,
            [id, tenant, hash],
          );
        }
      } finally {
        c.release();
      }
    }

    it("a per-tenant anchor's event_count counts ONLY that tenant's events", async () => {
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      const nA = 3;
      const nB = 5; // distinct from nA, nB, and nA+nB so any cross-tenant mix fails

      await seedEvents(tenantA, nA, "A");
      await seedEvents(tenantB, nB, "B");

      const anchorA = await publishAnchor(appPool, fakeBroadcaster, {
        tenantId: tenantA,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      });
      const anchorB = await publishAnchor(appPool, fakeBroadcaster, {
        tenantId: tenantB,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      });

      expect(anchorA).not.toBeNull();
      expect(anchorB).not.toBeNull();
      // The bug made BOTH report nA + nB (= 8). Per-tenant scoping pins each to its own.
      expect(anchorA?.event_count).toBe(nA);
      expect(anchorB?.event_count).toBe(nB);
      // Disjoint event sets ⇒ distinct Merkle roots (no shared/mixed root).
      expect(anchorA?.merkle_root.equals(anchorB?.merkle_root as Buffer)).toBe(false);
    });

    it("listEventsForAnchor leaks cross-tenant under BYPASSRLS, proving the pool choice is load-bearing", async () => {
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      await seedEvents(tenantA, 2, "leakA");
      await seedEvents(tenantB, 4, "leakB");

      // RLS-enforced app pool: tenant A sees only its 2 events.
      const scoped = await withTenantScope(appPool, tenantA, async (c) => {
        const { rows } = await c.query<{ tenant_id: string }>(LIST_EVENTS_FOR_ANCHOR_SQL, [
          PERIOD_START,
          PERIOD_END,
        ]);
        return rows;
      });
      expect(scoped.filter((e) => e.tenant_id === tenantA).length).toBe(2);
      expect(scoped.filter((e) => e.tenant_id === tenantB).length).toBe(0);

      // Owner pool is BYPASSRLS: the SAME query with app.tenant_id set to A still
      // returns B's events too — this is exactly why the worker must NOT publish
      // through the privileged pool. (Guards against a future "optimization" that
      // swaps the app pool back to the privileged one.)
      const leaked = await withTenantScope(adminPool, tenantA, async (c) => {
        const { rows } = await c.query<{ tenant_id: string }>(LIST_EVENTS_FOR_ANCHOR_SQL, [
          PERIOD_START,
          PERIOD_END,
        ]);
        return rows;
      });
      expect(leaked.some((e) => e.tenant_id === tenantB)).toBe(true);
    });
  },
);
