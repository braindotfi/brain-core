/**
 * Brain scope vocabulary.
 *
 * §3.2: scopes are `{layer}:{verb}` where verb is `read | write | admin`.
 * `admin` is held only by the tenant root user — required for signing
 * policies and registering agents.
 *
 * External agents (principal_type=agent, registered in BrainMCPAgentRegistry)
 * can hold at most three scopes:
 *   wiki:read, raw:write, execution:propose
 * Tenant grants these at registration via EIP-712 signature.
 */

import type { BrainErrorCode } from "../errors.js";
import { brainError } from "../errors.js";

export const LAYERS = ["raw", "wiki", "policy", "execution", "audit"] as const;
export type Layer = (typeof LAYERS)[number];

export const VERBS = ["read", "write", "admin", "propose", "sign"] as const;
export type Verb = (typeof VERBS)[number];

/** `{layer}:{verb}` tuple. Narrower types could enumerate valid pairs,
 *  but the verb set is small enough to validate at runtime at boundaries. */
export type Scope = `${Layer}:${Verb}`;

/** The finite set of scopes recognized at MVP. */
export const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "raw:read",
  "raw:write",
  "raw:admin",
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
  "audit:read",
  "audit:admin",
]);

export function isValidScope(s: string): s is Scope {
  return VALID_SCOPES.has(s as Scope);
}

/**
 * Scopes that only external agents can hold (§3.2). An external agent JWT
 * carrying a scope outside this set is rejected at the auth boundary.
 */
export const AGENT_PERMITTED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "wiki:read",
  "raw:write",
  "execution:propose",
]);

export function hasScope(held: ReadonlyArray<string>, required: Scope): boolean {
  return held.includes(required) || held.includes(impliedAdmin(required));
}

/** Admin for the layer implies every verb in that layer. */
function impliedAdmin(scope: Scope): Scope {
  const [layer] = scope.split(":") as [Layer, Verb];
  return `${layer}:admin` as Scope;
}

export function requireScope(
  held: ReadonlyArray<string>,
  required: Scope,
): void {
  if (!hasScope(held, required)) {
    const code: BrainErrorCode = "auth_scope_insufficient";
    throw brainError(code, `missing required scope: ${required}`, {
      details: { required, held },
    });
  }
}
