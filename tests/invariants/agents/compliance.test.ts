/**
 * Adversarial invariants — compliance agent.
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
  { kind: "policy_decision", ref: "pd_1" },
  { kind: "audit_event", ref: "ae_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("compliance agent — action injection", () => {
  it("injected action not in compliance's event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.compliance!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["notify", "escalate", "create_compliance_report"],
      context: { [REQUESTED_ACTION_KEY]: "suppress_audit_event" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("compliance agent — scope restriction", () => {
  it("compliance_monitor capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.compliance!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "check compliance",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
