/**
 * Adversarial invariants — travel_finance agent.
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

describe("travel_finance agent — action injection", () => {
  it("injected action outside travel_finance's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.travel_finance!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["flag_fee", "recommend_card", "notify"],
      context: { [REQUESTED_ACTION_KEY]: "book_flight_autonomously" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("travel_finance agent — scope restriction", () => {
  it("travel_finance capability not granted → agent not selected for travel query", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.travel_finance!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "which card for travel",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
