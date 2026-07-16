/**
 * Regression coverage for the ledger 0044 unique-index deploy path.
 *
 * The test applies migrations up to, but not including, the 0044 direct-write
 * dedup indexes, seeds rows that the old select-then-insert path could create,
 * then runs the preflight cleanup and 0044 through the real migration runner.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

let client: Client;
let schema: string;

suite("ledger 0044 dedup preflight migration (integration -- requires DATABASE_URL)", () => {
  beforeAll(async () => {
    schema = `ledger_0044_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    client = new Client({
      connectionString: DB_URL,
      application_name: `ledger-0044-${schema}`,
    });
    await client.connect();
    await client.query(`SET search_path TO ${schema}, public`);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.end();
    }
    const done = new Client({ connectionString: DB_URL });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.end();
  }, 60_000);

  it("merges duplicate counterparties and obligations before 0044 creates unique indexes", async () => {
    const discovered = await discoverMigrations(repoRoot());
    const preflight = discovered.find(
      (m) => m.service === "ledger" && m.name === "0043_ledger_direct_write_dedup_preflight.sql",
    );
    const migration0044 = discovered.find(
      (m) => m.service === "ledger" && m.name === "0044_ledger_direct_write_dedup_constraints.sql",
    );
    const invoiceMatchCleanup = discovered.find(
      (m) => m.service === "ledger" && m.name === "0046_ledger_orphaned_invoice_match_cleanup.sql",
    );

    expect(preflight).toBeDefined();
    expect(migration0044).toBeDefined();
    expect(invoiceMatchCleanup).toBeDefined();

    const before0044 = discovered.filter(
      (m) => m.key < migration0044!.key && m.key !== preflight!.key,
    );
    await applyAll(client as never, before0044, { appliedBy: "ledger-0044-test-setup" });

    await client.query(`SET app.tenant_id = 'tenant_0044'`);
    await seedHistoricalDuplicates();

    await applyAll(client as never, [preflight!, migration0044!], {
      appliedBy: "ledger-0044-test",
    });

    const { rows: orphanedInvoiceMatchesBeforeCleanup } = await client.query<{ count: string }>(
      `SELECT count(*)::text
         FROM ledger_reconciliation_matches r
        WHERE r.owner_id = 'tenant_0044'
          AND r.left_entity_type = 'invoice'
          AND r.left_entity_id = 'inv_loser'`,
    );
    expect(orphanedInvoiceMatchesBeforeCleanup[0]?.count).toBe("1");

    await applyAll(client as never, [invoiceMatchCleanup!], {
      appliedBy: "ledger-0044-test",
    });
    await client.query(invoiceMatchCleanup!.sql);

    const { rows: counterparties } = await client.query<{
      id: string;
      aliases: string[];
      source_ids: string[];
      evidence_ids: string[];
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, aliases, source_ids, evidence_ids, metadata
         FROM ledger_counterparties
        WHERE owner_id = 'tenant_0044'
          AND normalized_name = 'acme industrial'
          AND type = 'vendor'`,
    );
    expect(counterparties).toHaveLength(1);
    expect(counterparties[0]?.id).toBe("cp_survivor");
    expect(counterparties[0]?.aliases).toEqual(["acme", "acme old"]);
    expect(counterparties[0]?.source_ids).toEqual(["raw_cp_loser", "raw_cp_survivor"]);
    expect(counterparties[0]?.evidence_ids).toEqual(["prs_cp_loser", "prs_cp_survivor"]);
    expect(counterparties[0]?.metadata).toMatchObject({
      retained: "survivor",
      loser_note: "merged",
    });

    const { rows: obligations } = await client.query<{
      id: string;
      counterparty_id: string;
      linked_transaction_ids: string[];
      source_ids: string[];
      evidence_ids: string[];
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, counterparty_id, linked_transaction_ids, source_ids, evidence_ids, metadata
         FROM ledger_obligations
        WHERE owner_id = 'tenant_0044'
          AND counterparty_id = 'cp_survivor'
          AND type = 'invoice'
          AND amount_due = 100.00
          AND currency = 'USD'
          AND due_date = '2026-08-01T00:00:00Z'::timestamptz`,
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.id).toBe("obl_survivor");
    expect(obligations[0]?.linked_transaction_ids).toEqual(["tx_loser", "tx_survivor"]);
    expect(obligations[0]?.source_ids).toEqual(["raw_obl_loser", "raw_obl_survivor"]);
    expect(obligations[0]?.evidence_ids).toEqual(["prs_obl_loser", "prs_obl_survivor"]);
    expect(obligations[0]?.metadata).toMatchObject({
      retained: "obligation_survivor",
      loser_note: "obligation_merged",
    });

    const { rows: refs } = await client.query<{
      destination_counterparty_id: string;
      obligation_id: string | null;
      invoice_id: string | null;
    }>(
      `SELECT destination_counterparty_id, obligation_id, invoice_id
         FROM ledger_payment_intents
        WHERE id = 'pi_loser_refs'`,
    );
    expect(refs[0]).toEqual({
      destination_counterparty_id: "cp_survivor",
      obligation_id: "obl_survivor",
      invoice_id: "inv_survivor",
    });

    const { rows: documentRefs } = await client.query<{ linked_obligation_ids: string[] }>(
      `SELECT linked_obligation_ids
         FROM ledger_documents
        WHERE id = 'doc_0044'`,
    );
    expect(documentRefs[0]?.linked_obligation_ids).toEqual(["obl_survivor"]);

    const { rows: directRefs } = await client.query<{
      tx_counterparty_id: string;
      instruction_counterparty_id: string;
    }>(
      `SELECT
         (SELECT counterparty_id FROM ledger_transactions WHERE id = 'tx_ref') AS tx_counterparty_id,
         (SELECT counterparty_id FROM ledger_counterparty_payment_instructions WHERE id = 'cpi_ref') AS instruction_counterparty_id`,
    );
    expect(directRefs[0]).toEqual({
      tx_counterparty_id: "cp_survivor",
      instruction_counterparty_id: "cp_survivor",
    });

    const { rows: reconRefs } = await client.query<{
      id: string;
      left_entity_type: string;
      left_entity_id: string;
      evidence_ids: string[];
    }>(
      `SELECT id, left_entity_type, left_entity_id, evidence_ids
         FROM ledger_reconciliation_matches
        WHERE owner_id = 'tenant_0044'
        ORDER BY id`,
    );
    expect(reconRefs).toEqual([
      {
        id: "rcn_cp_survivor",
        left_entity_type: "counterparty",
        left_entity_id: "cp_survivor",
        evidence_ids: ["prs_match_cp_loser", "prs_match_cp_survivor"],
      },
      {
        id: "rcn_inv_survivor",
        left_entity_type: "invoice",
        left_entity_id: "inv_survivor",
        evidence_ids: ["prs_match_inv_survivor"],
      },
      {
        id: "rcn_obl_survivor",
        left_entity_type: "obligation",
        left_entity_id: "obl_survivor",
        evidence_ids: ["prs_match_obl_loser", "prs_match_obl_survivor"],
      },
    ]);

    const { rows: orphanedInvoiceMatchesAfterCleanup } = await client.query<{ count: string }>(
      `SELECT count(*)::text
         FROM ledger_reconciliation_matches r
        WHERE r.owner_id = 'tenant_0044'
          AND r.id = 'rcn_inv_loser'`,
    );
    expect(orphanedInvoiceMatchesAfterCleanup[0]?.count).toBe("0");

    const { rows: orphanCounts } = await client.query<{ count: string }>(
      `SELECT count(*)::text
         FROM ledger_payment_intents pi
         LEFT JOIN ledger_counterparties cp ON cp.id = pi.destination_counterparty_id
         LEFT JOIN ledger_obligations obl ON obl.id = pi.obligation_id
         LEFT JOIN ledger_invoices inv ON inv.id = pi.invoice_id
        WHERE pi.owner_id = 'tenant_0044'
          AND (cp.id IS NULL OR obl.id IS NULL OR inv.id IS NULL)`,
    );
    expect(orphanCounts[0]?.count).toBe("0");

    const { rows: indexes } = await client.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = $1
          AND indexname IN (
            'uq_ledger_counterparties_owner_normalized_type',
            'uq_ledger_obligations_external_key',
            'uq_ledger_obligations_legacy_dedup'
          )
        ORDER BY indexname`,
      [schema],
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      "uq_ledger_counterparties_owner_normalized_type",
      "uq_ledger_obligations_external_key",
      "uq_ledger_obligations_legacy_dedup",
    ]);
  }, 60_000);
});

async function seedHistoricalDuplicates(): Promise<void> {
  await client.query(
    `INSERT INTO ledger_accounts (
       id, owner_id, institution, external_account_id, account_type, name, currency,
       current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence,
       created_at, updated_at
     )
     VALUES (
       'acct_0044', 'tenant_0044', 'Bank', 'acct_ext_0044', 'bank_checking', 'Operating', 'USD',
       1000, 1000, 'active', ARRAY['raw_acct'], ARRAY['prs_acct'], 'extracted', 0.99,
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
     )`,
  );

  await client.query(
    `INSERT INTO ledger_counterparties (
       id, owner_id, name, normalized_name, type, aliases, linked_accounts, source_ids,
       evidence_ids, provenance, confidence, created_at, updated_at, metadata
     )
     VALUES
       (
         'cp_survivor', 'tenant_0044', 'Acme Industrial', 'acme industrial', 'vendor',
         ARRAY['acme'], ARRAY['acct_a'], ARRAY['raw_cp_survivor'], ARRAY['prs_cp_survivor'],
         'extracted', 0.80, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
         '{"retained":"survivor"}'::jsonb
       ),
       (
         'cp_loser', 'tenant_0044', 'Acme Industrial LLC', 'acme industrial', 'vendor',
         ARRAY['acme old'], ARRAY['acct_b'], ARRAY['raw_cp_loser'], ARRAY['prs_cp_loser'],
         'extracted', 0.95, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
         '{"retained":"loser","loser_note":"merged"}'::jsonb
       )`,
  );

  await client.query(
    `INSERT INTO ledger_transactions (
       id, owner_id, account_id, external_transaction_id, amount, currency, direction,
       transaction_date, posted_date, counterparty_id, status, source_ids, evidence_ids,
       provenance, confidence, created_at, updated_at
     )
     VALUES (
       'tx_ref', 'tenant_0044', 'acct_0044', 'tx_ext_0044', 100, 'USD', 'outflow',
       '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'cp_loser', 'posted',
       ARRAY['raw_tx'], ARRAY['prs_tx'], 'extracted', 0.90,
       '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'
     )`,
  );

  await client.query(
    `INSERT INTO ledger_obligations (
       id, owner_id, type, counterparty_id, amount_due, minimum_due, currency, due_date,
       status, linked_transaction_ids, source_ids, evidence_ids, provenance, confidence,
       created_at, updated_at, metadata
     )
     VALUES
       (
         'obl_survivor', 'tenant_0044', 'invoice', 'cp_survivor', 100.00, NULL, 'USD',
         '2026-08-01T00:00:00Z', 'due', ARRAY['tx_survivor'], ARRAY['raw_obl_survivor'],
         ARRAY['prs_obl_survivor'], 'extracted', 0.78,
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
         '{"retained":"obligation_survivor"}'::jsonb
       ),
       (
         'obl_loser', 'tenant_0044', 'invoice', 'cp_loser', 100.00, NULL, 'USD',
         '2026-08-01T00:00:00Z', 'due', ARRAY['tx_loser'], ARRAY['raw_obl_loser'],
         ARRAY['prs_obl_loser'], 'extracted', 0.94,
         '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
         '{"retained":"obligation_loser","loser_note":"obligation_merged"}'::jsonb
       )`,
  );

  await client.query(
    `INSERT INTO ledger_invoices (
       id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid, currency,
       issue_date, due_date, status, linked_document_ids, linked_transaction_ids, source_ids,
       evidence_ids, provenance, confidence, created_at, updated_at, metadata
     )
     VALUES
       (
         'inv_survivor', 'tenant_0044', 'INV-0044', 'cp_survivor', 100, 0, 'USD',
         '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'sent', ARRAY['doc_a'],
         ARRAY['tx_survivor'], ARRAY['raw_inv_survivor'], ARRAY['prs_inv_survivor'],
         'extracted', 0.78, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
         '{"retained":"invoice_survivor"}'::jsonb
       ),
       (
         'inv_loser', 'tenant_0044', 'INV-0044', 'cp_loser', 100, 10, 'USD',
         '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'sent', ARRAY['doc_b'],
         ARRAY['tx_loser'], ARRAY['raw_inv_loser'], ARRAY['prs_inv_loser'],
         'extracted', 0.91, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
         '{"retained":"invoice_loser","loser_note":"invoice_merged"}'::jsonb
       )`,
  );

  await client.query(
    `INSERT INTO ledger_documents (
       id, owner_id, document_type, source_uri, extracted_fields, linked_account_ids,
       linked_transaction_ids, linked_obligation_ids, source_ids, evidence_ids,
       confidence_score, provenance, confidence, created_at, updated_at
     )
     VALUES (
       'doc_0044', 'tenant_0044', 'invoice', 'blob://0044', '{}'::jsonb,
       ARRAY[]::text[], ARRAY[]::text[], ARRAY['obl_loser','obl_survivor'],
       ARRAY['raw_doc'], ARRAY['prs_doc'], 0.91, 'extracted', 0.91,
       '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
     )`,
  );

  await client.query(
    `INSERT INTO ledger_payment_intents (
       id, owner_id, created_by_agent_id, action_type, source_account_id,
       destination_counterparty_id, amount, currency, obligation_id, invoice_id, status,
       source_ids, evidence_ids, provenance, confidence, created_at, updated_at
     )
     VALUES (
       'pi_loser_refs', 'tenant_0044', 'agent_0044', 'ach_outbound', 'acct_0044',
       'cp_loser', 100, 'USD', 'obl_loser', 'inv_loser', 'proposed',
       ARRAY['raw_pi'], ARRAY['prs_pi'], 'inferred', 0.88,
       '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'
     )`,
  );

  await client.query(
    `INSERT INTO ledger_counterparty_payment_instructions (
       id, owner_id, counterparty_id, changed_at, prior_hash, current_hash, source_id, actor, created_at
     )
     VALUES (
       'cpi_ref', 'tenant_0044', 'cp_loser', '2026-01-03T00:00:00Z',
       NULL, 'hash_current', 'raw_cpi', 'agent_0044', '2026-01-03T00:00:00Z'
     )`,
  );

  await client.query(
    `INSERT INTO ledger_reconciliation_matches (
       id, owner_id, match_type, left_entity_type, left_entity_id, right_entity_type,
       right_entity_id, confidence_score, status, evidence_ids, explanation, created_at, updated_at
     )
     VALUES
       (
         'rcn_cp_survivor', 'tenant_0044', 'counterparty_duplicate', 'counterparty',
         'cp_survivor', 'document', 'doc_0044', 0.80, 'matched',
         ARRAY['prs_match_cp_survivor'], 'survivor counterparty match',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
       ),
       (
         'rcn_cp_loser', 'tenant_0044', 'counterparty_duplicate', 'counterparty',
         'cp_loser', 'document', 'doc_0044', 0.90, 'matched',
         ARRAY['prs_match_cp_loser'], 'loser counterparty match',
         '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
       ),
       (
         'rcn_obl_survivor', 'tenant_0044', 'obligation_duplicate', 'obligation',
         'obl_survivor', 'document', 'doc_0044', 0.81, 'matched',
         ARRAY['prs_match_obl_survivor'], 'survivor obligation match',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
       ),
       (
         'rcn_obl_loser', 'tenant_0044', 'obligation_duplicate', 'obligation',
         'obl_loser', 'document', 'doc_0044', 0.92, 'matched',
         ARRAY['prs_match_obl_loser'], 'loser obligation match',
         '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
       ),
       (
         'rcn_inv_survivor', 'tenant_0044', 'invoice_payment', 'invoice',
         'inv_survivor', 'transaction', 'tx_ref', 0.82, 'matched',
         ARRAY['prs_match_inv_survivor'], 'survivor invoice match',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
       ),
       (
         'rcn_inv_loser', 'tenant_0044', 'invoice_payment', 'invoice',
         'inv_loser', 'transaction', 'tx_ref', 0.93, 'matched',
         ARRAY['prs_match_inv_loser'], 'loser invoice match',
         '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
       )`,
  );
}
