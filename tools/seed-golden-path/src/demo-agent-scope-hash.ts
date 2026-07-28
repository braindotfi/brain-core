import { computeAgentScopeHash, PAYMENT_AGENT_SCOPES } from "@brain/shared";

/**
 * The demo agent scope_hash, canonical and single source: computeAgentScopeHash
 * over the same PAYMENT_AGENT_SCOPES the payment role maps to everywhere else
 * (SIWX issuance, the BrainSaaS demo seed, on-chain registration tooling). A
 * prior version of this seeder hashed `${tenantId}:payment` with plain SHA-256
 * instead, a tenant-specific preimage that produced a unique, non-canonical
 * hash per seeded tenant.
 *
 * Split out of cli.ts (rather than exported from there) so this pure
 * derivation can be unit-tested without importing cli.ts itself, whose
 * top-level `main().then(...).catch(...)` runs as a side effect of module
 * load.
 */
export function demoAgentScopeHash(): Buffer {
  return Buffer.from(computeAgentScopeHash(PAYMENT_AGENT_SCOPES).slice(2), "hex");
}
