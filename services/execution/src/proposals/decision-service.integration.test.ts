import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import {
  newAccountId,
  newAgentId,
  newCounterpartyId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newProposalId,
  newTenantId,
  newUserId,
  PostgresAuditEmitter,
  withTenantScope,
  type PaymentIntent,
  type ServiceCallContext,
} from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import { ActorResolver } from "../members/ActorResolver.js";
import { PostgresMemberLookup } from "../members/repository.js";
import { ProposalDecisionService } from "./decision-service.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("proposal decisions integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let service: ProposalDecisionService;

  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const memberA = newUserId();
  const memberB = newUserId();
  const missingMember = newUserId();
  const agentA = newAgentId();
  const agentB = newAgentId();
  const notifyProposal = newProposalId();
  const tenantBProposal = newProposalId();
  const approvedProposal = newProposalId();
  const executedProposal = newProposalId();
  const paymentIntent = newPaymentIntentId();

  const approvePaymentIntent = vi.fn(async () => paymentIntentRecord("awaiting_second_approval"));

  const userCtx: ServiceCallContext = {
    tenantId: tenantA,
    actor: memberA,
    principalType: "user",
    scopes: ["payment_intent:approve"],
  };
  const tenantBCtx: ServiceCallContext = {
    tenantId: tenantB,
    actor: memberB,
    principalType: "user",
  };
  const missingCtx: ServiceCallContext = {
    tenantId: tenantA,
    actor: missingMember,
    principalType: "user",
  };
  const agentCtx: ServiceCallContext = {
    tenantId: tenantA,
    actor: agentA,
    principalType: "agent",
  };

  beforeAll(async () => {
    schema = `proposal_decide_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: schema });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}, public`);
    });

    const migrator = await pool.connect();
    try {
      await migrator.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(migrator as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "proposals-decide-integration",
      });
    } finally {
      migrator.release();
    }

    await seedTenant(tenantA, memberA, agentA);
    await seedTenant(tenantB, memberB, agentB);
    await seedProposal(tenantA, agentA, notifyProposal, "pending", {
      type: "vendor_risk",
      mode: "notify_only",
    });
    await seedProposal(tenantB, agentB, tenantBProposal, "pending", {
      type: "vendor_risk",
      mode: "notify_only",
    });
    await seedProposal(tenantA, agentA, approvedProposal, "approved", {
      type: "compliance",
      mode: "propose",
    });
    await seedProposal(tenantA, agentA, executedProposal, "executed", {
      type: "compliance",
      mode: "propose",
    });
    await seedPaymentIntent(tenantA, agentA, paymentIntent);

    service = new ProposalDecisionService({
      pool,
      audit: new PostgresAuditEmitter(pool),
      actorResolver: new ActorResolver({ members: new PostgresMemberLookup(pool) }),
      paymentIntents: {
        approve: approvePaymentIntent,
      } as unknown as PaymentIntentService,
    });
  }, 60_000);

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  }, 60_000);

  it("writes proposal.decided audit before acknowledging notify-only proposals", async () => {
    const result = await service.decide(userCtx, notifyProposal, "acknowledge");

    expect(result).toMatchObject({
      id: notifyProposal,
      decision: "acknowledge",
      status: "acknowledged",
      payment_intent_id: null,
    });
    expect(result.audit_id).toEqual(expect.stringMatching(/^evt_/));

    const row = await proposalRow(tenantA, notifyProposal);
    expect(row?.status).toBe("acknowledged");

    const audit = await auditRow(tenantA, result.audit_id ?? "");
    expect(audit).toMatchObject({
      action: "proposal.decided",
      actor: memberA,
    });
    expect(audit?.before_state).toMatchObject({ id: notifyProposal, status: "pending" });
    expect(audit?.after_state).toMatchObject({ id: notifyProposal, status: "acknowledged" });
  });

  it("is idempotent for a repeated terminal decision", async () => {
    const first = await service.decide(userCtx, notifyProposal, "acknowledge");
    const second = await service.decide(userCtx, notifyProposal, "acknowledge");

    expect(second.audit_id).toBe(first.audit_id);
    expect(await decisionAuditCount(tenantA, notifyProposal, "acknowledge")).toBe(1);
  });

  it("denies unauthorized users and agent principals without auditing", async () => {
    const unauthorizedProposal = newProposalId();
    const agentDeniedProposal = newProposalId();
    await seedProposal(tenantA, agentA, unauthorizedProposal, "pending", {
      type: "vendor_risk",
      mode: "notify_only",
    });
    await seedProposal(tenantA, agentA, agentDeniedProposal, "pending", {
      type: "vendor_risk",
      mode: "notify_only",
    });

    await expect(
      service.decide(missingCtx, unauthorizedProposal, "acknowledge"),
    ).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
    });
    await expect(
      service.decide(agentCtx, agentDeniedProposal, "acknowledge"),
    ).rejects.toMatchObject({
      code: "payment_intent_approval_invalid",
    });

    expect(await decisionAuditCount(tenantA, unauthorizedProposal, "acknowledge")).toBe(0);
    expect(await decisionAuditCount(tenantA, agentDeniedProposal, "acknowledge")).toBe(0);
  });

  it("does not expose proposals across tenants", async () => {
    await expect(service.decide(userCtx, tenantBProposal, "acknowledge")).rejects.toMatchObject({
      code: "execution_proposal_not_found",
    });

    const result = await service.decide(tenantBCtx, tenantBProposal, "acknowledge");
    expect(result.status).toBe("acknowledged");
  });

  it("allows undo before execution and rejects undo after execution", async () => {
    const undone = await service.decide(userCtx, approvedProposal, "undo");
    expect(undone.status).toBe("undone");

    await expect(service.decide(userCtx, executedProposal, "undo")).rejects.toMatchObject({
      code: "execution_proposal_invalid_state",
    });
    expect((await proposalRow(tenantA, executedProposal))?.status).toBe("executed");
  });

  it("routes money-path approval through PaymentIntentService", async () => {
    const result = await service.decide(userCtx, paymentIntent, "approve");

    expect(approvePaymentIntent).toHaveBeenCalledWith(userCtx, paymentIntent);
    expect(result).toMatchObject({
      id: paymentIntent,
      status: "awaiting_second_approval",
      payment_intent_id: paymentIntent,
    });
  });

  async function seedTenant(tenant: string, member: string, agent: string): Promise<void> {
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenant]);
      await client.query(
        `INSERT INTO members (
           tenant_id, id, email, display_name, role, status, active, approval_domains,
           per_item_limit_cents, requires_second_approver_above_cents
         )
         VALUES ($1, $2, $3, 'Admin', 'admin', 'active', true,
           ARRAY['ap', 'ar', 'treasury', 'payroll', 'reconciliation']::text[],
           9223372036854775807, NULL)`,
        [tenant, member, `${member}@example.com`],
      );
      await client.query(
        `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
         VALUES ($1, $2, 'internal', 'vendor_risk', 'Vendor Risk Agent', 'active', now())`,
        [agent, tenant],
      );
    });
  }

  async function seedProposal(
    tenant: string,
    agent: string,
    proposal: string,
    status: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(
        `INSERT INTO proposals (
           id, tenant_id, proposing_agent, action, policy_version, policy_decision,
           policy_trace, required_approvers, status, approvers_signed, created_at
         )
         VALUES ($1, $2, $3, $4::jsonb, 1, 'confirm', '{}'::jsonb, ARRAY[]::text[],
           $5, ARRAY[]::text[], now())`,
        [proposal, tenant, agent, JSON.stringify(action), status],
      );
    });
  }

  async function seedPaymentIntent(tenant: string, agent: string, intent: string): Promise<void> {
    await withTenantScope(pool, tenant, async (client) => {
      const account = newAccountId();
      const counterparty = newCounterpartyId();
      await client.query(
        `INSERT INTO ledger_accounts (
           id, owner_id, external_account_id, account_type, name, currency,
           status, source_ids, evidence_ids, provenance, confidence
         )
         VALUES ($1, $2, $3, 'bank_checking', 'Checking', 'USD', 'active',
           ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
        [account, tenant, `ext_${account}`],
      );
      await client.query(
        `INSERT INTO ledger_counterparties (
           id, owner_id, name, normalized_name, type, aliases, linked_accounts,
           source_ids, evidence_ids, provenance, confidence
         )
         VALUES ($1, $2, 'Vendor', 'vendor', 'vendor', ARRAY[]::text[], ARRAY[]::text[],
           ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
        [counterparty, tenant],
      );
      await client.query(
        `INSERT INTO ledger_payment_intents (
           id, owner_id, created_by_agent_id, action_type, source_account_id,
           destination_counterparty_id, amount, currency, status,
           policy_decision_id, approval_ids, execution_receipt_ids, source_ids,
           evidence_ids, provenance, confidence, created_at, updated_at
         )
         VALUES ($1, $2, $3, 'ach_outbound', $4, $5, 10, 'USD', 'pending_approval',
           $6, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
           ARRAY[]::text[], 'agent_contributed', 0.91, now(), now())`,
        [intent, tenant, agent, account, counterparty, newPolicyDecisionId()],
      );
    });
  }

  async function proposalRow(tenant: string, proposal: string): Promise<{ status: string } | null> {
    return withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM proposals WHERE id = $1`,
        [proposal],
      );
      return rows[0] ?? null;
    });
  }

  async function auditRow(
    tenant: string,
    auditId: string,
  ): Promise<{
    action: string;
    actor: string;
    before_state: Record<string, unknown> | null;
    after_state: Record<string, unknown> | null;
  } | null> {
    return withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{
        action: string;
        actor: string;
        before_state: Record<string, unknown> | null;
        after_state: Record<string, unknown> | null;
      }>(`SELECT action, actor, before_state, after_state FROM audit_events WHERE id = $1`, [
        auditId,
      ]);
      return rows[0] ?? null;
    });
  }

  async function decisionAuditCount(
    tenant: string,
    proposal: string,
    decision: string,
  ): Promise<number> {
    return withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM audit_events
          WHERE action = 'proposal.decided'
            AND inputs->>'proposal_id' = $1
            AND inputs->>'decision' = $2`,
        [proposal, decision],
      );
      return Number(rows[0]?.count ?? "0");
    });
  }
});

function paymentIntentRecord(status: PaymentIntent["status"]): PaymentIntent {
  const now = new Date().toISOString();
  return {
    id: newPaymentIntentId(),
    owner_id: newTenantId(),
    created_by_agent_id: newAgentId(),
    action_type: "ach_outbound",
    source_account_id: newAccountId(),
    destination_counterparty_id: newCounterpartyId(),
    amount: "10",
    currency: "USD",
    obligation_id: null,
    invoice_id: null,
    status,
    policy_decision_id: newPolicyDecisionId(),
    approval_ids: [],
    execution_receipt_ids: [],
    source_ids: [],
    evidence_ids: [],
    provenance: "agent_contributed",
    confidence: 0.91,
    created_at: now,
    updated_at: now,
  };
}
