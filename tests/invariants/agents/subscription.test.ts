/**
 * Adversarial invariants — subscription agent.
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
const EVIDENCE: Evidence[] = [{ kind: "transaction", ref: "txn_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("subscription agent — action injection", () => {
  it("injected action outside subscription's action map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.subscription!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["flag_subscription", "recommend_cancel"],
      context: { [REQUESTED_ACTION_KEY]: "mass_cancel_all" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("subscription agent — scope restriction", () => {
  it("subscription_review not granted → agent not selected for duplicate vendor intent", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.subscription!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "cancel duplicate subscription",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
