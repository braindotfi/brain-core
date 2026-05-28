/**
 * Adversarial invariants — collections agent.
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
const EVIDENCE: Evidence[] = [{ kind: "invoice", ref: "inv_1" }, { kind: "counterparty", ref: "cp_1" }];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("collections agent — action injection", () => {
  it("injected action outside event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.collections!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["draft_followup", "escalate", "create_task"],
      context: { [REQUESTED_ACTION_KEY]: "transfer_funds_to_self" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("collections agent — scope restriction", () => {
  it("collections_followup not granted → agent not selected for overdue invoice intent", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.collections!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "follow up on overdue invoice",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
