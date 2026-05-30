/**
 * Adversarial invariants — fraud_anomaly agent.
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

describe("fraud_anomaly agent — action injection", () => {
  it("injected high-impact action not in event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.fraud_anomaly!;
    // freeze_card is high-impact and intentionally not in event_action_map
    const r = await resolver.resolve({
      definition: def,
      actions: ["flag_transaction", "notify"],
      context: { [REQUESTED_ACTION_KEY]: "freeze_card" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("fraud_anomaly agent — scope restriction", () => {
  it("fraud_anomaly capability not granted → agent not selected for suspicious activity", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.fraud_anomaly!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "consumer",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "flag suspicious activity",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
