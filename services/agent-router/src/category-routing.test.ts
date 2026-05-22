import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext, type TenantCategory } from "@brain/shared";
import { internalAgentCatalog } from "@brain/internal-agents";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import type { RoutingInput } from "./types.js";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };
const allCapabilities = new Set(internalAgentCatalog.flatMap((d) => d.capabilities));

function routeAs(category: TenantCategory | undefined, input: Omit<RoutingInput, "tenant_id">) {
  const router = new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer(),
    getScopedCapabilities: () => allCapabilities,
    ...(category !== undefined ? { getTenantCategory: () => category } : {}),
    audit: new InMemoryAuditEmitter(),
  });
  return router.route(CTX, { tenant_id: "tnt_acme", ...input });
}

describe("category-aware routing", () => {
  it("routes cash.balance_high to Treasury on a business tenant", async () => {
    const d = await routeAs("business", { event: "cash.balance_high" });
    expect(d.selected_agent_id).toBe("treasury");
  });

  it("routes cash.balance_high to Savings on a consumer tenant", async () => {
    const d = await routeAs("consumer", { event: "cash.balance_high" });
    expect(d.selected_agent_id).toBe("savings");
  });

  it("routes bill.due_soon to Payment on business, Bill Management on consumer", async () => {
    expect((await routeAs("business", { event: "bill.due_soon" })).selected_agent_id).toBe(
      "payment",
    );
    expect((await routeAs("consumer", { event: "bill.due_soon" })).selected_agent_id).toBe(
      "bill_management",
    );
  });

  it("routes Fraud & Anomaly (agnostic) correctly for both categories", async () => {
    for (const category of ["business", "consumer"] as const) {
      const d = await routeAs(category, { event: "transaction.unusual" });
      expect(d.selected_agent_id).toBe("fraud_anomaly");
    }
  });

  it("invokes Purchase Advisor by intent ('can I afford this?') with no event", async () => {
    const d = await routeAs("consumer", { intent: "can I afford this?" });
    expect(d.selected_agent_id).toBe("purchase_advisor");
  });

  it("lets explicit intent override the category preference (downgrade, not reject)", async () => {
    // Business tenant, but an explicit savings intent and no competing business
    // agent: the consumer Savings agent is still selected (mismatch is a
    // downgrade, never a hard reject).
    const d = await routeAs("business", { intent: "help me save" });
    expect(d.selected_agent_id).toBe("savings");
  });

  it("is category-blind when no tenant category is provided (phase 1/2 behavior)", async () => {
    // cash.balance_high with all caps scoped and no category: a candidate is
    // still chosen (no hard failure); business routing from earlier phases works
    // via scope grants in their own tests.
    const d = await routeAs(undefined, { event: "invoice.overdue" });
    expect(d.selected_agent_id).toBe("collections");
  });
});
