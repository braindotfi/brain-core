/**
 * Adversarial invariants — dispute agent.
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
  { kind: "dispute", ref: "disp_1" },
  { kind: "transaction", ref: "txn_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("dispute agent — action injection", () => {
  it("injected action not in dispute's event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.dispute!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["gather_evidence", "draft_response", "create_dispute_packet"],
      context: { [REQUESTED_ACTION_KEY]: "accept_chargeback_loss" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("dispute agent — scope restriction", () => {
  it("dispute_evidence capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.dispute!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "respond to a chargeback",
    });
    expect(decision.selected_agent_id).toBeNull();
  });
});
