import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, type Action, type Decision, type PolicyDocument } from "@brain/policy";
import { resolveExecutionMode, type DecisionVerdict } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { EvidenceBundle } from "./evidence.js";
import type { InternalAgentHandler, ProposedAction } from "./handler.js";
import { paymentDefinition } from "./payment/definition.js";
import { paymentHandler } from "./payment/handler.js";
import { subscriptionDefinition } from "./subscription/definition.js";
import { subscriptionHandler } from "./subscription/handler.js";
import { vendorRiskDefinition } from "./vendor_risk/definition.js";
import { vendorRiskHandler } from "./vendor_risk/handler.js";
import { cashForecastDefinition } from "./cash_forecast/definition.js";
import { cashForecastHandler } from "./cash_forecast/handler.js";
import { disputeDefinition } from "./dispute/definition.js";
import { disputeHandler } from "./dispute/handler.js";
import { complianceDefinition } from "./compliance/definition.js";
import { complianceHandler } from "./compliance/handler.js";
import { revenueIntelDefinition } from "./revenue_intel/definition.js";
import { revenueIntelHandler } from "./revenue_intel/handler.js";

// Evidence covering every business agent's required kinds.
const FULL: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1" },
    { kind: "counterparty", ref: "cp_1" },
    { kind: "payment_destination", ref: "dest_1" },
    { kind: "transaction", ref: "tx_1" },
    { kind: "balance", ref: "bal_1" },
    { kind: "dispute", ref: "dsp_1" },
    { kind: "policy_decision", ref: "pd_1" },
    { kind: "audit_event", ref: "evt_1" },
    { kind: "vendor", ref: "ven_1" },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

const PAYMENT_CONTEXT = {
  source_account_id: "acct_1",
  destination_counterparty_id: "cp_2",
  amount: "5000",
  currency: "USD",
  invoice_id: "inv_1",
};

const CASH_FORECAST_CONTEXT = {
  balance_id: "bal_1",
  current_balance: "1000.00",
  currency: "USD",
  receivables: [
    {
      invoice_id: "inv_1",
      amount: "250.00",
      currency: "USD",
      due_date: "2026-08-01T00:00:00.000Z",
    },
  ],
  payables: [
    {
      obligation_id: "obl_1",
      amount: "100.00",
      currency: "USD",
      due_date: "2026-08-15T00:00:00.000Z",
    },
  ],
};

const DISPUTE_CONTEXT = {
  dispute_id: "dsp_1",
  transaction_id: "tx_1",
  amount: "750.00",
  currency: "USD",
  deadline: "2026-08-01T00:00:00.000Z",
  dispute_age_days: 8,
  evidence_completeness: 1,
};

const REVENUE_INTEL_CONTEXT = {
  invoice_id: "inv_1",
  transaction_id: "tx_1",
  currency: "USD",
  current_period_revenue: "1000.00",
  prior_period_revenue: "900.00",
  current_dso: 20,
  prior_dso: 18,
};

const SUBSCRIPTION_CONTEXT = {
  transaction_id: "tx_1",
  counterparty_id: "cp_1",
  amount: "100.00",
  currency: "USD",
  transaction_date: "2026-07-18",
  history: [
    { transaction_id: "tx_hist_1", amount: "100.00", transaction_date: "2026-05-18" },
    { transaction_id: "tx_hist_2", amount: "100.00", transaction_date: "2026-06-18" },
    { transaction_id: "tx_1", amount: "100.00", transaction_date: "2026-07-18" },
  ],
};

function loadPolicy(rel: string): PolicyDocument {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as PolicyDocument;
}

function toPolicyAction(proposed: ProposedAction, agentRole: string): Action {
  // 1b.5 templates key on agent.id; populate both id and role. Window aggregates
  // absent (prior = 0) so the envelope is satisfied on amount alone.
  const common = {
    agent_role: agentRole,
    agent_id: agentRole,
    tenant_category: "business" as const,
    timestamp: new Date("2026-05-22T12:00:00Z"),
  };
  if (proposed.channel === "agent") {
    return {
      kind: "ledger_write",
      counterparty_id: (proposed.action.counterparty_id as string | null) ?? null,
      amount: null,
      ...common,
    };
  }
  return {
    kind: "outbound_payment",
    counterparty_id: proposed.intent.destination_counterparty_id,
    amount: { currency: proposed.intent.currency, value: proposed.intent.amount },
    ...common,
  };
}

function outcomeToDecision(outcome: Decision["outcome"]): DecisionVerdict {
  return outcome === "reject" ? "DENY" : outcome === "confirm" ? "ESCALATE" : "ALLOW";
}

interface Case {
  readonly def: InternalAgentDefinition;
  readonly handler: InternalAgentHandler;
  readonly policy: string;
  readonly sampleAction: string;
  readonly context: Record<string, unknown>;
  readonly expectedOutcome: Decision["outcome"];
}

