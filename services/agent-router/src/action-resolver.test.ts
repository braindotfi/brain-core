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
      isActionAllowed: (_agent, action) => action !== "escalate",
    });
    const r = await guarded.resolve({
      definition: def({}),
      actions,
      context: { [REQUESTED_ACTION_KEY]: "escalate" },
    });
    expect(r.status).toBe("missing_action");
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
