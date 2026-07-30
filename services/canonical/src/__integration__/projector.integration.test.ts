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
import {
  InMemoryAuditEmitter,
  MockMetrics,
  newRawArtifactId,
  newRawParsedId,
  newTenantId,
} from "@brain/shared";
import {
  replayQuarantined,
  runProjectionCycle,
  type LedgerUploadProjectedEvent,
} from "../projectors/worker.js";

// runProjectionCycle polls pending raw_parsed rows across tenants, so keep this
// file's database-backed suites from seeding competing tenants at the same time.
const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe.sequential : describe.skip;

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

DESCRIBE("canonical projector poison handling (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const glRawId = newRawArtifactId();
  const goodRawId = newRawArtifactId();
  const poisonRawId = newRawArtifactId();
  const glParsedId = newRawParsedId();
  const goodParsedId = newRawParsedId();
  const poisonParsedId = newRawParsedId();

  // 36 integer digits overflows NUMERIC(38,8) (max 30 integer digits): a real,
  // deterministic in-transaction projection failure the parser passes through.
  const OVERFLOW_AMOUNT = "1".repeat(36);

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

  async function logRow(
    rawParsedId: string,
  ): Promise<{ attempts: number; quarantined: boolean; error: string | null } | undefined> {
    const { rows } = await pool.query<{
      attempts: number;
      quarantined: boolean;
      error: string | null;
    }>(
      `SELECT attempts, quarantined, error FROM canonical_projection_log WHERE raw_parsed_id = $1`,
      [rawParsedId],
    );
    return rows[0];
  }

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
      [tenant],
    );
    return Number(rows[0]!.n);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await seedArtifact(glRawId);
    await seedArtifact(goodRawId);
    await seedArtifact(poisonRawId);
    await seedParsed(glParsedId, glRawId, {
      object_type: "gl_account",
      merge_integration: "NetSuite",
      objects: [{ id: "acct_cash", name: "Cash", classification: "ASSET", account_number: "1000" }],
    });
    await seedParsed(goodParsedId, goodRawId, {
      object_type: "journal_entry",
      merge_integration: "NetSuite",
      objects: [
        {
          id: "je_good",
          transaction_date: "2026-06-01T00:00:00Z",
          currency: "USD",
          lines: [{ account: "acct_cash", net_amount: "10.00" }],
        },
      ],
    });
    await seedParsed(poisonParsedId, poisonRawId, {
      object_type: "journal_entry",
      merge_integration: "NetSuite",
      objects: [
        {
          id: "je_poison",
          transaction_date: "2026-06-02T00:00:00Z",
          currency: "USD",
          lines: [{ account: "acct_cash", net_amount: OVERFLOW_AMOUNT }],
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

  it("retries, quarantines after the budget, and keeps projecting siblings", async () => {
    // Cycle 1: the good entry projects; the poison entry fails its first attempt.
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50, maxAttempts: 2 });
    expect(await count("canonical_journal_entry")).toBe(1); // good landed; lane continued
    let poison = await logRow(poisonParsedId);
    expect(poison?.attempts).toBe(1);
    expect(poison?.quarantined).toBe(false); // 1 < 2: still retryable
    expect(poison?.error).not.toBeNull();

    // Cycle 2: good is terminal (excluded); poison is re-polled, fails again,
    // and tips into quarantine (attempts 2 >= 2).
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50, maxAttempts: 2 });
    expect(await count("canonical_journal_entry")).toBe(1); // good not duplicated
    poison = await logRow(poisonParsedId);
    expect(poison?.attempts).toBe(2);
    expect(poison?.quarantined).toBe(true);

    // Cycle 3: a quarantined row is excluded — no further attempts.
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50, maxAttempts: 2 });
    expect((await logRow(poisonParsedId))?.attempts).toBe(2); // unchanged
  });

  it("replayQuarantined releases the row so the lane re-attempts it", async () => {
    const released = await replayQuarantined({ pool, audit: noopAudit }, { tenantId: tenant });
    expect(released).toBeGreaterThanOrEqual(1);

    let poison = await logRow(poisonParsedId);
    expect(poison?.quarantined).toBe(false);
    expect(poison?.attempts).toBe(0); // retry budget reset

    // Re-attempted next cycle (still overflows, so it fails again with a fresh count).
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50, maxAttempts: 2 });
    poison = await logRow(poisonParsedId);
    expect(poison?.attempts).toBe(1);
    expect(poison?.quarantined).toBe(false);
  });
});

