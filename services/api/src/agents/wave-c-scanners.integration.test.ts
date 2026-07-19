import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  ActionResolver,
  AgentRouter,
  AgentRunService,
  RulesIntentClassifier,
  ServiceEvidenceGatherer,
  type AgentRunStore,
} from "@brain/agent-router";
import { AgentService, insertAgentRun, insertRoutingDecision } from "@brain/execution";
import { LedgerService } from "@brain/ledger";
import {
  InMemoryAuditEmitter,
  brainId,
  newAccountId,
  newCounterpartyId,
  newInvoiceId,
  newTenantId,
  newTransactionId,
  withTenantScope,
  type IWikiMemoryService,
  type ServiceCallContext,
} from "@brain/shared";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "@brain/internal-agents";
import { listProposals } from "../../../execution/src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { buildEvidenceProviders } from "./evidence-providers.js";
import { runDisputeScanCycle, type DisputeCandidateRow } from "./dispute-scanner.js";
import {
  runRevenueIntelScanCycle,
  type RevenueIntelCandidateRow,
} from "./revenue-intel-scanner.js";
import { runSubscriptionScanCycle, type SubscriptionCandidateRow } from "./subscription-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("Wave C scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const accountA = newAccountId();
  const accountB = newAccountId();
  const counterpartyA = newCounterpartyId();
  const counterpartyB = newCounterpartyId();
  const invoiceA = newInvoiceId();
  const invoiceB = newInvoiceId();
  const transactionA = newTransactionId();
  const transactionB = newTransactionId();

  beforeAll(async () => {
    schema = `wave_c_scan_${createHash("sha1")
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
        appliedBy: "wave-c-scanner-integration",
      });
    } finally {
      migrator.release();
    }

    const audit = new InMemoryAuditEmitter();
    const ledger = new LedgerService({ pool, audit });
    const classifier = new RulesIntentClassifier();
    const evidence = new ServiceEvidenceGatherer(
      buildEvidenceProviders({ ledger, wiki: emptyWikiService() }),
    );
    const router = new AgentRouter({
      catalog: () => internalAgentCatalog,
      classifier,
      evidence,
      getScopedCapabilities: () => new Set(internalAgentCatalog.flatMap((def) => def.capabilities)),
      getTenantCategory: () => "business",
      signals: () => ({ reputation: 1, cost: 0 }),
      audit,
    });
    const actionResolver = new ActionResolver({ classifier });
    const agents = new AgentService({
      pool,
      audit,
      evaluatePolicy: async () => ({
        outcome: "allow",
        matched_rule_id: "test_allow",
        required_approvers: [],
        trace: [],
        policy_version: 1,
      }),
      resolveAgentAuthority: (_ctx, agentId) =>
        agentId === "revenue_intel" ? "notify_only" : "propose",
    });
    runService = new AgentRunService({
      router,
      actionResolver,
      handlers: internalAgentHandlers,
      definitions: internalAgentDefinitions,
      evidence,
      propose: {
        agents,
        paymentIntents: {
          create: async () => {
            throw new Error("Wave C agents must not create payment intents");
          },
        } as never,
      },
      store: runStore(pool),
      getTenantCategory: () => "business",
      isShadowed: () => false,
    });

    await seedTenant(pool, tenantA, accountA, counterpartyA, invoiceA, transactionA, "Acme");
    await seedTenant(pool, tenantB, accountB, counterpartyB, invoiceB, transactionB, "Beta");
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

  it("creates grounded proposals for all three Wave C scanners and respects cooldown", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    await runDisputeScanCycle(
      {
        scanPool: scanPoolWith([dispute(tenantA, transactionA, counterpartyA)]),
        appPool: pool,
        runService,
      },
      { now, cooldownMs: 86_400_000 },
    );
    await runRevenueIntelScanCycle(
      {
        scanPool: scanPoolWith([revenue(tenantA, invoiceA, transactionA, counterpartyA)]),
        appPool: pool,
        runService,
      },
      { now, cooldownMs: 86_400_000 },
    );
    await runSubscriptionScanCycle(
      {
        scanPool: scanPoolWith([subscription(tenantA, transactionA, counterpartyA)]),
        appPool: pool,
        runService,
      },
      { now, cooldownMs: 86_400_000 },
    );

    await runDisputeScanCycle(
      {
        scanPool: scanPoolWith([dispute(tenantA, transactionA, counterpartyA)]),
        appPool: pool,
        runService,
      },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const disputeProposals = await listProposals(pool, ctxA, { type: "dispute" });
    const revenueProposals = await listProposals(pool, ctxA, { type: "revenue_intel" });
    const subscriptionProposals = await listProposals(pool, ctxA, { type: "subscription" });

    expect(disputeProposals.proposals).toHaveLength(1);
    expect(revenueProposals.proposals).toHaveLength(1);
    expect(subscriptionProposals.proposals).toHaveLength(1);
    expect(disputeProposals.proposals[0]).toMatchObject({
      type: "dispute",
      payment_intent_id: null,
      agent: { id: "dispute", kind: "internal", display_name: "Dispute" },
    });
    expect(disputeProposals.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([
        { kind: "dispute", ref: `dsp_${transactionA}`, resolvable: false },
        { kind: "transaction", ref: transactionA, resolvable: true },
      ]),
    );
    expect(revenueProposals.proposals[0]).toMatchObject({
      type: "revenue_intel",
      mode: "notify_only",
      agent: { id: "revenue_intel", kind: "internal", display_name: "Revenue Intelligence" },
    });
    expect(subscriptionProposals.proposals[0]).toMatchObject({
      type: "subscription",
      mode: "propose",
      agent: { id: "subscription", kind: "internal", display_name: "Subscription" },
    });
  });

  it("keeps tenant proposals isolated", async () => {
    await runDisputeScanCycle(
      {
        scanPool: scanPoolWith([dispute(tenantB, transactionB, counterpartyB)]),
        appPool: pool,
        runService,
      },
      { now: new Date("2026-07-20T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
    expect((await listProposals(pool, ctxA, { type: "dispute" })).proposals).toHaveLength(1);
    expect((await listProposals(pool, ctxB, { type: "dispute" })).proposals).toHaveLength(1);
  });

  it("holds missing required evidence with zero proposals", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const counterparty = newCounterpartyId();
    const invoice = newInvoiceId();
    const transaction = newTransactionId();
    await seedTenant(pool, tenant, account, counterparty, invoice, transaction, "Missing Evidence");

    await runService.run(
      {
        tenantId: tenant,
        actor: "test",
        principalType: "api_partner",
        scopes: ["execution:propose"],
      },
      {
        tenant_id: tenant,
        event: "dispute.created",
        context: { dispute_id: "dsp_missing" },
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    expect((await listProposals(pool, ctx, { type: "dispute" })).proposals).toHaveLength(0);
  });
});

function emptyWikiService(): IWikiMemoryService {
  return {
    search: async () => [],
    listRecent: async () => [],
    getPage: async () => null,
    upsertPage: async () => {
      throw new Error("wiki writes are not used");
    },
    annotate: async () => {
      throw new Error("wiki writes are not used");
    },
  } as unknown as IWikiMemoryService;
}

function runStore(pool: Pool): AgentRunStore {
  return {
    recordRoutingDecision: (ctx, input) =>
      withTenantScope(pool, ctx.tenantId, async (client) => {
        const row = await insertRoutingDecision(client, {
          id: brainId("agrd"),
          tenantId: ctx.tenantId,
          tenantCategory: input.tenantCategory,
          policyStatus: input.policyStatus,
          selectedAgentId: input.selectedAgentId,
          fallbackAgentIds: [...input.fallbackAgentIds],
          confidence: input.confidence,
          evidenceScore: input.evidenceScore,
          reason: input.reason,
          eventType: input.eventType ?? null,
          intent: input.intent ?? null,
        });
        return { id: row.id };
      }),
    recordRun: (ctx, input) =>
      withTenantScope(pool, ctx.tenantId, async (client) => {
        const row = await insertAgentRun(client, {
          id: brainId("agnr"),
          tenantId: ctx.tenantId,
          tenantCategory: input.tenantCategory,
          agentId: input.agentId,
          agentKind: input.agentKind,
          executionMode: input.executionMode,
          status: input.status,
          reason: input.reason,
          shadowMode: input.shadowMode,
          routingDecisionId: input.routingDecisionId,
          eventType: input.eventType ?? null,
          intent: input.intent ?? null,
          action: input.action ?? null,
          confidence: input.confidence ?? null,
          evidenceScore: input.evidenceScore ?? null,
          policyStatus: input.policyStatus ?? null,
          proposalId: input.proposalId ?? null,
          paymentIntentId: input.paymentIntentId ?? null,
          failureReason: input.failureReason ?? null,
        });
        return { id: row.id };
      }),
  };
}

async function seedTenant(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  invoiceId: string,
  transactionId: string,
  counterpartyName: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
    for (const [id, role, displayName] of [
      ["dispute", "dispute", "Dispute"],
      ["revenue_intel", "revenue_intel", "Revenue Intelligence"],
      ["subscription", "subscription", "Subscription"],
    ] as const) {
      await client.query(
        `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
         VALUES ($1, $2, 'internal', $3, $4, 'active', now())`,
        [id, tenantId, role, displayName],
      );
    }
    await client.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, institution, external_account_id, account_type, name, currency,
         current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Test Bank', $1, 'bank_checking', 'Operating', 'USD',
         10000, 10000, 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [accountId, tenantId],
    );
    await client.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, risk_level, verified_status,
         aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, lower($3), 'customer', NULL, 'document_verified',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId, counterpartyName],
    );
    await client.query(
      `INSERT INTO ledger_transactions (
         id, owner_id, account_id, external_transaction_id, amount, currency,
         direction, transaction_date, posted_date, counterparty_id, category_id,
         status, description_raw, description_normalized, source_ids, evidence_ids,
         reconciliation_status, provenance, confidence
       )
       VALUES ($1, $2, $3, $1, 130, 'USD', 'outflow',
         '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z',
         $4, NULL, 'posted', 'subscription charge', 'subscription charge',
         ARRAY[]::text[], ARRAY[]::text[], 'unreconciled', 'human_confirmed', 1)`,
      [transactionId, tenantId, accountId, counterpartyId],
    );
    await client.query(
      `INSERT INTO ledger_invoices (
         id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
         currency, issue_date, due_date, status, linked_document_ids,
         linked_transaction_ids, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $1, $3, 1200, 1200, 'USD',
         '2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 'paid',
         ARRAY[]::text[], ARRAY[$4]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [invoiceId, tenantId, counterpartyId, transactionId],
    );
  });
}

