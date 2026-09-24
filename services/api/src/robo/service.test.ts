import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newUserId,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import { composeOvernightSummary, RoboService, toRoboAnswer } from "./service.js";
import type { RoboBriefResponse, RoboServiceDeps } from "./types.js";
import type { DecisionAuditLogEntry, ProposalReadItem } from "@brain/execution";

const TENANT = newTenantId();
const USER = newUserId();

const ctx: ServiceCallContext = {
  tenantId: TENANT,
  actor: USER,
  requestId: "req_1",
  principalType: "user",
  scopes: ["wiki:read"],
};

const proposal: ProposalReadItem = {
  id: "prop_01K5P89Y9S1TF48WWGKG7JKW8A",
  type: "cash_forecast",
  created_at: "2026-09-20T00:00:00.000Z",
  status: "pending",
  risk_band: "high",
  confidence: 0.9,
  mode: "propose",
  narrative: "Runway risk",
  evidence: [],
  agent: { id: "agent_cash", kind: "internal", display_name: "Cash Forecast" },
  payment_intent_id: null,
  action_type: null,
  stored_action_type: "alert_shortfall",
  details: {
    amount_cents: 1200000,
    currency: "USD",
    at_burn_cents: 300000,
    extends_to_months_if_forecast: 14,
  },
  policy: {
    decision: null,
    policy_id: null,
    policy_version: null,
    matched_rule_id: null,
    explanation: null,
    required_approvers: [],
    trace: {},
  },
  presentation: {
    headline: "Runway needs attention",
    recommendation: null,
    key_facts: [],
    confidence_band: "high",
    policy: {
      decision: null,
      policy_id: null,
      policy_version: null,
      matched_rule_id: null,
      explanation: null,
      required_approvers: [],
      trace: {},
    },
    consequences: { approve: null, reject: null, acknowledge: null },
    actions: [],
    technical_detail: {
      "1_ingest": {},
      "2_extract": {},
      "3_classify": {},
      "4_score": {},
      "5_policy": {
        decision: null,
        policy_id: null,
        policy_version: null,
        matched_rule_id: null,
        explanation: null,
        required_approvers: [],
        trace: {},
      },
      "6_propose": {},
    },
  },
  available_decisions: [],
  runway_projection: [
    {
      date: "2026-09-27",
      projected_balance: "9000",
      projected_runway_months: "9",
    },
  ],
};

class FakePool {
  public readonly cache = new Map<string, RoboBriefResponse>();
  public readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  public async connect() {
    return {
      query: async (sql: string, values: readonly unknown[] = []) => this.query(sql, values),
      release: vi.fn(),
    };
  }

