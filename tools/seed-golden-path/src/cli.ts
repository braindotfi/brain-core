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

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { InMemoryAuditEmitter, withTenantScope, newPolicyId, newAgentId } from "@brain/shared";
import { seedGoldenPath } from "./index.js";

/**
 * Demo-only governance seed: an active 5-rule policy + a registered payment
 * agent, so the golden money path works on a fresh testnet deploy WITHOUT the
 * real signed-EIP-712 policy ceremony / on-chain agent registration. NOT for
 * production — there policies are signed and agents are registered on-chain.
 * Skipped when BRAIN_SEED_DEMO_GOVERNANCE=false. Idempotent (deactivates any
 * prior active policy; replaces the demo agent).
 */
const DEMO_POLICY = {
  version: 1,
  rules: [
    {
      id: "auto-small-payment",
      applies_to: ["outbound_payment"],
      when: { "amount.lte": { currency: "USD", value: "1000.00" } },
      execute: "auto",
    },
    {
      id: "reject-excessive-payment",
      applies_to: ["outbound_payment"],
      when: { "amount.gt": { currency: "USD", value: "10000.00" } },
      execute: "reject",
    },
    {
      id: "confirm-mid-payment",
      applies_to: ["outbound_payment"],
      when: {
        "amount.gt": { currency: "USD", value: "1000.00" },
        "amount.lte": { currency: "USD", value: "10000.00" },
      },
      require: "owner_approval",
      execute: "confirm",
    },
    { id: "auto-agent-action", applies_to: ["agent_action"], when: {}, execute: "auto" },
    { id: "auto-onchain-tx", applies_to: ["onchain_tx"], when: {}, execute: "auto" },
  ],
};

async function seedDemoGovernance(
  pool: Pool,
  tenantId: string,
  actor: string,
): Promise<{ policy_id: string; agent_id: string }> {
  const smartAccount =
    process.env.BRAIN_ONCHAIN_SMART_ACCOUNT ?? "0x0000000000000000000000000000000000000000";
  const policyJson = JSON.stringify(DEMO_POLICY);
  const policyHash = createHash("sha256").update(policyJson).digest();
  const scopeHash = createHash("sha256").update(`${tenantId}:payment`).digest();
  const policyId = newPolicyId();
  const agentId = newAgentId();
  await withTenantScope(pool, tenantId, async (c) => {
    const v = await c.query<{ next: number }>(
      `SELECT COALESCE(MAX(version) + 1, 1) AS next FROM policies WHERE tenant_id = $1`,
      [tenantId],
    );
    await c.query(
      `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
    );
    await c.query(
      `INSERT INTO policies (id, tenant_id, version, content, content_hash, quorum_required, state, created_by, activated_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, 'active', $6, now(), now())`,
      [policyId, tenantId, v.rows[0]?.next ?? 1, policyJson, policyHash, actor],
    );
    await c.query(`DELETE FROM agents WHERE display_name = 'Demo Payment Agent'`);
    await c.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, onchain_address, state, registered_at, created_at, contribution_count, quarantine_threshold)
       VALUES ($1, $2, 'internal', 'payment', 'Demo Payment Agent', $3, $4, 'active', now(), now(), 0, 100)`,
      [agentId, tenantId, scopeHash, smartAccount],
    );
  });
  return { policy_id: policyId, agent_id: agentId };
}

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
  // Audit events from the seed go to stdout via InMemoryAuditEmitter.
  // Production wiring would inject PostgresAuditEmitter; the seed is
  // explicitly off-the-record so an analyst running it locally doesn't
  // pollute the tenant's audit chain.
  const audit = new InMemoryAuditEmitter();

  try {
    const result = await seedGoldenPath(pool, audit, tenantId, actor);
    const governance =
      process.env.BRAIN_SEED_DEMO_GOVERNANCE === "false"
        ? "skipped"
        : await seedDemoGovernance(pool, tenantId, actor);
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
          demo_governance: governance,
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
