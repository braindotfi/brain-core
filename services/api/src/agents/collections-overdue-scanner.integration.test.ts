import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  AgentRouter,
  AgentRunService,
  ActionResolver,
  RulesIntentClassifier,
  ServiceEvidenceGatherer,
  type AgentRunStore,
} from "@brain/agent-router";
import { AgentService, insertAgentRun, insertRoutingDecision } from "@brain/execution";
import { LedgerService } from "@brain/ledger";
import {
  InMemoryAuditEmitter,
  brainId,
  newCounterpartyId,
  newInvoiceId,
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
import { buildEvidenceProviders } from "./evidence-providers.js";
import {
  runCollectionsOverdueScanCycle,
  type CollectionsOverdueReceivableRow,
} from "./collections-overdue-scanner.js";
import { listProposals } from "../../../execution/src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("collections overdue scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const counterpartyA = newCounterpartyId();
  const counterpartyB = newCounterpartyId();
  const invoiceA = newInvoiceId();
  const invoiceB = newInvoiceId();

  beforeAll(async () => {
    schema = `collections_scan_${createHash("sha1")
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
        appliedBy: "collections-overdue-scanner-integration",
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
            throw new Error("collections must not create payment intents");
          },
        } as never,
      },
      store: runStore(pool),
      getTenantCategory: () => "business",
      isShadowed: () => false,
    });

    await seedTenant(pool, tenantA, counterpartyA, invoiceA, "Acme");
    await seedTenant(pool, tenantB, counterpartyB, invoiceB, "Beta");
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

  it("creates one grounded collections proposal per tenant and respects cooldown", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const rows = [
      receivable(tenantA, invoiceA, counterpartyA, "Acme"),
      receivable(tenantB, invoiceB, counterpartyB, "Beta"),
    ];

    await runCollectionsOverdueScanCycle(
      { scanPool: scanPoolWith(rows), appPool: pool, runService },
      { now, cooldownMs: 86_400_000 },
    );
    await runCollectionsOverdueScanCycle(
      { scanPool: scanPoolWith(rows), appPool: pool, runService },
      { now: new Date("2026-07-19T01:00:00.000Z"), cooldownMs: 86_400_000 },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
    const proposalsA = await listProposals(pool, ctxA, { type: "collections" });
    const proposalsB = await listProposals(pool, ctxB, { type: "collections" });

    expect(proposalsA.proposals).toHaveLength(1);
    expect(proposalsB.proposals).toHaveLength(1);
    expect(proposalsA.proposals[0]).toMatchObject({
      type: "collections",
      status: "approved",
      risk_band: "elevated",
      confidence: expect.any(Number),
      mode: "propose",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "collections", kind: "internal", display_name: "Collections" },
    });
    expect(proposalsA.proposals[0]?.narrative).toContain("18 days overdue");
    expect(proposalsA.proposals[0]?.narrative).toContain("Acme");
    expect(proposalsA.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([
        { kind: "invoice", ref: invoiceA, resolvable: true },
        { kind: "counterparty", ref: counterpartyA, resolvable: true },
      ]),
    );
    expect(proposalsB.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([
        { kind: "invoice", ref: invoiceB, resolvable: true },
        { kind: "counterparty", ref: counterpartyB, resolvable: true },
      ]),
    );
  });

  it("rotates through an overdue backlog instead of starving rows inside cooldown", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    const invoices = Array.from({ length: 5 }, () => newInvoiceId());
    await seedCollectionsTenant(pool, tenant, counterparty, "Gamma");
    for (let i = 0; i < invoices.length; i += 1) {
      await seedInvoice(pool, tenant, counterparty, invoices[i]!, `INV-R-${i}`, i);
    }

    const now = new Date("2026-07-19T00:00:00.000Z");
    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now, batchSize: 2, perTenantBatchSize: 5, cooldownMs: 86_400_000 },
    );
    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T01:00:00.000Z"),
        batchSize: 2,
        perTenantBatchSize: 5,
        cooldownMs: 86_400_000,
      },
    );
    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T02:00:00.000Z"),
        batchSize: 2,
        perTenantBatchSize: 5,
        cooldownMs: 86_400_000,
      },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    expect((await listProposals(pool, ctx, { type: "collections" })).proposals).toHaveLength(5);

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T03:00:00.000Z"),
        batchSize: 2,
        perTenantBatchSize: 5,
        cooldownMs: 86_400_000,
      },
    );
    expect((await listProposals(pool, ctx, { type: "collections" })).proposals).toHaveLength(5);

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-20T02:01:00.000Z"),
        batchSize: 2,
        perTenantBatchSize: 5,
        cooldownMs: 86_400_000,
      },
    );
    expect((await listProposals(pool, ctx, { type: "collections" })).proposals).toHaveLength(5);
  });

  it("applies a per-tenant cap so one tenant cannot monopolize a cycle", async () => {
    const tenantC = newTenantId();
    const tenantD = newTenantId();
    const counterpartyC = newCounterpartyId();
    const counterpartyD = newCounterpartyId();
    const invoicesC = Array.from({ length: 3 }, () => newInvoiceId());
    const invoicesD = Array.from({ length: 3 }, () => newInvoiceId());
    await seedCollectionsTenant(pool, tenantC, counterpartyC, "Charlie");
    await seedCollectionsTenant(pool, tenantD, counterpartyD, "Delta");
    for (let i = 0; i < 3; i += 1) {
      await seedInvoice(pool, tenantC, counterpartyC, invoicesC[i]!, `INV-C-${i}`, i);
      await seedInvoice(pool, tenantD, counterpartyD, invoicesD[i]!, `INV-D-${i}`, i + 10);
    }

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 4,
        perTenantBatchSize: 2,
        cooldownMs: 86_400_000,
      },
    );

    const ctxC: ServiceCallContext = { tenantId: tenantC, actor: "test" };
    const ctxD: ServiceCallContext = { tenantId: tenantD, actor: "test" };
    expect((await listProposals(pool, ctxC, { type: "collections" })).proposals).toHaveLength(2);
    expect((await listProposals(pool, ctxD, { type: "collections" })).proposals).toHaveLength(2);
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
  counterpartyId: string,
  invoiceId: string,
  counterpartyName: string,
): Promise<void> {
  await seedCollectionsTenant(pool, tenantId, counterpartyId, counterpartyName);
  await seedInvoice(pool, tenantId, counterpartyId, invoiceId, "INV-100", 0);
}

async function seedCollectionsTenant(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  counterpartyName: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('collections', $1, 'internal', 'collections', 'Collections', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
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

async function seedInvoice(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  invoiceId: string,
  invoiceNumber: string,
  dayOffset: number,
): Promise<void> {
  const dueDate = new Date(Date.parse("2026-07-01T00:00:00.000Z") + dayOffset * 86_400_000);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_invoices (
         id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
         currency, issue_date, due_date, status, linked_document_ids,
         linked_transaction_ids, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $4, $3, 900, 0, 'USD',
         '2026-06-01T00:00:00.000Z', $5::timestamptz, 'sent',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [invoiceId, tenantId, counterpartyId, invoiceNumber, dueDate.toISOString()],
    );
  });
}

function receivable(
  tenantId: string,
  invoiceId: string,
  counterpartyId: string,
  counterpartyName: string,
): CollectionsOverdueReceivableRow {
  return {
    tenant_id: tenantId,
    id: invoiceId,
    invoice_number: "INV-100",
    counterparty_id: counterpartyId,
    counterparty_name: counterpartyName,
    amount: "900.00",
    currency: "USD",
    due_date: "2026-07-01T00:00:00.000Z",
    days_overdue: 18,
    aging_tier: "15_29",
  };
}

function scanPoolWith(rows: readonly CollectionsOverdueReceivableRow[]): Pool {
  return {
    query: async () => ({ rows: [...rows], rowCount: rows.length }),
  } as unknown as Pool;
}
