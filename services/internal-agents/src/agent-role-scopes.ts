/**
 * Scope set per agent role (SIWX + registration single source).
 *
 * An agent registers with a role; SIWX issues a JWT carrying these scopes,
 * and the `agents.scope_hash` column must equal
 * `computeAgentScopeHash(scopesForAgentRole(role))` (or, once registered
 * on-chain, the on-chain attestation) for that role. Lives here rather than
 * in services/api so services/execution (agent registration) can reuse the
 * same mapping without a cross-service import cycle back to @brain/api.
 */

import type { Scope } from "@brain/shared";
import { internalAgentDefinitions } from "./registry.js";

export function scopesForAgentRole(role: string): Scope[] {
  switch (role) {
    case "dispute":
    case "fraud_anomaly":
    case "vendor_risk":
      return [...catalogReadableScopesForRole(role), "execution:propose"];
    case "reconciliation":
      return ["ledger:read", "wiki:read", "raw:write", "execution:propose"];
    case "payment":
      // Canonical set shared with the demo seed + on-chain registration tooling
      // so the JWT scopes and the on-chain scope_hash never diverge.
      return ["ledger:read", "wiki:read", "payment_intent:propose", "execution:propose"];
    case "anomaly":
      return ["ledger:read", "wiki:read"];
    case "partner":
      // Default partner role (batch 10 H-3): READ + PROPOSE + APPROVE only.
      // The role was previously broadened to include `payment_intent:execute`
      // for the BrainSaaS Playground convenience, but that means any partner
      // address registered on-chain implicitly carried execute power. Demos
      // that need execute now use the explicit `partner_execute` role below
      // (or mint their own scoped token via /v1/demo/provision-run, which
      // post-C-1 issues read+propose tokens only). Tightening this default
      // means a leaked partner key cannot drain funds; the worst case is a
      // proposed-and-approved intent that still requires a tenant-side
      // execute call.
      return [
        "ledger:read",
        "wiki:read",
        "raw:write",
        "policy:read",
        "payment_intent:propose",
        "payment_intent:approve",
        "execution:propose",
        "audit:read",
      ];
    case "partner_execute":
      // Opt-in partner role (batch 10 H-3): adds `payment_intent:execute`
      // to the default partner scope set. Operators must explicitly register
      // an agent with this role for it to mint a tokenable execute scope; a
      // partner row created with the default `partner` role does NOT auto-
      // upgrade. The scope-hash check against BrainMCPAgentRegistry covers
      // the role-to-scope mapping, so a partner_execute scope_hash differs
      // from a plain partner scope_hash and cannot be cross-impersonated.
      return [
        "ledger:read",
        "wiki:read",
        "raw:write",
        "policy:read",
        "payment_intent:propose",
        "payment_intent:approve",
        "payment_intent:execute",
        "execution:propose",
        "audit:read",
      ];
    default:
      // dev / unknown -- read-heavy, no execution
      return ["ledger:read", "wiki:read", "policy:read", "audit:read"];
  }
}

function catalogReadableScopesForRole(role: "dispute" | "fraud_anomaly" | "vendor_risk"): Scope[] {
  const definition = internalAgentDefinitions[role];
  if (definition === undefined) {
    throw new Error(`${role} must exist in the internal-agent catalog before SIWX can mint it`);
  }
  const scopes = definition.readable_data.filter((scope): scope is Scope =>
    scope.endsWith(":read"),
  );
  if (!scopes.includes("raw:read")) {
    throw new Error(`${role} must declare raw:read before SIWX can mint it`);
  }
  return scopes;
}
