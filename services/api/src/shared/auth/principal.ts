/**
 * Brain Principal — the authenticated subject of a request.
 *
 * §3.1 JWT payload fields:
 *   iss, sub, tenant_id, principal_type, scopes, exp, jti
 *
 * `principal_type` partitions the subject space into three kinds with distinct
 * governance properties:
 *
 *   - user        → a human logged in via SSO
 *   - agent       → a registered agent, internal OR external
 *   - api_partner → a server-to-server integration (future; deferred post-MVP)
 */

import type { Scope } from "./scopes.js";

export type PrincipalType = "user" | "agent" | "api_partner";

export interface Principal {
  /** The `sub` JWT claim. Prefix matches `principal_type`. */
  readonly id: string;
  readonly type: PrincipalType;
  readonly tenantId: string;
  readonly scopes: ReadonlyArray<Scope>;
  /** The `jti` — used for revocation checks. */
  readonly tokenId: string;
  /** Seconds-since-epoch expiry. */
  readonly expiresAt: number;
}
