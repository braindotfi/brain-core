/**
 * Adversarial invariants — treasury agent.
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

describe("treasury agent — action injection", () => {
  it("an action not in treasury's event_action_map resolves to missing_action", async () => {
    const def = internalAgentDefinitions.treasury!;
    const r = await resolver.resolve({
      definition: def,
      actions: ["recommend_cash_sweep", "alert_low_balance", "create_liquidity_plan"],
      context: { [REQUESTED_ACTION_KEY]: "drain_account" },
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("treasury agent — scope restriction", () => {
  it("treasury_sweep not granted → agent not selected", async () => {
    const router = new AgentRouter({
      catalog: () => [internalAgentDefinitions.treasury!],
      classifier: new RulesIntentClassifier(),
      evidence: new StaticEvidenceGatherer(EVIDENCE),
      getScopedCapabilities: () => new Set<string>(),
      getTenantCategory: () => "business",
      audit: new InMemoryAuditEmitter(),
    });
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "sweep idle cash",
    });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("unscoped");
  });
});
