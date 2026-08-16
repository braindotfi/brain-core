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
  newCounterpartyId,
  newObligationId,
  newTenantId,
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
import { runObligationAnomalyScanCycle } from "./obligation-anomaly-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
const NOW = new Date("2026-08-16T00:00:00.000Z");

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("obligation anomaly scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `obligation_anomaly_scan_${createHash("sha1")
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
        appliedBy: "obligation-anomaly-scanner-integration",
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
      audit,
      actionResolver,
      handlers: internalAgentHandlers,
      definitions: internalAgentDefinitions,
      evidence,
      propose: {
        agents,
        paymentIntents: {
          create: async () => {
            throw new Error("invoice_integrity must not create payment intents");
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

  it("flags two obligations with the same counterparty, amount, currency, and due date as duplicates", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    await seedInvoiceIntegrityTenant(pool, tenant);
    await seedCounterparty(pool, tenant, counterparty, "Vantage Point Consulting", "document_verified");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "48750.00", "2026-08-15");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "48750.00", "2026-08-15");

    await runObligationAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    // Each side of the mutual duplicate pair is independently eligible and gets its
    // own notify-only finding, cross-referencing the other obligation.
    const proposals = await listProposals(
      pool,
      { tenantId: tenant, actor: "test" },
      { type: "invoice_integrity" },
    );
    expect(proposals.proposals).toHaveLength(2);
    for (const proposal of proposals.proposals) {
      expect(proposal).toMatchObject({
        type: "invoice_integrity",
        status: "pending",
        mode: "notify_only",
      });
    }
  });

  it("flags split obligations to the same counterparty and due date as structuring", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    await seedInvoiceIntegrityTenant(pool, tenant);
    await seedCounterparty(pool, tenant, counterparty, "Northgate Supplies Co", "document_verified");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "4875.00", "2026-08-17");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "4900.00", "2026-08-17");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "4950.00", "2026-08-17");

    await runObligationAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenant)).toBeGreaterThanOrEqual(1);
  });

  it("flags an amount just below a round approval threshold", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    await seedInvoiceIntegrityTenant(pool, tenant);
    await seedCounterparty(pool, tenant, counterparty, "Coastal Logistics Partners", "document_verified");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "89999.00", "2026-08-13");

    await runObligationAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    const proposals = await listProposals(
      pool,
      { tenantId: tenant, actor: "test" },
      { type: "invoice_integrity" },
    );
    expect(proposals.proposals).toHaveLength(1);
  });

  it("flags a high-value obligation to an unverified counterparty", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    await seedInvoiceIntegrityTenant(pool, tenant);
    await seedCounterparty(pool, tenant, counterparty, "Meridian Offshore Holdings Ltd", "unverified");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "275000.00", "2026-08-09");

    await runObligationAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenant)).toBeGreaterThanOrEqual(1);
  });

  it("does not flag an ordinary obligation to a verified, established counterparty", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    await seedInvoiceIntegrityTenant(pool, tenant);
    await seedCounterparty(pool, tenant, counterparty, "Ashgrove Manufacturing", "document_verified");
    await seedObligation(pool, tenant, newObligationId(), counterparty, "9200.00", "2026-08-22");

    await runObligationAnomalyScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenant)).toBe(0);
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

async function seedInvoiceIntegrityTenant(pool: Pool, tenantId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`, [
      tenantId,
    ]);
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('invoice_integrity', $1, 'internal', 'invoice_integrity', 'Invoice Integrity', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedCounterparty(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  name: string,
  verifiedStatus: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, risk_level, verified_status,
         aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence
       )
       VALUES ($1, $2, $3, lower($3), 'vendor', NULL, $4,
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId, name, verifiedStatus],
    );
  });
}

async function seedObligation(
  pool: Pool,
  tenantId: string,
  obligationId: string,
  counterpartyId: string,
  amountDue: string,
  dueDate: string,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_obligations (
         id, owner_id, type, counterparty_id, amount_due, currency, due_date, status,
         direction, external_key, linked_transaction_ids, source_ids, evidence_ids,
         provenance, confidence
       )
       VALUES ($1, $2, 'invoice', $3, $4, 'USD', $5::timestamptz, 'due',
         'payable', $1, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'human_confirmed', 1)`,
      [obligationId, tenantId, counterpartyId, amountDue, dueDate],
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