  private async query(sql: string, values: readonly unknown[]) {
    this.queries.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM brief_cache") && sql.startsWith("SELECT")) {
      const cached = this.cache.get(String(values[0]));
      return {
        rows: cached === undefined ? [] : [{ response: cached }],
        rowCount: cached === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("INSERT INTO brief_cache")) {
      const date = String(values[0]);
      const response = JSON.parse(String(values[1])) as RoboBriefResponse;
      if (!this.cache.has(date)) this.cache.set(date, response);
      return { rows: [{ response: this.cache.get(date)! }], rowCount: 1 };
    }
    if (sql.includes("FROM ledger_balances") && sql.includes("ranked")) {
      return {
        rows: [
          { day: new Date("2026-09-18T00:00:00.000Z"), currency: "USD", value_cents: "4500000" },
          { day: new Date("2026-09-20T00:00:00.000Z"), currency: "USD", value_cents: "5000000" },
        ],
        rowCount: 2,
      };
    }
    if (
      sql.includes("FROM ledger_balances") &&
      sql.includes("sum(current_balance)") &&
      sql.includes("interval '6 day'")
    ) {
      return { rows: [{ currency: "USD", value_cents: "4200000" }], rowCount: 1 };
    }
    if (sql.includes("FROM ledger_balances") && sql.includes("sum(current_balance)")) {
      return { rows: [{ currency: "USD", value_cents: "5000000" }], rowCount: 1 };
    }
    if (sql.includes("FROM ledger_transactions") && sql.includes("interval '59 day'")) {
      return { rows: [{ currency: "USD", value_cents: "250000" }], rowCount: 1 };
    }
    if (sql.includes("FROM ledger_transactions")) {
      return { rows: [{ currency: "USD", value_cents: "500000" }], rowCount: 1 };
    }
    if (sql.includes("FROM audit_events")) {
      return { rows: [{ created_at: new Date("2026-09-20T01:00:00.000Z") }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function buildService(pool: FakePool, overrides: Partial<RoboServiceDeps> = {}) {
  return new RoboService({
    pool: pool as unknown as Pool,
    audit: new InMemoryAuditEmitter(),
    askWiki: async () => ({
      answered: true,
      answer: "Runway improves if the burn plan lands.",
      evidence: [{ entityType: "proposal", entityId: proposal.id, excerpt: "Runway risk" }],
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    recordDeterministicIntentUsage: async () => undefined,
    wikiDeps: {
      llm: {} as never,
      embed: {} as never,
      redis: {} as never,
      metrics: {} as never,
    },
    questionModel: "test-model",
    listProposals: async () => ({ proposals: [proposal] }),
    auditLog: {
      list: async () => ({
        entries: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            tenant_id: TENANT,
            occurred_at: "2026-09-20T03:00:00.000Z",
            actor: { type: "agent", id: "agent_cash", display_name: "Cash" },
            proposal_id: proposal.id,
            agent: "cash_forecast",
            decision: "alert_shortfall",
            outcome: { status: "recorded", details: { change_word: "steady", months: 9 } },
            policy_context: {},
            payload_snapshot_id: "00000000-0000-4000-8000-000000000201",
            event_id: "evt_overnight_1",
            event_action: "decision.executed",
            archived_at: null,
            cold_storage_uri: null,
            created_at: "2026-09-20T03:00:01.000Z",
          },
          {
            id: "00000000-0000-4000-8000-000000000102",
            tenant_id: TENANT,
            occurred_at: "2026-09-20T02:00:00.000Z",
            actor: { type: "agent", id: "agent_recon", display_name: "Reconciliation" },
            proposal_id: "prop_01K5P89Y9S1TF48WWGKG7JKW8B",
            agent: "reconciliation",
            decision: "confirm_all_matches",
            outcome: {
              status: "recorded",
              details: { matched_count: 203, period: "August", exception_count: 2 },
            },
            policy_context: {},
            payload_snapshot_id: "00000000-0000-4000-8000-000000000202",
            event_id: "evt_overnight_2",
            event_action: "decision.auto_executed",
            archived_at: null,
            cold_storage_uri: null,
            created_at: "2026-09-20T02:00:01.000Z",
          },
        ],
        next_cursor: null,
      }),
    },
    getProposal: async () => proposal,
    insertSnapshot: async (_client: TenantScopedClient, snapshotCtx, payload) => ({
      id: "00000000-0000-4000-8000-000000000001",
      tenant_id: snapshotCtx.tenantId,
      payload,
      payload_sha256: "hash",
      created_by: snapshotCtx.actor,
      created_at: "2026-09-20T00:00:00.000Z",
    }),
    now: () => new Date("2026-09-20T04:00:00.000Z"),
    threadIdFactory: () => "00000000-0000-4000-8000-000000000002",
    messageIdFactory: () => "00000000-0000-4000-8000-000000000003",
    ...overrides,
  });
}

describe("RoboService", () => {
  it.each([
    [
      "reconciliation",
      { matched_count: 203, period: "August", exception_count: 2 },
      "Matched 203 August bank items to invoices and bills · 2 exceptions queued",
      "Refreshed reconciliation results",
    ],
    [
      "aml_compliance",
      { checks_passed: 4, vendor: "Al Noor Trading", docs_needed: 1 },
      "Cleared 4 on the Al Noor Trading wire · 1 still needed",
      "Reviewed AML checks on a wire",
    ],
    [
      "collections",
      { notice_type: "second", customer: "BigCo" },
      "Drafted second notice to BigCo · ready for your review",
      "Drafted collections notice",
    ],
    [
      "fraud_anomaly",
      { amount: 4200, currency: "USD", card_last4: "4242", reason_hint: "outside normal region" },
      "Flagged unusual $4,200 charge on the 4242 card · outside normal region",
      "Flagged unusual charge on the card",
    ],
    [
      "payable_approval",
      { count: 6, total_amount: 12900, currency: "USD" },
      "Auto-paid 6 SaaS bills under threshold · $12,900 total",
      "Processed SaaS bills under threshold",
    ],
    [
      "cash_forecast",
      { change_word: "extended", months: 14 },
      "Refreshed cash forecast · runway extended at 14 months",
      "Refreshed cash forecast",
    ],
    [
      "treasury",
      { amount: 250000, currency: "USD", apy: "4.8%" },
      "Swept $250,000 to reserve · earning at 4.8%",
      "Reviewed reserve sweep",
    ],
    [
      "vendor_risk",
      { vendor: "Quick Pay Solutions" },
      "Held Quick Pay Solutions wire pending routing verification · flagged for review",
      "Held wire pending routing verification",
    ],
    [
      "dispute",
      { amount: 860, currency: "USD", date: "Sep 28" },
      "Filed dispute evidence for $860 charge · Visa response expected Sep 28",
      "Filed dispute evidence for charge",
    ],
    [
      "revenue_intel",
      { top_customer: "Enterprise Holdings", top_customer_pct: 42, period: "Q3" },
      "Refreshed concentration for Enterprise Holdings · now 42% of Q3 revenue",
      "Refreshed revenue concentration",
    ],
    [
      "subscription_management",
      { vendor: "Notion", price_delta_pct: 18, days: 12 },
      "Flagged Notion renewal · 18% increase in 12 days",
      "Flagged subscription renewal",
    ],
    [
      "invoice_integrity",
      { vendor: "CloudOps Inc", match_pct: 97, prior_invoice: "INV-101" },
      "Flagged possible duplicate from CloudOps Inc · 97% match to INV-101",
      "Flagged possible duplicate invoice",
    ],
  ])("composes specific overnight summaries for %s", (agent, details, populated, missing) => {
    expect(composeOvernightSummary(auditEntry(agent, details))).toBe(populated);
    expect(composeOvernightSummary(auditEntry(agent, {}))).toBe(missing);
  });

  it("returns the same cached brief for two calls on the same day", async () => {
    const pool = new FakePool();
    const service = buildService(pool);

    const first = await service.createBrief(ctx, { tenant_id: TENANT, as_of: "2026-09-20" });
    const second = await service.createBrief(ctx, { tenant_id: TENANT, as_of: "2026-09-20" });

    expect(second.prepared_at).toBe(first.prepared_at);
    expect(pool.cache.size).toBe(1);
  });

  it("populates brief signals and urgent proposal highlights from read models", async () => {
    const service = buildService(new FakePool());

    const brief = await service.createBrief(ctx, { tenant_id: TENANT, as_of: "2026-09-20" });

    expect(brief.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "cash_on_hand",
          value_cents: 5000000,
          delta_cents_7d: 800000,
        }),
        expect.objectContaining({ key: "net_30_day", value_cents: 500000, delta_pct: 100 }),
        expect.objectContaining({ key: "runway_months", value_months: 9, at_burn_cents: 300000 }),
      ]),
    );
    expect(brief.highlights).toEqual([
      expect.objectContaining({
        proposal_id: proposal.id,
        agent: "Cash Forecast",
        title: "Runway needs attention",
        amount_cents: 1200000,
        urgency: "urgent",
      }),
    ]);
    expect(brief.body_markdown).toContain("2 decisions executed overnight.");
  });

  it("returns overnight Robo actions from the decision audit log", async () => {
    const service = buildService(new FakePool());

    const overnight = await service.getOvernight(ctx);

    expect(overnight.window).toEqual({
      start: "2026-09-20T01:00:00.000Z",
      end: "2026-09-20T04:00:00.000Z",
    });
    expect(overnight.action_count).toBe(2);
    expect(overnight.actions).toEqual([
      {
        agent: "Reconciliation",
        summary: "Matched 203 August bank items to invoices and bills · 2 exceptions queued",
        related_proposal_ids: ["prop_01K5P89Y9S1TF48WWGKG7JKW8B"],
        occurred_at: "2026-09-20T02:00:00.000Z",
      },
      {
        agent: "Cash",
        summary: "Refreshed cash forecast · runway steady at 9 months",
        related_proposal_ids: [proposal.id],
        occurred_at: "2026-09-20T03:00:00.000Z",
      },
    ]);
  });

  it("omits unavailable brief fields instead of fabricating them", async () => {
    const service = buildService(new FakePool(), {
      listProposals: async () => ({ proposals: [] }),
    });

    const brief = await service.createBrief(ctx, { tenant_id: TENANT, as_of: "2026-09-20" });

    expect(brief.signals.some((signal) => signal.key === "runway_months")).toBe(false);
    expect(brief.highlights).toEqual([]);
  });

  it("attaches proposal snapshot context when opening a thread", async () => {
    const pool = new FakePool();
    const prompts: string[] = [];
    let snapshotPayload: Record<string, unknown> | null = null;
    const service = buildService(pool, {
      askWiki: async ({ options }) => {
        prompts.push(options.question);
        return {
          answered: true,
          answer: "Use the modeled burn plan.",
          evidence: [{ entityType: "proposal", entityId: proposal.id, excerpt: "Runway risk" }],
          model: "test",
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
      insertSnapshot: async (_client, snapshotCtx, payload) => {
        snapshotPayload = payload;
        return {
          id: "00000000-0000-4000-8000-000000000001",
          tenant_id: snapshotCtx.tenantId,
          payload,
          payload_sha256: "hash",
          created_by: snapshotCtx.actor,
          created_at: "2026-09-20T00:00:00.000Z",
        };
      },
    });

    const result = await service.askFromContext(ctx, {
      tenant_id: TENANT,
      source: {
        kind: "proposal_rail",
        agent: "cash_forecast",
        rail: "scenario_modeling",
        proposal_id: proposal.id,
      },
      prompt: "Model what keeps runway above 12 months",
      open_thread: false,
    });

    expect(result.thread_id).toBe("00000000-0000-4000-8000-000000000002");
    expect(result.first_response.refs).toEqual([
      { kind: "proposal", id: proposal.id, display_name: proposal.id },
    ]);
    expect(snapshotPayload).toEqual(
      expect.objectContaining({
        kind: "robo_context_proposal_snapshot",
        proposal,
      }),
    );
    expect(prompts[0]).toContain("Proposal details");
    expect(pool.queries.some((entry) => entry.sql.includes("INSERT INTO robo_messages"))).toBe(
      true,
    );
  });

  it("keeps existing text answers valid while adding optional structured fields", () => {
    const answer = toRoboAnswer({
      answered: true,
      answer: "Cash is stable.",
      evidence: [],
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    expect(answer).toEqual({
      text: "Cash is stable.",
      data_cards: [],
      charts: [],
      follow_ups: [],
      refs: [],
    });
  });
});

function auditEntry(agent: string, details: Record<string, unknown>): DecisionAuditLogEntry {
  return {
    id: "00000000-0000-4000-8000-000000000999",
    tenant_id: TENANT,
    occurred_at: "2026-09-20T03:00:00.000Z",
    actor: { type: "agent", id: "agent_test", display_name: null },
    proposal_id: "prop_01K5P89Y9S1TF48WWGKG7JKW8Z",
    agent,
    decision: "approve",
    outcome: { status: "recorded", details },
    policy_context: {},
    payload_snapshot_id: "00000000-0000-4000-8000-000000000998",
    event_id: "evt_test",
    event_action: "decision.executed",
    archived_at: null,
    cold_storage_uri: null,
    created_at: "2026-09-20T03:00:01.000Z",
  };
}
