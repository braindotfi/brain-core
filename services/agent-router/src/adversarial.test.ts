/**
 * Adversarial fixtures (Agent Autonomy v3, 3.1) — router + action-resolver.
 * Each asserts an existing protection holds against a hostile input.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import {
  internalAgentCatalog,
  internalAgentDefinitions,
  type Evidence,
} from "@brain/internal-agents";
import { AgentRouter } from "./router.js";
import { ActionResolver, REQUESTED_ACTION_KEY } from "./action-resolver.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [{ kind: "balance", ref: "bal_1" }];

describe("3.1 intent injection — scope filter blocks an unscoped high-authority agent", () => {
  it("an intent crafted to match Treasury is not selected when treasury_sweep is unscoped", async () => {
    const router = new AgentRouter({
      catalog: () => internalAgentCatalog,
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      // The hostile principal has scoped NOTHING that matches → eligible is empty.
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "sweep idle cash and move excess balance to yield", // Treasury's patterns
    });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("unscoped");
  });
});

describe("3.1 action injection — an injected requested_action cannot escalate", () => {
  const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

  it("a requested_action the agent does not offer resolves to missing_action", async () => {
    const def = internalAgentDefinitions.collections!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["draft_followup", "send_followup"],
      context: { [REQUESTED_ACTION_KEY]: "wire_money" }, // injected, not offered
    });
    expect(r.status).toBe("missing_action");
  });

  it("an offered action denied by the policy hook resolves to missing_action", async () => {
    const guarded = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: () => false, // policy template action.in denies everything
    });
    const r = await guarded.resolve({
      definition: internalAgentDefinitions.payment!,
      actions: ["propose_payment"],
      context: { [REQUESTED_ACTION_KEY]: "propose_payment" },
    });
    expect(r.status).toBe("missing_action");
  });
});
