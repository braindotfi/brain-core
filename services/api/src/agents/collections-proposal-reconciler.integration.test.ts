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
import { runCollectionsOverdueScanCycle } from "./collections-overdue-scanner.js";
import { runCollectionsProposalReconcileCycle } from "./collections-proposal-reconciler.js";
import { listProposals } from "../../../execution/src/proposals/read-model.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
// Every suite here connects as the table owner ("brain"), which Postgres
// never subjects to row security regardless of FORCE ROW LEVEL SECURITY (see
// services/raw/src/__integration__/rls.integration.test.ts). That is fine for
// the other scenarios below, but the tenant-isolation test's entire point is
// proving the reconciler's per-tenant queries do not leak, which an
// owner-connected pool cannot detect. That one test additionally requires
// DATABASE_URL_APP (brain_app: NOBYPASSRLS, applied by .github/workflows/pr.yml's
// "Apply DB role model" step) and skips cleanly when it is absent.
const APP_URL = process.env.DATABASE_URL_APP;
const itRlsProven = APP_URL !== undefined && APP_URL !== "" ? it : it.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

const evaluatePolicy = async () => ({
  outcome: "confirm" as const,
  matched_rule_id: "test_confirm",
  required_approvers: [],
  trace: [],
  policy_version: 1,
});

// All tests in this suite share one schema/pool (beforeAll runs once), so a
// pending proposal from an earlier test is still in the table when a later
// test's cycle runs. Every reconcile call below pins `now` to this same
// instant so an earlier test's already-current proposal cannot appear
// drifted against real wall-clock time and get touched by an unrelated test.
const FIXED_NOW = new Date("2026-07-19T00:00:00.000Z");

