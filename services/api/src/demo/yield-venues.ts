/**
 * Yield-venue reference catalog — public DeFi market data served by
 * GET /v1/reference/yield-venues.
 *
 * This is *not* tenant ledger data: it is the same for every tenant, carries no
 * truth/provenance, and so lives as a static reference module rather than in the
 * Ledger. The BrainSaaS "Brain Playground" Treasury scenario reads it to decide
 * how to split idle cash across venues (subject to the per-venue cap). The
 * endpoint is registered always-on (outside BRAIN_DEMO_MODE / the provisioning
 * flag) because it is harmless public data with no tenant coupling.
 *
 * Shape mirrors the former BrainSaaS `seed.ts` `YieldVenue` so the runners can
 * consume it without remapping; `id` is added for stable referencing.
 */

export interface YieldVenue {
  /** Stable slug for referencing a venue in a run. */
  id: string;
  name: string;
  /** Annual percentage yield, e.g. 4.2 = 4.2%. */
  apy: number;
  /** Max share of the deployable treasury allocatable to this venue, percent. */
  cap_pct: number;
  chain: "base";
}

export const YIELD_VENUES: readonly YieldVenue[] = [
  { id: "aave-v3-usdc-base", name: "Aave v3 USDC on Base", apy: 4.2, cap_pct: 40, chain: "base" },
  {
    id: "compound-v3-usdc-base",
    name: "Compound v3 USDC on Base",
    apy: 3.9,
    cap_pct: 40,
    chain: "base",
  },
  { id: "morpho-usdc-base", name: "Morpho USDC on Base", apy: 4.6, cap_pct: 30, chain: "base" },
] as const;
