/**
 * Adversarial invariants — vendor_risk agent.
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
  { kind: "vendor", ref: "vendor_1" },
  { kind: "payment_destination", ref: "dest_1" },
  { kind: "counterparty_history", ref: "hist_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("vendor_risk agent — action injection", () => {
  it("injected action outside vendor_risk's action map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.vendor_risk!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["flag_vendor_risk", "require_approval"],
      context: { [REQUESTED_ACTION_KEY]: "auto_approve_vendor" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("vendor_risk agent — scope restriction", () => {
  it("vendor_risk capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.vendor_risk!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "check vendor risk",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
