import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  upsertObligationRow,
} from "@brain/ledger";
import {
  contentHash,
  runActivationLintGate,
  validatePolicyDocument,
  type PolicyDocument,
} from "@brain/policy";
import {
  newAgentId,
  newInvoiceId,
  newPolicyId,
  newProposalId,
  newRawArtifactId,
  newRawParsedId,
  PostgresAuditEmitter,
  withTenantScope,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  NORTHSTAR_AS_OF,
  NORTHSTAR_COUNTERPARTIES,
  NORTHSTAR_MONTHLY_CASH_FLOW,
  NORTHSTAR_PAYABLES,
  NORTHSTAR_RECEIVABLES,
  NORTHSTAR_SEED_KEY,
  validateNorthstarFixture,
} from "./fixture.js";

export type NorthstarSeedResult = {
  tenantId: string;
  policyId: string;
  agentId: string;
  proposalIds: string[];
  counts: {
    accounts: number;
    counterparties: number;
    transactions: number;
    payables: number;
    receivables: number;
  };
};

type NorthstarPolicyDocument = PolicyDocument & { seed_key: string };

export async function seedNorthstarDemo(
  pool: Pool,
  tenantId: string,
  actor: string,
): Promise<NorthstarSeedResult> {
  validateNorthstarFixture();
  await assertTenantIsReady(pool, tenantId);

  const audit = new PostgresAuditEmitter(pool);
  const ctx: ServiceCallContext = { tenantId, actor };
  const sourceIds = [newRawArtifactId()];
  const evidenceIds = [newRawParsedId()];
  const counterparties = new Map<string, string>();

  for (const fixture of NORTHSTAR_COUNTERPARTIES) {
    const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
      name: fixture.name,
      type: fixture.type,
      risk_level: fixture.riskLevel,
      verified_status: fixture.verifiedStatus,
      metadata: {
        seed_key: NORTHSTAR_SEED_KEY,
        segment: fixture.type === "customer" ? "customer" : "vendor",
      },
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "human_confirmed",
      confidence: 1,
    });
    counterparties.set(fixture.key, row.id);
  }

  const operating = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "northstar:operating:001",
    institution: "Harborline Bank",
    account_type: "bank_checking",
    name: "Northstar Operating",
    currency: "USD",
    current_balance: "482750.00",
    available_balance: "482750.00",
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "human_confirmed",
    confidence: 1,
  });
  await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "northstar:reserve:001",
    institution: "Harborline Bank",
    account_type: "bank_savings",
    name: "Northstar Reserve",
    currency: "USD",
    current_balance: "1200000.00",
    available_balance: "1200000.00",
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "human_confirmed",
    confidence: 1,
  });
  const card = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "northstar:card:001",
    institution: "Keystone Corporate Card",
    account_type: "card",
    name: "Northstar Corporate Card",
    currency: "USD",
    current_balance: "28640.00",
    available_balance: "0.00",
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "human_confirmed",
    confidence: 1,
  });

  for (const [index, month] of NORTHSTAR_MONTHLY_CASH_FLOW.entries()) {
    const date = `${month.month}-15T12:00:00.000Z`;
    const customer = ["helio", "apex", "kestrel", "vertex", "horizon"][index % 5]!;
    const entries = [
      ["revenue", month.revenue, "inflow", customer, "Subscription revenue"],
      ["payroll", month.payroll, "outflow", "meridian", "Payroll and benefits"],
      ["cloud", month.cloud, "outflow", "cascade", "Cloud infrastructure"],
      ["operating", month.other, "outflow", "redwood", "Operating expense"],
    ] as const;
    for (const [kind, amount, direction, counterpartyKey, description] of entries) {
      await recordTransactionRow(pool, audit, ctx, {
        account_id:
          direction === "outflow" && kind === "operating" ? card.row.id : operating.row.id,
        external_transaction_id: `northstar:${month.month}:${kind}`,
        amount: amount.toFixed(2),
        currency: "USD",
        direction,
        transaction_date: date,
        posted_date: date,
        counterparty_id: counterparties.get(counterpartyKey)!,
        status: "posted",
        description_normalized: description,
        source_ids: sourceIds,
        evidence_ids: evidenceIds,
        provenance: "human_confirmed",
        confidence: 1,
      });
    }
  }

  for (const [counterpartyKey, invoiceNumber, amount, dueDate, type] of NORTHSTAR_PAYABLES) {
    await upsertObligationRow(pool, audit, ctx, {
      type,
      counterparty_id: counterparties.get(counterpartyKey)!,
      amount_due: amount,
      currency: "USD",
      due_date: `${dueDate}T12:00:00.000Z`,
      ...(type === "subscription" ? { recurrence: "RRULE:FREQ=MONTHLY" } : {}),
      status: "upcoming",
      direction: "payable",
      external_key: `northstar:ap:${invoiceNumber}`,
      metadata: { seed_key: NORTHSTAR_SEED_KEY, scenario: "ap", invoice_number: invoiceNumber },
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "human_confirmed",
      confidence: 1,
    });
  }

  const receivableInvoices = new Map<string, string>();
  for (const [
    counterpartyKey,
    invoiceNumber,
    amount,
    issueDate,
    dueDate,
    status,
  ] of NORTHSTAR_RECEIVABLES) {
    const obligation = await upsertObligationRow(pool, audit, ctx, {
      type: "invoice",
      counterparty_id: counterparties.get(counterpartyKey)!,
      amount_due: amount,
      currency: "USD",
      due_date: `${dueDate}T12:00:00.000Z`,
      status: status === "overdue" ? "overdue" : "upcoming",
      direction: "receivable",
      external_key: `northstar:ar:${invoiceNumber}`,
      metadata: { seed_key: NORTHSTAR_SEED_KEY, scenario: "ar", invoice_number: invoiceNumber },
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "human_confirmed",
      confidence: 1,
    });
    const invoiceId = await insertInvoice(pool, tenantId, {
      invoiceNumber,
      counterpartyId: counterparties.get(counterpartyKey)!,
      amount,
      issueDate,
      dueDate,
      status,
      sourceIds,
      evidenceIds,
      obligationId: obligation.row.id,
      metadata: { seed_key: NORTHSTAR_SEED_KEY, scenario: "ar", invoice_number: invoiceNumber },
    });
    receivableInvoices.set(invoiceNumber, invoiceId);
  }

  const policy = await seedPolicy(
    pool,
    tenantId,
    actor,
    buildNorthstarPolicy(
      ["cascade", "atlas", "meridian", "redwood", "fathom"].map((key) => counterparties.get(key)!),
    ),
  );
  await audit.emit({
    tenantId,
    layer: "policy",
    actor,
    action: "policy.activated",
    inputs: { policy_id: policy.id, version: policy.version, seed_key: NORTHSTAR_SEED_KEY },
    outputs: { state: "active" },
    idempotencyKey: `${NORTHSTAR_SEED_KEY}:policy.activated`,
  });
  const agentId = await seedCollectionsAgent(pool, tenantId);
  const proposalIds = await seedCollectionsProposals(
    pool,
    audit,
    tenantId,
    agentId,
    policy.version,
    counterparties,
    receivableInvoices,
  );

  return {
    tenantId,
    policyId: policy.id,
    agentId,
    proposalIds,
    counts: {
      accounts: 3,
      counterparties: NORTHSTAR_COUNTERPARTIES.length,
      transactions: NORTHSTAR_MONTHLY_CASH_FLOW.length * 4,
      payables: NORTHSTAR_PAYABLES.length,
      receivables: NORTHSTAR_RECEIVABLES.length,
    },
  };
}

