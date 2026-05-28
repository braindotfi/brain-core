/**
 * Adversarial invariants — tax_prep agent.
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

describe("tax_prep agent — action injection", () => {
  it("injected action outside tax_prep's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.tax_prep!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["tag_tax_item", "create_tax_summary"],
      context: { [REQUESTED_ACTION_KEY]: "file_taxes_autonomously" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("tax_prep agent — scope restriction", () => {
  it("tax_prep capability not granted → agent not selected for tax query", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.tax_prep!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "prepare my taxes",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
