/**
 * Integration test for the Ledger AP/AR projection (Phase 5 deep refactor, PR-F).
 *
 * Proves, against a real database and a FRESH tenant (no extractor-written rows,
 * so production behaviour is untouched): the Ledger rebuilds obligations +
 * counterparties from canonical alone, resolves the counterparty link, and a
 * rebuild preserves the Phase-4 overlay -- a corroboration-lifted obligation
 * confidence and a human-confirmed counterparty name both survive while
 * provider-derived fields refresh. Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  newCanonicalCounterpartyId,
  newCanonicalObligationId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { rebuildAparProjectionFromCanonical } from "../projection/obligations.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("ledger AP/AR projection integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "sys_test" };
  const audit = new InMemoryAuditEmitter();
  const cpId = newCanonicalCounterpartyId();
  const oblId = newCanonicalObligationId();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO canonical_counterparty
         (id, tenant_id, source_system, source_natural_key, name, normalized_name, type, provenance, confidence)
       VALUES ($1,$2,'netsuite','con_acme','Acme Supply','acme_supply','vendor','extracted',NULL)`,
      [cpId, tenant],
    );
    await pool.query(
      `INSERT INTO canonical_obligation
         (id, tenant_id, source_system, source_natural_key, direction, type,
          canonical_counterparty_id, counterparty_source_key, amount, currency, due_date, status, provenance, confidence)
       VALUES ($1,$2,'netsuite','inv_1004','payable','bill',$3,'con_acme','1250.00','USD','2026-07-01','OPEN','extracted',NULL)`,
      [oblId, tenant, cpId],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM ledger_invoices WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM ledger_obligations WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM ledger_counterparties WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  it("rebuilds obligations + counterparties from canonical with the link resolved", async () => {
    const result = await rebuildAparProjectionFromCanonical(pool, audit, ctx);
    expect(result).toEqual({ counterparties: 1, obligations: 1, invoices: 0 });

    const { rows: obls } = await pool.query<{
      direction: string;
      type: string;
      amount_due: string;
      provenance: string;
      confidence: number;
      counterparty_id: string;
    }>(
      `SELECT direction, type, amount_due, provenance, confidence, counterparty_id
         FROM ledger_obligations WHERE owner_id = $1`,
      [tenant],
    );
    expect(obls).toHaveLength(1);
    expect(obls[0]!.direction).toBe("payable");
    expect(obls[0]!.type).toBe("bill");
    expect(Number(obls[0]!.amount_due)).toBe(1250);
    expect(obls[0]!.provenance).toBe("extracted");
    expect(obls[0]!.confidence).toBeCloseTo(0.85, 5);

    const { rows: cps } = await pool.query<{ id: string; type: string; confidence: number }>(
      `SELECT id, type, confidence FROM ledger_counterparties WHERE owner_id = $1`,
      [tenant],
    );
    expect(cps).toHaveLength(1);
    expect(cps[0]!.type).toBe("vendor");
    expect(obls[0]!.counterparty_id).toBe(cps[0]!.id); // link resolved
  });

  it("preserves a corroboration lift + a human-confirmed name across rebuild", async () => {
    // Phase-4 corroboration lifted the obligation's confidence; a human renamed
    // and confirmed the counterparty. Both are non-provider authority (§13).
    await pool.query(
      `UPDATE ledger_obligations SET confidence = 0.9 WHERE owner_id = $1 AND canonical_obligation_id = $2`,
      [tenant, oblId],
    );
    await pool.query(
      `UPDATE ledger_counterparties
          SET name = 'Acme Supply Co. (confirmed)', provenance = 'human_confirmed'
        WHERE owner_id = $1 AND canonical_counterparty_id = $2`,
      [tenant, cpId],
    );

    await rebuildAparProjectionFromCanonical(pool, audit, ctx);

    const { rows: obls } = await pool.query<{ confidence: number; provenance: string }>(
      `SELECT confidence, provenance FROM ledger_obligations WHERE owner_id = $1`,
      [tenant],
    );
    // Corroboration lift survives (GREATEST keeps 0.9, not reset to 0.85).
    expect(obls[0]!.confidence).toBeCloseTo(0.9, 5);

    const { rows: cps } = await pool.query<{ name: string; provenance: string; type: string }>(
      `SELECT name, provenance, type FROM ledger_counterparties WHERE owner_id = $1`,
      [tenant],
    );
    expect(cps[0]!.name).toBe("Acme Supply Co. (confirmed)"); // human name survives
    expect(cps[0]!.provenance).toBe("human_confirmed");
    expect(cps[0]!.type).toBe("vendor"); // provider field still refreshed
  });

  it("is idempotent: a third rebuild adds no rows", async () => {
    await rebuildAparProjectionFromCanonical(pool, audit, ctx);
    const { rows: o } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_obligations WHERE owner_id = $1`,
      [tenant],
    );
    const { rows: c } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_counterparties WHERE owner_id = $1`,
      [tenant],
    );
    expect(Number(o[0]!.n)).toBe(1);
    expect(Number(c[0]!.n)).toBe(1);
  });

  it("keeps canonical obligations out of the legacy content dedup target", async () => {
    const secondObligation = newCanonicalObligationId();
    await pool.query(
      `INSERT INTO canonical_obligation
         (id, tenant_id, source_system, source_natural_key, direction, type,
          canonical_counterparty_id, counterparty_source_key, amount, currency, due_date, status, provenance, confidence)
       VALUES ($1,$2,'netsuite','inv_1005','payable','bill',$3,'con_acme','1250.00','USD','2026-07-01','OPEN','extracted',NULL)`,
      [secondObligation, tenant, cpId],
    );

    const result = await rebuildAparProjectionFromCanonical(pool, audit, ctx);
    expect(result).toEqual({ counterparties: 1, obligations: 2, invoices: 0 });

    const { rows } = await pool.query<{ external_key: string }>(
      `SELECT external_key
         FROM ledger_obligations
        WHERE owner_id = $1
        ORDER BY external_key`,
      [tenant],
    );
    expect(rows.map((row) => row.external_key)).toEqual([
      `canonical:${oblId}`,
      `canonical:${secondObligation}`,
    ]);
  });

  it("projects document-upload receivables and payroll obligations into compact AP/AR tables", async () => {
    const documentTenant = newTenantId();
    const arCounterparty = newCanonicalCounterpartyId();
    const payrollCounterpartyA = newCanonicalCounterpartyId();
    const payrollCounterpartyB = newCanonicalCounterpartyId();
    const invoiceObligation = newCanonicalObligationId();
    const payrollObligationA = newCanonicalObligationId();
    const payrollObligationB = newCanonicalObligationId();
    const documentCtx: ServiceCallContext = { tenantId: documentTenant, actor: "sys_test" };

    try {
      await pool.query(
        `INSERT INTO canonical_counterparty
           (id, tenant_id, source_system, source_natural_key, name, normalized_name,
            type, provenance, confidence, source_ids, evidence_ids)
         VALUES
           ($1,$2,'document_upload','customer_helios','Helios','helios','customer','extracted',0.72,ARRAY['raw_ar'],ARRAY['prs_ar']),
           ($3,$2,'document_upload','payroll_2026_06A','Payroll 2026-06A','payroll_2026_06a','employee','extracted',0.9,ARRAY['raw_payroll'],ARRAY['prs_payroll']),
           ($4,$2,'document_upload','payroll_2026_06B','Payroll 2026-06B','payroll_2026_06b','employee','extracted',0.9,ARRAY['raw_payroll'],ARRAY['prs_payroll'])`,
        [arCounterparty, documentTenant, payrollCounterpartyA, payrollCounterpartyB],
      );
      await pool.query(
        `INSERT INTO canonical_obligation
           (id, tenant_id, source_system, source_natural_key, direction, type,
            canonical_counterparty_id, counterparty_source_key, amount, currency,
            issue_date, due_date, status, provenance, confidence, source_ids,
            evidence_ids, extensions)
         VALUES
           ($1,$2,'document_upload','invoice_NL_2417','receivable','invoice',
            $3,'customer_helios','1200.00','USD','2026-05-01','2026-05-22','OPEN',
            'extracted',0.72,ARRAY['raw_ar'],ARRAY['prs_ar'],
            '{ "document_upload": { "invoice_ref": "NL-2417" } }'::jsonb),
           ($4,$2,'document_upload','payroll_2026_06A','payable','payroll',
            $5,'payroll_2026_06A','29612.42','USD','2026-06-12','2026-06-12','OPEN',
            'extracted',0.9,ARRAY['raw_payroll'],ARRAY['prs_payroll'],'{}'::jsonb),
           ($6,$2,'document_upload','payroll_2026_06B','payable','payroll',
            $7,'payroll_2026_06B','29612.42','USD','2026-06-26','2026-06-26','OPEN',
            'extracted',0.9,ARRAY['raw_payroll'],ARRAY['prs_payroll'],'{}'::jsonb)`,
        [
          invoiceObligation,
          documentTenant,
          arCounterparty,
          payrollObligationA,
          payrollCounterpartyA,
          payrollObligationB,
          payrollCounterpartyB,
        ],
      );

      const result = await rebuildAparProjectionFromCanonical(pool, audit, documentCtx);
      expect(result).toEqual({ counterparties: 3, obligations: 3, invoices: 1 });

      const { rows: obligations } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM ledger_obligations
          WHERE owner_id = $1
            AND canonical_obligation_id = ANY($2::text[])`,
        [documentTenant, [invoiceObligation, payrollObligationA, payrollObligationB]],
      );
      expect(Number(obligations[0]!.n)).toBe(3);

      const { rows: invoices } = await pool.query<{
        invoice_number: string;
        amount_due: string;
        source_ids: string[];
        evidence_ids: string[];
      }>(
        `SELECT invoice_number, amount_due, source_ids, evidence_ids
           FROM ledger_invoices
          WHERE owner_id = $1 AND canonical_obligation_id = $2`,
        [documentTenant, invoiceObligation],
      );
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        invoice_number: "NL-2417",
        source_ids: ["raw_ar"],
        evidence_ids: ["prs_ar"],
      });
      expect(Number(invoices[0]!.amount_due)).toBe(1200);
    } finally {
      await pool.query(`DELETE FROM ledger_invoices WHERE owner_id = $1`, [documentTenant]);
      await pool.query(`DELETE FROM ledger_obligations WHERE owner_id = $1`, [documentTenant]);
      await pool.query(`DELETE FROM ledger_counterparties WHERE owner_id = $1`, [documentTenant]);
      await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [documentTenant]);
      await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [documentTenant]);
    }
  });
});
