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
  newApprovalId,
  newAuditEventId,
  newCounterpartyId,
  newPaymentIntentId,
  newPolicyDecisionId,
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
import { runComplianceScanCycle, type ComplianceFindingRow } from "./compliance-scanner.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
const NOW = new Date("2026-07-19T00:00:00.000Z");

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("compliance scanner integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let runService: AgentRunService;

  beforeAll(async () => {
    schema = `compliance_scan_${createHash("sha1")
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
        appliedBy: "compliance-scanner-integration",
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
            throw new Error("compliance must not create payment intents");
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

  it("creates one grounded notify-only finding for a movement missing required approval", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const counterparty = newCounterpartyId();
    await seedComplianceTenant(pool, tenant, account, counterparty);
    const seeded = await seedPaymentIntentCase(pool, tenant, account, counterparty, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 0,
      staleApprovals: 0,
    });

    await runComplianceScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );
    await runComplianceScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: new Date("2026-07-19T01:00:00.000Z"), batchSize: 10, cooldownMs: 86_400_000 },
    );

    const proposals = await listProposals(
      pool,
      { tenantId: tenant, actor: "test" },
      { type: "compliance" },
    );

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      type: "compliance",
      status: "pending",
      risk_band: "elevated",
      mode: "notify_only",
      payment_intent_id: null,
      action_type: null,
      agent: { id: "compliance", kind: "internal", display_name: "Compliance" },
      evidence: expect.arrayContaining([
        { kind: "policy_decision", ref: seeded.policyDecisionId, resolvable: false },
        { kind: "audit_event", ref: seeded.auditEventId, resolvable: false },
      ]),
    });
    expect(proposals.proposals[0]?.narrative).toContain("approval_missing");
  });

  it("does not emit for a compliant movement with a valid approval", async () => {
    const tenant = newTenantId();
    const account = newAccountId();
    const counterparty = newCounterpartyId();
    await seedComplianceTenant(pool, tenant, account, counterparty);
    await seedPaymentIntentCase(pool, tenant, account, counterparty, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 1,
      staleApprovals: 0,
    });

    await runComplianceScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenant)).toBe(0);
  });

  it("keeps tenants isolated and applies per-tenant fairness", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const accountA = newAccountId();
    const accountB = newAccountId();
    const counterpartyA = newCounterpartyId();
    const counterpartyB = newCounterpartyId();
    await seedComplianceTenant(pool, tenantA, accountA, counterpartyA);
    await seedTenantAndLedgerOnly(pool, tenantB, accountB, counterpartyB);
    await seedPaymentIntentCase(pool, tenantA, accountA, counterpartyA, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 0,
      staleApprovals: 0,
    });
    await seedPaymentIntentCase(pool, tenantA, accountA, counterpartyA, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 0,
      staleApprovals: 0,
    });
    await seedPaymentIntentCase(pool, tenantB, accountB, counterpartyB, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 0,
      staleApprovals: 0,
    });
    await seedPaymentIntentCase(pool, tenantB, accountB, counterpartyB, {
      status: "executed",
      requiredApprovers: ["admin"],
      validApprovals: 0,
      staleApprovals: 0,
    });

    await runComplianceScanCycle(
      { scanPool: pool, appPool: pool, runService },
      { now: NOW, batchSize: 10, perTenantBatchSize: 1, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenantA)).toBe(1);
    expect(await countProposals(pool, tenantB)).toBe(1);
    const visibleToA = await listProposals(
      pool,
      { tenantId: tenantA, actor: "test" },
      { type: "compliance" },
    );
    expect(visibleToA.proposals).toHaveLength(1);
  });

  it("records a missing-evidence hold without creating a proposal", async () => {
    const tenant = newTenantId();
    await seedTenantOnly(pool, tenant);

    await runComplianceScanCycle(
      {
        scanPool: scanPoolWith([
          {
            tenant_id: tenant,
            finding_id: "pi_missing_evidence",
            finding_type: "approval_missing",
            severity: "medium",
            event_hint: "approval.missing",
            policy_decision_id: newPolicyDecisionId(),
            audit_event_id: "",
            payment_intent_id: "pi_missing_evidence",
            subject_type: "payment_intent",
            subject_id: "pi_missing_evidence",
            policy_outcome: "confirm",
            rule_id: "approval_required",
            required_approvers_count: "1",
            valid_approval_count: "0",
            stale_approval_count: "0",
            detected_at: "2026-07-18T00:00:00.000Z",
          },
        ]),
        appPool: pool,
        runService,
      },
      { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
    );

    expect(await countProposals(pool, tenant)).toBe(0);
    const run = await withTenantScope(pool, tenant, async (client) => {
      const { rows } = await client.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason
           FROM agent_runs
          WHERE agent_id = 'compliance'
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

  it("detects approval-state permutations and surfaces no-audit-trail movements", async () => {
    const cases: Array<{
      name: string;
      outcome: "allow" | "confirm" | "reject";
      status: "proposed" | "approved" | "dispatching" | "executed";
      requiredApprovers: readonly string[];
      validApprovals: number;
      staleApprovals: number;
      createAudit: boolean;
      expectedFinding: string | null;
    }> = [
      {
        name: "allow proposed no approvals",
        outcome: "allow",
        status: "proposed",
        requiredApprovers: [],
        validApprovals: 0,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: null,
      },
      {
        name: "allow approved no required approvals",
        outcome: "allow",
        status: "approved",
        requiredApprovers: [],
        validApprovals: 0,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: null,
      },
      {
        name: "allow approved required approval missing",
        outcome: "allow",
        status: "approved",
        requiredApprovers: ["admin"],
        validApprovals: 0,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: "approval_missing",
      },
      {
        name: "confirm approved partial approvals",
        outcome: "confirm",
        status: "approved",
        requiredApprovers: ["admin", "approver"],
        validApprovals: 1,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: "approval_missing",
      },
      {
        name: "confirm executed stale approval only",
        outcome: "confirm",
        status: "executed",
        requiredApprovers: ["admin"],
        validApprovals: 0,
        staleApprovals: 1,
        createAudit: true,
        expectedFinding: "approval_missing",
      },
      {
        name: "confirm executed full approvals",
        outcome: "confirm",
        status: "executed",
        requiredApprovers: ["admin"],
        validApprovals: 1,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: null,
      },
      {
        name: "reject proposed policy violation",
        outcome: "reject",
        status: "proposed",
        requiredApprovers: [],
        validApprovals: 0,
        staleApprovals: 0,
        createAudit: true,
        expectedFinding: "policy_violation",
      },
      {
        name: "confirm executed missing approval and no audit trail",
        outcome: "confirm",
        status: "executed",
        requiredApprovers: ["admin"],
        validApprovals: 0,
        staleApprovals: 0,
        createAudit: false,
        expectedFinding: "audit_gap_detected",
      },
    ];

    const captured: Array<{
      name: string;
      tenantId: string;
      findingType: unknown;
      auditEventId: unknown;
    }> = [];
    const caseTenantByName = new Map<string, string>();
    for (const testCase of cases) {
      const tenant = newTenantId();
      caseTenantByName.set(testCase.name, tenant);
      const account = newAccountId();
      const counterparty = newCounterpartyId();
      await seedTenantAndLedgerOnly(pool, tenant, account, counterparty);
      await seedPaymentIntentCase(pool, tenant, account, counterparty, {
        status: testCase.status,
        outcome: testCase.outcome,
        requiredApprovers: testCase.requiredApprovers,
        validApprovals: testCase.validApprovals,
        staleApprovals: testCase.staleApprovals,
        createAudit: testCase.createAudit,
      });
      const runServiceForCase = {
        run: async (ctx: ServiceCallContext, input: Parameters<AgentRunService["run"]>[1]) => {
          const context = input.context ?? {};
          captured.push({
            name: testCase.name,
            tenantId: ctx.tenantId,
            findingType: context.finding_type,
            auditEventId: context.audit_event_id,
          });
          return {
            status: "notify_only" as const,
            routing_decision_id: `route_${captured.length}`,
            run_id: `run_${captured.length}`,
            selected_agent_id: "compliance",
            action: "notify",
            shadow_mode: false,
            reason: {},
          };
        },
      };

      await runComplianceScanCycle(
        { scanPool: pool, appPool: pool, runService: runServiceForCase },
        { now: NOW, batchSize: 10, perTenantBatchSize: 10, cooldownMs: 86_400_000 },
      );
    }

    for (const testCase of cases) {
      const tenant = caseTenantByName.get(testCase.name);
      const hit = captured.find((row) => row.name === testCase.name && row.tenantId === tenant);
      if (testCase.expectedFinding === null) {
        expect(hit, testCase.name).toBeUndefined();
      } else {
        expect(hit, testCase.name).toMatchObject({ findingType: testCase.expectedFinding });
      }
    }
    const noAudit = captured.find(
      (row) => row.name === "confirm executed missing approval and no audit trail",
    );
    expect(noAudit?.auditEventId).toMatch(/^audit_missing:/);
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

async function seedComplianceTenant(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
): Promise<void> {
  await seedTenantAndLedgerOnly(pool, tenantId, accountId, counterpartyId);
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
       VALUES ('compliance', $1, 'internal', 'compliance', 'Compliance', 'active', now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedTenantOnly(pool: Pool, tenantId: string): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, kind) VALUES ($1, 'demo') ON CONFLICT DO NOTHING`,
      [tenantId],
    );
  });
}