function dispute(
  tenantId: string,
  transactionId: string,
  counterpartyId: string,
): DisputeCandidateRow {
  return {
    tenant_id: tenantId,
    dispute_id: `dsp_${transactionId}`,
    transaction_id: transactionId,
    counterparty_id: counterpartyId,
    amount: "750.00",
    currency: "USD",
    deadline: "2026-07-25",
    dispute_age_days: "7",
    evidence_completeness: "0.9",
    event_hint: "chargeback.received",
  };
}

function revenue(
  tenantId: string,
  invoiceId: string,
  transactionId: string,
  counterpartyId: string,
): RevenueIntelCandidateRow {
  return {
    tenant_id: tenantId,
    counterparty_id: counterpartyId,
    invoice_id: invoiceId,
    transaction_id: transactionId,
    currency: "USD",
    current_period_revenue: "1200.00",
    prior_period_revenue: "1000.00",
    current_dso: "35",
    prior_dso: "20",
    event_hint: "customer.payment_behavior_changed",
    detected_at: "2026-07-18T00:00:00.000Z",
  };
}

function subscription(
  tenantId: string,
  transactionId: string,
  counterpartyId: string,
): SubscriptionCandidateRow {
  return {
    tenant_id: tenantId,
    transaction_id: transactionId,
    counterparty_id: counterpartyId,
    amount: "130.00",
    currency: "USD",
    transaction_date: "2026-07-18",
    history: [
      { transaction_id: `${transactionId}_a`, amount: "100.00", transaction_date: "2026-05-18" },
      { transaction_id: `${transactionId}_b`, amount: "100.00", transaction_date: "2026-06-18" },
      { transaction_id: transactionId, amount: "130.00", transaction_date: "2026-07-18" },
    ],
    event_hint: "subscription.price_changed",
  };
}

function scanPoolWith<T extends object>(rows: readonly T[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}
