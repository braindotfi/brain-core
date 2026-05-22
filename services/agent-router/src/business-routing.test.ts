import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import { internalAgentCatalog } from "@brain/internal-agents";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };

// All capabilities the catalog declares are treated as scoped for this tenant.
const allCapabilities = new Set(internalAgentCatalog.flatMap((d) => d.capabilities));

function router(): AgentRouter {
  return new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer(),
    getScopedCapabilities: () => allCapabilities,
    audit: new InMemoryAuditEmitter(),
  });
}

// One [agent_key, trigger] pair per declared trigger across the whole catalog.
const PAIRS: ReadonlyArray<readonly [string, string]> = internalAgentCatalog.flatMap((d) =>
  d.triggers.map((t) => [d.agent_key, t] as const),
);

describe("router selects each agent for its declared triggers", () => {
  it.each(PAIRS)("routes %s trigger '%s' to its agent", async (agentKey, trigger) => {
    const decision = await router().route(CTX, { tenant_id: "tnt_acme", event: trigger });
    expect(decision.selected_agent_id).toBe(agentKey);
  });

  it("covers all seven Phase 2 business agents", () => {
    const keys = new Set(internalAgentCatalog.map((d) => d.agent_key));
    for (const key of [
      "payment",
      "subscription",
      "vendor_risk",
      "cash_forecast",
      "dispute",
      "compliance",
      "revenue_intel",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});
