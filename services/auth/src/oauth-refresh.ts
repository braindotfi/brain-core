/**
 * oauth_refresh_tokens DB operations (OAUTH-AS-PLAN.md section 3, Phase 2b).
 *
 * Rotation algorithm lifted verbatim from services/api/src/production-tenancy/
 * routes.ts's session-refresh handler (insertRefreshToken / findRefreshToken /
 * revokeRefreshFamily) -- 0001_oauth_clients_and_grants.sql's oauth_refresh_tokens
 * mirrors session_refresh_tokens field for field precisely so this code could
 * be lifted unchanged. Same two-pool split as oauth-codes.ts: brain_resolver
 * (BYPASSRLS, SELECT only) for the pre-tenant token_hash -> row lookup /token
 * needs before it has resolved a tenant_id, brain_auth (NOBYPASSRLS,
 * tenant-scoped) for every write.
 *
 * Write-skew guard (Opus review, Phase 2b): rotateRefreshToken (UPDATE the
 * old row + INSERT the successor) and revokeRefreshFamily (UPDATE by
 * family_id) are separate transactions. At READ COMMITTED a revoker cannot
 * see a concurrent rotator's not-yet-committed successor row, so a bare
 * revoke-by-family_id can commit having missed it -- a family "revoked" by
 * /revoke or reuse detection could still have one live, unrevoked token with
 * a fresh 30-day TTL. Every transaction that rotates OR revokes a family
 * takes `pg_advisory_xact_lock` (same mechanism as
 * shared/src/audit/emitter.ts's per-tenant hash-chain lock) FIRST, keyed on
 * `grant_id` rather than `family_id`: this schema mints exactly one
 * refresh-token family per grant (one code, consumed once, atomically mints
 * one family -- oauth-codes.ts's consumeAuthorizationCode), so the two keys
 * are 1:1 today, and `grant_id` is the one already available to
 * oauth-codes.ts's revokeRefreshTokenFamilyForGrant WITHOUT a lookup query.
 * All three lock sites (rotateRefreshToken and revokeRefreshFamily here,
 * revokeRefreshTokenFamilyForGrant in oauth-codes.ts) use the SAME namespace
 * and key so they serialize against each other.
 */

import type { Pool } from "pg";
import { withTenantScope, type Scope, type TenantScopedClient } from "@brain/shared";

/** Same TTL as the existing session-refresh convention (production-tenancy/routes.ts). */
export const REFRESH_TOKEN_TTL_DAYS = 30;

// Fixed advisory-lock namespace (int4) for serializing rotate/revoke on one
// refresh-token family, keyed by grant_id (see file header). Distinct from
// shared/src/audit/emitter.ts's AUDIT_CHAIN_LOCK_NAMESPACE (0x41554454,
// "AUDT"). Value is arbitrary but stable: 0x4f415246 = "OARF" (OAuth Refresh
// Family).
export const OAUTH_REFRESH_LOCK_NAMESPACE = 0x4f415246;