DESCRIBE("canonical upload projector audit integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const rawId = newRawArtifactId();
  const parsedId = newRawParsedId();
  const audit = new InMemoryAuditEmitter();
  const uploadEvents: LedgerUploadProjectedEvent[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'pdf_upload',$4,$5,'sys_test')`,
      [rawId, tenant, Buffer.from(rawId), `blob://${rawId}`, 1],
    );
    await pool.query(
      `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
       VALUES ($1,$2,$3,'bank_statement_upload_v1','1.0.0',$4::jsonb,0.92)`,
      [
        parsedId,
        rawId,
        tenant,
        JSON.stringify({
          object_type: "bank_statement",
          account: {
            account_id: "acct_upload_audit",
            name: "Operating",
            currency: "USD",
            current_balance: "100.00",
          },
          transactions: [
            {
              transaction_id: "tx_upload_audit_1",
              date: "2026-06-10",
              amount: "42.00",
              currency: "USD",
              direction: "outflow",
              description: "Office supplies",
              counterparty_name: "Office Depot",
            },
          ],
        }),
      ],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_transaction WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_account WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_parsed WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_artifacts WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  it("emits ledger.upload.projected and calls the upload projection hook after upload projection completes", async () => {
    await runProjectionCycle(
      {
        pool,
        audit,
        onUploadProjected: async (event) => {
          uploadEvents.push(event);
        },
      },
      { batchSize: 50 },
    );

    const actions = audit.events.map((event) => event.action);
    expect(actions.indexOf("canonical.projected")).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf("ledger.upload.projected")).toBeGreaterThan(
      actions.indexOf("canonical.projected"),
    );
    expect(audit.events.find((event) => event.action === "ledger.upload.projected")).toMatchObject({
      tenantId: tenant,
      layer: "ledger",
      eventType: "system_activity",
      severity: "info",
      inputs: {
        raw_artifact_id: rawId,
        raw_parsed_id: parsedId,
        projector: "bank_statement_upload_canonical_v1",
      },
      outputs: {
        summary: expect.objectContaining({
          accounts: 1,
          transactions: 1,
          newCounterparties: 1,
        }),
      },
    });
    expect(uploadEvents).toEqual([
      expect.objectContaining({
        event: "ledger.upload.projected",
        tenantId: tenant,
        rawArtifactId: rawId,
        rawParsedId: parsedId,
        projector: "bank_statement_upload_canonical_v1",
        summary: expect.objectContaining({
          accounts: 1,
          transactions: 1,
          newCounterparties: 1,
        }),
      }),
    ]);
  });
});

DESCRIBE("canonical doc obligation upload hook integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const rawId = newRawArtifactId();
  const parsedId = newRawParsedId();
  const audit = new InMemoryAuditEmitter();
  const uploadEvents: LedgerUploadProjectedEvent[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'pdf_upload',$4,$5,'sys_test')`,
      [rawId, tenant, Buffer.from(rawId), `blob://${rawId}`, 1],
    );
    await pool.query(
      `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
       VALUES ($1,$2,$3,'doc_obligation_v1','1.0.0',$4::jsonb,0.5)`,
      [
        parsedId,
        rawId,
        tenant,
        JSON.stringify({
          counterparty_name: "Payroll Tax",
          direction: "payable",
          type: "payroll_tax",
          amount: "2500.00",
          currency: "USD",
          due_date: "2026-08-15",
          description: "Employer Payroll Tax Remittance",
        }),
      ],
    );
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

  it("emits ledger.upload.projected and calls the upload projection hook for doc obligations", async () => {
    await runProjectionCycle(
      {
        pool,
        audit,
        onUploadProjected: async (event) => {
          uploadEvents.push(event);
        },
      },
      { batchSize: 50 },
    );

    expect(audit.events.find((event) => event.action === "ledger.upload.projected")).toMatchObject({
      tenantId: tenant,
      layer: "ledger",
      eventType: "system_activity",
      severity: "info",
      inputs: {
        raw_artifact_id: rawId,
        raw_parsed_id: parsedId,
        projector: "doc_obligation_canonical_v1",
      },
      outputs: {
        summary: expect.objectContaining({
          obligations: 1,
          newCounterparties: 1,
        }),
      },
    });
    expect(uploadEvents).toEqual([
      expect.objectContaining({
        event: "ledger.upload.projected",
        tenantId: tenant,
        rawArtifactId: rawId,
        rawParsedId: parsedId,
        projector: "doc_obligation_canonical_v1",
        summary: expect.objectContaining({
          obligations: 1,
          newCounterparties: 1,
        }),
      }),
    ]);
  });
});

