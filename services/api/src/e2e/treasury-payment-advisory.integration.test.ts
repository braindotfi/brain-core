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
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "@brain/internal-agents";
import {
  InMemoryAuditEmitter,
  brainId,
  newAccountId,
  newCounterpartyId,
  newObligationId,
  newTenantId,
  withTenantScope,
  type IWikiMemoryService,
  type ServiceCallContext,
} from "@brain/shared";
import { LedgerService } from "../../../ledger/src/service/LedgerService.js";
import { listProposals } from "../../../execution/src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { buildEvidenceProviders } from "../agents/evidence-providers.js";
import { runPaymentAdvisoryScanCycle } from "../agents/payment-advisory-scanner.js";
import { runTreasuryScanCycle, type TreasuryBalanceRow } from "../agents/treasury-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("treasury and payment advisory scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `treasury_payment_scan_${createHash("sha1")
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
        appliedBy: "treasury-payment-advisory-integration",
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
      actionResolver: new ActionResolver({ classifier }),
      handlers: internalAgentHandlers,
      definitions: internalAgentDefinitions,
      evidence,
      propose: {
        agents,
        paymentIntents: {
          create: async () => {
            throw new Error("advisory scanner integration must not create payment intents");
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

  it("records grounded treasury proposals when balance evidence resolves", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const accountA = newAccountId();
    const accountB = newAccountId();
    await seedTenantAgents(pool, tenantA);
    await seedTenantAgents(pool, tenantB);
    const balanceA = await seedAccountBalance(pool, tenantA, accountA, "120000.00");
    const balanceB = await seedAccountBalance(pool, tenantB, accountB, "10000.00");

    await runTreasuryScanCycle(
      {
        scanPool: scanPoolWithTreasury([
          {
            tenant_id: tenantA,
            balance_id: balanceA,
            account_id: accountA,
            current_balance: "120000.00",
            currency: "USD",
            as_of: "2026-07-18T00:00:00.000Z",
            event_hint: "cash.balance_high",
          },
          {
            tenant_id: tenantB,
            balance_id: balanceB,
            account_id: accountB,
            current_balance: "10000.00",
            currency: "USD",
            as_of: "2026-07-18T00:00:00.000Z",
            event_hint: "cash.balance_low",
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
    await runTreasuryScanCycle(
      {
        scanPool: scanPoolWithTreasury([
          {
            tenant_id: tenantA,
            balance_id: balanceA,
            account_id: accountA,
            current_balance: "120000.00",
            currency: "USD",
            as_of: "2026-07-18T00:00:00.000Z",
            event_hint: "cash.balance_high",
          },
          {
            tenant_id: tenantB,
            balance_id: balanceB,
            account_id: accountB,
            current_balance: "10000.00",
            currency: "USD",
            as_of: "2026-07-18T00:00:00.000Z",
            event_hint: "cash.balance_low",
          },
        ]),
        appPool: pool,
        runService,
      },
      {
        now: new Date("2026-07-19T01:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
    await expect(latestRun(pool, tenantA, "treasury")).resolves.toMatchObject({
      status: "proposal_created",
      failure_reason: null,
    });
    const proposalsA = await listProposals(pool, ctxA, { type: "treasury" });
    const proposalsB = await listProposals(pool, ctxB, { type: "treasury" });

    expect(proposalsA.proposals).toHaveLength(1);
    expect(proposalsB.proposals).toHaveLength(1);
    expect(proposalsA.proposals[0]).toMatchObject({
      type: "treasury",
      evidence: expect.arrayContaining([{ kind: "balance", ref: balanceA, resolvable: false }]),
    });
    expect(proposalsB.proposals[0]).toMatchObject({
      type: "treasury",
      mode: "propose",
      evidence: expect.arrayContaining([{ kind: "balance", ref: balanceB, resolvable: false }]),
    });
  });

  it("creates one grounded payment advisory proposal from an upcoming payable", async () => {
    const tenant = newTenantId();
    const vendor = newCounterpartyId();
    const account = newAccountId();
    const obligation = newObligationId();
    await seedTenantAgents(pool, tenant);
    await seedAccountBalance(pool, tenant, account, "10000.00");
    await seedVendor(pool, tenant, vendor);
    await seedPaymentInstruction(pool, tenant, vendor, "cpi_eval_payment");
    await seedPayableObligation(pool, tenant, vendor, obligation, "500.00", 5);

    await runPaymentAdvisoryScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );
    await runPaymentAdvisoryScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T01:00:00.000Z"),
        batchSize: 10,
        perTenantBatchSize: 10,
        cooldownMs: 86_400_000,
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const proposals = await listProposals(pool, ctx, { type: "payment" });

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "payment",
      status: "approved",
      payment_intent_id: null,
      action_type: null,
    });
    expect(proposals.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "obligation", ref: obligation }),
        expect.objectContaining({ kind: "counterparty", ref: vendor }),
        expect.objectContaining({
          kind: "payment_destination",
          ref: expect.stringMatching(/^cpi_/),
        }),
      ]),
    );
    expect(proposals.proposals[0]?.narrative).toContain("pay_now");
  });

  it("records missing evidence holds without creating advisory proposals", async () => {
    const tenant = newTenantId();
    await seedTenantAgents(pool, tenant);

    await runTreasuryScanCycle(
      {
        scanPool: scanPoolWithTreasury([
          {
            tenant_id: tenant,
            balance_id: "bal_missing",
            account_id: "acct_missing",
            current_balance: "120000.00",
            currency: "USD",
            as_of: "2026-07-18T00:00:00.000Z",
            event_hint: "cash.balance_high",
          },
        ]),
        appPool: pool,
        runService,
      },
      { now: new Date("2026-07-19T00:00:00.000Z") },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    expect((await listProposals(pool, ctx, { type: "treasury" })).proposals).toHaveLength(0);
    const run = await latestRun(pool, tenant, "treasury");
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

async function seedTenantAgents(pool: Pool, tenantId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    for (const [agentId, displayName] of [
      ["treasury", "Treasury"],
      ["payment", "Payment"],
    ] as const) {
      await client.query(
        `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
         VALUES ($1, $2, 'internal', $1, $3, 'active', now())
         ON CONFLICT DO NOTHING`,
        [agentId, tenantId, displayName],
      );
    }
  });
}

async function seedAccountBalance(
  pool: Pool,
  tenantId: string,
  accountId: string,
  balance: string,
): Promise<string> {
  const balanceId = brainId("bal");
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, institution, external_account_id, account_type, name, currency,
         current_balance, available_balance, status, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Test Bank', $1, 'bank_checking', 'Operating', 'USD',
         $3, $3, 'active', ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [accountId, tenantId, balance],
    );
    await client.query(
      `INSERT INTO ledger_balances (
         id, owner_id, account_id, as_of, current_balance, available_balance,
         pending_balance, currency, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, '2026-07-18T00:00:00.000Z', $4, $4, 0, 'USD',
         ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [balanceId, tenantId, accountId, balance],
    );
  });
  return balanceId;
}

