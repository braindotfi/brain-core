import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  type IAgentService,
  type IPaymentIntentService,
  type ServiceCallContext,
} from "@brain/shared";
import {
  internalAgentDefinitions,
  internalAgentHandlers,
  type Evidence,
  type InternalAgentHandler,
} from "@brain/internal-agents";
import { AgentRouter } from "./router.js";
import { ActionResolver } from "./action-resolver.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import {
  AgentRunService,
  type AgentRunStore,
  type RecordRoutingDecisionInput,
  type RecordRunInput,
} from "./agent-run-service.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
  { kind: "payment_destination", ref: "pd_1" },
  { kind: "balance", ref: "bal_1" },
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

function makeStore(): {
  store: AgentRunStore;
  runs: RecordRunInput[];
  decisions: RecordRoutingDecisionInput[];
} {
  const runs: RecordRunInput[] = [];
  const decisions: RecordRoutingDecisionInput[] = [];
  const store: AgentRunStore = {
    recordRoutingDecision: async (_ctx, input) => {
      decisions.push(input);
      return { id: `agrd_${decisions.length}` };
    },
    recordRun: async (_ctx, input) => {
      runs.push(input);
      return { id: `agnr_${runs.length}` };
    },
  };
  return { store, runs, decisions };
}

function makeService(
  store: AgentRunStore,
  scoped: string[],
  onPropose: () => void,
  onCreatePI: () => void,
  opts: {
    evidence?: Evidence[];
    routerEvidence?: Evidence[];
    handlers?: Record<string, InternalAgentHandler>;
    isShadowed?: (agentId: string) => boolean;
  } = {},
): AgentRunService {
  const agents = {
    propose: async () => {
      onPropose();
      return {
        id: "prop_1",
        proposing_agent_id: "x",
        action: {},
        policy_decision_id: "pd_1",
        status: "pending",
        approvers_signed: [],
        created_at: "2026-05-22T12:00:00Z",
      };
    },
  } as unknown as IAgentService;
  const paymentIntents = {
    create: async () => {
      onCreatePI();
      throw new Error("payment intent must not be created in shadow mode");
    },
  } as unknown as IPaymentIntentService;
  return new AgentRunService({
    router: new AgentRouter({
      catalog: () => Object.values(internalAgentDefinitions),
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(opts.routerEvidence ?? opts.evidence ?? EVIDENCE),
      getScopedCapabilities: () => new Set(scoped),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    }),
    actionResolver: new ActionResolver({ classifier: new RulesIntentClassifier() }),
    handlers: opts.handlers ?? internalAgentHandlers,
    definitions: internalAgentDefinitions,
    evidence: new StaticEvidenceGatherer(opts.evidence ?? EVIDENCE),
    propose: { agents, paymentIntents },
    store,
    getTenantCategory: () => "business",
    isShadowed: opts.isShadowed ?? (() => true),
  });
}

