import { describe, expect, it } from "vitest";
import {
  ActionResolver,
  AgentRouter,
  AgentRunService,
  RulesIntentClassifier,
  StaticEvidenceGatherer,
  type AgentRunStore,
} from "@brain/agent-router";
import {
  InMemoryAuditEmitter,
  newTenantId,
  type IAgentService,
  type IPaymentIntentService,
  type ServiceCallContext,
} from "@brain/shared";
import type { EvidenceRef } from "./evidence.js";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "./registry.js";

const DECISION_CONTEXT = {
  decide_by: "Fri Sep 25, 4 days",
  if_wrong: "Acting too early may interrupt a valid workflow. Waiting too long may increase risk.",
  reversible: { state: "yes", label: "Yes for 24 hours" },
};

describe("new agent event integration", () => {
  it("routes every AML compliance event to a proposal", async () => {
    const events = [
      "payment.cross_border_created",
      "payment.above_regulatory_threshold",
      "kyc.beneficiary_stale",
      "ofac.list_updated",
    ] as const;

    for (const event of events) {
      const harness = createHarness([
        { kind: "payment_intent", ref: "pi_1" },
        { kind: "counterparty", ref: "cp_1" },
        { kind: "kyc", ref: "kyc_1" },
        { kind: "screening", ref: "scr_1" },
      ]);
      const result = await harness.service.run(harness.ctx, {
        tenant_id: harness.ctx.tenantId,
        event,
        context: amlContext(),
      });

      expect(result.status).toBe("proposal_created");
      expect(harness.proposals.at(-1)).toMatchObject({
        type: "aml_compliance",
        recommended_action: event === "kyc.beneficiary_stale" ? "provide_docs" : expect.any(String),
      });
    }
  });

  it("routes every subscription management event to a proposal", async () => {
    const events = [
      "recurring_charge.detected",
      "vendor.duplicate_detected",
      "subscription.price_changed",
      "subscription.seats_underutilized",
      "subscription.new_signup_detected",
    ] as const;

    for (const event of events) {
      const harness = createHarness([
        { kind: "transaction", ref: "tx_1" },
        { kind: "subscription", ref: "sub_1" },
        { kind: "directory_usage", ref: "dir_1" },
        { kind: "contract", ref: "ctr_1" },
      ]);
      const result = await harness.service.run(harness.ctx, {
        tenant_id: harness.ctx.tenantId,
        event,
        target_agent_id: "subscription_management",
        context: subscriptionContext(),
      });

      expect(result.status).toBe("proposal_created");
      expect(harness.proposals.at(-1)).toMatchObject({
        type: "subscription_management",
        recommended_action: expect.any(String),
      });
    }
  });
});

function createHarness(evidence: readonly EvidenceRef[]): {
  readonly ctx: ServiceCallContext;
  readonly service: AgentRunService;
  readonly proposals: Record<string, unknown>[];
} {
  const tenantId = newTenantId();
  const proposals: Record<string, unknown>[] = [];
  const audit = new InMemoryAuditEmitter();
  const classifier = new RulesIntentClassifier();
  const gatherer = new StaticEvidenceGatherer(evidence);
  const router = new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier,
    evidence: gatherer,
    getScopedCapabilities: () => new Set(internalAgentCatalog.flatMap((def) => def.capabilities)),
    getTenantCategory: () => "business",
    signals: () => ({ reputation: 1, cost: 0 }),
    audit,
  });
  const agents = {
    propose: async (_ctx, _agentId, input) => {
      proposals.push(input.action);
      return {
        id: `prop_${proposals.length}`,
        proposing_agent_id: _agentId,
        action: input.action,
        policy_decision_id: "pd_1",
        status: "pending",
        approvers_signed: [],
        created_at: "2026-09-20T00:00:00.000Z",
      };
    },
  } satisfies Pick<IAgentService, "propose">;
  const store: AgentRunStore = {
    async recordRoutingDecision() {
      return { id: "agrd_1" };
    },
    async recordRun() {
      return { id: "agnr_1" };
    },
  };

  return {
    ctx: { tenantId, actor: "test" },
    proposals,
    service: new AgentRunService({
      router,
      audit,
      actionResolver: new ActionResolver({ classifier }),
      handlers: internalAgentHandlers,
      definitions: internalAgentDefinitions,
      evidence: gatherer,
      propose: {
        agents: agents as unknown as IAgentService,
        paymentIntents: {} as IPaymentIntentService,
      },
      store,
      getTenantCategory: () => "business",
      isShadowed: () => false,
    }),
  };
}

function amlContext(): Record<string, unknown> {
  return {
    decision_context: DECISION_CONTEXT,
    payment_id: "pi_1",
    beneficiary_id: "cp_1",
    counterparty_id: "cp_1",
    amount: "12000.00",
    currency: "USD",
    jurisdictions_involved: ["US"],
    screenings: {
      ofac: { status: "clear", lists_checked: ["stub.ofac"], timestamp: "2026-09-20T00:00:00Z" },
      pep: { status: "clear", matches: [] },
      kyc_freshness: { status: "stale", note: "kyc_store_not_wired" },
    },
    required_documents: [{ type: "beneficiary_kyc", status: "needed", description: "KYC" }],
    regulatory_context: {
      jurisdiction: "US",
      regulation_id: "US-BSA-CTR-10000",
      threshold: "10000.00",
      purpose_code_required: false,
    },
    deadline: "2026-09-21T00:00:00.000Z",
  };
}

function subscriptionContext(): Record<string, unknown> {
  return {
    decision_context: DECISION_CONTEXT,
    subscription_id: "sub_1",
    transaction_id: "tx_1",
    merchant: "Acme SaaS",
    current_plan: "Team",
    renewal_date: "2026-12-01",
    currency: "USD",
    current_price: "1200.00",
    options: [
      {
        label: "renew",
        price: "1200.00",
        seats: 10,
        savings_vs_current: "0.00",
        recommended: true,
      },
    ],
  };
}
