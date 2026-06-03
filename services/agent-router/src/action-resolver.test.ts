import { describe, expect, it } from "vitest";
import type { InternalAgentDefinition } from "@brain/schemas";
import { ActionResolver, REQUESTED_ACTION_KEY } from "./action-resolver.js";
import { RulesIntentClassifier } from "./intent-classifier.js";

function def(partial: Partial<InternalAgentDefinition>): InternalAgentDefinition {
  return {
    agent_key: "test_agent",
    provenance: "internal",
    category: "business",
    capabilities: ["test"],
    triggers: [],
    intent_patterns: [],
    readable_data: [],
    risk_level: "low",
    minimum_confidence: 0.5,
    required_evidence: [],
    default_authority: "propose",
    enabled_by_default: true,
    ...partial,
  };
}

const resolver = new ActionResolver({ classifier: new RulesIntentClassifier() });

describe("ActionResolver", () => {
  const actions = ["draft", "send", "escalate"];

  it("resolves an explicit requested action", async () => {
    const r = await resolver.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(r).toEqual({ status: "resolved", action: "send", source: "explicit" });
  });

  it("rejects an explicit action the agent does not offer", async () => {
    const r = await resolver.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "wire_money" },
    });
    expect(r.status).toBe("missing_action");
  });

  it("rejects an explicit action denied by the policy hook", async () => {
    const guarded = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (_tenant, _agent, action) => action !== "escalate",
    });
    const r = await guarded.resolve({
      definition: def({}),
      actions,
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "escalate" },
    });
    expect(r.status).toBe("missing_action");
  });

  it("skips the policy hook when no tenant is supplied (pre-H-23 callers)", async () => {
    const guarded = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: () => false, // would deny everything if consulted
    });
    const r = await guarded.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(r).toEqual({ status: "resolved", action: "send", source: "explicit" });
  });

  it("resolves via event_action_map", async () => {
    const r = await resolver.resolve({
      definition: def({ event_action_map: { "invoice.overdue": "draft" } }),
      actions,
      event: "invoice.overdue",
    });
    expect(r).toEqual({ status: "resolved", action: "draft", source: "event_map" });
  });

  it("explicit takes precedence over event_action_map", async () => {
    const r = await resolver.resolve({
      definition: def({ event_action_map: { "invoice.overdue": "draft" } }),
      actions,
      event: "invoice.overdue",
      context: { [REQUESTED_ACTION_KEY]: "escalate" },
    });
    expect(r).toEqual({ status: "resolved", action: "escalate", source: "explicit" });
  });

  it("skips an event mapping to an action the agent no longer offers", async () => {
    const r = await resolver.resolve({
      definition: def({ event_action_map: { "x.y": "removed_action" }, default_action: "draft" }),
      actions,
      event: "x.y",
    });
    expect(r).toEqual({ status: "resolved", action: "draft", source: "default" });
  });

  it("resolves via intent_action_map using the classifier", async () => {
    const r = await resolver.resolve({
      definition: def({
        intent_action_map: [{ patterns: ["escalate this dispute"], action: "escalate" }],
      }),
      actions,
      intent: "please escalate this dispute now",
    });
    expect(r).toEqual({ status: "resolved", action: "escalate", source: "intent_map" });
  });

  it("resolves via default_action when nothing else matches", async () => {
    const r = await resolver.resolve({
      definition: def({ default_action: "draft" }),
      actions,
      event: "unmapped.event",
    });
    expect(r).toEqual({ status: "resolved", action: "draft", source: "default" });
  });

  it("returns missing_action when no default is declared (money-mover safety)", async () => {
    const r = await resolver.resolve({
      definition: def({ event_action_map: { "cash.high": "sweep" } }),
      actions: ["sweep"],
      event: "unmapped.event",
    });
    expect(r.status).toBe("missing_action");
  });
});

describe("ActionResolver — H-23 signed-policy allowlist", () => {
  // The production wiring passes (agentKey, action) => allowedActionsFor(policy,
  // agentKey).includes(action) as isActionAllowed. This closure mirrors that.
  const agentActions: Record<string, readonly string[]> = { test_agent: ["draft", "send"] };
  const fromPolicy = new ActionResolver({
    classifier: new RulesIntentClassifier(),
    isActionAllowed: (_tenant, agent, action) => (agentActions[agent] ?? []).includes(action),
  });

  it("resolves an explicit action the signed policy lists for the agent", async () => {
    const r = await fromPolicy.resolve({
      definition: def({}),
      actions: ["draft", "send"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(r).toEqual({ status: "resolved", action: "send", source: "explicit" });
  });

  it("denies an explicit action the policy does not list, with a policy reason", async () => {
    const r = await fromPolicy.resolve({
      definition: def({}),
      actions: ["draft", "send", "wire"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "wire" },
    });
    expect(r.status).toBe("missing_action");
    if (r.status === "missing_action") expect(r.reason).toMatch(/denied by policy/);
  });

  it("does NOT consult the allowlist on the event-map fallback path", async () => {
    // "escalate" is NOT in the agent's policy allowlist, yet the event mapping
    // still resolves it — the allowlist gates explicit requests only.
    const r = await fromPolicy.resolve({
      definition: def({ event_action_map: { "invoice.overdue": "escalate" } }),
      actions: ["escalate"],
      tenantId: "tnt_test",
      event: "invoice.overdue",
    });
    expect(r).toEqual({ status: "resolved", action: "escalate", source: "event_map" });
  });

  it("denies every explicit request when the agent's allowlist is empty", async () => {
    const empty = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: () => false,
    });
    const r = await empty.resolve({
      definition: def({}),
      actions: ["draft"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "draft" },
    });
    expect(r.status).toBe("missing_action");
  });

  it("supports an async (policy-loading) allowlist hook", async () => {
    const asyncPolicy = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: async (_tenant, agent, action) =>
        Promise.resolve((agentActions[agent] ?? []).includes(action)),
    });
    const ok = await asyncPolicy.resolve({
      definition: def({}),
      actions: ["draft", "send"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(ok).toEqual({ status: "resolved", action: "send", source: "explicit" });
    const denied = await asyncPolicy.resolve({
      definition: def({}),
      actions: ["draft", "send", "wire"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "wire" },
    });
    expect(denied.status).toBe("missing_action");
  });
});
