/**
 * Real-DB regression for the `agent_proposals` table: RLS tenant isolation,
 * decide round-trip persistence, and a concurrent-decide race.
 *
 * Requires a migrated Postgres via DATABASE_URL; skipped otherwise.
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

DESCRIBE("agent_proposals (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenantA = newTenantId();
  const tenantB = newTenantId();

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    for (const tenantId of [tenantA, tenantB]) {
      await withTenantScope(pool, tenantId, async (c) => {
        await c.query(`DELETE FROM agent_proposals WHERE tenant_id = $1`, [tenantId]);
      });
    }
    await pool.end();
  });

  it("RLS: tenant B cannot read tenant A's row", async () => {
    const row = await withTenantScope(pool, tenantA, (c) =>
      insertAgentProposal(c, proposalInput(tenantA)),
    );

    const seenFromB = await withTenantScope(pool, tenantB, (c) => getAgentProposal(c, row.id));
    expect(seenFromB).toBeNull();

    const seenFromA = await withTenantScope(pool, tenantA, (c) => getAgentProposal(c, row.id));
    expect(seenFromA?.id).toBe(row.id);
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
