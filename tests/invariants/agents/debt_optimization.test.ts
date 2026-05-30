/**
 * Adversarial invariants — debt_optimization agent.
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
const EVIDENCE: Evidence[] = [{ kind: "obligation", ref: "obl_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("debt_optimization agent — action injection", () => {
  it("injected action outside debt_optimization's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.debt_optimization!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["recommend_paydown", "create_debt_plan"],
      context: { [REQUESTED_ACTION_KEY]: "max_out_credit_line" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("debt_optimization agent — scope restriction", () => {
  it("debt_optimization capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.debt_optimization!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "pay down debt",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
