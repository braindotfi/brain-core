/**
 * Adversarial invariants — purchase_advisor agent.
 */

import { describe, expect, it } from "vitest";
import { internalAgentDefinitions } from "@brain/internal-agents";
import {
  ActionResolver,
  REQUESTED_ACTION_KEY,
} from "../../../services/agent-router/src/action-resolver.js";
import { RulesIntentClassifier } from "../../../services/agent-router/src/intent-classifier.js";
import { AgentRouter } from "../../../services/agent-router/src/router.js";
import { StaticEvidenceGatherer } from "../../../services/agent-router/src/evidence-gatherer.js";
import { InMemoryAuditEmitter } from "@brain/shared";
import type { Evidence } from "@brain/internal-agents";

const CTX = { tenantId: "tnt_acme", actor: "agent_system" };
const EVIDENCE: Evidence[] = [{ kind: "balance", ref: "bal_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("purchase_advisor agent — action injection", () => {
  it("injected action outside purchase_advisor's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.purchase_advisor!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["approve_recommendation", "recommend_delay", "warn"],
      context: { [REQUESTED_ACTION_KEY]: "complete_purchase_autonomously" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("purchase_advisor agent — scope restriction", () => {
  it("purchase_advisor capability not granted → agent not selected for affordability query", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.purchase_advisor!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "can i afford this",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
