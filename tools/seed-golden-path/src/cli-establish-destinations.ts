#!/usr/bin/env node
/**
 * brain-seed-establish-destinations — demo-only. Backdates a tenant's
 * payment-instruction history out of the section 6 gate's 24h fraud window.
 *
 * Why this exists as a SEPARATE step from the main seed:
 *
 * The migration 0027 trigger on ledger_counterparties fires AFTER INSERT OR
 * UPDATE OF (linked_accounts, onchain_address), so EVERY counterparty gets a
 * payment-instruction row stamped at now() the moment it is created -- not
 * only when its destination actually changes. Gate check 11.5 rule 6
 * (destination_recently_changed, services/policy/src/duplicate-detector.ts)
 * reads any such row inside 24h as the strongest fraud signal it has.
 *
 * Both existing seeders already backdate for exactly this reason
 * (tools/seed-golden-path/src/index.ts and
 * services/api/src/demo/brainsaas-seed.ts), but they can only cover rows that
 * exist at seed time. A counterparty that the canonical projector mints later
 * -- which is what a document-extracted obligation always produces, since
 * canonical projection creates its own ledger counterparty rather than
 * matching a seeded one by name -- is stamped at now() well after the seed has
 * finished, so the golden path's own document vendor stays inside the window
 * and the run cannot reach the rail.
 *
 * Running this after the obligation projects makes the destination read as
 * pre-established, which is what the demo dataset represents. It does NOT
 * change the gate: a genuine destination change during a run still stamps
 * now() and is still flagged.
 *
 * Required env:
 *   DATABASE_URL    Postgres connection string
 *   BRAIN_TENANT_ID tnt_<ulid>
 */

import { Pool } from "pg";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  const tenantId = process.env.BRAIN_TENANT_ID;
  if (
    databaseUrl === undefined ||
    databaseUrl === "" ||
    tenantId === undefined ||
    tenantId === ""
  ) {
    process.stderr.write("error: DATABASE_URL and BRAIN_TENANT_ID are required\n");
    return 1;
  }
  if (!/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId)) {
    process.stderr.write("error: BRAIN_TENANT_ID must be a tnt_<ulid>\n");
    return 1;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rowCount } = await pool.query(
      `UPDATE ledger_counterparty_payment_instructions
          SET changed_at = now() - interval '25 hours'
        WHERE owner_id = $1
          AND changed_at > now() - interval '24 hours'`,
      [tenantId],
    );
    process.stdout.write(`backdated ${rowCount ?? 0} payment-instruction row(s)\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
