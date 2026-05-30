/**
 * Adversarial invariants — bill_management agent.
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
const EVIDENCE: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "payment_destination", ref: "dest_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("bill_management agent — action injection", () => {
  it("injected action outside bill_management's map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.bill_management!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["remind", "alert_late_fee_risk"],
      context: { [REQUESTED_ACTION_KEY]: "auto_pay_all_bills" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("bill_management agent — scope restriction", () => {
  it("bill_management capability not granted → agent not selected for overdue bill", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.bill_management!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "pay my bill",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
