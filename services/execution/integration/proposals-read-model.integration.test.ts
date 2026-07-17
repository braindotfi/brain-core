import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  newAccountId,
  newAgentId,
  newCounterpartyId,
  newDocumentId,
  newInvoiceId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newProposalId,
  newRawParsedId,
  newTenantId,
  newUserId,
  newWikiEntityId,
  withTenantScope,
  type ServiceCallContext,
} from "@brain/shared";
import { listProposals, getProposal, type ProposalReadItem } from "../src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

suite("proposals read model integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;

  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const userA = newUserId();
  const userB = newUserId();
  const vendorAgentA = newAgentId();
  const paymentAgentA = newAgentId();
  const vendorAgentB = newAgentId();
  const proposalA1 = newProposalId();
  const proposalA2 = newProposalId();
  const proposalB1 = newProposalId();
  const paymentIntentA = newPaymentIntentId();
  const wikiEntity = newWikiEntityId();
  const invoiceRef = newInvoiceId();
  const documentRef = newDocumentId();
  const parsedRef = newRawParsedId();

  const ctxA: ServiceCallContext = { tenantId: tenantA, actor: userA };
  const ctxB: ServiceCallContext = { tenantId: tenantB, actor: userB };

  beforeAll(async () => {
    schema = `proposal_read_${createHash("sha1")
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
        appliedBy: "proposals-read-model-integration",
      });
    } finally {
      migrator.release();
    }

    await seedTenant(tenantA, vendorAgentA, paymentAgentA, proposalA1, proposalA2, paymentIntentA);
    await seedTenant(tenantB, vendorAgentB, null, proposalB1, null, null);
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

  it("isolates tenants, paginates stably, and returns typed evidence refs", async () => {
    const firstPage = await listProposals(pool, ctxA, { limit: 2 });
    expect(firstPage.proposals.map((proposal) => proposal.id)).toEqual([
      proposalA1,
      paymentIntentA,
    ]);
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const secondPage = await listProposals(pool, ctxA, {
      limit: 2,
      cursor: firstPage.next_cursor ?? undefined,
    });
    expect(secondPage.proposals.map((proposal) => proposal.id)).toEqual([proposalA2]);
    expect(secondPage.next_cursor).toBeNull();

    const combined = [...firstPage.proposals, ...secondPage.proposals];
    expect(new Set(combined.map((proposal) => proposal.id)).size).toBe(3);
    expect(combined.map((proposal) => proposal.id)).not.toContain(proposalB1);

    expectProposalEvidence(firstPage.proposals[0]!, [
      { kind: "invoice", ref: invoiceRef, resolvable: false },
      { kind: "policy", ref: wikiEntity, resolvable: true },
    ]);
    expectProposalEvidence(firstPage.proposals[1]!, [
      { kind: "document", ref: documentRef, resolvable: false },
      { kind: "raw_parsed", ref: parsedRef, resolvable: false },
    ]);

    expect(await getProposal(pool, ctxA, proposalA1)).toMatchObject({ id: proposalA1 });
    expect(await getProposal(pool, ctxB, proposalA1)).toBeNull();
    expect((await listProposals(pool, ctxB, {})).proposals.map((proposal) => proposal.id)).toEqual([
      proposalB1,
    ]);
  });

  async function seedTenant(
    tenant: string,
    vendorAgent: string,
    paymentAgent: string | null,
    primaryProposal: string,
    secondaryProposal: string | null,
    paymentIntent: string | null,
  ): Promise<void> {
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenant]);
      await client.query(
        `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
         VALUES ($1, $2, 'internal', 'vendor_risk', 'Vendor Risk Agent', 'active', now())`,
        [vendorAgent, tenant],
      );
      if (paymentAgent !== null) {
        await client.query(
          `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
           VALUES ($1, $2, 'internal', 'payment', 'Payment Agent', 'active', now())`,
          [paymentAgent, tenant],
        );
      }

      await client.query(
        `INSERT INTO proposals (
           id, tenant_id, proposing_agent, action, policy_version, policy_decision,
           policy_trace, required_approvers, status, approvers_signed, created_at
         )
         VALUES ($1, $2, $3, $4::jsonb, 1, 'confirm', '{}'::jsonb, ARRAY[]::text[], 'pending', ARRAY[]::text[], $5::timestamptz)`,
        [
          primaryProposal,
          tenant,
          vendorAgent,
          JSON.stringify({
            type: "vendor_risk",
            risk_band: "elevated",
            confidence: "0.77",
            narrative: "Vendor risk increased.",
            evidence_refs:
              tenant === tenantA
                ? [
                    { kind: "invoice", ref: invoiceRef },
                    { kind: "policy", ref: wikiEntity },
                  ]
                : [{ kind: "invoice", ref: newInvoiceId() }],
          }),
          tenant === tenantA ? "2026-01-03T00:00:00.000Z" : "2026-01-04T00:00:00.000Z",
        ],
      );

      if (tenant === tenantA) {
        await client.query(
          `INSERT INTO wiki_entities (
             id, tenant_id, kind, attributes, valid_from, valid_to,
             provenance, confidence, source_evidence
           )
           VALUES ($1, $2, 'policy', '{"name":"Policy"}'::jsonb, now(), NULL, 'human_confirmed', 1, ARRAY[]::text[])`,
          [wikiEntity, tenant],
        );
      }

      if (secondaryProposal !== null) {
        await client.query(
          `INSERT INTO proposals (
             id, tenant_id, proposing_agent, action, policy_version, policy_decision,
             policy_trace, required_approvers, status, approvers_signed, created_at
           )
           VALUES ($1, $2, $3, $4::jsonb, 1, 'allow', '{}'::jsonb, ARRAY[]::text[], 'pending', ARRAY[]::text[], '2026-01-01T00:00:00.000Z')`,
          [
            secondaryProposal,
            tenant,
            vendorAgent,
            JSON.stringify({
              type: "collections",
              evidence_refs: ["legacy_ref"],
            }),
          ],
        );
      }

      if (paymentAgent !== null && paymentIntent !== null) {
        const account = newAccountId();
        const counterparty = newCounterpartyId();
        await client.query(
          `INSERT INTO ledger_accounts (
             id, owner_id, external_account_id, account_type, name, currency,
             status, source_ids, evidence_ids, provenance, confidence
           )
           VALUES ($1, $2, $3, 'bank_checking', 'Checking', 'USD', 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
          [account, tenant, `ext_${account}`],
        );
        await client.query(
          `INSERT INTO ledger_counterparties (
             id, owner_id, name, normalized_name, type, aliases, linked_accounts,
             source_ids, evidence_ids, provenance, confidence
           )
           VALUES ($1, $2, 'Vendor', 'vendor', 'vendor', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
          [counterparty, tenant],
        );
        await client.query(
          `INSERT INTO ledger_payment_intents (
             id, owner_id, created_by_agent_id, action_type, source_account_id,
             destination_counterparty_id, amount, currency, status,
             policy_decision_id, approval_ids, execution_receipt_ids, source_ids,
             evidence_ids, provenance, confidence, created_at, updated_at
           )
           VALUES ($1, $2, $3, 'ach_outbound', $4, $5, 10, 'USD', 'approved',
             $6, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
             $7::text[], 'agent_contributed', 0.91, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
          [
            paymentIntent,
            tenant,
            paymentAgent,
            account,
            counterparty,
            newPolicyDecisionId(),
            [documentRef, parsedRef],
          ],
        );
      }
    });
  }
});

function expectProposalEvidence(
  proposal: ProposalReadItem,
  expected: ProposalReadItem["evidence"],
): void {
  expect(proposal.evidence).toEqual(expected);
}
