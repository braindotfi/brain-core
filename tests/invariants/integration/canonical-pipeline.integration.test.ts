/**
 * End-to-end canonical money-path pipeline test (Phase 5 cutover hardening).
 *
 * The wedge proves the projection LOGIC by calling the projection functions
 * directly (and the Ledger FULL rebuild). Production instead relies on two
 * scheduled WORKERS running in sequence:
 *
 *   raw_parsed --runProjectionCycle--> canonical --runLedgerAparProjectionCycle--> Ledger
 *
 * This test drives those exact worker cycles (not the rebuild) and asserts an
 * obligation actually reaches ledger_obligations -- the wired async path the
 * money flow now depends on, which nothing else exercises end to end. It also
 * confirms the projection metrics fire so a stalled worker is observable.
 *
 * Requires DATABASE_URL (migrated public schema, as the CI integration job
 * provides); skips otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  MockMetrics,
  newRawArtifactId,
  newRawParsedId,
  newTenantId,
} from "@brain/shared";
import { runProjectionCycle } from "@brain/canonical";
import { runLedgerAparProjectionCycle } from "@brain/ledger";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("canonical money-path pipeline e2e (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const contactRaw = newRawArtifactId();
  const invoiceRaw = newRawArtifactId();

  async function seedArtifact(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'merge_accounting',$4,1,'sys_test')`,
      [id, tenant, Buffer.from(id), `blob://${id}`],
    );
  }
  async function seedParsed(rawId: string, extracted: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted)
       VALUES ($1,$2,$3,'merge_accounting_v1','1.0.0',$4::jsonb)`,
      [newRawParsedId(), rawId, tenant, JSON.stringify(extracted)],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await seedArtifact(contactRaw);
    await seedArtifact(invoiceRaw);
    await seedParsed(contactRaw, {
      object_type: "contact",
      merge_integration: "NetSuite",
      objects: [{ id: "con_acme", name: "Acme Industrial Supply", is_supplier: true }],
    });
    await seedParsed(invoiceRaw, {
      object_type: "invoice",
      merge_integration: "NetSuite",
      objects: [
        {
          id: "inv_e2e_1",
          remote_id: "ns-9001",
          type: "ACCOUNTS_PAYABLE",
          contact: "con_acme",
          due_date: "2026-08-01T00:00:00Z",
          balance: "980.00",
          currency: "USD",
          status: "OPEN",
          line_items: [{ account: "gl-6100" }],
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM ledger_obligations WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM ledger_counterparties WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_parsed WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_artifacts WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  it("delivers an obligation to the Ledger through the two scheduled worker cycles", async () => {
    const audit = new InMemoryAuditEmitter();
    const metrics = new MockMetrics();

    // Worker cycle 1: raw_parsed -> canonical (the canonical projector).
    await runProjectionCycle({ pool, audit, metrics }, { batchSize: 50 });
    // Worker cycle 2: canonical -> Ledger (the incremental AP/AR projection).
    await runLedgerAparProjectionCycle({ pool, metrics }, { batchSize: 50 });

    const { rows } = await pool.query<{
      direction: string;
      provenance: string;
      amount_due: string;
      counterparty_id: string;
    }>(
      `SELECT direction, provenance, amount_due, counterparty_id
         FROM ledger_obligations WHERE owner_id = $1`,
      [tenant],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe("payable");
    expect(rows[0]!.provenance).toBe("extracted");
    expect(Number(rows[0]!.amount_due)).toBe(980);

    // The counterparty was projected and linked (not a null FK).
    const { rows: cp } = await pool.query<{ id: string }>(
      `SELECT id FROM ledger_counterparties WHERE owner_id = $1 AND id = $2`,
      [tenant, rows[0]!.counterparty_id],
    );
    expect(cp).toHaveLength(1);

    // Both money-path projection workers emitted their record counter, so a
    // stall (records flatlining) is observable.
    const names = metrics.calls.map((c) => c.name);
    expect(names).toContain("brain.canonical.projector.records.count");
    expect(names).toContain("brain.ledger.apar_projection.records.count");
  });
});
