/**
 * Regression: anchor orphan recovery must not use the request pool.
 *
 * The reconciler's orphan query is cross-tenant and runs with no app.tenant_id
 * set. Under a NOBYPASSRLS request role plus FORCE RLS, that query sees zero
 * rows and reports a false-clean cycle. The verifier role must see the orphan
 * anchors across tenants.
 *
 * Requires DATABASE_URL with role-management privileges; skips otherwise.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import { newTenantId, withTenantScope } from "@brain/shared";
import { reconcileOrphanedAnchors } from "@brain/audit";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

let ownerPool: Pool;
let appPool: Pool | undefined;
let verifierPool: Pool | undefined;
let schema: string;
let appRole: string;
let verifierRole: string;
let rolesReady = false;

suite("anchor reconciler RLS visibility (integration -- requires DATABASE_URL)", () => {
  beforeAll(async () => {
    schema = `anchorrecon_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    appRole = `${schema}_app`;
    verifierRole = `${schema}_verifier`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    ownerPool = new Pool({
      connectionString: DB_URL,
      max: 5,
      application_name: `anchorrecon-${schema}`,
    });
    ownerPool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });

    const mig = await ownerPool.connect();
    try {
      await mig.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "anchor-reconciler-rls-integration",
      });

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

      try {
        await mig.query(`DROP ROLE IF EXISTS ${appRole}`);
        await mig.query(`DROP ROLE IF EXISTS ${verifierRole}`);
        await mig.query(`CREATE ROLE ${appRole} NOLOGIN NOBYPASSRLS`);
        await mig.query(`CREATE ROLE ${verifierRole} NOLOGIN BYPASSRLS`);
        await mig.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}, ${verifierRole}`);
        await mig.query(`GRANT SELECT ON ${schema}.audit_anchors TO ${appRole}`);
        await mig.query(`GRANT SELECT, UPDATE ON ${schema}.audit_anchors TO ${verifierRole}`);
        rolesReady = true;
      } catch {
        rolesReady = false;
      }
    } finally {
      mig.release();
    }

    if (!rolesReady) return;

    appPool = new Pool({ connectionString: DB_URL, max: 2, application_name: appRole });
    appPool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public; SET ROLE ${appRole}`);
    });
    verifierPool = new Pool({
      connectionString: DB_URL,
      max: 2,
      application_name: verifierRole,
    });
    verifierPool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public; SET ROLE ${verifierRole}`);
    });

    for (const tenant of [newTenantId(), newTenantId()]) {
      await withTenantScope(ownerPool, tenant, async (c) => {
        await c.query(
          `INSERT INTO audit_anchors
             (id, tenant_id, merkle_root, event_count, period_start, period_end)
           VALUES ($1,$2,$3,1,now() - interval '1 hour', now())`,
          [`anchor_${tenant.slice(4)}`, tenant, createHash("sha256").update(tenant).digest()],
        );
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (appPool !== undefined) await appPool.end();
    if (verifierPool !== undefined) await verifierPool.end();
    if (ownerPool !== undefined) await ownerPool.end();
    const done = new Client({ connectionString: DB_URL });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.query(`DROP ROLE IF EXISTS ${appRole}`);
    await done.query(`DROP ROLE IF EXISTS ${verifierRole}`);
    await done.end();
  }, 60_000);

  it("false-cleans under the request role but sees orphans under the verifier role", async () => {
    if (!rolesReady || appPool === undefined || verifierPool === undefined) {
      return;
    }

    const requestVisible = await appPool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM audit_anchors
        WHERE onchain_tx_hash IS NULL AND onchain_status <> 'reverted'`,
    );
    expect(Number(requestVisible.rows[0]?.n ?? 0)).toBe(0);

    const reader = { findAnchorTx: vi.fn(async () => null) };
    const audit = { emit: vi.fn(async () => ({ id: "evt_test" })) };
    const result = await reconcileOrphanedAnchors(
      { privilegedPool: verifierPool, reader, audit },
      { orphanGraceMs: 24 * 60 * 60 * 1000 },
    );

    expect(result).toEqual({ recovered: 0, flagged: 0 });
    expect(reader.findAnchorTx).toHaveBeenCalledTimes(2);
  });
});
