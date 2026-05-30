/**
 * Adversarial invariants — payment agent.
 * Asserts protection properties hold against hostile inputs.
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
  { kind: "counterparty", ref: "cp_1" },
  { kind: "balance", ref: "bal_1" },
  { kind: "payment_destination", ref: "dest_1" },
];
const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("payment agent — action injection", () => {
  it("an injected action not in payment's event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.payment!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["propose_payment", "schedule_payment"],
      context: { [REQUESTED_ACTION_KEY]: "wire_all_funds" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("payment agent — scope restriction", () => {
  it("payment_propose capability not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.payment!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "pay this bill",
    });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("unscoped");
  });
});