DESCRIBE("canonical projector re-projects a corrected payload (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const rawId = newRawArtifactId();
  const parsedId = newRawParsedId();

  function bankStatementPayload(transactionCount: number): Record<string, unknown> {
    return {
      object_type: "bank_statement",
      account: {
        account_id: "acct_source_version",
        name: "Operating",
        currency: "USD",
        current_balance: "100.00",
      },
      transactions: Array.from({ length: transactionCount }, (_, i) => ({
        transaction_id: `tx_source_version_${i}`,
        date: "2026-06-10",
        amount: "10.00",
        currency: "USD",
        direction: "outflow",
        description: "Office supplies",
        counterparty_name: "Office Depot",
      })),
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO raw_artifacts (id, tenant_id, sha256, source_type, blob_uri, bytes, ingested_by)
       VALUES ($1,$2,$3,'pdf_upload',$4,$5,'sys_test')`,
      [rawId, tenant, Buffer.from(rawId), `blob://${rawId}`, 1],
    );
    await pool.query(
      `INSERT INTO raw_parsed (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
       VALUES ($1,$2,$3,'bank_statement_upload_v1','1.0.0',$4::jsonb,0.92)`,
      [parsedId, rawId, tenant, JSON.stringify(bankStatementPayload(1))],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM canonical_transaction WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_counterparty WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_account WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM canonical_projection_log WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_parsed WHERE tenant_id = $1`, [tenant]);
    await pool.query(`DELETE FROM raw_artifacts WHERE tenant_id = $1`, [tenant]);
    await pool.end();
  });

  async function transactionCount(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM canonical_transaction WHERE tenant_id = $1`,
      [tenant],
    );
    return Number(rows[0]!.n);
  }

  function bankStatementPayloadWithKey(transactionId: string): Record<string, unknown> {
    return {
      object_type: "bank_statement",
      account: {
        account_id: "acct_source_version",
        name: "Operating",
        currency: "USD",
        current_balance: "100.00",
      },
      transactions: [
        {
          transaction_id: transactionId,
          date: "2026-06-10",
          amount: "10.00",
          currency: "USD",
          direction: "outflow",
          description: "Office supplies",
          counterparty_name: "Office Depot",
        },
      ],
    };
  }

  it("re-projects when a repair bumps extracted_at without touching the log row", async () => {
    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50 });
    expect(await transactionCount()).toBe(1);
    const { rows: logRows } = await pool.query<{ error: string | null }>(
      `SELECT error FROM canonical_projection_log WHERE raw_parsed_id = $1`,
      [parsedId],
    );
    expect(logRows[0]?.error).toBeNull(); // terminal success, same as `main` today

    // Simulate repairParsedOutput: mutate raw_parsed in place, bump
    // extracted_at, but leave canonical_projection_log untouched. On `main`
    // (before the source-version fix) PENDING_EXCLUSION would permanently
    // skip this row because it already has a log entry with error IS NULL.
    await pool.query(
      `UPDATE raw_parsed SET extracted = $2::jsonb, extracted_at = now() WHERE id = $1`,
      [parsedId, JSON.stringify(bankStatementPayload(2))],
    );

    await runProjectionCycle({ pool, audit: noopAudit }, { batchSize: 50 });
    expect(await transactionCount()).toBe(2);
  });

  it("H3: a shrink/rename is left in place (not deleted) but surfaced via metric + warn log", async () => {
    // Starting state (from the previous test): 2 transactions, tx_source_version_0
    // and tx_source_version_1. Correct the payload down to a SINGLE, DIFFERENTLY
    // KEYED transaction (an OCR-style natural-key rename). Deleting the two
    // stale rows was tried and reverted (see detectOrphanedCanonicalRows'
    // doc comment): no DELETE grant under least-privilege, shared-evidence
    // natural keys, and degraded-extraction data loss all made it unsound.
    // The honest fallback: detect, don't touch, log + metric loudly, still
    // mark the projection terminal.
    const metrics = new MockMetrics();
    const warnCalls: unknown[] = [];
    const log = { debug: () => {}, warn: (obj: unknown) => warnCalls.push(obj) };

    await pool.query(
      `UPDATE raw_parsed SET extracted = $2::jsonb, extracted_at = now() WHERE id = $1`,
      [parsedId, JSON.stringify(bankStatementPayloadWithKey("tx_source_version_corrected"))],
    );

    await runProjectionCycle({ pool, audit: noopAudit, metrics, log }, { batchSize: 50 });

    // Nothing deleted: the 2 stale rows plus the 1 corrected row all remain.
    expect(await transactionCount()).toBe(3);
    const { rows } = await pool.query<{ source_natural_key: string }>(
      `SELECT source_natural_key FROM canonical_transaction WHERE tenant_id = $1 ORDER BY source_natural_key`,
      [tenant],
    );
    expect(rows.map((r) => r.source_natural_key)).toEqual([
      "tx_source_version_0",
      "tx_source_version_1",
      "tx_source_version_corrected",
    ]);

    // Surfaced, not silent.
    const orphanMetric = metrics.calls.find(
      (c) => c.kind === "increment" && c.name === "brain.canonical.projector.orphaned_records",
    );
    expect(orphanMetric?.value).toBe(2);
    expect(orphanMetric?.tags).toMatchObject({ table: "canonical_transaction" });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      tenantId: tenant,
      rawParsedId: parsedId,
      table: "canonical_transaction",
      naturalKeys: ["tx_source_version_0", "tx_source_version_1"],
      count: 2,
    });

    // Still terminal -- the projector does not hot-spin retrying this row.
    const { rows: logRows } = await pool.query<{ error: string | null }>(
      `SELECT error FROM canonical_projection_log WHERE raw_parsed_id = $1`,
      [parsedId],
    );
    expect(logRows[0]?.error).toBeNull();
  });
});