async function seedTenantAndLedgerOnly(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
): Promise<void> {
  await seedTenantOnly(pool, tenantId);
  await withTenantScope(pool, tenantId, async (client) => {
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
       VALUES ($1, $2, 'Vendor', 'vendor', 'vendor', NULL, 'document_verified',
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'human_confirmed', 1)`,
      [counterpartyId, tenantId],
    );
  });
}

async function seedPaymentIntentCase(
  pool: Pool,
  tenantId: string,
  accountId: string,
  counterpartyId: string,
  options: {
    readonly status: "proposed" | "approved" | "dispatching" | "executed";
    readonly outcome?: "allow" | "confirm" | "reject";
    readonly requiredApprovers: readonly string[];
    readonly validApprovals: number;
    readonly staleApprovals: number;
    readonly createAudit?: boolean;
  },
): Promise<{ paymentIntentId: string; policyDecisionId: string; auditEventId: string }> {
  const paymentIntentId = newPaymentIntentId();
  const policyDecisionId = newPolicyDecisionId();
  const auditEventId = newAuditEventId();
  const outcome = options.outcome ?? "confirm";
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO policy_decisions (
         id, tenant_id, policy_id, policy_version, subject_type, subject_id, outcome,
         matched_rule_id, required_approvers, ledger_snapshot_hash, trace, decided_at
       )
       VALUES ($1, $2, 'pol_test', 1, 'payment_intent', $3, $4,
         'approval_required', $5::text[], 'snapshot', '[]'::jsonb, '2026-07-18T00:00:00.000Z')`,
      [policyDecisionId, tenantId, paymentIntentId, outcome, [...options.requiredApprovers]],
    );
    await client.query(
      `INSERT INTO ledger_payment_intents (
         id, owner_id, created_by_agent_id, action_type, source_account_id,
         destination_counterparty_id, amount, currency, obligation_id, invoice_id,
         status, policy_decision_id, approval_ids, execution_receipt_ids,
         source_ids, evidence_ids, provenance, confidence, created_at, updated_at
       )
       VALUES ($1, $2, 'payment', 'ach_outbound', $3, $4, 100, 'USD', NULL, NULL,
         $5, $6, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'agent_contributed', 1, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`,
      [paymentIntentId, tenantId, accountId, counterpartyId, options.status, policyDecisionId],
    );
    for (let i = 0; i < options.validApprovals; i += 1) {
      await seedApproval(client, tenantId, paymentIntentId, "valid");
    }
    for (let i = 0; i < options.staleApprovals; i += 1) {
      await seedApproval(client, tenantId, paymentIntentId, "stale");
    }
    if (options.createAudit !== false) {
      await client.query(
        `INSERT INTO audit_events (
           id, tenant_id, layer, actor, action, inputs, outputs, policy_version,
           event_hash, prev_event_hash, created_at
         )
         VALUES ($1, $2, 'execution', 'agent_payment', 'payment_intent.execute.before',
           $3::jsonb, '{}'::jsonb, 1, $4, NULL, '2026-07-18T00:00:01.000Z')`,
        [
          auditEventId,
          tenantId,
          JSON.stringify({
            payment_intent_id: paymentIntentId,
            policy_decision_id: policyDecisionId,
          }),
          createHash("sha256").update(auditEventId).digest(),
        ],
      );
    }
  });
  return { paymentIntentId, policyDecisionId, auditEventId };
}

async function seedApproval(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  tenantId: string,
  paymentIntentId: string,
  status: "valid" | "stale",
): Promise<void> {
  await client.query(
    `INSERT INTO approvals (
       id, tenant_id, subject_type, subject_id, approver_principal_id, approver_role,
       signed_at, signature, policy_version, revoked_at, signer_tenant_id, status
     )
     VALUES ($1, $2, 'payment_intent', $3, $4, 'admin',
       '2026-07-18T00:00:00.000Z', NULL, 1, NULL, $2, $5)`,
    [newApprovalId(), tenantId, paymentIntentId, `user_${status}_${paymentIntentId}`, status],
  );
}

async function countProposals(pool: Pool, tenantId: string): Promise<number> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM proposals WHERE tenant_id = current_setting('app.tenant_id', true)`,
    );
    return Number(rows[0]?.count ?? 0);
  });
}

function scanPoolWith(rows: readonly ComplianceFindingRow[]): Pool {
  return {
    query: async () => ({
      rows: rows.map((row) => ({ ...row, eligible_count: rows.length, fair_count: rows.length })),
      rowCount: rows.length,
    }),
  } as unknown as Pool;
}
