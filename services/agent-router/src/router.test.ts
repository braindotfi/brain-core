import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import { AgentRouter, type AgentRouterDeps } from "./router.js";
import { RulesIntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import type { Evidence } from "@brain/internal-agents";
import type { CandidateSignals } from "./types.js";

const COLLECTIONS: InternalAgentDefinition = {
  agent_key: "collections",
  display_name: "Collections",
  provenance: "internal",
  category: "business",
  capabilities: ["collections_followup"],
  triggers: ["invoice.overdue", "payment.failed", "receivable.aging_threshold_crossed"],
  intent_patterns: ["follow up on overdue invoice", "chase late payment"],
  readable_data: ["ledger:read"],
  risk_level: "medium",
  minimum_confidence: 0.75,
  required_evidence: ["invoice", "counterparty"],
  default_authority: "propose",
  enabled_by_default: true,
};

const TREASURY: InternalAgentDefinition = {
  agent_key: "treasury",
  display_name: "Treasury",
  provenance: "internal",
  category: "business",
  capabilities: ["treasury_sweep"],
  triggers: [
    "cash.balance_high",
    "cash.balance_low",
    "runway.changed",
    "yield_opportunity.detected",
  ],
  intent_patterns: ["sweep idle cash", "move excess balance to yield"],
  readable_data: ["ledger:read"],
  risk_level: "medium",
  minimum_confidence: 0.8,
  required_evidence: ["balance"],
  default_authority: "propose",
  enabled_by_default: true,
};

const FULL_EVIDENCE: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
  { kind: "balance", ref: "bal_1" },
];

const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };

function makeRouter(overrides: Partial<AgentRouterDeps> = {}): {
  router: AgentRouter;
  audit: InMemoryAuditEmitter;
} {
  const audit = new InMemoryAuditEmitter();
  const deps: AgentRouterDeps = {
    catalog: () => [COLLECTIONS, TREASURY],
    classifier: new RulesIntentClassifier(),
    evidence: new StaticEvidenceGatherer(FULL_EVIDENCE),
    getScopedCapabilities: () => new Set(["collections_followup", "treasury_sweep"]),
    audit,
    ...overrides,
  };
  return { router: new AgentRouter(deps), audit };
}

describe("AgentRouter", () => {
  it("selects Collections for invoice.overdue", async () => {
    const { router } = makeRouter();
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    expect(decision.selected_agent_id).toBe("collections");
    expect(decision.policy_status).toBe("routed");
    expect(decision.execution_mode).not.toBeNull();
  });

  it("selects Treasury for cash.balance_high on a business tenant", async () => {
    const { router } = makeRouter();
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "cash.balance_high" });
    expect(decision.selected_agent_id).toBe("treasury");
    expect(decision.policy_status).toBe("routed");
  });

  it("respects tenant scope grants (unscoped capability is not routed)", async () => {
    const { router } = makeRouter({
      getScopedCapabilities: () => new Set(["collections_followup"]), // treasury not scoped
    });
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "cash.balance_high" });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("unscoped");
  });

  it("emits started + selected audit events", async () => {
    const { router, audit } = makeRouter();
    await router.route(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("agent.router.started");
    expect(actions).toContain("agent.router.selected");
    const selected = audit.events.find((e) => e.action === "agent.router.selected");
    expect(selected?.outputs.selected_agent_id).toBe("collections");
  });

  it("returns notify_only when required evidence is missing", async () => {
    const { router } = makeRouter({ evidence: new StaticEvidenceGatherer([]) });
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    expect(decision.selected_agent_id).toBe("collections");
    expect(decision.evidence_score).toBe(0);
    expect(decision.execution_mode).toBe("notify_only");
  });

  it("routes by intent when no event is given", async () => {
    const { router } = makeRouter();
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "please follow up on the overdue invoice",
    });
    expect(decision.selected_agent_id).toBe("collections");
  });

  it("returns no_match when nothing matches the event", async () => {
    const { router, audit } = makeRouter();
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "unknown.event" });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("no_match");
    expect(audit.events.map((e) => e.action)).toContain("agent.router.no_match");
  });

  it("ranks by score and returns the rest as fallbacks", async () => {
    const NOTIFY: InternalAgentDefinition = {
      ...COLLECTIONS,
      agent_key: "notifications",
      capabilities: ["notify"],
      required_evidence: [],
    };
    const signals = (key: string): CandidateSignals =>
      key === "notifications" ? { reputation: 0.2, cost: 0 } : { reputation: 0.9, cost: 0 };
    const { router } = makeRouter({
      catalog: () => [COLLECTIONS, NOTIFY],
      getScopedCapabilities: () => new Set(["collections_followup", "notify"]),
      signals,
    });
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    expect(decision.selected_agent_id).toBe("collections");
    expect(decision.fallback_agent_ids).toEqual(["notifications"]);
  });

  it("skips agents that are not enabled by default", async () => {
    const { router } = makeRouter({
      catalog: () => [{ ...COLLECTIONS, enabled_by_default: false }],
    });
    const decision = await router.route(CTX, { tenant_id: "tnt_acme", event: "invoice.overdue" });
    expect(decision.policy_status).toBe("no_match");
  });
});
