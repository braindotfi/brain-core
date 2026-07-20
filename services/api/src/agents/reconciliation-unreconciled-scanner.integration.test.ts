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
import {
  runReconciliationUnreconciledScanCycle,
  type ReconciliationUnreconciledRow,
} from "./reconciliation-unreconciled-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("reconciliation unreconciled scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `reconciliation_scan_${createHash("sha1")
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
        appliedBy: "reconciliation-unreconciled-scanner-integration",
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
            throw new Error("reconciliation must not create payment intents");
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

  it("creates one grounded propose_match proposal from an unreconciled transaction without manual trigger", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const counterparty = newCounterpartyId();
    const tx = newTransactionId();
    const invoice = newInvoiceId();
    await seedReconciliationTenant(pool, tenant, account, counterparty, "Acme");
    await seedTransaction(pool, tenant, account, counterparty, tx, "900.00", 0);
    await seedInvoice(pool, tenant, counterparty, invoice, "900.00", 0);

    await runReconciliationUnreconciledScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );
    await runReconciliationUnreconciledScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T01:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const proposals = await listProposals(pool, ctx, { type: "reconciliation" });

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "reconciliation",
      status: "approved",
      risk_band: "standard",
      confidence: expect.any(Number),
      mode: "propose",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "reconciliation", kind: "internal", display_name: "Reconciliation" },
      evidence: [{ kind: "transaction", ref: tx, resolvable: true }],
    });
    expect(proposals.proposals[0]?.narrative).toContain(`proposed invoice match ${invoice}`);
  });

  it("keeps tenants isolated and applies per-tenant fairness", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const accountA = newAccountId();
    const accountB = newAccountId();
    const counterpartyA = newCounterpartyId();
    const counterpartyB = newCounterpartyId();
    await seedReconciliationTenant(pool, tenantA, accountA, counterpartyA, "Alpha");
    await seedReconciliationTenant(pool, tenantB, accountB, counterpartyB, "Beta");
    for (let i = 0; i < 2; i += 1) {
      await seedTransaction(
        pool,
        tenantA,
        accountA,
        counterpartyA,
        newTransactionId(),
        "700.00",
        i,
      );
      await seedInvoice(pool, tenantA, counterpartyA, newInvoiceId(), "700.00", i);
      await seedTransaction(
        pool,
        tenantB,
        accountB,
        counterpartyB,
        newTransactionId(),
        "800.00",
        i,
      );
      await seedInvoice(pool, tenantB, counterpartyB, newInvoiceId(), "800.00", i);
    }

    await runReconciliationUnreconciledScanCycle(
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
    expect((await listProposals(pool, ctxA, { type: "reconciliation" })).proposals).toHaveLength(1);
    expect((await listProposals(pool, ctxB, { type: "reconciliation" })).proposals).toHaveLength(1);
  });

  it("records missing-required-evidence hold without creating a proposal", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const counterparty = newCounterpartyId();
    await seedReconciliationTenant(pool, tenant, account, counterparty, "Hold Co");

    await runReconciliationUnreconciledScanCycle(
      {
        scanPool: scanPoolWith([
          {
            tenant_id: tenant,
            transaction_id: "tx_missing",
            account_id: account,
            amount: "900.00",
            currency: "USD",
            direction: "inflow",
            transaction_date: "2026-07-18T00:00:00.000Z",
            counterparty_id: counterparty,
            counterparty_name: "Hold Co",
            description: "missing evidence row",
            candidates: [],
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
    expect((await listProposals(pool, ctx, { type: "reconciliation" })).proposals).toHaveLength(0);
    const run = await withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason
           FROM agent_runs
          WHERE agent_id = 'reconciliation'
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

async function seedReconciliationTenant(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  counterpartyName: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('reconciliation', $1, 'internal', 'reconciliation', 'Reconciliation', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
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
         id, owner_id, name, normalized_name, type, aliases, linked_accounts,
         source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, lower($3), 'customer',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId, counterpartyName],
    );
  });
}

async function seedTransaction(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  transactionId: string,
  amount: string,
  dayOffset: number,
): Promise<void> {
  const date = new Date(Date.parse("2026-07-18T00:00:00.000Z") + dayOffset * 86_400_000);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_transactions (
         id, owner_id, account_id, external_transaction_id, amount, currency,
         direction, transaction_date, posted_date, counterparty_id, category_id,
         status, description_raw, description_normalized, source_ids, evidence_ids,
         reconciliation_status, provenance, confidence
       )
       VALUES ($1, $2, $3, $1, $5, 'USD', 'inflow', $6::timestamptz, $6::timestamptz,
         $4, NULL, 'posted', 'customer payment', 'customer payment',
         ARRAY[]::text[], ARRAY[]::text[], 'unreconciled', 'human_confirmed', 1)`,
      [transactionId, tenantId, accountId, counterpartyId, amount, date.toISOString()],
    );
  });
}

async function seedInvoice(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  invoiceId: string,
  amount: string,
  dayOffset: number,
): Promise<void> {
  const dueDate = new Date(Date.parse("2026-07-18T00:00:00.000Z") + dayOffset * 86_400_000);
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

function scanPoolWith(rows: readonly ReconciliationUnreconciledRow[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}
