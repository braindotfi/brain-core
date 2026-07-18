import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  type IAgentService,
  type IPaymentIntentService,
  type ServiceCallContext,
} from "@brain/shared";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer, type EvidenceGatherer } from "./evidence-gatherer.js";
import { ActionResolver } from "./action-resolver.js";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
  type Evidence,
  type InternalAgentHandler,
} from "@brain/internal-agents";
import { routeAndPropose, type RouteAndProposeDeps } from "./worker.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
  { kind: "payment_destination", ref: "pd_1" },
  { kind: "balance", ref: "bal_1" },
  { kind: "transaction", ref: "tx_1" },
];
const PAYMENT_CONTEXT = {
  source_account_id: "acct_source",
  destination_counterparty_id: "cp_vendor",
  amount: "125.00",
  currency: "USD",
};
const COMPLETE_COLLECTIONS_HANDLER: InternalAgentHandler = {
  agent_key: "collections",
  actions: ["draft_followup", "send_followup", "create_task", "escalate", "propose_payment_plan"],
  build: (input) => ({
    channel: "agent",
    action: {
      type: input.action,
      invoice_id: "inv_1",
      counterparty_id: "cp_1",
      amount_due: "125.00",
      days_overdue: 7,
      recommended_tone: "firm",
      draft_message: "Please remit payment for invoice inv_1.",
      next_escalation_date: "2026-05-29",
      evidence_refs: input.evidence.items.map((i) => i.ref),
    },
  }),
};
const COMPLETE_RECONCILIATION_HANDLER: InternalAgentHandler = {
  agent_key: "reconciliation",
  actions: ["propose_match", "flag_discrepancy", "create_task"],
  build: (input) => ({
    channel: "agent",
    action: {
      type: input.action,
      match_type: "invoice_transaction",
      left_entity_id: "inv_1",
      right_entity_id: "tx_1",
      confidence_score: 0.91,
      explanation: "Invoice and transaction amounts match.",
      evidence_refs: input.evidence.items.map((i) => i.ref),
    },
  }),
};

let proposeCalls = 0;
let createPICalls = 0;
function makeDeps(
  opts: {
    scoped?: string[];
    isShadowed?: (agentId: string) => boolean;
    evidence?: EvidenceGatherer;
    routerEvidence?: EvidenceGatherer;
    handlers?: RouteAndProposeDeps["handlers"];
    paymentIntents?: IPaymentIntentService;
  } = {},
): RouteAndProposeDeps {
  proposeCalls = 0;
  createPICalls = 0;
  const agents = {
    propose: async () => {
      proposeCalls += 1;
      return {
        id: "prop_1",
        proposing_agent_id: "collections",
        action: {},
        policy_decision_id: "pd_1",
        status: "pending",
        approvers_signed: [],
        created_at: "2026-05-22T12:00:00Z",
      };
    },
  } as unknown as IAgentService;
  // A shadowed financial proposal must never reach create() — it throws if it does.
  const paymentIntents =
    opts.paymentIntents ??
    ({
      create: async () => {
        createPICalls += 1;
        throw new Error("payment intent must not be created in shadow mode");
      },
    } as unknown as IPaymentIntentService);
  return {
    router: new AgentRouter({
      catalog: () => internalAgentCatalog,
      classifier: new RulesIntentClassifier(),
      evidence: opts.routerEvidence ?? opts.evidence ?? new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () =>
        new Set(opts.scoped ?? ["collections_followup", "treasury_sweep", "reconciliation_review"]),
      audit: new InMemoryAuditEmitter(),
    }),
    handlers: opts.handlers ?? internalAgentHandlers,
    definitions: internalAgentDefinitions,
    actionResolver: new ActionResolver({ classifier: new RulesIntentClassifier() }),
    evidence: opts.evidence ?? new StaticEvidenceGatherer(EVIDENCE),
    propose: { agents, paymentIntents },
    // Default: not shadowed (existing non-financial tests propose through).
    isShadowed: opts.isShadowed ?? (() => false),
  };
}

