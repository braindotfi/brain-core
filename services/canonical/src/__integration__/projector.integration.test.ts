/**
 * Integration test for the canonical accounting projector (RFC 0005, PR-B).
 *
 * Proves the core Phase 5 properties against a real database: Merge accounting
 * pages already sitting in raw_parsed project into canonical GL accounts +
 * journal entries with resolved line references, and replaying the cycle is
 * idempotent (no duplicate rows). Requires DATABASE_URL; skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryAuditEmitter, newRawArtifactId, newRawParsedId, newTenantId } from "@brain/shared";
import { runProjectionCycle } from "../projectors/worker.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

const noopAudit = new InMemoryAuditEmitter();

DESCRIBE("canonical projector integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const glRawId = newRawArtifactId();
  const jeRawId = newRawArtifactId();
  const glParsedId = newRawParsedId();
  const jeParsedId = newRawParsedId();

  async function seedArtifact(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'merge_accounting',$4,$5,'sys_test')`,
      [id, tenant, Buffer.from(id), `blob://${id}`, 1],
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
    await seedArtifact(glRawId);
    await seedArtifact(jeRawId);
    await seedParsed(glParsedId, glRawId, {
      object_type: "gl_account",
      merge_integration: "NetSuite",
      objects: [
        { id: "acct_equip", name: "Equipment", classification: "ASSET", account_number: "6100" },
        { id: "acct_cash", name: "Cash", classification: "ASSET", account_number: "1000" },
      ],
    });
    await seedParsed(jeParsedId, jeRawId, {
      object_type: "journal_entry",
      merge_integration: "NetSuite",
      objects: [
        {
          id: "je_equip_buy",
          transaction_date: "2026-06-01T00:00:00Z",
          memo: "Equipment purchase",
          currency: "USD",
          lines: [
            { account: "acct_equip", net_amount: "1250.00", description: "Asset" },
            { account: "acct_cash", net_amount: "-1250.00", description: "Cash out" },
          ],
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_journal_line WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_journal_entry WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_gl_account WHERE tenant_id = $1`, [tenant]);
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

  it("projects GL accounts and a journal entry with resolved line references", async () => {
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50 });

    expect(await count("canonical_gl_account")).toBe(2);
    expect(await count("canonical_journal_entry")).toBe(1);
    expect(await count("canonical_journal_line")).toBe(2);

    // The double-entry legs landed with explicit direction + non-negative amount.
    const { rows: lines } = await pool.query<{
      direction: string;
      amount: string;
      gl_account_id: string | null;
      gl_account_key: string;
    }>(
      `SELECT direction, amount, gl_account_id, gl_account_key
         FROM canonical_journal_line WHERE tenant_id = $1 ORDER BY line_number`,
      [tenant],
    );
    expect(lines.map((l) => l.direction)).toEqual(["debit", "credit"]);
    expect(Number(lines[0]!.amount)).toBe(1250);
    // GL-account pages sort ahead of journal_entry pages, so the line reference
    // resolved to a canonical account id in the same cycle.
    expect(lines[0]!.gl_account_id).not.toBeNull();
    expect(lines[0]!.gl_account_key).toBe("acct_equip");

    // Both pages are marked consumed in the projection log.
    expect(await count("canonical_projection_log")).toBe(2);
  });

  it("is idempotent on replay: re-running the cycle adds no rows", async () => {
    // Clear the log so the projector re-processes the same raw_parsed rows.
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50 });

    expect(await count("canonical_gl_account")).toBe(2);
    expect(await count("canonical_journal_entry")).toBe(1);
    expect(await count("canonical_journal_line")).toBe(2); // replaced, not duplicated
  });
});
