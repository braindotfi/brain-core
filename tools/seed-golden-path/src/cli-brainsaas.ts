#!/usr/bin/env node
/**
 * brain-seed-brainsaas — provisions a tenant with the BrainSaaS "Brain
 * Playground" demo dataset (the AP / Treasury / AR scenarios), so brain-core
 * is the single source of truth for that demo. See ./brainsaas.ts.
 *
 * Required env:
 *   DATABASE_URL    Postgres connection string
 *   BRAIN_TENANT_ID tnt_<ulid>
 *   BRAIN_ACTOR     actor id (user_<ulid> or agent_<ulid>)
 *
 * Optional env:
 *   BRAIN_ONCHAIN_SMART_ACCOUNT  0x... — when set, seeds an onchain account and
 *                                points the demo agent at it (for the onchain_base rail).
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   BRAIN_TENANT_ID=tnt_01HQ7K3 \
 *   BRAIN_ACTOR=user_01HQ7K3 \
 *   node tools/seed-golden-path/dist/cli-brainsaas.js
 */

import { Pool } from "pg";
import { InMemoryAuditEmitter } from "@brain/shared";
import { seedBrainSaasDemo } from "./brainsaas.js";

async function main(): Promise<number> {
  const dbUrl = process.env.DATABASE_URL;
  const tenantId = process.env.BRAIN_TENANT_ID;
  const actor = process.env.BRAIN_ACTOR;

  if (dbUrl === undefined || tenantId === undefined || actor === undefined) {
    process.stderr.write("error: DATABASE_URL, BRAIN_TENANT_ID, and BRAIN_ACTOR are required\n");
    return 1;
  }
  if (!tenantId.startsWith("tnt_")) {
    process.stderr.write("error: BRAIN_TENANT_ID must be a tnt_<ulid>\n");
    return 1;
  }

  const pool = new Pool({ connectionString: dbUrl, max: 5 });
  // The seed is explicitly off-the-record (like the golden-path seed) so an
  // analyst running it locally doesn't pollute the tenant's audit chain.
  const audit = new InMemoryAuditEmitter();

  try {
    const result = await seedBrainSaasDemo(pool, audit, tenantId, actor);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          tenant_id: tenantId,
          vendors: result.vendors,
          customers: result.customers,
          accounts: result.accounts,
          ap_invoices: result.apInvoices,
          ar_invoices: result.arInvoices,
          policy_id: result.policyId,
          agent_id: result.agentId,
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
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
