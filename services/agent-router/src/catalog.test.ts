import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, capabilityHash, type ServiceCallContext } from "@brain/shared";
import { AgentRouter } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import { internalAgentCatalog, internalAgentHandlers, type Evidence } from "@brain/internal-agents";

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };

// Evidence covering every internal agent's required kinds.
const FULL: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
  { kind: "balance", ref: "bal_1" },
  { kind: "transaction", ref: "tx_1" },
];

function routerOverCatalog(): AgentRouter {
  return new AgentRouter({
    catalog: () => internalAgentCatalog,
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer(FULL),
    getScopedCapabilities: () =>
      new Set(["collections_followup", "treasury_sweep", "reconciliation_review"]),
    audit: new InMemoryAuditEmitter(),
  });
}

describe("internal agent catalog", () => {
  it("ships the Phase 1 + Phase 2 internal agents", () => {
    const keys = new Set(internalAgentCatalog.map((d) => d.agent_key));
    for (const key of [
      "collections",
      "treasury",
      "reconciliation",
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

  it("has a handler for every definition", () => {
    for (const def of internalAgentCatalog) {
      expect(internalAgentHandlers[def.agent_key]).toBeDefined();
    }
  });

  it("derives a valid capability hash for every capability", () => {
    for (const def of internalAgentCatalog) {
      for (const cap of def.capabilities) {
        expect(capabilityHash(cap)).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });
});

describe("routing over the real catalog", () => {
  it("routes invoice.overdue to Collections", async () => {
    const decision = await routerOverCatalog().route(CTX, {
      tenant_id: "tnt_acme",
      event: "invoice.overdue",
    });
    expect(decision.selected_agent_id).toBe("collections");
  });

  it("routes cash.balance_high to Treasury", async () => {
    const decision = await routerOverCatalog().route(CTX, {
      tenant_id: "tnt_acme",
      event: "cash.balance_high",
    });
    expect(decision.selected_agent_id).toBe("treasury");
  });

  it("routes transaction.unreconciled to Reconciliation", async () => {
    const decision = await routerOverCatalog().route(CTX, {
      tenant_id: "tnt_acme",
      event: "transaction.unreconciled",
    });
    expect(decision.selected_agent_id).toBe("reconciliation");
  });
});