async function assertTenantIsReady(pool: Pool, tenantId: string): Promise<void> {
  const { rows } = await pool.query<{ ledger_rows: number }>(
    `SELECT (SELECT COUNT(*)::int FROM ledger_accounts WHERE owner_id = $1) +
            (SELECT COUNT(*)::int FROM ledger_counterparties WHERE owner_id = $1) AS ledger_rows`,
    [tenantId],
  );
  if ((rows[0]?.ledger_rows ?? 0) > 0) {
    throw new Error(
      `Tenant ${tenantId} is not empty. Northstar seeding requires an isolated tenant.`,
    );
  }
}

async function insertInvoice(
  pool: Pool,
  tenantId: string,
  input: {
    invoiceNumber: string;
    counterpartyId: string;
    amount: string;
    issueDate: string;
    dueDate: string;
    status: string;
    sourceIds: string[];
    evidenceIds: string[];
    obligationId: string;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  return withTenantScope(pool, tenantId, async (c) => {
    const invoiceId = newInvoiceId();
    await c.query(
      `INSERT INTO ledger_invoices (id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid, currency, issue_date, due_date, status, source_ids, evidence_ids, linked_document_ids, provenance, confidence, canonical_obligation_id, metadata)
       VALUES ($1,$2,$3,$4,$5,0,'USD',$6,$7,$8,$9,$10,ARRAY[]::TEXT[],'human_confirmed',1,$11,$12::jsonb)`,
      [
        invoiceId,
        tenantId,
        input.invoiceNumber,
        input.counterpartyId,
        input.amount,
        `${input.issueDate}T12:00:00.000Z`,
        `${input.dueDate}T12:00:00.000Z`,
        input.status,
        input.sourceIds,
        input.evidenceIds,
        input.obligationId,
        JSON.stringify(input.metadata),
      ],
    );
    return invoiceId;
  });
}

export function buildNorthstarPolicy(approvedVendorIds: string[]): NorthstarPolicyDocument {
  return {
    version: 1,
    seed_key: NORTHSTAR_SEED_KEY,
    lists: { "vendors.policy_allowlisted": approvedVendorIds },
    rules: [
      {
        id: "northstar-ap-auto-approved",
        applies_to: ["outbound_payment"],
        when: {
          "counterparty.in": "vendors.policy_allowlisted",
          "amount.lte": { currency: "USD", value: "50000.00" },
          "agent.risk_level.lte": "low",
        },
        approval_required_above: { currency: "USD", value: "10000.00" },
        execute: "auto",
      },
      {
        id: "northstar-ap-review",
        applies_to: ["outbound_payment"],
        when: {},
        require: "admin_approval",
        execute: "confirm",
      },
      {
        id: "northstar-collections-review",
        applies_to: ["agent_action"],
        when: { "agent.confidence.gte": 0.6 },
        require: "single_signer",
        execute: "confirm",
      },
    ],
  };
}

async function seedPolicy(
  pool: Pool,
  tenantId: string,
  actor: string,
  policy: NorthstarPolicyDocument,
): Promise<{ id: string; version: number }> {
  validatePolicyDocument(policy);
  const activation = runActivationLintGate(policy, {
    lintEnforce: true,
    confidenceEnforce: true,
  });
  if (activation.blocking.length > 0) {
    throw new Error(`Northstar policy failed activation lint: ${activation.blocking[0]?.code}`);
  }
  return withTenantScope(pool, tenantId, async (c) => {
    const existing = await c.query<{ id: string; version: number }>(
      `SELECT id, version FROM policies WHERE content->>'seed_key' = $1 ORDER BY version DESC LIMIT 1`,
      [NORTHSTAR_SEED_KEY],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0];
    await c.query(
      `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
    );
    const next = await c.query<{ version: number }>(
      `SELECT COALESCE(MAX(version) + 1, 1)::int AS version FROM policies WHERE tenant_id = $1`,
      [tenantId],
    );
    const version = next.rows[0]!.version;
    const id = newPolicyId();
    await c.query(
      `INSERT INTO policies (id, tenant_id, version, content, content_hash, quorum_required, state, created_by, activated_at, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,1,'active',$6,$7,$7)`,
      [id, tenantId, version, JSON.stringify(policy), contentHash(policy), actor, NORTHSTAR_AS_OF],
    );
    return { id, version };
  });
}

async function seedCollectionsAgent(pool: Pool, tenantId: string): Promise<string> {
  return withTenantScope(pool, tenantId, async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM agents WHERE display_name = 'Northstar Collections Agent' LIMIT 1`,
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;
    const id = newAgentId();
    await c.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, state, registered_at, created_at, contribution_count, quarantine_threshold) VALUES ($1,$2,'internal','collections','Northstar Collections Agent',$3,'active',$4,$4,0,100)`,
      [id, tenantId, Buffer.alloc(32), NORTHSTAR_AS_OF],
    );
    return id;
  });
}

async function seedCollectionsProposals(
  pool: Pool,
  audit: PostgresAuditEmitter,
  tenantId: string,
  agentId: string,
  policyVersion: number,
  counterparties: Map<string, string>,
  invoices: Map<string, string>,
): Promise<string[]> {
  const source = [
    ["helio", "AR-HELIO-2026-07", "184000.00", 42],
    ["apex", "AR-APEX-2026-07", "96000.00", 12],
  ] as const;
  const proposalIds: string[] = [];
  for (const [key, invoiceNumber, amount, daysOverdue] of source) {
    const proposalId = newProposalId();
    const counterpartyId = counterparties.get(key)!;
    const invoiceId = invoices.get(invoiceNumber)!;
    const action = {
      kind: "agent_action",
      type: "collections",
      agent_role: "collections",
      agent_id: agentId,
      action_id: `northstar.collections.${invoiceNumber.toLowerCase()}`,
      mode: "propose",
      confidence: 0.82,
      counterparty_id: counterpartyId,
      amount: { currency: "USD", value: amount },
      invoice_id: invoiceId,
      summary: `Review collections outreach for ${invoiceNumber}`,
      narrative: `${invoiceNumber} is ${daysOverdue} days overdue for $${amount}. Review customer-safe collections outreach.`,
      affected_entities: [counterpartyId, invoiceId],
      evidence_refs: [
        { kind: "invoice", ref: invoiceId },
        { kind: "counterparty", ref: counterpartyId },
      ],
    };
    await withTenantScope(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO proposals (id, tenant_id, proposing_agent, action, policy_version, policy_decision, policy_trace, required_approvers, status, proposal_dedup_key, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,'confirm',$6::jsonb,ARRAY['signer']::text[],'pending',$7,$8)`,
        [
          proposalId,
          tenantId,
          agentId,
          JSON.stringify(action),
          policyVersion,
          JSON.stringify([{ rule_id: "northstar-collections-review", matched: true }]),
          `northstar:${invoiceNumber}:collections`,
          NORTHSTAR_AS_OF,
        ],
      );
    });
    await audit.emit({
      tenantId,
      layer: "agent",
      actor: agentId,
      action: "agent.action.proposed",
      policyCheckId: "northstar-collections-review",
      outcome: "confirm",
      inputs: { proposal_id: proposalId, invoice_id: invoiceId },
      outputs: { status: "pending", counterparty_id: counterpartyId, amount },
      idempotencyKey: `northstar:${invoiceNumber}:agent.action.proposed`,
    });
    proposalIds.push(proposalId);
  }
  return proposalIds;
}
