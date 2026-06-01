#!/usr/bin/env node
/**
 * brain-demo-reset — wipe a demo tenant's ledger data and re-seed.
 *
 * Required env:
 *   DATABASE_URL    Postgres connection string
 *   BRAIN_TENANT_ID tnt_<ulid>  (must already exist)
 *   BRAIN_ACTOR     user_<ulid> or agent_<ulid>
 *
 * Usage:
 *   DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *   BRAIN_TENANT_ID=tnt_01GOLDEN00000000000000000 \
 *   BRAIN_ACTOR=usr_01GOLDEN00000000000000000 \
 *   node tools/demo-reset/dist/cli.js
 */

import { Pool } from "pg";
import { InMemoryAuditEmitter } from "@brain/shared";
import { seedGoldenPath } from "@brain/seed-golden-path";

// audit_events and audit_anchors are intentionally excluded — the audit log is
// append-only per the non-negotiable principles in CLAUDE.md. Demo resets
// clear business-entity state only; the audit chain must survive resets.
// { table, tenantCol } — delete in dependency order so FK constraints don't fire.
// ledger_* tables use owner_id; wiki_pages uses tenant_id.
const DEMO_TABLES: ReadonlyArray<{ table: string; tenantCol: string }> = [
  { table: "policy_decisions", tenantCol: "tenant_id" },
  { table: "policies", tenantCol: "tenant_id" },
  { table: "ledger_payment_intents", tenantCol: "owner_id" },
  { table: "ledger_transactions", tenantCol: "owner_id" },
  { table: "ledger_invoices", tenantCol: "owner_id" },
  { table: "ledger_obligations", tenantCol: "owner_id" },
  { table: "ledger_documents", tenantCol: "owner_id" },
  { table: "wiki_pages", tenantCol: "tenant_id" },
  { table: "ledger_accounts", tenantCol: "owner_id" },
  { table: "ledger_counterparties", tenantCol: "owner_id" },
];

async function truncateTenant(pool: Pool, tenantId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // Delete in dependency order so FK constraints don't fire.
    for (const { table, tenantCol } of DEMO_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE ${tenantCol} = $1`, [tenantId]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<number> {
  const dbUrl = process.env["DATABASE_URL"];
  const tenantId = process.env["BRAIN_TENANT_ID"];
  const actor = process.env["BRAIN_ACTOR"];

  if (dbUrl === undefined || tenantId === undefined || actor === undefined) {
    process.stderr.write("error: DATABASE_URL, BRAIN_TENANT_ID, and BRAIN_ACTOR are required\n");
    return 1;
  }
  if (!tenantId.startsWith("tnt_")) {
    process.stderr.write("error: BRAIN_TENANT_ID must be a tnt_<ulid>\n");
    return 1;
  }

  const pool = new Pool({ connectionString: dbUrl, max: 5 });
  const start = Date.now();

  try {
    process.stdout.write(`demo-reset: truncating tenant ${tenantId}...\n`);
    await truncateTenant(pool, tenantId);

    process.stdout.write("demo-reset: re-seeding...\n");
    const audit = new InMemoryAuditEmitter();
    await seedGoldenPath(pool, audit, tenantId, actor);

    const elapsed = Date.now() - start;
    process.stdout.write(`demo-reset: done in ${elapsed}ms\n`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`demo-reset: failed — ${msg}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`demo-reset: unhandled error — ${msg}\n`);
    process.exit(1);
  });
