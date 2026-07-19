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
  newTenantId,
  newTransactionId,
  withTenantScope,
  type IWikiMemoryService,
} from "@brain/shared";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "@brain/internal-agents";
import { listProposals } from "../../../execution/src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { buildEvidenceProviders } from "./evidence-providers.js";
import { runFraudAnomalyScanCycle } from "./fraud-anomaly-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
const NOW = new Date("2026-07-19T00:00:00.000Z");

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("fraud anomaly scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `fraud_anomaly_scan_${createHash("sha1")
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
        appliedBy: "fraud-anomaly-scanner-integration",
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
      resolveAgentAuthority: () => "notify_only",
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
            throw new Error("fraud anomaly must not create payment intents");
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

  it("creates one grounded notify-only finding for an anomalous transaction", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const merchant = newCounterpartyId();
    const anomaly = newTransactionId();
    await seedFraudTenant(pool, tenant, account, merchant, "Merchant");
    await seedBaselineTransactions(pool, tenant, account, merchant, "100.00", 6);
    await seedTransaction(pool, tenant, account, merchant, anomaly, "1000.00", 0);

    await runFraudAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );
    await runFraudAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: new Date("2026-07-19T01:00:00.000Z"), batchSize: 10, cooldownMs: 86_400_000 },
    );

    const proposals = await listProposals(
      pool,
      { tenantId: tenant, actor: "test" },
      {
        type: "fraud_anomaly",
      },
    );

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "fraud_anomaly",
      status: "pending",
      risk_band: "high",
      mode: "notify_only",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "fraud_anomaly", kind: "internal", display_name: "Fraud and Anomaly" },
      evidence: expect.arrayContaining([{ kind: "transaction", ref: anomaly, resolvable: true }]),
    });
    expect(proposals.proposals[0]?.narrative).toContain("Recommend hold");
  });

  it("does not emit for normal and insufficient-history transactions", async () => {
    const normalTenant = newTenantId();
    const normalAccount = newAccountId();
    const normalMerchant = newCounterpartyId();
    await seedFraudTenant(pool, normalTenant, normalAccount, normalMerchant, "Normal Merchant");
    await seedBaselineTransactions(pool, normalTenant, normalAccount, normalMerchant, "100.00", 6);
    await seedTransaction(
      pool,
      normalTenant,
      normalAccount,
      normalMerchant,
      newTransactionId(),
      "105.00",
      0,
    );

    const newTenant = newTenantId();
    const newAccount = newAccountId();
    const newMerchant = newCounterpartyId();
    await seedTenantAndLedgerOnly(pool, newTenant, newAccount, newMerchant, "New Merchant");
    await seedTransaction(
      pool,
      newTenant,
      newAccount,
      newMerchant,
      newTransactionId(),
      "900.00",
      0,
    );

    await runFraudAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, normalTenant)).toBe(0);
    expect(await countProposals(pool, newTenant)).toBe(0);
  });

  it("keeps tenants isolated and applies per-tenant fairness", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const accountA = newAccountId();
    const accountB = newAccountId();
    const merchantA = newCounterpartyId();
    const merchantB = newCounterpartyId();
    await seedFraudTenant(pool, tenantA, accountA, merchantA, "Alpha Merchant");
    await seedTenantAndLedgerOnly(pool, tenantB, accountB, merchantB, "Beta Merchant");
    await seedBaselineTransactions(pool, tenantA, accountA, merchantA, "100.00", 6);
    await seedBaselineTransactions(pool, tenantB, accountB, merchantB, "100.00", 6);
    await seedTransaction(pool, tenantA, accountA, merchantA, newTransactionId(), "1000.00", 0);
    await seedTransaction(pool, tenantA, accountA, merchantA, newTransactionId(), "1100.00", 1);
    await seedTransaction(pool, tenantB, accountB, merchantB, newTransactionId(), "1000.00", 0);
    await seedTransaction(pool, tenantB, accountB, merchantB, newTransactionId(), "1100.00", 1);

    await runFraudAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 1, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenantA)).toBe(1);
    expect(await countProposals(pool, tenantB)).toBe(1);
    const visibleToA = await listProposals(pool, { tenantId: tenantA, actor: "test" }, {});
    expect(visibleToA.proposals).toHaveLength(1);
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

async function seedFraudTenant(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  counterpartyName: string,
): Promise<void> {
  await seedTenantAndLedgerOnly(pool, tenantId, accountId, counterpartyId, counterpartyName);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('fraud_anomaly', $1, 'internal', 'fraud_anomaly', 'Fraud and Anomaly', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedTenantAndLedgerOnly(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  counterpartyName: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`,
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
         id, owner_id, name, normalized_name, type, risk_level, verified_status,
         aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, lower($3), 'merchant', NULL, 'document_verified',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId, counterpartyName],
    );
  });
}

async function seedBaselineTransactions(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  amount: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await seedTransaction(
      pool,
      tenantId,
      accountId,
      counterpartyId,
      newTransactionId(),
      amount,
      -40 - i,
    );
  }
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
       VALUES ($1, $2, $3, $1, $5, 'USD', 'outflow', $6::timestamptz, $6::timestamptz,
         $4, NULL, 'posted', 'merchant charge', 'merchant charge',
         ARRAY[]::text[], ARRAY[]::text[], 'unreconciled', 'human_confirmed', 1)`,
      [transactionId, tenantId, accountId, counterpartyId, amount, date.toISOString()],
    );
  });
}

async function countProposals(pool: Pool, tenantId: string): Promise<number> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM proposals WHERE tenant_id = current_setting('app.tenant_id', true)`,
    );
    return Number(rows[0]?.count ?? 0);
  });
}
