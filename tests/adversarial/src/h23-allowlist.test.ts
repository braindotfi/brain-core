/**
 * P1.1 adversarial -- H-23 (Opus 4.8 P2-4 regression lock).
 *
 * Vector: a caller routes through ActionResolver WITHOUT supplying a tenant.
 * Before commit ecedae5 the resolver gated the per-agent action allowlist on
 * both `isActionAllowed !== undefined` AND `tenantId !== undefined`, so
 * omitting the tenant skipped the allowlist check entirely. A caller could
 * trivially bypass the signed-policy per-agent action allowlist
 * (PolicyDocument.agent_actions) by leaving the tenant off the request.
 *
 * ecedae5 dropped the tenantId guard. This adversarial test locks the fix
 * by asserting two properties that, taken together, prove the bypass cannot
 * reappear:
 *
 *   1. With the hook configured and the tenant OMITTED, an `isActionAllowed`
 *      that returns false denies the action. (The resolver must consult the
 *      hook even without a tenant.)
 *   2. The hook receives `undefined` for the tenant verbatim -- the resolver
 *      doesn't synthesize a fake tenant id to keep its types happy. The
 *      wiring's "no tenant => allow" allowance lives in the WIRING (e.g.
 *      services/api/src/main.ts), not in the resolver; a closure that wants
 *      to deny-on-missing-tenant can see and act on that signal.
 *
 * Lives in tests/adversarial so the "attacks fail closed" catalogue carries
 * the regression. The narrower unit tests in
 * services/agent-router/src/action-resolver.test.ts cover the same shape;
 * this file is the higher-altitude, hostile-input framing the adversarial
 * suite uses.
 */

import { describe, expect, it } from "vitest";
import type { InternalAgentDefinition } from "@brain/schemas";
import { ActionResolver, REQUESTED_ACTION_KEY, RulesIntentClassifier } from "@brain/agent-router";

function agentDef(): InternalAgentDefinition {
  return {
    agent_key: "test_agent",
    provenance: "internal",
    category: "business",
    capabilities: ["payments"],
    triggers: [],
    intent_patterns: [],
    readable_data: [],
    risk_level: "low",
    minimum_confidence: 0.5,
    required_evidence: [],
    default_authority: "propose",
    enabled_by_default: true,
  };
}

const offeredActions = ["draft", "send", "wire_money"];

describe("P1.1 adversarial -- H-23 allowlist bypass (Opus P2-4)", () => {
  it("denies an explicit action when the policy hook says false, even with NO tenant", async () => {
    // The attack: leave tenantId off and request a money-touching action.
    // Pre-ecedae5 this would skip the hook and resolve as "explicit". Post-fix,
    // the hook is invoked with tenantId=undefined and its deny verdict stands.
    const resolver = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: async () => false, // hostile environment: hook always denies
    });
    const result = await resolver.resolve({
      definition: agentDef(),
      actions: offeredActions,
      context: { [REQUESTED_ACTION_KEY]: "wire_money" },
      // tenantId DELIBERATELY omitted -- this is the attack
    });
    expect(result.status).toBe("missing_action");
  });

  it("invokes the policy hook with the undefined tenant verbatim (no synthetic id)", async () => {
    // The resolver must not paper over the missing tenant by passing a
    // synthetic id ("" or "tnt_unknown"); a downstream wiring closure has to
    // be able to see the absence and decide. This pins the call-shape.
    const seen: Array<string | undefined> = [];
    const resolver = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (tenantId, _agent, _action) => {
        seen.push(tenantId);
        return true; // allow, so the resolver continues to "resolved"
      },
    });
    await resolver.resolve({
      definition: agentDef(),
      actions: offeredActions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
      // tenantId omitted
    });
    expect(seen).toEqual([undefined]);
  });

  it("threads the tenant verbatim when one IS supplied (no swap, no normalization)", async () => {
    // Sanity: when the caller DOES supply a tenant, the hook sees exactly
    // that tenant id -- not the agent's owner_tenant, not a normalized value.
    const seen: Array<string | undefined> = [];
    const resolver = new ActionResolver({
      classifier: new RulesIntentClassifier(),
      isActionAllowed: (tenantId, _agent, _action) => {
        seen.push(tenantId);
        return true;
      },
    });
    await resolver.resolve({
      definition: agentDef(),
      actions: offeredActions,
      context: { [REQUESTED_ACTION_KEY]: "send" },
      tenantId: "tnt_caller_xyz",
    });
    expect(seen).toEqual(["tnt_caller_xyz"]);
  });
});