async function seedVendor(pool: Pool, tenantId: string, counterpartyId: string): Promise<void> {
  await withTenantScope(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, aliases, linked_accounts,
         source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, 'Vendor', 'vendor', 'vendor',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId],
    ),
  );
}

async function seedPaymentInstruction(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  instructionId: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO ledger_counterparty_payment_instructions (
         id, owner_id, counterparty_id, changed_at, prior_hash, current_hash, source_id, actor
       )
       VALUES ($1, $2, $3, '2026-07-18T00:00:00.000Z', NULL, 'hash_current', NULL, 'test')`,
      [instructionId, tenantId, counterpartyId],
    ),
  );
}

async function seedPayableObligation(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  obligationId: string,
  amount: string,
  dayOffset: number,
): Promise<void> {
  const dueDate = new Date(Date.parse("2026-07-19T00:00:00.000Z") + dayOffset * 86_400_000);
  await withTenantScope(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO ledger_obligations (
         id, owner_id, type, counterparty_id, amount_due, minimum_due, currency,
         due_date, recurrence, status, linked_transaction_ids, source_ids,
         evidence_ids, provenance, confidence, direction, metadata
       )
       VALUES ($1, $2, 'bill', $3, $4, NULL, 'USD', $5::timestamptz, NULL,
         'due', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1, 'payable', '{}'::jsonb)`,
      [obligationId, tenantId, counterpartyId, amount, dueDate.toISOString()],
    ),
  );
}

async function latestRun(
  pool: Pool,
  tenantId: string,
  agentId: string,
): Promise<{ readonly status: string; readonly failure_reason: string | null } | undefined> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ status: string; failure_reason: string | null }>(
      `SELECT status, failure_reason
         FROM agent_runs
        WHERE agent_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [agentId],
    );
    return rows[0];
  });
}

function scanPoolWithTreasury(rows: readonly TreasuryBalanceRow[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}
