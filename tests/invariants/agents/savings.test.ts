/**
 * Adversarial invariants — savings agent.
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
const EVIDENCE: Evidence[] = [{ kind: "balance", ref: "bal_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("savings agent — action injection", () => {
  it("injected action outside savings event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.savings!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["recommend_savings_transfer", "update_goal_progress"],
      context: { [REQUESTED_ACTION_KEY]: "withdraw_all_savings" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("savings agent — scope restriction", () => {
  it("savings_sweep capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.savings!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "move money to savings",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
