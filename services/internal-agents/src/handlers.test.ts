import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, type Action, type PolicyDocument } from "@brain/policy";
import type { IAgentService, IPaymentIntentService, ServiceCallContext } from "@brain/shared";
import type { EvidenceBundle } from "./evidence.js";
import { proposeAction, type ProposedAction } from "./handler.js";
import { collectionsHandler } from "./collections/handler.js";
import { collectionsDefinition } from "./collections/definition.js";
import { revenueIntelDefinition } from "./revenue_intel/definition.js";
import { treasuryHandler } from "./treasury/handler.js";
import { treasuryDefinition } from "./treasury/definition.js";
import { reconciliationHandler } from "./reconciliation/handler.js";
import { reconciliationDefinition } from "./reconciliation/definition.js";
import { paymentHandler } from "./payment/handler.js";
import { paymentDefinition } from "./payment/definition.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_1" };
const EVIDENCE: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1" },
    { kind: "counterparty", ref: "cp_1" },
    { kind: "balance", ref: "bal_1" },
    { kind: "transaction", ref: "tx_1" },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

function loadPolicy(rel: string): PolicyDocument {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as PolicyDocument;
}

function toPolicyAction(proposed: ProposedAction, agentRole: string): Action {
  // 1b.5 templates key on agent.id; populate both id and role. Window aggregates
  // are absent (prior spend/count = 0) so the envelope is satisfied on amount.
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

describe("Collections handler", () => {
  it("produces a non-financial proposal that passes its policy", () => {
    const proposed = collectionsHandler.build({
      action: "draft_followup",
      context: {
        invoice_id: "inv_1",
        counterparty_id: "cp_1",
        amount: "100",
        currency: "USD",
        due_date: "2026-07-01T00:00:00.000Z",
        days_overdue: 8,
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("agent");
    const decision = evaluate(
      loadPolicy("./collections/policy.template.json"),
      toPolicyAction(proposed, "collections"),
    );
    expect(decision.outcome).not.toBe("reject");
  });

  it("stamps policy gate signals from trusted definition and evidence", () => {
    const proposed = collectionsHandler.build({
      action: "draft_followup",
      context: {
        invoice_id: "inv_1",
        counterparty_id: "cp_1",
        amount: "100",
        currency: "USD",
        due_date: "2026-07-01T00:00:00.000Z",
        days_overdue: 8,
      },
      evidence: {
        ...EVIDENCE,
        evidence_score: 0.9,
        items: [{ kind: "invoice", ref: "inv_1", confidence: 0.42 }],
      },
      definition: collectionsDefinition,
      confidence: 0.88,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        confidence: 0.42,
        evidence_score: 0.9,
        risk_level: "medium",
        agent_id: "collections",
        agent_role: "collections",
        mode: "propose",
      });
    }
  });

  it("marks notify-only definitions as notify_only regardless of action content", () => {
    const proposed = collectionsHandler.build({
      action: "draft_followup",
      context: {
        invoice_id: "inv_1",
        counterparty_id: "cp_1",
        amount: "100",
        currency: "USD",
        due_date: "2026-07-01T00:00:00.000Z",
        days_overdue: 8,
      },
      evidence: EVIDENCE,
      definition: revenueIntelDefinition,
      confidence: 0.9,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action.mode).toBe("notify_only");
    }
  });
});

describe("Treasury handler", () => {
  it("auto-approves a transfer within the envelope and below the approval threshold", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "5000",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    const decision = evaluate(
      loadPolicy("./treasury/policy.template.json"),
      toPolicyAction(proposed, "treasury"),
    );
    expect(decision.outcome).toBe("allow");
  });

  it("escalates a transfer above the approval threshold to confirm", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "50000",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });
    const decision = evaluate(
      loadPolicy("./treasury/policy.template.json"),
      toPolicyAction(proposed, "treasury"),
    );
    expect(decision.outcome).toBe("confirm");
  });

  it("rejects a transfer outside the per-tx envelope cap", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "250000",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });
    const decision = evaluate(
      loadPolicy("./treasury/policy.template.json"),
      toPolicyAction(proposed, "treasury"),
    );
    expect(decision.outcome).toBe("reject");
  });

  it("produces an advisory proposal that passes its policy", () => {
    const proposed = treasuryHandler.build({
      action: "recommend_cash_sweep",
      context: {
        balance_id: "bal_1",
        account_id: "acct_1",
        current_balance: "120000.00",
        currency: "USD",
        thresholds: {
          operating_minimum: "50000.00",
          surplus_floor: "100000.00",
          low_balance_floor: "25000.00",
        },
      },
      evidence: EVIDENCE,
    });
    expect(proposed.channel).toBe("agent");
    const decision = evaluate(
      loadPolicy("./treasury/policy.template.json"),
      toPolicyAction(proposed, "treasury"),
    );
    expect(decision.outcome).not.toBe("reject");
  });

  it("caps payment-intent confidence at low-confidence evidence", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "5000",
        currency: "USD",
      },
      evidence: {
        ...EVIDENCE,
        evidence_score: 1,
        items: [{ kind: "balance", ref: "bal_1", confidence: 0.5 }],
      },
      definition: treasuryDefinition,
      confidence: 0.95,
    });

    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel === "payment_intent") {
      expect(proposed.intent.confidence).toBe(0.5);
      expect(proposed.intent.evidence_score).toBe(1);
      expect(proposed.intent.risk_level).toBe("medium");
    }
  });
});

