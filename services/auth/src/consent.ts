/**
 * The consent scope-intersection model (OAUTH-AS-PLAN.md section 0):
 *
 *   granted_scopes = requested_scopes
 *                  ∩ registered_scopes(agent)     // scopesForAgentRole(agent.role)
 *                  ∩ AGENT_PERMITTED_SCOPES        // shared/src/auth/scopes.ts
 *
 * `AGENT_PERMITTED_SCOPES` IS the AS's consentable-scope ceiling: it is
 * intersected in unconditionally below, so nothing this module returns can
 * ever exceed it (proved by test/consent-scope-ceiling.test.ts, mirroring
 * services/mcp/src/tools/registry.no-execute.test.ts). It contains no
 * `payment_intent:approve`, `payment_intent:execute`, `*:admin`, or
 * `policy:sign`, so an OAuth-minted token structurally cannot approve or
 * execute a payment.
 */

import { AGENT_PERMITTED_SCOPES, isValidScope, type Scope } from "@brain/shared";

/** Space-delimited `scope` query/form param -> validated Scope[], unknown tokens dropped. */
export function parseScopeParam(raw: string | undefined): Scope[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .filter((s): s is Scope => isValidScope(s));
}

/**
 * §0 steps 1-3: what the consent page is allowed to OFFER (checked by
 * default). `registered` is `scopesForAgentRole(agent.role)`, already
 * asserted acceptable against the on-chain/canonical hash by the caller
 * (`assertScopeHashAcceptable`) before this is called.
 */
export function computeConsentableScopes(
  requested: readonly Scope[],
  registered: readonly Scope[],
): Scope[] {
  const registeredSet = new Set(registered);
  return requested.filter((s) => registeredSet.has(s) && AGENT_PERMITTED_SCOPES.has(s));
}

/**
 * §0 step 4: "the admin may deselect, never add." `selected` is whatever the
 * consent form POSTs back (arbitrary, possibly-tampered strings); intersecting
 * against `consentable` means the result can never contain anything the GET
 * render did not already offer, regardless of what a malicious client submits.
 */
export function narrowByDeselection(
  consentable: readonly Scope[],
  selected: ReadonlyArray<string>,
): Scope[] {
  const selectedSet = new Set(selected);
  return consentable.filter((s) => selectedSet.has(s));
}
