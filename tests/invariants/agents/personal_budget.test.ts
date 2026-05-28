/**
 * Adversarial invariants — personal_budget agent.
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
const EVIDENCE: Evidence[] = [{ kind: "transaction", ref: "txn_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("personal_budget agent — action injection", () => {
  it("injected action outside personal_budget's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.personal_budget!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["categorize_spending", "recommend_budget_adjustment", "notify"],
      context: { [REQUESTED_ACTION_KEY]: "delete_spending_history" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("personal_budget agent — scope restriction", () => {
  it("personal_budget capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.personal_budget!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "am i over budget",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
