/**
 * Integration test for the governed canonical read query layer (Phase 6).
 *
 * Proves against a real database: a canonical obligation reads back as a
 * governed data product (record + provenance + freshness joined from the
 * projection log) and the direction filter works. Tenant isolation is enforced
 * by RLS (the query carries no explicit tenant filter, matching the other
 * read services) and is covered by the dedicated cross-tenant-rls suite, which
 * runs under the brain_app role; this suite runs as the DB owner. Requires
 * DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  newCanonicalObligationId,
  newRawArtifactId,
  newRawParsedId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { getObligationProduct, listObligationProducts } from "../query/obligations.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("canonical read API query layer (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "user_test" };
  const payableId = newCanonicalObligationId();
  const receivableId = newCanonicalObligationId();
  const evidenceId = newRawParsedId();

  async function seedObligation(
    id: string,
    tenantId: string,
    direction: string,
    evidenceIds: string[],
  ): Promise<void> {
    await pool.query(
      `INSERT INTO canonical_obligation
         (id, tenant_id, source_system, source_natural_key, direction, type, amount, currency,
          due_date, status, provenance, confidence, source_ids, evidence_ids)
       VALUES ($1,$2,'netsuite',$3,$4,'bill','1250.00','USD','2026-07-01','due','extracted',0.85,
               $5::text[],$6::text[])`,
      [id, tenantId, `nk_${id}`, direction, [newRawArtifactId()], evidenceIds],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await seedObligation(payableId, tenant, "payable", [evidenceId]);
    await seedObligation(receivableId, tenant, "receivable", []);
    // A projection-log row backing the payable's evidence supplies freshness.
    await pool.query(
      `INSERT INTO canonical_projection_log (raw_parsed_id, tenant_id, projector, domain, records_written)
       VALUES ($1,$2,'merge_accounting_canonical_v1','ap_ar',1)`,
      [evidenceId, tenant],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  it("returns one obligation as a governed product with provenance + freshness", async () => {
    const p = await getObligationProduct(pool, ctx, payableId);
    expect(p).not.toBeNull();
    expect(p!.domain).toBe("ap_ar");
    expect(p!.record.direction).toBe("payable");
    expect(Number(p!.record.amount)).toBe(1250);
    expect(p!.provenance.provenance).toBe("extracted");
    expect(p!.provenance.evidence_ids).toEqual([evidenceId]);
    // Freshness joined from the projection log via the backing evidence.
    expect(p!.freshness.projector).toBe("merge_accounting_canonical_v1");
    expect(p!.freshness.projected_at).not.toBeNull();
  });

  it("filters by direction", async () => {
    const payables = await listObligationProducts(pool, ctx, { direction: "payable", limit: 50 });
    expect(payables.length).toBeGreaterThan(0);
    expect(payables.every((p) => p.record.direction === "payable")).toBe(true);
    expect(payables.some((p) => p.record.id === payableId)).toBe(true);
    expect(payables.some((p) => p.record.id === receivableId)).toBe(false);
  });

  it("returns null for an unknown id", async () => {
    expect(await getObligationProduct(pool, ctx, "cob_does_not_exist")).toBeNull();
  });
});
