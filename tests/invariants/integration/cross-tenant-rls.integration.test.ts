/**
 * Batch 13: cross-tenant RLS visibility, per data-bearing table.
 *
 * The existing `db-invariants.integration.test.ts` proves the property on
 * audit_events (one table). This file widens the proof to one table per layer
 * of the money path. Together with the policy-presence test in
 * db-invariants ("every tenant-scoped table has an enabled RLS policy"), the
 * pair establishes both COVERAGE (the policy exists on every table) AND
 * ENFORCEMENT (the policy actually filters under the non-owner app role) at
 * every layer that touches money.
 *
 * Probe shape (mirrors db-invariants):
 *
 *   1. Construct a fresh per-run schema, run all migrations, FORCE RLS on
 *      every enabled table, mint a non-owner role that has SELECT/INSERT
 *      grants only. The schema owner bypasses RLS regardless of FORCE, so
 *      every probe runs `SET LOCAL ROLE <appRole>` first.
 *
 *   2. As the pooled owner (which bypasses RLS), seed one row keyed to
 *      tenant A in each target table.
 *
 *   3. As the appRole with `app.tenant_id` SET to tenant B, count rows
 *      visible. Expect ZERO across every table.
 *
 *   4. Same row, same appRole, this time with `app.tenant_id` SET to tenant
 *      A. Expect exactly ONE row visible. This second assertion guards
 *      against the false-positive case where the policy filters EVERYTHING
 *      (which would also pass "tenant B sees 0").
 *
 * Hermetic by design: skips entirely when DATABASE_URL is absent so
 * `pnpm test` stays DB-free. The integration vitest config picks this file up
 * via `pnpm -C tests/invariants run test:integration`.
 *
 * Opus 4.8 batch-13 ask. Adds layer coverage across Ledger, Policy, Agent
 * (PaymentIntent rows), Wiki, and the agents table itself.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { newTenantId } from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

let pool: Pool;
let schema: string;
let appRole: string;

suite("Cross-tenant RLS, per data-bearing table (integration -- requires DATABASE_URL)", () => {
  beforeAll(async () => {
    schema = `xtrls_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    appRole = `${schema}_app`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: `xtrls-${schema}` });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });

    const mig = await pool.connect();
    try {
      await mig.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "cross-tenant-rls-integration",
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

      // Non-owner app role. SELECT/INSERT are enough -- this suite only reads.
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

  /**
   * Run `query` as the non-owner appRole with `app.tenant_id` SET to `tenant`,
   * and return the number of rows it returned. The role / scope set is per-
   * transaction (SET LOCAL), so each call is isolated.
   */
  async function countAs(query: string, params: unknown[], tenant: string): Promise<number> {
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${appRole}`);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const res = await c.query(query, params);
      await c.query("ROLLBACK");
      return res.rows.length;
    } finally {
      c.release();
    }
  }

  /** Seed as the schema OWNER (RLS bypass) so we can construct cross-tenant rows. */
  async function seedOwner(sql: string, params: unknown[]): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query(sql, params);
    } finally {
      c.release();
    }
  }

  // ------ Ledger (layer 2) ------------------------------------------------

  it("ledger_counterparties: tenant B cannot see tenant A's row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const cpId = `cp_${createHash("sha1").update(`${a}:cp`).digest("hex").slice(0, 26)}`;
    await seedOwner(
      `INSERT INTO ledger_counterparties
         (id, owner_id, type, name, normalized_name, source_ids, evidence_ids, provenance, confidence)
       VALUES ($1, $2, 'vendor', 'Acme', 'acme', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'extracted', 0.9)`,
      [cpId, a],
    );
    expect(await countAs("SELECT id FROM ledger_counterparties WHERE id = $1", [cpId], b)).toBe(0);
    expect(await countAs("SELECT id FROM ledger_counterparties WHERE id = $1", [cpId], a)).toBe(1);
  });

  it("ledger_obligations: tenant B cannot see tenant A's row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const cpId = `cp_${createHash("sha1").update(`${a}:obl-cp`).digest("hex").slice(0, 26)}`;
    const oblId = `obl_${createHash("sha1").update(`${a}:obl`).digest("hex").slice(0, 26)}`;
    await seedOwner(
      `INSERT INTO ledger_counterparties
         (id, owner_id, type, name, normalized_name, source_ids, evidence_ids, provenance, confidence)
       VALUES ($1, $2, 'vendor', 'Acme', 'acme', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'extracted', 0.9)`,
      [cpId, a],
    );
    await seedOwner(
      `INSERT INTO ledger_obligations
         (id, owner_id, type, counterparty_id, amount_due, currency, due_date,
          status, source_ids, evidence_ids, provenance, confidence)
       VALUES ($1, $2, 'bill', $3, '100.00', 'USD', '2026-12-31T00:00:00Z',
               'upcoming', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'extracted', 0.9)`,
      [oblId, a, cpId],
    );
    expect(await countAs("SELECT id FROM ledger_obligations WHERE id = $1", [oblId], b)).toBe(0);
    expect(await countAs("SELECT id FROM ledger_obligations WHERE id = $1", [oblId], a)).toBe(1);
  });

  // ------ Policy (layer 4) ------------------------------------------------

  it("policies: tenant B cannot see tenant A's policy row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const polId = `pol_${createHash("sha1").update(`${a}:pol`).digest("hex").slice(0, 26)}`;
    const userId = `user_${createHash("sha1").update(`${a}:user`).digest("hex").slice(0, 26)}`;
    await seedOwner(
      `INSERT INTO policies
         (id, tenant_id, version, content, content_hash, quorum_required, state, created_by)
       VALUES ($1, $2, 1, '{}'::jsonb, $3, 1, 'active', $4)`,
      [polId, a, Buffer.from("00".repeat(32), "hex"), userId],
    );
    expect(await countAs("SELECT id FROM policies WHERE id = $1", [polId], b)).toBe(0);
    expect(await countAs("SELECT id FROM policies WHERE id = $1", [polId], a)).toBe(1);
  });

  // ------ Agent layer / PaymentIntent (layer 5) ---------------------------

  it("ledger_payment_intents: tenant B cannot see tenant A's row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const cpId = `cp_${createHash("sha1").update(`${a}:pi-cp`).digest("hex").slice(0, 26)}`;
    const acctId = `acct_${createHash("sha1").update(`${a}:pi-acct`).digest("hex").slice(0, 26)}`;
    const piId = `pi_${createHash("sha1").update(`${a}:pi`).digest("hex").slice(0, 26)}`;
    await seedOwner(
      `INSERT INTO ledger_counterparties
         (id, owner_id, type, name, normalized_name, source_ids, evidence_ids, provenance, confidence)
       VALUES ($1, $2, 'vendor', 'Acme', 'acme', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'extracted', 0.9)`,
      [cpId, a],
    );
    await seedOwner(
      `INSERT INTO ledger_accounts
         (id, owner_id, type, name, currency, status, source_ids, evidence_ids, provenance, confidence)
       VALUES ($1, $2, 'bank_checking', 'Checking', 'USD', 'active',
               ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'extracted', 0.9)`,
      [acctId, a],
    );
    await seedOwner(
      `INSERT INTO ledger_payment_intents
         (id, owner_id, action_type, source_account_id, destination_counterparty_id,
          amount, currency, status, evidence_ids)
       VALUES ($1, $2, 'ach_outbound', $3, $4, '10.00', 'USD', 'approved', ARRAY[]::TEXT[])`,
      [piId, a, acctId, cpId],
    );
    expect(await countAs("SELECT id FROM ledger_payment_intents WHERE id = $1", [piId], b)).toBe(0);
    expect(await countAs("SELECT id FROM ledger_payment_intents WHERE id = $1", [piId], a)).toBe(1);
  });

  // ------ Agents (the registration table itself) --------------------------

  it("agents: tenant B cannot see tenant A's agent row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const agentId = `agent_${createHash("sha1").update(`${a}:agent`).digest("hex").slice(0, 26)}`;
    await seedOwner(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state)
       VALUES ($1, $2, 'internal', 'payment', 'Payment Agent', 'active')`,
      [agentId, a],
    );
    expect(await countAs("SELECT id FROM agents WHERE id = $1", [agentId], b)).toBe(0);
    expect(await countAs("SELECT id FROM agents WHERE id = $1", [agentId], a)).toBe(1);
  });

  // ------ Wiki (layer 3) --------------------------------------------------

  it("wiki_pages: tenant B cannot see tenant A's row", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const pageId = `wpg_${createHash("sha1").update(`${a}:wpg`).digest("hex").slice(0, 26)}`;
    // wiki_pages keys on tenant_id (not owner_id) and its real NOT NULL columns
    // are page_type / slug / body_md / source_revision.
    await seedOwner(
      `INSERT INTO wiki_pages
         (id, tenant_id, page_type, subject_id, slug, body_md, source_revision)
       VALUES ($1, $2, 'counterparty', 'cp_seed', $3, 'body', 'rev1')`,
      [pageId, a, `/counterparty/${pageId}`],
    );
    expect(await countAs("SELECT id FROM wiki_pages WHERE id = $1", [pageId], b)).toBe(0);
    expect(await countAs("SELECT id FROM wiki_pages WHERE id = $1", [pageId], a)).toBe(1);
  });
});
