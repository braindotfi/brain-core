/**
 * Adversarial invariants — revenue_intel agent.
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
  { kind: "invoice", ref: "inv_1" },
  { kind: "transaction", ref: "txn_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("revenue_intel agent — action injection", () => {
  it("injected action outside revenue_intel's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.revenue_intel!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["create_revenue_summary", "flag_churn_risk", "identify_expansion_opportunity"],
      context: { [REQUESTED_ACTION_KEY]: "issue_refund_batch" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("revenue_intel agent — scope restriction", () => {
  it("revenue_intel capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.revenue_intel!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "analyze revenue",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
