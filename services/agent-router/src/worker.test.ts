import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  type IAgentService,
  type IPaymentIntentService,
  type ServiceCallContext,
} from "@brain/shared";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import { internalAgentCatalog, internalAgentHandlers } from "./agents/registry.js";
import { routeAndPropose, type RouteAndProposeDeps } from "./worker.js";
import type { Evidence } from "./types.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
  { kind: "balance", ref: "bal_1" },
  { kind: "transaction", ref: "tx_1" },
];

let proposeCalls = 0;
function makeDeps(): RouteAndProposeDeps {
  proposeCalls = 0;
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
  const paymentIntents = {} as unknown as IPaymentIntentService;
  return {
    router: new AgentRouter({
      catalog: () => internalAgentCatalog,
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () =>
        new Set(["collections_followup", "treasury_sweep", "reconciliation_review"]),
      audit: new InMemoryAuditEmitter(),
    }),
    handlers: internalAgentHandlers,
    evidence: new StaticEvidenceGatherer(EVIDENCE),
    propose: { agents, paymentIntents },
  };
}

describe("routeAndPropose", () => {
  it("routes invoice.overdue to collections and proposes through the existing path", async () => {
    const deps = makeDeps();
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
});
