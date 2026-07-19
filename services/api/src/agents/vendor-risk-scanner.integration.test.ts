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
import { runVendorRiskScanCycle, type VendorRiskRow } from "./vendor-risk-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
const NOW = new Date("2026-07-19T00:00:00.000Z");

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("vendor risk scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `vendor_risk_scan_${createHash("sha1")
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
        appliedBy: "vendor-risk-scanner-integration",
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
            throw new Error("vendor risk must not create payment intents");
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

  it("creates one grounded high-risk proposal for a new vendor with a bank-detail change", async () => {
    const tenant = newTenantId();
    const vendor = newCounterpartyId();
    await seedVendorTenant(pool, tenant, vendor, {
      name: "Acme",
      verifiedStatus: "unverified",
      createdAt: "2026-07-18T00:00:00.000Z",
      priorHash: "old_hash",
      currentHash: "new_hash",
      changedAt: "2099-01-01T00:00:00.000Z",
    });

    await runVendorRiskScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );
    await runVendorRiskScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: new Date("2026-07-19T01:00:00.000Z"), batchSize: 10, cooldownMs: 86_400_000 },
    );

    const proposals = await listProposals(
      pool,
      { tenantId: tenant, actor: "test" },
      {
        type: "vendor_risk",
      },
    );

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "vendor_risk",
      status: "approved",
      risk_band: "high",
      mode: "propose",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "vendor_risk", kind: "internal", display_name: "Vendor Risk" },
      evidence: expect.arrayContaining([
        { kind: "counterparty", ref: vendor, resolvable: true },
        { kind: "unknown", ref: paymentInstructionId(vendor), resolvable: false },
      ]),
    });
    expect(proposals.proposals[0]?.narrative).toContain("Recommend hold");
  });

  it("keeps tenants isolated and applies per-tenant fairness", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    await seedVendorTenant(pool, tenantA, newCounterpartyId(), { name: "Alpha 1" });
    await seedVendorTenant(pool, tenantA, newCounterpartyId(), { name: "Alpha 2" });
    await seedVendorTenant(pool, tenantB, newCounterpartyId(), { name: "Beta 1" });
    await seedVendorTenant(pool, tenantB, newCounterpartyId(), { name: "Beta 2" });

    await runVendorRiskScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 1, cooldownMs: 86_400_000 },
    );

    const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
    const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
    expect((await listProposals(pool, ctxA, { type: "vendor_risk" })).proposals).toHaveLength(1);
    expect((await listProposals(pool, ctxB, { type: "vendor_risk" })).proposals).toHaveLength(1);
  });

  it("records an unresolved-identity hold without creating a proposal", async () => {
    const tenant = newTenantId();
    await seedTenantAndAgentOnly(pool, tenant);

    await runVendorRiskScanCycle(
      {
        scanPool: scanPoolWith([
          {
            tenant_id: tenant,
            counterparty_id: "cp_missing",
            vendor_name: "Missing Vendor",
            verified_status: "unverified",
            risk_level: null,
            created_at: "2026-07-18T00:00:00.000Z",
            payment_destination_id: "cpi_missing",
            payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
            prior_destination_hash: "old_hash",
            current_destination_hash: "new_hash",
            destination_name: "Missing Vendor",
            history_risk_score: "0.85",
            event_hint: "vendor.bank_details_changed",
          },
        ]),
        appPool: pool,
        runService,
      },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    expect((await listProposals(pool, ctx, { type: "vendor_risk" })).proposals).toHaveLength(0);
    const run = await withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason
           FROM agent_runs
          WHERE agent_id = 'vendor_risk'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      return rows[0];
    });
    expect(run).toMatchObject({
      status: "notify_only",
      failure_reason: "execution_mode_notify_only",
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

async function seedTenantAndAgentOnly(pool: Pool, tenantId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('vendor_risk', $1, 'internal', 'vendor_risk', 'Vendor Risk', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedVendorTenant(
  pool: Pool,
  tenantId: string,
  counterpartyId: string,
  options: {
    name?: string;
    verifiedStatus?: string;
    createdAt?: string;
    priorHash?: string;
    currentHash?: string;
    changedAt?: string;
  } = {},
): Promise<void> {
  await seedTenantAndAgentOnly(pool, tenantId);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, risk_level, verified_status,
         aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence, created_at, updated_at
       )
       VALUES ($1, $2, $3, lower($3), 'vendor', NULL, $4,
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1, $5::timestamptz, $5::timestamptz)`,
      [
        counterpartyId,
        tenantId,
        options.name ?? "Vendor",
        options.verifiedStatus ?? "unverified",
        options.createdAt ?? "2026-07-18T00:00:00.000Z",
      ],
    );
    await client.query(
      `INSERT INTO ledger_counterparty_payment_instructions (
         id, owner_id, counterparty_id, changed_at, prior_hash, current_hash, source_id, actor
       )
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, NULL, $7)`,
      [
        paymentInstructionId(counterpartyId),
        tenantId,
        counterpartyId,
        options.changedAt ?? "2099-01-01T00:00:00.000Z",
        options.priorHash ?? "old_hash",
        options.currentHash ?? "new_hash",
        options.name ?? "Vendor",
      ],
    );
  });
}

function scanPoolWith(rows: readonly VendorRiskRow[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}

function paymentInstructionId(counterpartyId: string): string {
  return `cpi_${counterpartyId.replace(/[^a-zA-Z0-9_]/g, "")}`;
}