describe("Payment handler", () => {
  it("threads evidence score and risk into payment intents", () => {
    const proposed = paymentHandler.build({
      action: "propose_payment",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "100",
        currency: "USD",
      },
      evidence: { ...EVIDENCE, evidence_score: 0.74 },
      definition: paymentDefinition,
      confidence: 0.8,
    });

    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel === "payment_intent") {
      expect(proposed.intent.confidence).toBe(0.74);
      expect(proposed.intent.evidence_score).toBe(0.74);
      expect(proposed.intent.risk_level).toBe("medium");
    }
  });
});

describe("Reconciliation handler", () => {
  it("produces a proposal that passes its policy", () => {
    const proposed = reconciliationHandler.build({
      action: "propose_match",
      context: {
        transaction_id: "tx_1",
        amount: "900.00",
        currency: "USD",
        direction: "inflow",
        transaction_date: "2026-07-18T00:00:00.000Z",
        counterparty_id: "cp_1",
        candidates: [
          {
            kind: "invoice",
            id: "inv_1",
            amount: "900.00",
            currency: "USD",
            date: "2026-07-18T00:00:00.000Z",
            counterparty_id: "cp_1",
          },
        ],
      },
      evidence: EVIDENCE,
      definition: reconciliationDefinition,
    });
    const decision = evaluate(
      loadPolicy("./reconciliation/policy.template.json"),
      toPolicyAction(proposed, "reconciliation"),
    );
    expect(decision.outcome).not.toBe("reject");
  });
});

describe("proposeAction", () => {
  it("routes non-financial proposals through IAgentService.propose", async () => {
    const agents = {
      propose: async () => ({
        id: "prop_1",
        proposing_agent_id: "agent_1",
        action: {},
        policy_decision_id: "pd_1",
        status: "pending",
        approvers_signed: [],
        created_at: "2026-05-22T12:00:00Z",
      }),
    } as unknown as IAgentService;
    const paymentIntents = {} as unknown as IPaymentIntentService;
    const result = await proposeAction({ channel: "agent", action: {} }, CTX, "agent_1", {
      agents,
      paymentIntents,
    });
    expect(result.id).toBe("prop_1");
    expect(result.policy_decision_id).toBe("pd_1");
  });

  it("routes financial proposals through IPaymentIntentService.create", async () => {
    const paymentIntents = {
      create: async () => ({ id: "pi_1", status: "proposed", policy_decision_id: "pd_2" }),
    } as unknown as IPaymentIntentService;
    const agents = {} as unknown as IAgentService;
    const result = await proposeAction(
      {
        channel: "payment_intent",
        intent: {
          action_type: "onchain_transfer",
          source_account_id: "acct_1",
          destination_counterparty_id: "cp_2",
          amount: "50000",
          currency: "USD",
        },
      },
      CTX,
      "agent_1",
      { agents, paymentIntents },
    );
    expect(result.id).toBe("pi_1");
    expect(result.status).toBe("proposed");
  });
});
