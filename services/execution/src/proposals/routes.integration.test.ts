/**
 * Real-DB regression for the `agent_proposals` table: RLS tenant isolation,
 * decide round-trip persistence, and a concurrent-decide race.
 *
 * Requires a migrated Postgres via DATABASE_URL; skipped otherwise.
 *
 * RLS assertion note: CI's DATABASE_URL connects as the Postgres superuser
 * (the migration owner), and superusers bypass row security unconditionally
 * -- FORCE ROW LEVEL SECURITY notwithstanding (Postgres docs: "superusers
 * ... bypass the row security system"). So the isolation check below runs
 * through a transient, non-superuser role instead, mirroring
 * tests/invariants/integration/cross-tenant-rls.integration.test.ts (mint a
 * NOLOGIN role with SELECT only, `SET LOCAL ROLE` inside a rolled-back
 * transaction, assert row visibility per tenant). The decide round-trip and
 * concurrent-race tests don't depend on RLS, so they stay on the default
 * (superuser) pool connection.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { newTenantId, withTenantScope } from "@brain/shared";
import {
  decideAgentProposal,
  getAgentProposal,
  insertAgentProposal,
  type InsertAgentProposalInput,
} from "./repository.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

const NON_BYPASS_ROLE = "agent_proposals_rls_probe";

function proposalInput(tenantId: string): InsertAgentProposalInput {
  return {
    tenantId,
    type: "vendor_risk",
    agentPrincipal: "agent_integration",
    riskBand: "elevated",
    executionMode: "propose",
    title: "Integration test proposal",
    narrative: "narrative",
  };
}

/**
 * DROP ROLE fails with "cannot be dropped because some objects depend on it"
 * while the role still holds a GRANT -- REVOKE first (a no-op, wrapped in a
 * DO block, when the role doesn't exist yet).
 */
async function dropProbeRole(admin: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${NON_BYPASS_ROLE}') THEN
        EXECUTE 'REVOKE ALL ON agent_proposals FROM ${NON_BYPASS_ROLE}';
        EXECUTE 'DROP ROLE ${NON_BYPASS_ROLE}';
      END IF;
    END $$;
  `);
}

DESCRIBE("agent_proposals (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenantA = newTenantId();
  const tenantB = newTenantId();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const admin = await pool.connect();
    try {
      await dropProbeRole(admin);
      await admin.query(`CREATE ROLE ${NON_BYPASS_ROLE} NOLOGIN`);
      await admin.query(`GRANT SELECT ON agent_proposals TO ${NON_BYPASS_ROLE}`);
    } finally {
      admin.release();
    }
  });

  afterAll(async () => {
    if (pool === undefined) return;
    for (const tenantId of [tenantA, tenantB]) {
      await withTenantScope(pool, tenantId, async (c) => {
        await c.query(`DELETE FROM agent_proposals WHERE tenant_id = $1`, [tenantId]);
      });
    }
    const admin = await pool.connect();
    try {
      await dropProbeRole(admin);
    } finally {
      admin.release();
    }
    await pool.end();
  });

  /**
   * Read a row by id as the transient non-bypass role, tenant-scoped, inside
   * a transaction that always rolls back (so the role switch and tenant
   * scope never leak past this one probe).
   */
  async function readAsNonBypassRole(id: string, tenant: string): Promise<{ id: string } | null> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${NON_BYPASS_ROLE}`);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const res = await c.query<{ id: string }>(`SELECT id FROM agent_proposals WHERE id = $1`, [
        id,
      ]);
      return res.rows[0] ?? null;
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("RLS: tenant B cannot read tenant A's row", async () => {
    const row = await withTenantScope(pool, tenantA, (c) =>
      insertAgentProposal(c, proposalInput(tenantA)),
    );

    expect(await readAsNonBypassRole(row.id, tenantB)).toBeNull();
    expect(await readAsNonBypassRole(row.id, tenantA)).toMatchObject({ id: row.id });
  });

  it("decide round-trip persists status, decision, decided_by, decided_at", async () => {
    const row = await withTenantScope(pool, tenantA, (c) =>
      insertAgentProposal(c, proposalInput(tenantA)),
    );

    const updated = await withTenantScope(pool, tenantA, (c) =>
      decideAgentProposal(c, {
        id: row.id,
        expectedStatus: "needs_review",
        status: "approved",
        decision: "approved",
        decidedBy: "usr_integration",
      }),
    );
    expect(updated.status).toBe("approved");
    expect(updated.decision).toBe("approved");
    expect(updated.decided_by).toBe("usr_integration");
    expect(updated.decided_at).not.toBeNull();

    const reread = await withTenantScope(pool, tenantA, (c) => getAgentProposal(c, row.id));
    expect(reread?.status).toBe("approved");
    expect(reread?.decided_by).toBe("usr_integration");
  });

  it("concurrent decide: exactly one wins, the other loses the CAS", async () => {
    const row = await withTenantScope(pool, tenantA, (c) =>
      insertAgentProposal(c, proposalInput(tenantA)),
    );

    const attempt = () =>
      withTenantScope(pool, tenantA, (c) =>
        decideAgentProposal(c, {
          id: row.id,
          expectedStatus: "needs_review",
          status: "approved",
          decision: "approved",
          decidedBy: "usr_race",
        }),
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "agent_proposal_invalid_state",
    });
  });
});