describe("AgentRunService (shadow mode)", () => {
  it("terminates a financial proposal as shadow_completed without creating a PaymentIntent", async () => {
    const { store, runs } = makeStore();
    let proposed = 0;
    let createdPI = 0;
    const svc = makeService(
      store,
      ["payment_propose"],
      () => (proposed += 1),
      () => (createdPI += 1),
    );
    const result = await svc.run(CTX, {
      tenant_id: "tnt_acme",
      event: "bill.due_soon",
      context: PAYMENT_CONTEXT,
    });
    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("shadow_completed");
    expect(result.shadow_mode).toBe(true);
    expect(createdPI).toBe(0); // no money moved
    expect(runs.at(-1)?.status).toBe("shadow_completed");
  });

  it("proposes a non-financial action through the agent channel", async () => {
    const { store, runs } = makeStore();
    let proposed = 0;
    const svc = makeService(
      store,
      ["collections_followup"],
      () => (proposed += 1),
      () => {},
      { handlers: { ...internalAgentHandlers, collections: COMPLETE_COLLECTIONS_HANDLER } },
    );
    const result = await svc.run(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    expect(result.selected_agent_id).toBe("collections");
    expect(result.action).toBe("draft_followup");
    expect(result.status).toBe("proposal_created");
    expect(proposed).toBe(1);
    expect(runs.at(-1)?.proposalId).toBe("prop_1");
  });

  it("records a no_match routing decision and no run", async () => {
    const { store, runs, decisions } = makeStore();
    const svc = makeService(
      store,
      ["payment_propose"],
      () => {},
      () => {},
    );
    const result = await svc.run(CTX, { tenant_id: "tnt_acme", event: "nope.unknown" });
    expect(result.selected_agent_id).toBeNull();
    expect(result.status).toBe("no_match");
    expect(result.run_id).toBeNull();
    expect(decisions.at(-1)?.policyStatus).toBe("no_match");
    expect(runs).toHaveLength(0);
  });

  it("persists missing_action when no action resolves (money-mover via intent)", async () => {
    const { store, runs } = makeStore();
    const svc = makeService(
      store,
      ["treasury_sweep"],
      () => {},
      () => {},
    );
    // Treasury matches the intent but declares no intent_action_map / default_action.
    const result = await svc.run(CTX, { tenant_id: "tnt_acme", intent: "sweep idle cash" });
    expect(result.selected_agent_id).toBe("treasury");
    expect(result.status).toBe("missing_action");
    expect(runs.at(-1)?.status).toBe("missing_action");
  });

  it("records missing_evidence before notify_only when required evidence is missing", async () => {
    const { store, runs } = makeStore();
    let createdPI = 0;
    const svc = makeService(
      store,
      ["payment_propose"],
      () => {},
      () => {
        createdPI += 1;
      },
      {
        isShadowed: () => false,
        evidence: [
          { kind: "invoice", ref: "inv_1" },
          { kind: "counterparty", ref: "cp_1" },
          { kind: "balance", ref: "bal_1" },
        ],
      },
    );

    const result = await svc.run(CTX, { tenant_id: "tnt_acme", event: "bill.due_soon" });

    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("missing_evidence");
    expect(createdPI).toBe(0);
    expect(runs.at(-1)?.status).toBe("missing_evidence");
    expect(runs.at(-1)?.failureReason).toBe("critical_missing_evidence");
  });

  it("records missing_evidence when the gathered bundle has critical missing evidence", async () => {
    const { store, runs } = makeStore();
    let createdPI = 0;
    const svc = makeService(
      store,
      ["payment_propose"],
      () => {},
      () => {
        createdPI += 1;
      },
      {
        isShadowed: () => false,
        routerEvidence: EVIDENCE,
        evidence: [
          { kind: "invoice", ref: "inv_1" },
          { kind: "counterparty", ref: "cp_1" },
        ],
      },
    );

    const result = await svc.run(CTX, {
      tenant_id: "tnt_acme",
      event: "bill.due_soon",
      context: PAYMENT_CONTEXT,
    });

    expect(result.selected_agent_id).toBe("payment");
    expect(result.status).toBe("missing_evidence");
    expect(createdPI).toBe(0);
    expect(runs.at(-1)?.status).toBe("missing_evidence");
    expect(runs.at(-1)?.failureReason).toBe("critical_missing_evidence");
    expect(runs.at(-1)?.reason).toMatchObject({
      critical_missing: true,
      missing_required_evidence: ["payment_destination"],
    });
  });

  it("records failed when an agent-channel payload omits required fields", async () => {
    const { store, runs } = makeStore();
    let proposed = 0;
    const svc = makeService(
      store,
      ["collections_followup"],
      () => {
        proposed += 1;
      },
      () => {},
    );

    const result = await svc.run(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });

    expect(result.selected_agent_id).toBe("collections");
    expect(result.status).toBe("failed");
    expect(proposed).toBe(0);
    expect(runs.at(-1)?.status).toBe("failed");
    expect(runs.at(-1)?.failureReason).toBe("payload_invalid");
    expect(runs.at(-1)?.reason).toMatchObject({
      payload_validation: {
        status: "invalid",
        missing_fields: expect.arrayContaining(["invoice_id is required"]),
      },
    });
  });
});
