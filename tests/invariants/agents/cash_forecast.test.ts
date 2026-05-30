/**
 * Adversarial invariants — cash_forecast agent.
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

describe("cash_forecast agent — action injection", () => {
  it("injected action outside cash_forecast action map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.cash_forecast!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["generate_forecast", "recommend_action", "alert_shortfall"],
      context: { [REQUESTED_ACTION_KEY]: "transfer_reserves" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("cash_forecast agent — scope restriction", () => {
  it("cash_forecast capability not granted → agent not selected for runway query", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.cash_forecast!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "what is our runway",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
