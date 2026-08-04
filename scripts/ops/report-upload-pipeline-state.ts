/**
 * Read-only staging diagnostic for one upload pipeline tenant.
 *
 * It reports the state transitions across Raw extraction, canonical projection,
 * and compact Ledger projection without exposing document bytes or raw payloads.
 * The script accepts only a validated tenant id and executes inside a read-only
 * transaction using the worker's least-privileged projection connection.
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";

interface CountRow {
  count: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printRows(title: string, rows: readonly Record<string, unknown>[]): void {
  process.stdout.write(`${title}\n`);
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "tenant-id": { type: "string" } } });
  const tenantId = values["tenant-id"];
  if (tenantId === undefined || !/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId)) {
    fail("--tenant-id must be a canonical tenant id");
  }
  const connectionString =
    env("BRAIN_LEDGER_PROJECTOR_DB_URL") ??
    env("DATABASE_URL") ??
    fail("missing BRAIN_LEDGER_PROJECTOR_DB_URL");
  const pool = new Pool({ connectionString });
  try {
    await pool.query("BEGIN TRANSACTION READ ONLY");
    const params = [tenantId];
    const artifacts = await pool.query<Record<string, unknown>>(
      `SELECT ra.id AS raw_artifact_id,
              ra.source_ref->>'filename' AS filename,
              ra.source_type,
              ra.mime_type,
              ra.projection_status,
              ej.status AS extraction_status,
              ej.attempt_count,
              ej.parsed_id,
              ej.error->>'code' AS extraction_error_code,
              rp.parser,
              rp.parser_version,
              rp.extracted->>'object_type' AS object_type,
              cpl.projector,
              cpl.records_written,
              cpl.error AS canonical_error,
              cpl.quarantined
         FROM raw_artifacts ra
         LEFT JOIN LATERAL (
           SELECT status, attempt_count, parsed_id, error
             FROM extraction_jobs
            WHERE tenant_id = ra.tenant_id AND raw_id = ra.id
            ORDER BY updated_at DESC
            LIMIT 1
         ) ej ON true
         LEFT JOIN raw_parsed rp ON rp.id = ej.parsed_id AND rp.tenant_id = ra.tenant_id
         LEFT JOIN canonical_projection_log cpl ON cpl.raw_parsed_id = rp.id
        WHERE ra.tenant_id = $1
        ORDER BY ra.ingested_at ASC, ra.id ASC`,
      params,
    );
    const canonicalObligations = await pool.query<Record<string, unknown>>(
      `SELECT source_system, source_natural_key, direction, type, amount, currency, due_date, status,
              source_ids, evidence_ids
         FROM canonical_obligation
        WHERE tenant_id = $1
        ORDER BY updated_at ASC, id ASC`,
      params,
    );
    const obligations = await pool.query<Record<string, unknown>>(
      `SELECT lo.id, lo.type, lo.direction, lo.amount_due, lo.currency, lo.due_date, lo.status,
              cp.name AS counterparty_name, lo.source_ids, lo.evidence_ids
         FROM ledger_obligations lo
         LEFT JOIN ledger_counterparties cp ON cp.owner_id = lo.owner_id AND cp.id = lo.counterparty_id
        WHERE lo.owner_id = $1
        ORDER BY lo.due_date ASC, lo.id ASC`,
      params,
    );
    const invoices = await pool.query<Record<string, unknown>>(
      `SELECT li.id, li.invoice_number, li.amount_due, li.currency, li.due_date, li.status,
              cp.name AS counterparty_name, li.source_ids, li.evidence_ids
         FROM ledger_invoices li
         LEFT JOIN ledger_counterparties cp ON cp.owner_id = li.owner_id AND cp.id = li.counterparty_id
        WHERE li.owner_id = $1
        ORDER BY li.due_date ASC, li.id ASC`,
      params,
    );
    const transactions = await pool.query<CountRow>(
      `SELECT count(*)::text AS count FROM ledger_transactions WHERE owner_id = $1`,
      params,
    );
    await pool.query("COMMIT");

    process.stdout.write(`tenant_id=${tenantId}\n`);
    printRows("raw_artifacts", artifacts.rows);
    printRows("canonical_obligations", canonicalObligations.rows);
    printRows("ledger_obligations", obligations.rows);
    printRows("ledger_invoices", invoices.rows);
    process.stdout.write(`ledger_transaction_count=${transactions.rows[0]?.count ?? "0"}\n`);
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch {
      // Preserve the original diagnostic failure.
    }
    throw error;
  } finally {
    await pool.end();
  }
}

void main();
