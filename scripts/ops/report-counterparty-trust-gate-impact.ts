/**
 * Read-only pre-enable impact report for section 6 counterparty trust enforcement.
 *
 * Lists paused counterparties with active payment intents before an environment
 * enables BRAIN_TRUST_GATE_ENABLED. It never writes and always uses a read-only
 * transaction through the existing cross-tenant ledger-projector connection.
 *
 * Run from the repository root:
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/report-counterparty-trust-gate-impact.ts
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/report-counterparty-trust-gate-impact.ts --tenant-id tnt_example
 *
 * Required env:
 *   BRAIN_LEDGER_PROJECTOR_DB_URL or DATABASE_URL
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";

interface ImpactRow {
  tenant_id: string;
  tenant_kind: "production" | "demo";
  sandbox: boolean;
  created_via: string;
  review_required: boolean;
  counterparty_id: string;
  counterparty_name: string;
  trust_status: "paused";
  payment_intent_count: string;
  payment_intent_ids: string[];
  statuses: string[];
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "tenant-id": { type: "string" },
    },
  });
  const tenantId = values["tenant-id"];
  if (tenantId !== undefined && !/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId)) {
    fail("--tenant-id must be a canonical tenant id");
  }
  const connectionString =
    env("BRAIN_LEDGER_PROJECTOR_DB_URL") ??
    env("DATABASE_URL") ??
    fail("missing BRAIN_LEDGER_PROJECTOR_DB_URL");
  const pool = new Pool({ connectionString });
  try {
    await pool.query("BEGIN TRANSACTION READ ONLY");
    const { rows } = await pool.query<ImpactRow>(
      `SELECT cp.owner_id AS tenant_id,
              t.kind AS tenant_kind,
              t.sandbox,
              t.created_via,
              (t.kind = 'production' AND t.sandbox = FALSE) AS review_required,
              cp.id AS counterparty_id,
              cp.name AS counterparty_name,
              cp.trust_status,
              COUNT(pi.id)::text AS payment_intent_count,
              array_agg(pi.id ORDER BY pi.created_at) AS payment_intent_ids,
              array_agg(DISTINCT pi.status ORDER BY pi.status) AS statuses
         FROM ledger_counterparties cp
         JOIN tenants t ON t.id = cp.owner_id
         JOIN ledger_payment_intents pi
           ON pi.owner_id = cp.owner_id
          AND pi.destination_counterparty_id = cp.id
        WHERE cp.trust_status = 'paused'
          AND pi.status IN (
            'proposed', 'pending_approval', 'awaiting_second_approval',
            'approved', 'paused', 'dispatching'
          )
          AND ($1::text IS NULL OR cp.owner_id = $1)
        GROUP BY cp.owner_id, t.kind, t.sandbox, t.created_via, cp.id, cp.name, cp.trust_status
        ORDER BY cp.owner_id, cp.name, cp.id`,
      [tenantId ?? null],
    );
    await pool.query("COMMIT");

    const total = rows.reduce((sum, row) => sum + Number(row.payment_intent_count), 0);
    const reviewRows = rows.filter((row) => row.review_required);
    const reviewIntents = reviewRows.reduce(
      (sum, row) => sum + Number(row.payment_intent_count),
      0,
    );
    const exemptRows = rows.filter((row) => !row.review_required);
    const exemptIntents = exemptRows.reduce(
      (sum, row) => sum + Number(row.payment_intent_count),
      0,
    );
    process.stdout.write(`paused_counterparty_groups=${rows.length}\n`);
    process.stdout.write(`affected_payment_intents=${total}\n`);
    process.stdout.write(`non_demo_review_groups=${reviewRows.length}\n`);
    process.stdout.write(`non_demo_review_payment_intents=${reviewIntents}\n`);
    process.stdout.write(`demo_or_sandbox_groups=${exemptRows.length}\n`);
    process.stdout.write(`demo_or_sandbox_payment_intents=${exemptIntents}\n`);
    for (const row of rows) {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await pool.end();
  }
}

void main();
