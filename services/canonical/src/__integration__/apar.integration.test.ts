/**
 * Integration test for the canonical AP/AR projector (Phase 5 deep refactor, PR-E).
 *
 * Seeds Merge contact + invoice pages in raw_parsed and asserts they project
 * into canonical_counterparty + canonical_obligation, with the obligation's
 * counterparty reference resolved to the canonical id (contact pages sort ahead
 * of invoice pages), and that replay is idempotent. Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryAuditEmitter, newRawArtifactId, newRawParsedId, newTenantId } from "@brain/shared";
import { runProjectionCycle } from "../projectors/worker.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("canonical AP/AR projector integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const audit = new InMemoryAuditEmitter();
  const contactRawId = newRawArtifactId();
  const invoiceRawId = newRawArtifactId();
  const contactParsedId = newRawParsedId();
  const invoiceParsedId = newRawParsedId();

  async function seedArtifact(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'merge_accounting',$4,1,'sys_test')`,
      [id, tenant, Buffer.from(id), `blob://${id}`],
    );
  }

  async function seedParsed(
    id: string,
    rawId: string,
    extracted: Record<string, unknown>,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted)
       VALUES ($1,$2,$3,'merge_accounting_v1','1.0.0',$4::jsonb)`,
      [id, rawId, tenant, JSON.stringify(extracted)],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await seedArtifact(contactRawId);
    await seedArtifact(invoiceRawId);
    await seedParsed(contactParsedId, contactRawId, {
      object_type: "contact",
      merge_integration: "NetSuite",
      objects: [{ id: "con_acme", name: "Acme Supply", is_supplier: true }],
    });
    await seedParsed(invoiceParsedId, invoiceRawId, {
      object_type: "invoice",
      merge_integration: "NetSuite",
      objects: [
        {
          id: "inv_1004",
          type: "ACCOUNTS_PAYABLE",
          contact: "con_acme",
          number: "BILL-1004",
          due_date: "2026-07-01",
          total_amount: "1250.00",
          balance: "1250.00",
          currency: "USD",
          status: "OPEN",
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_parsed WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_artifacts WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
      [tenant],
    );
    return Number(rows[0]!.n);
  }

  it("projects contact + invoice into canonical counterparty + obligation with a resolved ref", async () => {
    await runProjectionCycle({ pool, audit }, { batchSize: 50 });

    expect(await count("canonical_counterparty")).toBe(1);
    expect(await count("canonical_obligation")).toBe(1);

    const { rows } = await pool.query<{
      direction: string;
      type: string;
      amount: string;
      canonical_counterparty_id: string | null;
    }>(
      `SELECT direction, type, amount, canonical_counterparty_id
         FROM canonical_obligation WHERE tenant_id = $1`,
      [tenant],
    );
    const obl = rows[0]!;
    expect(obl.direction).toBe("payable");
    expect(obl.type).toBe("bill");
    expect(Number(obl.amount)).toBe(1250);
    // Contact projected first, so the obligation's counterparty ref resolved.
    expect(obl.canonical_counterparty_id).not.toBeNull();

    const { rows: cp } = await pool.query<{ id: string; type: string; normalized_name: string }>(
      `SELECT id, type, normalized_name FROM canonical_counterparty WHERE tenant_id = $1`,
      [tenant],
    );
    expect(cp[0]!.type).toBe("vendor");
    expect(cp[0]!.normalized_name).toBe("acme_supply");
    expect(obl.canonical_counterparty_id).toBe(cp[0]!.id);
  });

  it("is idempotent on replay: re-running adds no rows", async () => {
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await runProjectionCycle({ pool, audit }, { batchSize: 50 });
    expect(await count("canonical_counterparty")).toBe(1);
    expect(await count("canonical_obligation")).toBe(1);
  });
});

DESCRIBE(
  "canonical AP/AR projector integration - customer-asserted CSV counterparty auto-resolve (requires DATABASE_URL)",
  () => {
    let pool: Pool;
    const tenant = newTenantId();
    const audit = new InMemoryAuditEmitter();
    const invoiceRawId = newRawArtifactId();
    const invoiceParsedId = newRawParsedId();

    async function seedArtifact(id: string): Promise<void> {
      await pool.query(
        `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
         VALUES ($1,$2,$3,'csv_upload',$4,1,'sys_test')`,
        [id, tenant, Buffer.from(id), `blob://${id}`],
      );
    }

    async function seedParsed(
      id: string,
      rawId: string,
      extracted: Record<string, unknown>,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted)
         VALUES ($1,$2,$3,'customer_asserted_csv_v1','1.0.3',$4::jsonb)`,
        [id, rawId, tenant, JSON.stringify(extracted)],
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await seedArtifact(invoiceRawId);
      // A payables_invoices CSV referencing a counterparty_id ("cp_new_001")
      // that was never separately declared via a counterparties-type upload -
      // exactly the compliance_test_invoices.csv scenario confirmed live in
      // production.
      await seedParsed(invoiceParsedId, invoiceRawId, {
        object_type: "customer_asserted_csv",
        record_type: "payables_invoices",
        records: [
          {
            invoice_id: "INV-CMP-001",
            counterparty_id: "cp_new_001",
            amount: "48750.00",
            currency: "USD",
            issued_date: "2026-08-01",
            due_date: "2026-08-15",
            status: "pending",
            vendor_name: "Vantage Point Consulting",
          },
        ],
      });
    }, 60_000);

    afterAll(async () => {
      if (pool === undefined) return;
      await pool.query(`DELETE FROM canonical_obligation WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM raw_parsed WHERE tenant_id = $1`, [tenant]);
      await pool.query(`DELETE FROM raw_artifacts WHERE tenant_id = $1`, [tenant]);
      await pool.end();
    });

    async function count(table: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
        [tenant],
      );
      return Number(rows[0]!.n);
    }

    it("auto-creates a placeholder counterparty instead of leaving the obligation stuck unresolved", async () => {
      await runProjectionCycle({ pool, audit }, { batchSize: 50 });

      expect(await count("canonical_counterparty")).toBe(1);
      expect(await count("canonical_obligation")).toBe(1);

      const { rows: cp } = await pool.query<{
        id: string;
        name: string;
        type: string;
        provenance: string;
        extensions: { customer_asserted_csv?: { auto_created?: boolean } };
      }>(
        `SELECT id, name, type, provenance, extensions FROM canonical_counterparty WHERE tenant_id = $1`,
        [tenant],
      );
      expect(cp[0]!.name).toBe("Vantage Point Consulting");
      expect(cp[0]!.type).toBe("vendor");
      expect(cp[0]!.provenance).toBe("customer_asserted");
      expect(cp[0]!.extensions.customer_asserted_csv?.auto_created).toBe(true);

      const { rows: obl } = await pool.query<{ canonical_counterparty_id: string | null }>(
        `SELECT canonical_counterparty_id FROM canonical_obligation WHERE tenant_id = $1`,
        [tenant],
      );
      expect(obl[0]!.canonical_counterparty_id).toBe(cp[0]!.id);
    });

    it("upgrades the placeholder in place when a real counterparties CSV later declares the same key", async () => {
      const counterpartiesRawId = newRawArtifactId();
      const counterpartiesParsedId = newRawParsedId();
      await seedArtifact(counterpartiesRawId);
      await seedParsed(counterpartiesParsedId, counterpartiesRawId, {
        object_type: "customer_asserted_csv",
        record_type: "counterparties",
        records: [
          {
            counterparty_id: "cp_new_001",
            name: "Vantage Point Consulting LLC",
            type: "vendor",
            email: "ap@vantagepointconsulting.com",
          },
        ],
      });

      await runProjectionCycle({ pool, audit }, { batchSize: 50 });

      // Still exactly one counterparty row - the real declaration updated the
      // placeholder in place rather than creating a duplicate.
      expect(await count("canonical_counterparty")).toBe(1);
      const { rows: cp } = await pool.query<{
        name: string;
        email: string | null;
        provenance: string;
        extensions: { customer_asserted_csv?: { auto_created?: boolean } };
      }>(
        `SELECT name, email, provenance, extensions FROM canonical_counterparty WHERE tenant_id = $1`,
        [tenant],
      );
      expect(cp[0]!.name).toBe("Vantage Point Consulting LLC");
      expect(cp[0]!.email).toBe("ap@vantagepointconsulting.com");
      expect(cp[0]!.extensions.customer_asserted_csv?.auto_created).toBeUndefined();
    });
  },
);
