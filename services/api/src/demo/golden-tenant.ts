/**
 * Fixed identity constants for the golden-path demo tenant.
 *
 * `GET /v1/demo/token` (main.ts) mints a session for DEMO_GOLDEN_USER in
 * DEMO_GOLDEN_TENANT. `tools/seed-golden-path/src/cli.ts` seeds a `members`
 * row for that SAME id so the minted session is member-resolvable
 * (`ActorResolver` looks members up by exact `(tenant_id, id)`, not by any
 * other claim on the token). Both usages must import these constants rather
 * than re-hardcode the literals, or the token and the seeded member drift
 * apart and every approval starts failing `actor_unresolved` again.
 */
export const DEMO_GOLDEN_USER = "user_00000000020000000000000001" as const;
export const DEMO_GOLDEN_TENANT = "tnt_00000000010000000000000000" as const;
