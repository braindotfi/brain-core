import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Client, Pool } from "pg";
import {
  AgentRouter,
  AgentRunService,
  ActionResolver,
  RulesIntentClassifier,
  ServiceEvidenceGatherer,
  type AgentRunStore,
} from "@brain/agent-router";
import { runProjectionCycle } from "@brain/canonical";
import {
  ActorResolver,
  AgentService,
  insertAgentRun,
  insertRoutingDecision,
  PostgresMemberLookup,
  ProposalDecisionService,
  registerProposalReadRoutes,
} from "@brain/execution";
import { ingestOne, runInterpretCycle } from "@brain/raw";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "@brain/internal-agents";
import {
  brainId,
  errorHandlerPlugin,
  MemoryBlobAdapter,
  newCounterpartyId,
  newInvoiceId,
  newRawParsedId,
  newTenantId,
  newUserId,
  PostgresAuditEmitter,
  withTenantScope,
  type IWikiMemoryService,
  type Principal,
} from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { buildEvidenceProviders } from "../agents/evidence-providers.js";
import { runCollectionsOverdueScanCycle } from "../agents/collections-overdue-scanner.js";
import { runDocumentExtractionCycle, type DocumentExtractPort } from "../raw-extract/worker.js";
import { LedgerService } from "../../../ledger/src/service/LedgerService.js";
import { registerLedgerRoutes } from "../../../ledger/src/routes/index.js";
import { registerCashFlowRoutes } from "../../../ledger/src/cash_flows/routes.js";
import { runNormalizeCycle } from "../../../ledger/src/workers/normalizeWorker.js";
import { runLedgerAparProjectionCycle } from "../../../ledger/src/projection/obligations.js";
import { runLedgerAccountTransactionProjectionCycle } from "../../../ledger/src/projection/accounts-transactions.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("E-2 end-to-end acceptance gate (requires DATABASE_URL)", () => {
  let pool: Pool;
  let appPool: Pool;
  let schema: string;
  let appRole: string;
  let app: FastifyInstance;
  let currentPrincipal: Principal;
  let runService: AgentRunService;
  let blob: MemoryBlobAdapter;
  let appAudit: PostgresAuditEmitter;
  let workerAudit: PostgresAuditEmitter;

  const tenantA = newTenantId();
  const tenantB = newTenantId();
  const memberA = newUserId();
  const memberB = newUserId();
  const collectionsCounterparty = newCounterpartyId();
  const collectionsInvoice = newInvoiceId();

  beforeAll(async () => {
    schema = `e2e_acceptance_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    appRole = `${schema}_app`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 8, application_name: schema });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}, public`);
    });

    const migrator = await pool.connect();
    try {
      await migrator.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(migrator as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "e2e-acceptance-gate",
      });
      await installAppRole(migrator, schema, appRole);
    } finally {
      migrator.release();
    }

    appPool = new Pool({ connectionString: DB_URL, max: 8, application_name: `${schema}_app` });
    appPool.on("connect", (client) => {
      void client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      void client.query(`SET ROLE ${quoteIdent(appRole)}`);
    });
    await primeAppPool(appPool, schema, appRole);

    workerAudit = new PostgresAuditEmitter(pool);
    appAudit = new PostgresAuditEmitter(appPool);
    const ledger = new LedgerService({ pool: appPool, audit: appAudit });
    const evidence = new ServiceEvidenceGatherer(
      buildEvidenceProviders({ ledger, wiki: emptyWikiService() }),
    );
    const classifier = new RulesIntentClassifier();
    const router = new AgentRouter({
      catalog: () => internalAgentCatalog,
      classifier,
      evidence,
      getScopedCapabilities: () => new Set(internalAgentCatalog.flatMap((def) => def.capabilities)),
      getTenantCategory: () => "business",
      signals: () => ({ reputation: 1, cost: 0 }),
      audit: appAudit,
    });
    const agents = new AgentService({
      pool: appPool,
      audit: appAudit,
      evaluatePolicy: async () => ({
        outcome: "confirm",
        matched_rule_id: "acceptance_confirm",
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
            throw new Error("collections acceptance flow must not create payment intents");
          },
        } as never,
      },
      store: runStore(appPool),
      getTenantCategory: () => "business",
      isShadowed: () => false,
    });

    await seedTenantShell(tenantA, memberA, true);
    await seedTenantShell(tenantB, memberB, false);
    await seedCollectionsLedgerState(tenantA, collectionsCounterparty, collectionsInvoice);

    currentPrincipal = principal(tenantA, memberA);
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request: FastifyRequest) => {
      request.principal = currentPrincipal;
    });
    await registerLedgerRoutes(app, ledger);
    await registerCashFlowRoutes(app, ledger);
    await registerProposalReadRoutes(app, {
      pool,
      decisions: new ProposalDecisionService({
        pool: appPool,
        audit: appAudit,
        actorResolver: new ActorResolver({ members: new PostgresMemberLookup(appPool) }),
        paymentIntents: {
          approve: async () => {
            throw new Error("money path is outside this acceptance flow");
          },
          reject: async () => {
            throw new Error("money path is outside this acceptance flow");
          },
        } as never,
      }),
    });
    blob = new MemoryBlobAdapter();
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (appPool !== undefined) await appPool.end();
    if (pool !== undefined) await pool.end();
    if (schema !== undefined) {
      if (DB_URL !== undefined) {
        const teardown = new Client({ connectionString: DB_URL });
        await teardown.connect();
        await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await teardown.query(`DROP ROLE IF EXISTS ${quoteIdent(appRole)}`);
        await teardown.end();
      }
    }
  }, 60_000);

  it("runs ingest to obligation, collections proposal, human decision, and tenant isolation", async () => {
    const actor = memberA;
    const ingested = await ingestOne(
      {
        pool: appPool,
        blob,
        audit: appAudit,
        extractionJobs: { documentExtractorConfigured: true },
      },
      {
        tenantId: tenantA,
        actor,
        sourceType: "pdf_upload",
        sourceRef: { filename: "bill.pdf" },
        body: Buffer.from("acceptance document bytes"),
        mimeType: "application/pdf",
      },
    );

    expect(ingested.extractionJob).toMatchObject({
      raw_id: ingested.rawId,
      status: "queued",
    });

    const extractorBoundary: DocumentExtractPort = {
      extract: async (ctx, input) => {
        // The Python document_extractor service is not booted inside this Node
        // integration harness. This is the explicit service boundary: seed the
        // real raw_parsed doc_obligation_v1 output, then drive the real
        // normalize, canonical, and Ledger projection workers below.
        const parsedId = newRawParsedId();
        await withTenantScope(pool, ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO raw_parsed (
               id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence
             )
             VALUES ($1, $2, $3, 'doc_obligation_v1', '1', $4::jsonb, 0.91)`,
            [
              parsedId,
              input.rawId,
              ctx.tenantId,
              JSON.stringify({
                counterparty_name: "Acceptance Vendor",
                direction: "payable",
                type: "bill",
                amount: "1250.00",
                currency: "USD",
                due_date: "2026-08-01T00:00:00.000Z",
                status: "due",
              }),
            ],
          ),
        );
        return { parsed_id: parsedId, confidence: 0.91 };
      },
    };

    await runDocumentExtractionCycle(
      { scanPool: pool, appPool, blob, audit: appAudit, client: extractorBoundary },
      { batchSize: 1 },
    );
    await runNormalizeCycle({ pool, audit: workerAudit }, { batchSize: 10 });
    await runProjectionCycle({ pool, audit: workerAudit }, { batchSize: 10 });
    await runLedgerAparProjectionCycle({ pool }, { batchSize: 10 });

    const obligationsA = await getObligationsAs(tenantA, memberA);
    expect(obligationsA).toHaveLength(1);
    expect(obligationsA[0]).toMatchObject({
      type: "bill",
      amount_due: "1250.00000000",
      currency: "USD",
      provenance: "agent_contributed",
      confidence: 0.5,
    });

    await runCollectionsOverdueScanCycle(
      { scanPool: pool, appPool, runService },
      {
        now: new Date("2026-07-19T00:00:00.000Z"),
        batchSize: 5,
        perTenantBatchSize: 5,
        cooldownMs: 86_400_000,
      },
    );

    const proposals = await getCollectionsProposalsAs(tenantA, memberA);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal).toMatchObject({
      type: "collections",
      status: "pending",
      payment_intent_id: null,
      action_type: null,
      risk_band: "elevated",
      mode: "propose",
      agent: { id: "collections", kind: "internal", display_name: "Collections" },
    });
    expect(proposal.confidence).toEqual(expect.any(Number));
    expect(proposal.narrative).toContain("18 days overdue");
    expect(proposal.evidence).toHaveLength(2);
    expect(proposal.evidence).toEqual(
      expect.arrayContaining([
        { kind: "invoice", ref: collectionsInvoice, resolvable: true },
        { kind: "counterparty", ref: collectionsCounterparty, resolvable: true },
      ]),
    );

    currentPrincipal = principal(tenantA, memberA);
    const decision = await app.inject({
      method: "POST",
      url: `/proposals/${proposal.id}/decide`,
      payload: { decision: "approve", actor: "ignored_payload_actor" },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      id: proposal.id,
      decision: "approve",
      status: "approved",
      payment_intent_id: null,
      audit_id: expect.stringMatching(/^evt_/),
    });

    expect(await proposalStatus(tenantA, proposal.id)).toBe("approved");
    expect(await proposalDecisionAuditCount(tenantA, proposal.id)).toBe(1);

    expect(await getObligationsAs(tenantB, memberB)).toHaveLength(0);
    expect(await getCollectionsProposalsAs(tenantB, memberB)).toHaveLength(0);
    expect(await proposalDecisionAuditCount(tenantB, proposal.id)).toBe(0);
  }, 60_000);

  it("projects uploaded bank statements and AR aging files into ledger reads", async () => {
    const actor = memberA;
    const bank = await ingestOne(
      { pool: appPool, blob, audit: appAudit },
      {
        tenantId: tenantA,
        actor,
        sourceType: "pdf_upload",
        sourceRef: { filename: "june-bank-statement.pdf", account_id: "uploaded_operating" },
        body: Buffer.from(syntheticJuneBankStatement()),
        mimeType: "application/pdf",
      },
    );
    const ar = await ingestOne(
      { pool: appPool, blob, audit: appAudit },
      {
        tenantId: tenantA,
        actor,
        sourceType: "csv_upload",
        sourceRef: { filename: "ar-aging.csv" },
        body: Buffer.from(
          [
            "Customer,Invoice Ref,Amount,Aging Bucket,Due Date",
            "Northwind Traders,INV-JUN-001,1200.50,31-60,2026-07-15",
            "Contoso Retail,INV-JUN-002,875.00,Current,2026-07-30",
          ].join("\n"),
        ),
        mimeType: "text/csv",
      },
    );

    expect(bank.sourceSchema).toBe("brain.upload.document.v1");
    expect(ar.sourceSchema).toBe("brain.upload.document.v1");

    await runInterpretCycle({ pool, blob, audit: workerAudit }, { batchSize: 10 });
    await runNormalizeCycle({ pool, audit: workerAudit }, { batchSize: 20 });
    await runProjectionCycle({ pool, audit: workerAudit }, { batchSize: 50 });
    await runLedgerAccountTransactionProjectionCycle({ pool }, { batchSize: 50 });
    await runLedgerAparProjectionCycle({ pool }, { batchSize: 50 });

    expect(await ledgerTransactionCountForRaw(tenantA, bank.rawId)).toBe(19);

    currentPrincipal = principal(tenantA, memberA);
    const cashFlows = await app.inject({
      method: "GET",
      url: "/ledger/cash_flows?days=90&currency=USD",
    });
    expect(cashFlows.statusCode).toBe(200);
    expect(cashFlows.json().currencies[0]).toMatchObject({
      currency: "USD",
      transaction_count: expect.any(Number),
    });
    expect(cashFlows.json().currencies[0].transaction_count).toBeGreaterThanOrEqual(19);

    const arObligations = await ledgerObligationsForRaw(tenantA, ar.rawId);
    expect(arObligations).toHaveLength(2);
    expect(arObligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invoice",
          direction: "receivable",
          amount_due: "1200.50000000",
        }),
        expect.objectContaining({
          type: "invoice",
          direction: "receivable",
          amount_due: "875.00000000",
        }),
      ]),
    );
  }, 60_000);

  async function getObligationsAs(tenantId: string, memberId: string): Promise<unknown[]> {
    currentPrincipal = principal(tenantId, memberId);
    const response = await app.inject({
      method: "GET",
      url: "/ledger/obligations?limit=10",
    });
    expect(response.statusCode).toBe(200);
    return response.json().obligations as unknown[];
  }

  async function getCollectionsProposalsAs(
    tenantId: string,
    memberId: string,
  ): Promise<
    Array<{
      id: string;
      type: string;
      status: string;
      risk_band: string | null;
      confidence: number | null;
      mode: string;
      narrative: string | null;
      evidence: unknown[];
      payment_intent_id: string | null;
      action_type: string | null;
      agent: { id: string; kind: string; display_name: string };
    }>
  > {
    currentPrincipal = principal(tenantId, memberId);
    const query = new URLSearchParams({ type: "collections", limit: "10" });
    const response = await app.inject({
      method: "GET",
      url: `/proposals?${query.toString()}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().proposals;
  }

  async function proposalStatus(tenantId: string, proposalId: string): Promise<string | null> {
    return withTenantScope(appPool, tenantId, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM proposals WHERE id = $1`,
        [proposalId],
      );
      return rows[0]?.status ?? null;
    });
  }

  async function proposalDecisionAuditCount(tenantId: string, proposalId: string): Promise<number> {
    return withTenantScope(appPool, tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM audit_events
          WHERE action = 'proposal.decided'
            AND inputs->>'proposal_id' = $1`,
        [proposalId],
      );
      return Number(rows[0]?.count ?? "0");
    });
  }

  async function ledgerTransactionCountForRaw(tenantId: string, rawId: string): Promise<number> {
    return withTenantScope(appPool, tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ledger_transactions
          WHERE owner_id = $1
            AND source_ids @> ARRAY[$2]::text[]`,
        [tenantId, rawId],
      );
      return Number(rows[0]?.count ?? "0");
    });
  }

  async function ledgerObligationsForRaw(tenantId: string, rawId: string): Promise<unknown[]> {
    return withTenantScope(appPool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT type, direction, amount_due, currency, provenance, confidence
           FROM ledger_obligations
          WHERE owner_id = $1
            AND source_ids @> ARRAY[$2]::text[]
          ORDER BY amount_due DESC`,
        [tenantId, rawId],
      );
      return rows;
    });
  }

  async function seedTenantShell(
    tenantId: string,
    memberId: string,
    seedCollectionsAgent: boolean,
  ): Promise<void> {
    await withTenantScope(pool, tenantId, async (client) => {
      await client.query(`INSERT INTO tenants (id, kind) VALUES ($1, 'demo')`, [tenantId]);
      await client.query(
        `INSERT INTO raw_tenant_settings (tenant_id, auto_extract_documents)
         VALUES ($1, TRUE)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO members (
           tenant_id, id, email, display_name, role, status, active, approval_domains,
           per_item_limit_cents, requires_second_approver_above_cents
         )
         VALUES ($1, $2, $3, 'Acceptance Admin', 'admin', 'active', true,
           ARRAY['ap','ar','treasury','payroll','reconciliation']::text[],
           9223372036854775807, NULL)`,
        [tenantId, memberId, `${memberId}@example.com`],
      );
      if (seedCollectionsAgent) {
        await client.query(
          `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
           VALUES ('collections', $1, 'internal', 'collections', 'Collections', 'active', now())`,
          [tenantId],
        );
      }
    });
  }

  async function seedCollectionsLedgerState(
    tenantId: string,
    counterpartyId: string,
    invoiceId: string,
  ): Promise<void> {
    await withTenantScope(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO ledger_counterparties (
           id, owner_id, name, normalized_name, type, aliases, linked_accounts,
           source_ids, evidence_ids, provenance, confidence
         )
         VALUES ($1, $2, 'Acceptance Customer', 'acceptance customer', 'customer',
           ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
           'human_confirmed', 1)`,
        [counterpartyId, tenantId],
      );
      await client.query(
        `INSERT INTO ledger_invoices (
           id, owner_id, invoice_number, counterparty_id, amount_due, amount_paid,
           currency, issue_date, due_date, status, linked_document_ids,
           linked_transaction_ids, source_ids, evidence_ids, provenance, confidence
         )
         VALUES ($1, $2, 'AR-ACCEPT-1', $3, 900, 0, 'USD',
           '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'sent',
           ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
           'human_confirmed', 1)`,
        [invoiceId, tenantId, counterpartyId],
      );
    });
  }
});

function principal(tenantId: string, memberId: string): Principal {
  return {
    id: memberId,
    type: "user",
    tenantId,
    scopes: ["ledger:read", "execution:read", "payment_intent:approve", "raw:write"],
    tokenId: "tok_01ACCEPTANCE000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function syntheticJuneBankStatement(): string {
  return [
    "June 2026 Statement",
    "06/01 ACH CREDIT Northwind Traders 2500.00 12500.00",
    "06/02 POS Office Depot 120.45 12379.55",
    "06/03 Payroll 1750.00 10629.55",
    "06/04 Interest Credit 4.12 10633.67",
    "06/05 Card Stripe Fees 42.00 10591.67",
    "06/06 Deposit Contoso Retail 875.00 11466.67",
    "06/07 ACH Debit Cloud Hosting 310.20 11156.47",
    "06/08 POS Fuel Station 64.11 11092.36",
    "06/09 ACH CREDIT Fabrikam 1900.00 12992.36",
    "06/10 Wire Rent 3200.00 9792.36",
    "06/11 POS Coffee 18.50 9773.86",
    "06/12 Deposit Tailspin Toys 640.00 10413.86",
    "06/13 ACH Debit Insurance 455.33 9958.53",
    "06/14 POS Hardware Store 214.60 9743.93",
    "06/15 ACH CREDIT Acme Co 1200.50 10944.43",
    "06/16 Payroll Tax 525.00 10419.43",
    "06/17 POS Shipping 89.40 10330.03",
    "06/18 Deposit Adventure Works 720.00 11050.03",
    "06/19 Bank Fee 15.00 11035.03",
  ].join("\n");
}

function emptyWikiService(): IWikiMemoryService {
  return {
    search: async () => [],
    listRecent: async () => [],
    getPage: async () => null,
    upsertPage: async () => {
      throw new Error("wiki writes are outside this acceptance gate");
    },
    annotate: async () => {
      throw new Error("wiki writes are outside this acceptance gate");
    },
  } as unknown as IWikiMemoryService;
}

async function installAppRole(
  client: { query: (text: string) => Promise<unknown> },
  schema: string,
  role: string,
): Promise<void> {
  const schemaSql = quoteIdent(schema);
  const roleSql = quoteIdent(role);
  await client.query(`CREATE ROLE ${roleSql} NOLOGIN NOBYPASSRLS`);
  await client.query(`GRANT USAGE ON SCHEMA ${schemaSql} TO ${roleSql}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaSql} TO ${roleSql}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaSql} TO ${roleSql}`);
}

async function primeAppPool(pool: Pool, schema: string, role: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    await client.query(`SET ROLE ${quoteIdent(role)}`);
  } finally {
    client.release();
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe identifier: ${value}`);
  }
  return `"${value}"`;
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
