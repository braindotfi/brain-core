/**
 * Adversarial invariants — financial_health agent.
 */

import { describe, expect, it } from "vitest";
import { internalAgentDefinitions } from "@brain/internal-agents";
import { ActionResolver, REQUESTED_ACTION_KEY } from "../../../services/agent-router/src/action-resolver.js";
import { RulesIntentClassifier } from "../../../services/agent-router/src/intent-classifier.js";
import { AgentRouter } from "../../../services/agent-router/src/router.js";
import { StaticEvidenceGatherer } from "../../../services/agent-router/src/evidence-gatherer.js";
import { InMemoryAuditEmitter } from "@brain/shared";
import type { Evidence } from "@brain/internal-agents";

const CTX = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [
  { kind: "balance", ref: "bal_1" },
  { kind: "transaction", ref: "txn_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("financial_health agent — action injection", () => {
  it("injected action outside financial_health's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.financial_health!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["generate_health_score", "recommend_action"],
      context: { [REQUESTED_ACTION_KEY]: "reduce_credit_limit" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("financial_health agent — scope restriction", () => {
  it("financial_health capability not granted → agent not selected for health query", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.financial_health!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "how is my financial health",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