export interface RefreshTokenLookup {
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly clientId: string;
  readonly grantId: string;
  readonly familyId: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: Date;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface RefreshTokenRow {
  readonly token_hash: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly client_id: string;
  readonly grant_id: string;
  readonly family_id: string;
  readonly scopes: Scope[];
  readonly expires_at: Date;
  readonly rotated_at: Date | null;
  readonly revoked_at: Date | null;
}

function fromRow(row: RefreshTokenRow): RefreshTokenLookup {
  return {
    tokenHash: row.token_hash,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    clientId: row.client_id,
    grantId: row.grant_id,
    familyId: row.family_id,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Pre-tenant lookup via brain_resolver (BYPASSRLS, SELECT only). Same
 * rationale as oauth-codes.ts's lookupAuthorizationCodeByHash: /token has no
 * tenant context to set until AFTER this resolves one, and brain_auth is
 * NOBYPASSRLS, so with no app.tenant_id set the tenant_isolation policy would
 * silently return zero rows rather than error.
 */
export async function lookupRefreshTokenByHash(
  resolverPool: Pool,
  tokenHash: string,
): Promise<RefreshTokenLookup | null> {
  const { rows } = await resolverPool.query<RefreshTokenRow>(
    `SELECT token_hash, tenant_id, agent_id, client_id, grant_id, family_id, scopes,
            expires_at, rotated_at, revoked_at
       FROM oauth_refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  return row === undefined ? null : fromRow(row);
}

export interface RefreshSeed {
  readonly tenantId: string;
  readonly agentId: string;
  readonly clientId: string;
  readonly grantId: string;
  readonly familyId: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly scopes: readonly Scope[];
}

/**
 * Takes a TenantScopedClient (not a Pool) so it composes into an existing
 * transaction -- oauth-codes.ts's consumeAuthorizationCode calls this inside
 * its own single UPDATE-then-INSERT transaction so a refresh token never
 * exists for an unconsumed code and a code is never burned without one.
 */
export async function insertRefreshToken(
  client: TenantScopedClient,
  seed: RefreshSeed,
): Promise<void> {
  await client.query(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, tenant_id, agent_id, client_id, grant_id, family_id, token_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], now() + ($9::text || ' days')::interval)`,
    [
      seed.tokenHash,
      seed.tenantId,
      seed.agentId,
      seed.clientId,
      seed.grantId,
      seed.familyId,
      seed.tokenId,
      [...seed.scopes],
      REFRESH_TOKEN_TTL_DAYS,
    ],
  );
}

/**
 * ONE transaction: the atomic rotate-marker UPDATE (rotated_at IS NULL AND
 * revoked_at IS NULL), then -- only if it won -- insertRefreshToken for the
 * new token in the SAME family. `false` (zero rows updated) is the losing
 * side of a concurrent rotation race; the caller treats that identically to
 * reuse (production-tenancy/routes.ts's /sessions/refresh does the same).
 */
export async function rotateRefreshToken(
  authPool: Pool,
  tenantId: string,
  oldTokenHash: string,
  newSeed: RefreshSeed,
): Promise<boolean> {
  return withTenantScope(authPool, tenantId, async (client: TenantScopedClient) => {
    // Locked FIRST, on grant_id -- see file header for why this is the shared
    // key across all three lock sites and why it closes the rotate-vs-revoke
    // write-skew window.
    await client.query(
      `SELECT pg_advisory_xact_lock(${OAUTH_REFRESH_LOCK_NAMESPACE}, hashtext($1))`,
      [newSeed.grantId],
    );
    // RETURNING + rows.length, not rowCount: rowCount is `number | null` in
    // node-pg's types, and `rowCount === 0` silently falls through (inserting
    // a successor for a token that was NOT rotated) if it were ever null.
    // rows.length has no such ambiguity, matching consumeAuthorizationCode's
    // existing pattern (oauth-codes.ts).
    const { rows } = await client.query<{ token_hash: string }>(
      `UPDATE oauth_refresh_tokens
          SET rotated_at = now()
        WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL
        RETURNING token_hash`,
      [oldTokenHash],
    );
    if (rows.length === 0) return false;
    await insertRefreshToken(client, newSeed);
    return true;
  });
}

/** RFC 6749 section 10.4 reuse detection / section 10.5 replay revocation: kill every token in the chain. */
export async function revokeRefreshFamily(
  authPool: Pool,
  tenantId: string,
  grantId: string,
  familyId: string,
): Promise<void> {
  await withTenantScope(authPool, tenantId, async (client: TenantScopedClient) => {
    // Same lock, same key as rotateRefreshToken -- see file header.
    await client.query(
      `SELECT pg_advisory_xact_lock(${OAUTH_REFRESH_LOCK_NAMESPACE}, hashtext($1))`,
      [grantId],
    );
    await client.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE family_id = $1`,
      [familyId],
    );
  });
}

export interface ConsentGrantLookup {
  readonly agentId: string;
  readonly clientId: string;
  readonly scopes: readonly Scope[];
  readonly scopeHashAtGrant: Buffer;
  readonly revokedAt: Date | null;
}

interface ConsentGrantRow {
  readonly agent_id: string;
  readonly client_id: string;
  readonly scopes: Scope[];
  readonly scope_hash_at_grant: Buffer;
  readonly revoked_at: Date | null;
}

/**
 * Tenant-scoped consent-grant reload for a refresh exchange. A revoked grant
 * (`revoked_at` set) must block refresh -- oauth_consent_grants' table
 * comment (migration 0001) is the durable record of what was actually
 * consented to; refresh re-reads it every time rather than trusting the
 * refresh-token row alone.
 */
export async function loadConsentGrant(
  authPool: Pool,
  tenantId: string,
  grantId: string,
): Promise<ConsentGrantLookup | null> {
  return withTenantScope(authPool, tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<ConsentGrantRow>(
      `SELECT agent_id, client_id, scopes, scope_hash_at_grant, revoked_at
         FROM oauth_consent_grants WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, grantId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      agentId: row.agent_id,
      clientId: row.client_id,
      scopes: row.scopes,
      scopeHashAtGrant: row.scope_hash_at_grant,
      revokedAt: row.revoked_at,
    };
  });
}
