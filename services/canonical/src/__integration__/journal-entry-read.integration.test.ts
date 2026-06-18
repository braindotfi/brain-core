/**
 * Integration test for the canonical journal-entry governed read (Phase 6).
 *
 * Seeds a journal entry + its debit/credit lines and a projection-log row, then
 * asserts the read returns the header, the aggregated lines (ordered), and the
 * provenance + freshness envelope. Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  newCanonicalJournalEntryId,
  newCanonicalJournalLineId,
  newRawParsedId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { getJournalEntryProduct, listJournalEntryProducts } from "../query/journal-entries.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("canonical journal-entry read (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "user_test" };
  const jeId = newCanonicalJournalEntryId();
  const evidenceId = newRawParsedId();

  async function seedLine(
    lineNumber: number,
    direction: string,
    amount: string,
    key: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO canonical_journal_line
         (id, tenant_id, journal_entry_id, line_number, gl_account_key, direction, amount, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD')`,
      [newCanonicalJournalLineId(), tenant, jeId, lineNumber, key, direction, amount],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO canonical_journal_entry
         (id, tenant_id, source_system, source_natural_key, posted_at, memo, currency, status,
          provenance, confidence, source_ids, evidence_ids)
       VALUES ($1,$2,'netsuite','je_77','2026-06-01T00:00:00Z','Equipment purchase','USD','POSTED',
               'extracted',NULL,'{}'::text[],$3::text[])`,
      [jeId, tenant, [evidenceId]],
    );
    await seedLine(1, "debit", "1250.00", "acct_equip");
    await seedLine(2, "credit", "1250.00", "acct_cash");
    await pool.query(
      `INSERT INTO canonical_projection_log (raw_parsed_id, tenant_id, projector, domain, records_written)
       VALUES ($1,$2,'merge_accounting_canonical_v1','accounting',1)`,
      [evidenceId, tenant],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_journal_line WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_journal_entry WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  it("returns the journal entry with its ordered debit/credit lines + provenance + freshness", async () => {
    const p = await getJournalEntryProduct(pool, ctx, jeId);
    expect(p).not.toBeNull();
    expect(p!.domain).toBe("accounting");
    expect(p!.record.memo).toBe("Equipment purchase");
    expect(p!.record.lines).toHaveLength(2);
    expect(p!.record.lines.map((l) => l.direction)).toEqual(["debit", "credit"]);
    expect(p!.record.lines[0]!.gl_account_key).toBe("acct_equip");
    expect(Number(p!.record.lines[0]!.amount)).toBe(1250);
    expect(p!.provenance.provenance).toBe("extracted");
    expect(p!.freshness.projector).toBe("merge_accounting_canonical_v1");
  });

  it("lists journal entries; null for an unknown id", async () => {
    const list = await listJournalEntryProducts(pool, ctx, 50);
    expect(list.some((p) => p.record.id === jeId)).toBe(true);
    expect(await getJournalEntryProduct(pool, ctx, "cje_missing")).toBeNull();
  });
});