suite("collections proposal reconciler integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let appRolePool: Pool | undefined;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `collections_reconcile_${createHash("sha1")
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
        appliedBy: "collections-proposal-reconciler-integration",
      });
    } finally {
      migrator.release();
    }

    if (APP_URL !== undefined && APP_URL !== "") {
      // db-roles.sql's blanket grants target "public"; this run's schema is
      // dynamic, so brain_app has no privileges there yet (mirrors
      // rls.integration.test.ts's own beforeAll).
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO brain_app`);
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO brain_app`,
      );
      appRolePool = new Pool({
        connectionString: APP_URL,
        max: 5,
        application_name: `${schema}-app`,
      });
      appRolePool.on("connect", (client) => {
        void client.query(`SET search_path TO ${schema}, public`);
      });
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
      evaluatePolicy,
      resolveAgentAuthority: () => "propose",
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
            throw new Error("collections must not create payment intents");
          },
        } as never,
      },
      store: runStore(pool),
      getTenantCategory: () => "business",
      isShadowed: () => false,
    });
  }, 60_000);

  afterAll(async () => {
    if (appRolePool !== undefined) {
      await appRolePool.end();
    }
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

  it("supersedes a pending proposal once its invoice disappears, and a second cycle is a no-op", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    const invoice = newInvoiceId();
    await seedTenant(pool, tenant, counterparty, invoice, "Ghost Co");

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: new Date("2026-07-19T00:00:00.000Z"), cooldownMs: 86_400_000 },
    );
    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const before = await listProposals(pool, ctx, { type: "collections" });
    expect(before.proposals).toHaveLength(1);
    expect(before.proposals[0]?.status).toBe("pending");

    // The invoice never lands in ledger_invoices (or is removed): #534's
    // failure mode, the forward scanner can no longer ever revisit it.
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(`DELETE FROM ledger_invoices WHERE id = $1`, [invoice]);
    });

    const audit = new InMemoryAuditEmitter();
    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool: pool, appPool: pool, evaluatePolicy, audit },
      { now: FIXED_NOW },
    );

    const after = await listProposals(pool, ctx, { type: "collections" });
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]?.id).toBe(before.proposals[0]?.id);
    expect(after.proposals[0]?.status).toBe("superseded");
    const tenantEvents = audit.events.filter((event) => event.tenantId === tenant);
    expect(tenantEvents).toHaveLength(1);
    expect(tenantEvents[0]).toMatchObject({
      tenantId: tenant,
      action: "agent.action.superseded",
      outputs: { status: "superseded", reason: "source_invoice_missing" },
    });

    // Idempotent: a second cycle finds nothing pending for this tenant.
    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool: pool, appPool: pool, evaluatePolicy, audit },
      { now: FIXED_NOW },
    );
    expect(audit.events.filter((event) => event.tenantId === tenant)).toHaveLength(1);
  });

  it("refreshes a pending proposal when days_overdue has drifted, preserving evidence and rewriting policy fields", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    const invoice = newInvoiceId();
    await seedTenant(pool, tenant, counterparty, invoice, "Drift Co");

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: FIXED_NOW, cooldownMs: 86_400_000 },
    );
    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const before = await listProposals(pool, ctx, { type: "collections" });
    expect(before.proposals).toHaveLength(1);
    expect(before.proposals[0]?.details).toMatchObject({ days_overdue: 18 });
    const proposalId = before.proposals[0]?.id;

    // Push the invoice further overdue without ever re-running the scanner.
    // Simulates a run stuck on an early terminal return after the cooldown
    // was already claimed (#535).
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(
        `UPDATE ledger_invoices SET due_date = due_date - interval '31 days' WHERE id = $1`,
        [invoice],
      );
    });

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool: pool, appPool: pool, evaluatePolicy },
      { now: FIXED_NOW },
    );

    const after = await listProposals(pool, ctx, { type: "collections" });
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]?.id).toBe(proposalId);
    expect(after.proposals[0]?.status).toBe("pending");
    expect(after.proposals[0]?.details).toMatchObject({
      days_overdue: 49,
      aging_tier: "30_59",
      recommended_action: "escalate",
    });
    expect(after.proposals[0]?.evidence).toEqual(
      expect.arrayContaining([{ kind: "invoice", ref: invoice, resolvable: true }]),
    );
  });

  it("leaves an already-current pending proposal untouched", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    const invoice = newInvoiceId();
    await seedTenant(pool, tenant, counterparty, invoice, "Current Co");

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: FIXED_NOW, cooldownMs: 86_400_000 },
    );
    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const before = await listProposals(pool, ctx, { type: "collections" });
    expect(before.proposals[0]?.details).toMatchObject({ days_overdue: 18 });

    const audit = new InMemoryAuditEmitter();
    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool: pool, appPool: pool, evaluatePolicy, audit },
      { now: FIXED_NOW },
    );

    const after = await listProposals(pool, ctx, { type: "collections" });
    expect(after.proposals[0]?.details).toEqual(before.proposals[0]?.details);
    expect(after.proposals[0]?.status).toBe("pending");
    expect(audit.events.filter((event) => event.tenantId === tenant)).toHaveLength(0);
  });

  it("never touches a non-pending collections proposal", async () => {
    const tenant = newTenantId();
    const counterparty = newCounterpartyId();
    const invoice = newInvoiceId();
    await seedTenant(pool, tenant, counterparty, invoice, "Resolved Co");

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: FIXED_NOW, cooldownMs: 86_400_000 },
    );
    const ctx: ServiceCallContext = { tenantId: tenant, actor: "test" };
    const before = await listProposals(pool, ctx, { type: "collections" });
    const proposalId = before.proposals[0]?.id;
    expect(proposalId).toBeDefined();

    // Resolve it and remove the invoice. If the reconciler mistakenly
    // touched non-pending rows this would flip to superseded.
    await withTenantScope(pool, tenant, async (client) => {
      await client.query(`UPDATE proposals SET status = 'approved' WHERE id = $1`, [proposalId]);
      await client.query(`DELETE FROM ledger_invoices WHERE id = $1`, [invoice]);
    });

    const audit = new InMemoryAuditEmitter();
    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool: pool, appPool: pool, evaluatePolicy, audit },
      { now: FIXED_NOW },
    );

    const after = await listProposals(pool, ctx, { type: "collections" });
    expect(after.proposals[0]?.id).toBe(proposalId);
    expect(after.proposals[0]?.status).toBe("approved");
    expect(audit.events.filter((event) => event.tenantId === tenant)).toHaveLength(0);
  });

  // Requires DATABASE_URL_APP (brain_app). An owner-connected pool bypasses
  // RLS regardless of FORCE ROW LEVEL SECURITY, so it cannot actually prove
  // isolation. See the module-level comment on APP_URL.
  itRlsProven(
    "keeps tenants isolated: brain_app scoped to tenant A never reads or writes tenant B's row",
    async () => {
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      const counterpartyA = newCounterpartyId();
      const counterpartyB = newCounterpartyId();
      const invoiceA = newInvoiceId();
      const invoiceB = newInvoiceId();
      await seedTenant(pool, tenantA, counterpartyA, invoiceA, "Isolated A");
      await seedTenant(pool, tenantB, counterpartyB, invoiceB, "Isolated B");

      await runCollectionsOverdueScanCycle(
        { scanPool: pool, appPool: pool, runService },
        { now: FIXED_NOW, cooldownMs: 86_400_000 },
      );

      const ctxA: ServiceCallContext = { tenantId: tenantA, actor: "test" };
      const ctxB: ServiceCallContext = { tenantId: tenantB, actor: "test" };
      const beforeB = await listProposals(pool, ctxB, { type: "collections" });

      // Only tenant A's invoice disappears.
      await withTenantScope(pool, tenantA, async (client) => {
        await client.query(`DELETE FROM ledger_invoices WHERE id = $1`, [invoiceA]);
      });

      const audit = new InMemoryAuditEmitter();
      // tenantDiscoveryPool stays the owner pool: production's equivalent
      // (brain_tenant_deletion) is deliberately BYPASSRLS for cross-tenant
      // enumeration. appPool is the real brain_app (NOBYPASSRLS) connection,
      // so this is the one call in the file that actually exercises RLS.
      await runCollectionsProposalReconcileCycle(
        { tenantDiscoveryPool: pool, appPool: appRolePool!, evaluatePolicy, audit },
        { now: FIXED_NOW },
      );

      const afterA = await listProposals(pool, ctxA, { type: "collections" });
      const afterB = await listProposals(pool, ctxB, { type: "collections" });
      expect(afterA.proposals[0]?.status).toBe("superseded");
      expect(afterB.proposals[0]?.status).toBe("pending");
      expect(afterB.proposals[0]?.details).toEqual(beforeB.proposals[0]?.details);
      const tenantAEvents = audit.events.filter((event) => event.tenantId === tenantA);
      const tenantBEvents = audit.events.filter((event) => event.tenantId === tenantB);
      expect(tenantAEvents).toHaveLength(1);
      expect(tenantBEvents).toHaveLength(0);
    },
  );
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
