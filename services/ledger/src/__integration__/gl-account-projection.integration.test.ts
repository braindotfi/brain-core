/**
 * Integration test for the Ledger chart-of-accounts projection (RFC 0005, PR-C).
 *
 * Proves the Phase 5 acceptance criterion against a real database: the Ledger
 * rebuilds its GL-account projection from the canonical store ALONE (no provider
 * contact), idempotently, and a human correction (a confirmed account name)
 * survives a subsequent rebuild while provider-derived fields refresh.
 *
 * Requires DATABASE_URL; skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  newCanonicalGlAccountId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import {
  confirmGlAccountName,
  rebuildAccountingProjectionFromCanonical,
} from "../projection/gl-accounts.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("ledger GL-account projection integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "sys_test" };
  const audit = new InMemoryAuditEmitter();
  const equipId = newCanonicalGlAccountId();
  const cashId = newCanonicalGlAccountId();

  async function seedCanonical(
    id: string,
    key: string,
    name: string,
    classification: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO canonical_gl_account
         (id, tenant_id, source_system, source_natural_key, name, classification, provenance, confidence)
       VALUES ($1,$2,'netsuite',$3,$4,$5,'extracted',NULL)`,
      [id, tenant, key, name, classification],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await seedCanonical(equipId, "acct_equip", "Equipment", "asset");
    await seedCanonical(cashId, "acct_cash", "Cash", "asset");
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM ledger_gl_accounts WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_gl_account WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  async function projectionRows(): Promise<
    Array<{ id: string; name: string; provenance: string; classification: string }>
  > {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      provenance: string;
      classification: string;
    }>(
      `SELECT id, name, provenance, classification FROM ledger_gl_accounts
        WHERE tenant_id = $1 ORDER BY source_natural_key`,
      [tenant],
    );
    return rows;
  }

  it("rebuilds the projection from canonical alone", async () => {
    const result = await rebuildAccountingProjectionFromCanonical(pool, audit, ctx);
    expect(result.projected).toBe(2);

    const rows = await projectionRows();
    expect(rows.map((r) => r.name)).toEqual(["Cash", "Equipment"]);
    expect(rows.every((r) => r.provenance === "extracted")).toBe(true);
    expect(audit.events.some((e) => e.action === "ledger.accounting_projection.rebuilt")).toBe(
      true,
    );
  });

  it("preserves a human-confirmed name across rebuild while refreshing provider fields", async () => {
    // A human renames the "Equipment" account and confirms it.
    const equip = (await projectionRows()).find(
      (r) => r.classification === "asset" && r.name === "Equipment",
    )!;
    await confirmGlAccountName(pool, audit, ctx, equip.id, "Capital Equipment (FY26)");

    // Provider data later reclassifies the account; rebuild from canonical.
    await pool.query(
      `UPDATE canonical_gl_account SET classification = 'expense', updated_at = now()
        WHERE id = $1`,
      [equipId],
    );
    await rebuildAccountingProjectionFromCanonical(pool, audit, ctx);

    const { rows } = await pool.query<{ name: string; provenance: string; classification: string }>(
      `SELECT name, provenance, classification FROM ledger_gl_accounts
        WHERE tenant_id = $1 AND source_natural_key = 'acct_equip'`,
      [tenant],
    );
    const row = rows[0]!;
    // Human name + provenance survive the rebuild (overlay reapplication)...
    expect(row.name).toBe("Capital Equipment (FY26)");
    expect(row.provenance).toBe("human_confirmed");
    // ...but the provider-derived classification refreshed from canonical.
    expect(row.classification).toBe("expense");
  });

  it("is idempotent: a third rebuild changes nothing and adds no rows", async () => {
    await rebuildAccountingProjectionFromCanonical(pool, audit, ctx);
    const rows = await projectionRows();
    expect(rows).toHaveLength(2);
    const equip = rows.find((r) => r.name === "Capital Equipment (FY26)");
    expect(equip).toBeDefined();
    expect(equip!.provenance).toBe("human_confirmed");
  });
});
