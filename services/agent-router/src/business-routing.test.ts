import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext, type TenantCategory } from "@brain/shared";
import { internalAgentCatalog } from "@brain/internal-agents";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };

// All capabilities the catalog declares are treated as scoped for this tenant.
const allCapabilities = new Set(internalAgentCatalog.flatMap((d) => d.capabilities));

function router(category: TenantCategory): AgentRouter {
  return new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer(),
    getScopedCapabilities: () => allCapabilities,
    getTenantCategory: () => category,
    audit: new InMemoryAuditEmitter(),
  });
}

// One [agent_key, agent_category, trigger] triple per declared trigger across
// the whole catalog. Each agent is routed in its own category context, so
// shared triggers (e.g. cash.balance_high) resolve to the aligned agent.
const TRIPLES: ReadonlyArray<readonly [string, TenantCategory, string]> =
  internalAgentCatalog.flatMap((d) => {
    // Agnostic agents are the sole candidate for their (unique) triggers, so
    // any tenant category routes to them; pick business arbitrarily.
    const category: TenantCategory = d.category === "consumer" ? "consumer" : "business";
    return d.triggers.map((t) => [d.agent_key, category, t] as const);
  });

describe("router selects each agent for its declared triggers (category-aware)", () => {
  it.each(TRIPLES)(
    "routes %s (%s tenant) trigger '%s' to its agent",
    async (agentKey, category, trigger) => {
      const decision = await router(category).route(CTX, { tenant_id: "tnt_acme", event: trigger });
      expect(decision.selected_agent_id).toBe(agentKey);
    },
  );

  it("covers all seven Phase 2 business agents and nine Phase 3 consumer agents", () => {
    const keys = new Set(internalAgentCatalog.map((d) => d.agent_key));
    for (const key of [
      "payment",
      "subscription",
      "vendor_risk",
      "cash_forecast",
      "dispute",
      "compliance",
      "revenue_intel",
      "personal_budget",
      "bill_management",
      "savings",
      "debt_optimization",
      "fraud_anomaly",
      "tax_prep",
      "travel_finance",
      "financial_health",
      "purchase_advisor",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});
