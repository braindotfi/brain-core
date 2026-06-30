/**
 * Brain scope vocabulary.
 *
 * §3.2: scopes are `{layer}:{verb}` where verb is `read | write | admin`.
 * `admin` is held only by the tenant root user — required for signing
 * policies and registering agents.
 *
 * External agents (principal_type=agent, registered in BrainMCPAgentRegistry)
 * may hold the five §3.2 scopes:
 *   ledger:read, wiki:read, raw:write, payment_intent:propose, execution:propose
 * Tenant grants a subset at registration via EIP-712 signature. §3.2 names the
 * non-financial-proposal scope `agent:propose`; the codebase implements it under
 * the legacy name `execution:propose` (the MCP agent.action.propose tool and the
 * SIWX grant both use execution:propose). Renaming it would change the on-chain
 * scope_hash, so the rename is tracked separately, not done here.
 */

import type { BrainErrorCode } from "../errors.js";
import { brainError } from "../errors.js";

export const LAYERS = [
  "raw",
  "canonical",
  "ledger",
  "wiki",
  "policy",
  "execution",
  "payment_intent",
  "audit",
  "surfaces",
] as const;
export type Layer = (typeof LAYERS)[number];

export const VERBS = ["read", "write", "admin", "propose", "approve", "execute", "sign"] as const;
export type Verb = (typeof VERBS)[number];

/** `{layer}:{verb}` tuple. Narrower types could enumerate valid pairs,
 *  but the verb set is small enough to validate at runtime at boundaries. */
export type Scope = `${Layer}:${Verb}`;

/** The finite set of scopes recognized at MVP. */
export const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "raw:read",
  "raw:write",
  "raw:admin",
  "canonical:read",
  "canonical:write",
  "canonical:admin",
  "ledger:read",
  "ledger:write",
  "ledger:admin",
  "wiki:read",
  "wiki:write",
  "wiki:admin",
  "policy:read",
  "policy:write",
  "policy:admin",
  "policy:sign",
  "execution:read",
  "execution:write",
  "execution:admin",
  "execution:propose",
  "payment_intent:propose",
  "payment_intent:approve",
  "payment_intent:execute",
  "audit:read",
  "audit:write",
  "audit:admin",
  "surfaces:admin",
]);

export function isValidScope(s: string): s is Scope {
  return VALID_SCOPES.has(s as Scope);
}

/**
 * The reference allowlist of scopes an external agent may hold (§3.2). This is
 * the canonical set the SIWX grant and per-tool MCP scope checks draw from; it
 * intentionally excludes admin/sign verbs. `ledger:read` is required by the five
 * MCP ledger-read tools and `payment_intent:propose` by the payment-intent
 * propose tool — both were previously missing.
 */
export const AGENT_PERMITTED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "ledger:read",
  "wiki:read",
  "raw:write",
  "payment_intent:propose",
  "execution:propose",
]);

/**
 * Canonical scope set for the demo `payment` agent role (a subset of
 * AGENT_PERMITTED_SCOPES — no `raw:write`). Single source of truth shared by
 * SIWX token issuance (scopesForRole), the BrainSaaS demo seed
 * (services/api/src/demo/brainsaas-seed.ts), and the on-chain registration
 * tooling (scripts/ops/register-prod-agent.ts), so the JWT scopes, the
 * `agents.scope_hash` column, and the on-chain BrainMCPAgentRegistry scopeHash
 * can never diverge. Order is irrelevant — `computeAgentScopeHash` sorts before
 * hashing — but kept stable here for readability.
 */
export const PAYMENT_AGENT_SCOPES: readonly Scope[] = [
  "ledger:read",
  "wiki:read",
  "payment_intent:propose",
  "execution:propose",
];

export function hasScope(held: ReadonlyArray<string>, required: Scope): boolean {
  return held.includes(required) || held.includes(impliedAdmin(required));
}

/** Admin for the layer implies every verb in that layer. */
function impliedAdmin(scope: Scope): Scope {
  const [layer] = scope.split(":") as [Layer, Verb];
  return `${layer}:admin` as Scope;
}

export function requireScope(held: ReadonlyArray<string>, required: Scope): void {
  if (!hasScope(held, required)) {
    const code: BrainErrorCode = "auth_scope_insufficient";
    throw brainError(code, `missing required scope: ${required}`, {
      details: { required, held },
    });
  }
}
