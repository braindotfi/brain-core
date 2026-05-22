/**
 * Tenant category.
 *
 * Distinguishes a business tenant from a consumer tenant so the agent router
 * can prefer the category-matching agent when a trigger matches agents of
 * different categories (e.g. cash.balance_high → Treasury for business,
 * Savings for consumer). Agents themselves carry a three-valued
 * AGENT_CATEGORIES (business | consumer | agnostic); a tenant is one of the
 * two concrete categories.
 *
 * There is no tenant entity yet — the value is resolved server-side via an
 * injected resolver (see AgentRouterDeps.getTenantCategory). Sourcing it from
 * a signed JWT claim or a tenant record is a follow-up.
 */

export const TENANT_CATEGORIES = ["business", "consumer"] as const;

export type TenantCategory = (typeof TENANT_CATEGORIES)[number];

export function isTenantCategory(s: string): s is TenantCategory {
  return (TENANT_CATEGORIES as readonly string[]).includes(s);
}