describe("routeAndPropose", () => {
  it("routes invoice.overdue to collections and proposes through the existing path", async () => {
    const deps = makeDeps({
      handlers: { ...internalAgentHandlers, collections: COMPLETE_COLLECTIONS_HANDLER },
    });
    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "invoice.overdue" },
      deps,
    );
    expect(result.selected_agent_id).toBe("collections");
    expect(result.proposed?.id).toBe("prop_1");
    expect(result.proposed?.policy_decision_id).toBe("pd_1");
    expect(proposeCalls).toBe(1);
  });

  it("does not propose when nothing routes", async () => {
    const deps = makeDeps();
    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "unknown.event" },
      deps,
    );
    expect(result.selected_agent_id).toBeNull();
    expect(result.proposed).toBeUndefined();
    expect(proposeCalls).toBe(0);
  });

  it("delegates reconciliation to its IAgentService override (the Python agent client)", async () => {
    const deps = makeDeps({
      handlers: { ...internalAgentHandlers, reconciliation: COMPLETE_RECONCILIATION_HANDLER },
    });
    let delegated = 0;
    const reconClient = {
      propose: async () => {
        delegated += 1;
        return {
          id: "prop_recon",
          proposing_agent_id: "reconciliation",
          action: {},
          policy_decision_id: "pd_recon",
          status: "pending",
          approvers_signed: [],
          created_at: "2026-05-22T12:00:00Z",
        };
      },
    } as unknown as IAgentService;
    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "transaction.unreconciled" },
      { ...deps, agentOverrides: { reconciliation: reconClient } },
    );
    expect(result.selected_agent_id).toBe("reconciliation");
    expect(result.proposed?.id).toBe("prop_recon");
    expect(delegated).toBe(1);
    // The default agents.propose must NOT have been used for reconciliation.
    expect(proposeCalls).toBe(0);
  });

  it("does not propose when the gathered bundle has critical missing evidence", async () => {
    let created = 0;
    const deps = makeDeps({
      scoped: ["payment_propose"],
      isShadowed: () => false,
      routerEvidence: new StaticEvidenceGatherer(EVIDENCE),
      evidence: new StaticEvidenceGatherer([
        { kind: "invoice", ref: "inv_1" },
        { kind: "counterparty", ref: "cp_1" },
      ]),
      paymentIntents: {
        create: async () => {
          created += 1;
          return { id: "pi_1", status: "proposed", policy_decision_id: null };
        },
      } as unknown as IPaymentIntentService,
    });

    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "bill.due_soon", context: PAYMENT_CONTEXT },
      deps,
    );

    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("missing_evidence");
    expect(result.reason).toBe("critical_missing_evidence:payment_destination");
    expect(created).toBe(0);
    expect(proposeCalls).toBe(0);
  });

  it("fails closed when an agent-channel payload omits required fields", async () => {
    const deps = makeDeps();
    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "invoice.overdue" },
      deps,
    );

    expect(result.selected_agent_id).toBe("collections");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("payload_invalid:");
    expect(result.reason).toContain("invoice_id is required");
    expect(result.proposed).toBeUndefined();
    expect(proposeCalls).toBe(0);
  });

  it("terminates a shadowed agent's financial proposal as shadow_completed (no PaymentIntent created)", async () => {
    // The /agents/events path must enforce the same LIVE_AGENTS shadow gate as
    // /agents/run: route a financial event to a shadowed agent and confirm no
    // PaymentIntent is created (the bug this closes let a shadowed agent create
    // a real proposal row via the BullMQ path).
    const deps = makeDeps({ scoped: ["payment_propose"], isShadowed: () => true });
    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "bill.due_soon", context: PAYMENT_CONTEXT },
      deps,
    );
    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("shadow_completed");
    expect(result.reason).toBe("agent_shadowed");
    expect(result.proposed).toBeUndefined();
    expect(createPICalls).toBe(0); // no money-moving proposal created
    expect(proposeCalls).toBe(0);
  });

  it("creates a financial proposal when the agent is NOT shadowed and execution mode permits it", async () => {
    // Same financial route, but live → the proposal flows through to create().
    // create() throws here by design, proving the gate let it through (we don't
    // assert success, only that the shadow gate did not short-circuit).
    const deps = makeDeps({
      scoped: ["payment_propose"],
      isShadowed: () => false,
    });
    await expect(
      routeAndPropose(
        CTX,
        { tenant_id: "tnt_acme", event: "bill.due_soon", context: PAYMENT_CONTEXT },
        deps,
      ),
    ).rejects.toThrow(/payment intent must not be created/);
    expect(createPICalls).toBe(1); // the gate let the financial proposal through
  });

  it("does not propose when required evidence makes the route notify_only", async () => {
    let created = 0;
    const deps = makeDeps({
      scoped: ["payment_propose"],
      isShadowed: () => false,
      evidence: new StaticEvidenceGatherer([
        { kind: "invoice", ref: "inv_1" },
        { kind: "counterparty", ref: "cp_1" },
      ]),
      paymentIntents: {
        create: async () => {
          created += 1;
          return { id: "pi_1", status: "proposed", policy_decision_id: null };
        },
      } as unknown as IPaymentIntentService,
    });

    const result = await routeAndPropose(
      CTX,
      { tenant_id: "tnt_acme", event: "bill.due_soon" },
      deps,
    );

    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("notify_only");
    expect(result.reason).toBe("execution_mode_notify_only");
    expect(created).toBe(0);
  });
});
