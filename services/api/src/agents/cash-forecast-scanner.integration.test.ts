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
  newObligationId,
  newTenantId,
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
import { runCashForecastScanCycle, type CashForecastPositionRow } from "./cash-forecast-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("cash forecast scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `cash_forecast_scan_${createHash("sha1")
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
        appliedBy: "cash-forecast-scanner-integration",
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
      resolveAgentAuthority: () => "propose",
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
            throw new Error("cash forecast must not create payment intents");
          },
        } as never,
      },
      store: runStore(pool),
      getTenantCategory: () => "business",
      isShadowed: () => false,
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

  it("creates one grounded forecast proposal from balances and scheduled flows", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const customer = newCounterpartyId();
    const vendor = newCounterpartyId();
    await seedCashTenant(pool, tenant, account, customer, vendor, "USD", "1000.00");
    await seedInvoice(pool, tenant, customer, newInvoiceId(), "500.00", 10);
    await seedObligation(pool, tenant, vendor, newObligationId(), "300.00", 20);

    await runCashForecastScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );
    await runCashForecastScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T01:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const proposals = await listProposals(pool, ctx, { type: "cash_forecast" });

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "cash_forecast",
      status: "approved",
      risk_band: "standard",
      confidence: expect.any(Number),
      mode: "propose",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "cash_forecast", kind: "internal", display_name: "Cash Forecasting" },
      evidence: expect.arrayContaining([
        { kind: "balance", ref: expect.stringMatching(/^bal_/), resolvable: false },
      ]),
    });
    expect(proposals.proposals[0]?.narrative).toContain("Recommend hold");
  });

  it("keeps tenants isolated and applies per-tenant fairness", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await seedCashTenant(
      pool,
      tenantA,
      newAccountId(),
      newCounterpartyId(),
      newCounterpartyId(),
      "USD",
      "1000.00",
    );
    await seedCashTenant(
      pool,
      tenantA,
      newAccountId(),
      newCounterpartyId(),
      newCounterpartyId(),
      "EUR",
      "900.00",
    );
    await seedCashTenant(
      pool,
      tenantB,
      newAccountId(),
      newCounterpartyId(),
      newCounterpartyId(),
      "USD",
      "800.00",
    );
    await seedCashTenant(
      pool,
      tenantB,
      newAccountId(),
      newCounterpartyId(),
      newCounterpartyId(),
      "EUR",
      "700.00",
    );

    await runCashForecastScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 1,
        cooldownMs: 86_400_000,
      },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
    expect((await listProposals(pool, ctxA, { type: "cash_forecast" })).proposals).toHaveLength(1);
    expect((await listProposals(pool, ctxB, { type: "cash_forecast" })).proposals).toHaveLength(1);
  });

  it("records missing-required-evidence hold without creating a proposal", async () => {
    const tenant = newTenantId();
    await seedTenantAndAgentOnly(pool, tenant);

    await runCashForecastScanCycle(
      {
        scanPool: scanPoolWith([
          {
            tenant_id: tenant,
            currency: "USD",
            balance_id: "bal_missing",
            current_balance: "1000.00",
            as_of: "2026-07-18T00:00:00.000Z",
            receivables: [],
            payables: [],
            total_flow_amount: "0.00",
            max_payable_amount: "0.00",
          },
        ]),
        appPool: pool,
        runService,
      },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    expect((await listProposals(pool, ctx, { type: "cash_forecast" })).proposals).toHaveLength(0);
    const run = await withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason
           FROM agent_runs
          WHERE agent_id = 'cash_forecast'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      return rows[0];
    });
    expect(run).toMatchObject({
      status: "missing_evidence",
      failure_reason: "critical_missing_evidence",
    });
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

async function seedCashTenant(
  pool: Pool,
  tenantId: string,
  accountId: string,
  customerId: string,
  vendorId: string,
  currency: string,
  balance: string,
): Promise<void> {
  await seedTenantAndAgentOnly(pool, tenantId);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, institution, external_account_id, account_type, name, currency,
         current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Test Bank', $1, 'bank_checking', $3, $4,
         $5, $5, 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [accountId, tenantId, `${currency} Operating`, currency, balance],
    );
    await client.query(
      `INSERT INTO ledger_balances (
         id, owner_id, account_id, as_of, current_balance, available_balance,
         pending_balance, currency, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, '2026-07-18T00:00:00.000Z', $4, $4, 0, $5,
         ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [brainId("bal"), tenantId, accountId, balance, currency],
    );
    await seedCounterparty(client, tenantId, customerId, "customer", `Customer ${customerId}`);
    await seedCounterparty(client, tenantId, vendorId, "vendor", `Vendor ${vendorId}`);
  });
}

async function seedTenantAndAgentOnly(pool: Pool, tenantId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('cash_forecast', $1, 'internal', 'cash_forecast', 'Cash Forecasting', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedCounterparty(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  tenantId: string,
  counterpartyId: string,
  type: "customer" | "vendor",
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_counterparties (
       id, owner_id, name, normalized_name, type, aliases, linked_accounts,
       source_ids, evidence_ids, provenance, confidence
     )
     VALUES ($1, $2, $3, lower($3), $4,
       ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
       'human_confirmed', 1)`,
    [counterpartyId, tenantId, name, type],
  );
}

async function seedInvoice(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  invoiceId: string,
  amount: string,
  dayOffset: number,
): Promise<void> {
  const dueDate = new Date(Date.parse("2026-07-19T00:00:00.000Z") + dayOffset * 86_400_000);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_invoices (
         id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
         currency, issue_date, due_date, status, linked_document_ids,
         linked_transaction_ids, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $1, $3, $4, 0, 'USD',
         '2026-07-01T00:00:00.000Z', $5::timestamptz, 'sent',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [invoiceId, tenantId, counterpartyId, amount, dueDate.toISOString()],
    );
  });
}

async function seedObligation(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  obligationId: string,
  amount: string,
  dayOffset: number,
): Promise<void> {
  const dueDate = new Date(Date.parse("2026-07-19T00:00:00.000Z") + dayOffset * 86_400_000);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_obligations (
         id, owner_id, type, counterparty_id, amount_due, minimum_due, currency,
         due_date, recurrence, status, linked_transaction_ids, source_ids,
         evidence_ids, provenance, confidence, direction
       )
       VALUES ($1, $2, 'bill', $3, $4, NULL, 'USD', $5::timestamptz, NULL,
         'due', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1, 'payable')`,
      [obligationId, tenantId, counterpartyId, amount, dueDate.toISOString()],
    );
  });
}

function scanPoolWith(rows: readonly CashForecastPositionRow[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}