const CASES: readonly Case[] = [
  {
    def: paymentDefinition,
    handler: paymentHandler,
    policy: "./payment/policy.template.json",
    sampleAction: "propose_payment",
    context: PAYMENT_CONTEXT,
    // $5k is within the envelope and below approval_required_above ($10k) → auto.
    expectedOutcome: "allow",
  },
  {
    def: subscriptionDefinition,
    handler: subscriptionHandler,
    policy: "./subscription/policy.template.json",
    sampleAction: "flag_subscription",
    context: SUBSCRIPTION_CONTEXT,
    expectedOutcome: "allow",
  },
  {
    def: vendorRiskDefinition,
    handler: vendorRiskHandler,
    policy: "./vendor_risk/policy.template.json",
    sampleAction: "require_approval",
    context: { counterparty_id: "cp_1" },
    expectedOutcome: "confirm",
  },
  {
    def: cashForecastDefinition,
    handler: cashForecastHandler,
    policy: "./cash_forecast/policy.template.json",
    sampleAction: "generate_forecast",
    context: CASH_FORECAST_CONTEXT,
    expectedOutcome: "allow",
  },
  {
    def: disputeDefinition,
    handler: disputeHandler,
    policy: "./dispute/policy.template.json",
    sampleAction: "gather_evidence",
    context: DISPUTE_CONTEXT,
    expectedOutcome: "allow",
  },
  {
    def: complianceDefinition,
    handler: complianceHandler,
    policy: "./compliance/policy.template.json",
    sampleAction: "notify",
    context: {},
    expectedOutcome: "confirm",
  },
  {
    def: revenueIntelDefinition,
    handler: revenueIntelHandler,
    policy: "./revenue_intel/policy.template.json",
    sampleAction: "recommend_follow_up",
    context: REVENUE_INTEL_CONTEXT,
    expectedOutcome: "allow",
  },
];

describe.each(CASES)("business agent: $def.agent_key", (c) => {
  it("produces a proposal that passes its policy template", () => {
    const proposed = c.handler.build({
      action: c.sampleAction,
      context: c.context,
      evidence: FULL,
    });
    const decision = evaluate(loadPolicy(c.policy), toPolicyAction(proposed, c.def.agent_key));
    expect(decision.outcome).toBe(c.expectedOutcome);
    expect(decision.outcome).not.toBe("reject");
  });

  it("returns notify_only when required evidence is missing", () => {
    const mode = resolveExecutionMode({
      decision: "ALLOW",
      confidence: 0.99,
      evidenceComplete: false,
      minimumConfidence: c.def.minimum_confidence,
      riskLevel: c.def.risk_level,
    });
    expect(mode).toBe("notify_only");
  });
});

describe("high-risk agents", () => {
  it.each([vendorRiskDefinition, complianceDefinition])(
    "$agent_key returns confirm even at high confidence",
    (def) => {
      const mode = resolveExecutionMode({
        decision: "ESCALATE", // high-risk policy templates escalate to confirm
        confidence: 0.99,
        evidenceComplete: true,
        minimumConfidence: def.minimum_confidence,
        riskLevel: def.risk_level,
      });
      expect(mode).toBe("confirm");
    },
  );
});

describe("integration", () => {
  it("Compliance never returns execute mode (high risk)", () => {
    const decisions: DecisionVerdict[] = ["ALLOW", "ESCALATE", "DENY"];
    for (const decision of decisions) {
      const mode = resolveExecutionMode({
        decision,
        confidence: 0.99,
        evidenceComplete: true,
        minimumConfidence: complianceDefinition.minimum_confidence,
        riskLevel: complianceDefinition.risk_level,
      });
      expect(mode).not.toBe("execute");
    }
    // And its policy template never auto-allows.
    const proposed = complianceHandler.build({ action: "notify", context: {}, evidence: FULL });
    const decision = evaluate(
      loadPolicy("./compliance/policy.template.json"),
      toPolicyAction(proposed, "compliance"),
    );
    expect(outcomeToDecision(decision.outcome)).toBe("ESCALATE");
  });

  it("Vendor Risk blocks payment.destination_changed when flagged risk evidence is present", () => {
    const withRisk = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      context: { counterparty_id: "cp_1", payment_destination: "dest_2" },
      evidence: FULL, // includes counterparty_history below
    });
    // FULL lacks counterparty_history; add it explicitly for the block path.
    const withHistory = vendorRiskHandler.build({
      action: "require_approval",
      context: { counterparty_id: "cp_1" },
      evidence: {
        items: [{ kind: "counterparty_history", ref: "hist_1", risk_flag: true }],
        completeness: 1,
        evidence_score: 1,
        missing_required_evidence: [],
        critical_missing: false,
      },
    });
    expect(withHistory.channel).toBe("agent");
    if (withHistory.channel === "agent") {
      expect(withHistory.action.type).toBe("block_payment");
    }
    // Without risk history it stays a flag.
    if (withRisk.channel === "agent") {
      expect(withRisk.action.type).toBe("flag_vendor_risk");
    }
  });

  it("Vendor Risk does not block on clean counterparty history presence alone", () => {
    const cleanHistory = vendorRiskHandler.build({
      action: "flag_vendor_risk",
      context: { counterparty_id: "cp_1" },
      evidence: {
        items: [{ kind: "counterparty_history", ref: "hist_clean", severity: "low" }],
        completeness: 1,
        evidence_score: 1,
        missing_required_evidence: [],
        critical_missing: false,
      },
    });

    expect(cleanHistory.channel).toBe("agent");
    if (cleanHistory.channel === "agent") {
      expect(cleanHistory.action.type).toBe("flag_vendor_risk");
    }
  });

  it("Cash Forecasting produces a forecast report proposal", () => {
    const proposed = cashForecastHandler.build({
      action: "generate_forecast",
      context: CASH_FORECAST_CONTEXT,
      evidence: FULL,
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "cash_forecast",
        recommended_action: "hold",
        projected_net_position: {
          day_30: "1150.00",
          day_60: "1150.00",
          day_90: "1150.00",
        },
      });
    }
  });
});
