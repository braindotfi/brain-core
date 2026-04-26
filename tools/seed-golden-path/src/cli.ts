#!/usr/bin/env node
/**
 * brain-seed-golden-path — populates a tenant with the refactor-6 dataset.
 *
 * Required env:
 *   DATABASE_URL    Postgres connection string
 *   BRAIN_TENANT_ID tnt_<ulid>
 *   BRAIN_ACTOR     actor id (user_<ulid> or agent_<ulid>)
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   BRAIN_TENANT_ID=tnt_01HQ7K3 \
 *   BRAIN_ACTOR=user_01HQ7K3 \
 *   node tools/seed-golden-path/dist/cli.js
 */

import { Pool } from "pg";
import { InMemoryAuditEmitter } from "@brain/api/shared";
import { seedGoldenPath } from "./index.js";

async function main(): Promise<number> {
  const dbUrl = process.env.DATABASE_URL;
  const tenantId = process.env.BRAIN_TENANT_ID;
  const actor = process.env.BRAIN_ACTOR;

  if (dbUrl === undefined || tenantId === undefined || actor === undefined) {
    process.stderr.write(
      "error: DATABASE_URL, BRAIN_TENANT_ID, and BRAIN_ACTOR are required\n",
    );
    return 1;
  }
  if (!tenantId.startsWith("tnt_")) {
    process.stderr.write("error: BRAIN_TENANT_ID must be a tnt_<ulid>\n");
    return 1;
  }

  const pool = new Pool({ connectionString: dbUrl, max: 5 });
  // Audit events from the seed go to stdout via InMemoryAuditEmitter.
  // Production wiring would inject PostgresAuditEmitter; the seed is
  // explicitly off-the-record so an analyst running it locally doesn't
  // pollute the tenant's audit chain.
  const audit = new InMemoryAuditEmitter();

  try {
    const result = await seedGoldenPath(pool, audit, tenantId, actor);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          tenant_id: tenantId,
          accounts: {
            checking: result.accounts.checking.id,
            savings: result.accounts.savings.id,
            card: result.accounts.card.id,
          },
          counterparties: Object.fromEntries(
            Object.entries(result.counterparties).map(([k, v]) => [k, v.id]),
          ),
          obligations: result.obligations,
          invoices: result.invoices,
          documents: result.documents,
          payment_intents: result.paymentIntents,
          audit_events_emitted: audit.events.length,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
