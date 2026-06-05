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

  it("consults the policy hook even when no tenant is supplied (no bypass)", async () => {
    // Omitting the tenant must NOT skip the allowlist — that would let a caller
    // bypass policy by leaving the tenant off. The hook is invoked with an
    // undefined tenant; here it denies, so resolution fails closed. (The
    // production wiring is what grants the pre-H-23 "no tenant ⇒ allow"
    // allowance — see services/api/src/main.ts — not the resolver.)
    const guarded = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (tenantId) => tenantId !== undefined, // deny when no tenant
    });
    const r = await guarded.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(r.status).toBe("missing_action");
  });

  it("invokes the policy hook with the undefined tenant verbatim", async () => {
    const seen: Array<string | undefined> = [];
    const guarded = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (tenantId) => {
        seen.push(tenantId);
        return true;
      },
    });
    await guarded.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(seen).toEqual([undefined]);
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

  // Codex 2026-06-05 P1: the signed allowlist must gate EVERY resolution
  // source, not just explicit requests. Previously event_map / intent_map /
  // default_action returned an action without consulting isActionAllowed, so a
  // denied action could still be selected by an event mapping, a classifier
  // match, or a declared default -- making PolicyDocument.agent_actions an
  // incomplete authorization boundary.

  it("consults the allowlist on the event-map path and denies a non-allowlisted action", async () => {
    // "escalate" is NOT in the agent's policy allowlist; the event mapping must
    // no longer smuggle it past the signed policy.
    const r = await fromPolicy.resolve({
      definition: def({ event_action_map: { "invoice.overdue": "escalate" } }),
      actions: ["escalate"],
      tenantId: "tnt_test",
      event: "invoice.overdue",
    });
    expect(r.status).toBe("missing_action");
    if (r.status === "missing_action") expect(r.reason).toMatch(/denied by policy/);
  });

  it("resolves an allowlisted action via the event-map path", async () => {
    // The check denies only non-allowlisted actions; an allowed one still flows.
    const r = await fromPolicy.resolve({
      definition: def({ event_action_map: { "doc.ready": "draft" } }),
      actions: ["draft"],
      tenantId: "tnt_test",
      event: "doc.ready",
    });
    expect(r).toEqual({ status: "resolved", action: "draft", source: "event_map" });
  });

  it("consults the allowlist on the intent-map path and denies a non-allowlisted action", async () => {
    const r = await fromPolicy.resolve({
      definition: def({
        intent_action_map: [{ patterns: ["escalate this dispute"], action: "escalate" }],
      }),
      actions: ["escalate"],
      tenantId: "tnt_test",
      intent: "please escalate this dispute now",
    });
    expect(r.status).toBe("missing_action");
    if (r.status === "missing_action") expect(r.reason).toMatch(/denied by policy/);
  });

  it("consults the allowlist on the default-action path and denies a non-allowlisted action", async () => {
    const r = await fromPolicy.resolve({
      definition: def({ default_action: "escalate" }),
      actions: ["escalate"],
      tenantId: "tnt_test",
      event: "unmapped.event",
    });
    expect(r.status).toBe("missing_action");
    if (r.status === "missing_action") expect(r.reason).toMatch(/denied by policy/);
  });

  it("resolves an allowlisted default action", async () => {
    const r = await fromPolicy.resolve({
      definition: def({ default_action: "draft" }),
      actions: ["draft"],
      tenantId: "tnt_test",
      event: "unmapped.event",
    });
    expect(r).toEqual({ status: "resolved", action: "draft", source: "default" });
  });

  it("fires onPolicyDenied with tenant/agent/action/source on a denial (Codex P1 follow-up)", async () => {
    const denied: Array<Record<string, unknown>> = [];
    const audited = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (_t, agent, action) => (agentActions[agent] ?? []).includes(action),
      onPolicyDenied: (info) => {
        denied.push(info);
      },
    });
    // "escalate" is not allowlisted, selected here via the event map.
    const r = await audited.resolve({
      definition: def({ event_action_map: { "invoice.overdue": "escalate" } }),
      actions: ["escalate"],
      tenantId: "tnt_test",
      event: "invoice.overdue",
    });
    expect(r.status).toBe("missing_action");
    expect(denied).toEqual([
      { tenantId: "tnt_test", agentKey: "test_agent", action: "escalate", source: "event_map" },
    ]);
  });

  it("does not fire onPolicyDenied when the candidate is allowed", async () => {
    const denied: unknown[] = [];
    const audited = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (_t, agent, action) => (agentActions[agent] ?? []).includes(action),
      onPolicyDenied: (info) => {
        denied.push(info);
      },
    });
    await audited.resolve({
      definition: def({}),
      actions: ["send"],
      tenantId: "tnt_test",
      context: { [REQUESTED_ACTION_KEY]: "send" },
    });
    expect(denied).toEqual([]);
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
