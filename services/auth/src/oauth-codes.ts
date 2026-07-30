/**
 * oauth_consent_grants + oauth_authorization_codes DB operations
 * (OAUTH-AS-PLAN.md section 4, section 5.4).
 *
 * Two pools, by design (0001_oauth_clients_and_grants.sql's header, and
 * AUTH-PATHS-PLAN.md section 6): `brain_auth` (NOBYPASSRLS, tenant-scoped)
 * writes and atomically consumes a code once the tenant is known; the
 * pre-tenant `code_hash -> tenant_id` lookup at /token runs through
 * `brain_resolver` (BYPASSRLS, SELECT only) because /token has no tenant
 * context to set until AFTER that lookup resolves one.
 */

import type { Pool } from "pg";
import {
  newOauthConsentGrantId,
  withTenantScope,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";
import {
  insertRefreshToken,
  OAUTH_REFRESH_LOCK_NAMESPACE,
  type RefreshSeed,
} from "./oauth-refresh.js";

export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

export interface IssueCodeInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly memberId: string;
  readonly scopes: readonly Scope[];
  readonly scopeHashAtGrant: Buffer;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string | null;
  readonly codeHash: string;
}

/**
 * One transaction: insert the durable consent-grant row, then the one-time
 * code that references it. Both or neither -- a code must never exist
 * without the grant it was issued under.
 */
export async function issueAuthorizationCode(
  pool: Pool,
  input: IssueCodeInput,
): Promise<{ grantId: string }> {
  return withTenantScope(pool, input.tenantId, async (client: TenantScopedClient) => {
    const grantId = newOauthConsentGrantId();
    await client.query(
      `INSERT INTO oauth_consent_grants
         (id, tenant_id, client_id, agent_id, member_id, scopes, scope_hash_at_grant)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
      [
        grantId,
        input.tenantId,
        input.clientId,
        input.agentId,
        input.memberId,
        [...input.scopes],
        input.scopeHashAtGrant,
      ],
    );
    await client.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, tenant_id, agent_id, member_id, grant_id, scopes,
          redirect_uri, code_challenge, code_challenge_method, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, 'S256', $10,
               now() + ($11::text || ' seconds')::interval)`,
      [
        input.codeHash,
        input.clientId,
        input.tenantId,
        input.agentId,
        input.memberId,
        grantId,
        [...input.scopes],
        input.redirectUri,
        input.codeChallenge,
        input.resource,
        AUTHORIZATION_CODE_TTL_SECONDS,
      ],
    );
    return { grantId };
  });
}

export interface AuthorizationCodeLookup {
  readonly codeHash: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly grantId: string;
  readonly scopes: readonly Scope[];
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

interface AuthorizationCodeRow {
  readonly code_hash: string;
  readonly client_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly grant_id: string;
  readonly scopes: Scope[];
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly resource: string | null;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

function fromRow(row: AuthorizationCodeRow): AuthorizationCodeLookup {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    grantId: row.grant_id,
    scopes: row.scopes,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Pre-tenant lookup via `brain_resolver` (BYPASSRLS, SELECT only -- cannot
 * consume). Distinguishes "never existed" (null) from "exists, possibly
 * already consumed or expired" (a row with `consumedAt` set) so the caller
 * can tell a genuine replay from a code that was never valid.
 */
export async function lookupAuthorizationCodeByHash(
  resolverPool: Pool,
  codeHash: string,
): Promise<AuthorizationCodeLookup | null> {
  const { rows } = await resolverPool.query<AuthorizationCodeRow>(
    `SELECT code_hash, client_id, tenant_id, agent_id, grant_id, scopes,
            redirect_uri, code_challenge, resource, expires_at, consumed_at
       FROM oauth_authorization_codes WHERE code_hash = $1 LIMIT 1`,
    [codeHash],
  );
  const row = rows[0];
  return row === undefined ? null : fromRow(row);
}

/** The three fields a fresh refresh token needs that the caller (routes/oauth.ts) already minted before calling consumeAuthorizationCode -- everything else (tenantId, agentId, clientId, grantId, scopes) comes from the code row itself, inside the same transaction. */
export interface NewRefreshTokenSeed {
  readonly tokenHash: string;
  readonly tokenId: string;
  readonly familyId: string;
}

/**
 * The atomic single-use claim (OAUTH-AS-PLAN.md section 5.4): a zero-row
 * result (already consumed by a concurrent request, or expired between the
 * pre-tenant lookup and here) is `null` -- the caller treats that identically
 * to a genuine replay and revokes the refresh-token family.
 *
 * Phase 2b: when the UPDATE returns a row AND `refreshSeed` is non-null, the
 * refresh token is inserted in the SAME transaction (both or neither) -- a
 * refresh token must never exist for an unconsumed code, and a code must
 * never be burned without its refresh token landing. `refreshSeed` is `null`
 * when the client's `oauth_clients.grant_types` does not include
 * `refresh_token` (routes/oauth.ts checks this before calling) -- that client
 * gets an access token only, per its own registration.
 */
export async function consumeAuthorizationCode(
  authPool: Pool,
  tenantId: string,
  codeHash: string,
  refreshSeed: NewRefreshTokenSeed | null,
): Promise<AuthorizationCodeLookup | null> {
  return withTenantScope(authPool, tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<AuthorizationCodeRow>(
      `UPDATE oauth_authorization_codes
          SET consumed_at = now()
        WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING code_hash, client_id, tenant_id, agent_id, grant_id, scopes,
                  redirect_uri, code_challenge, resource, expires_at, consumed_at`,
      [codeHash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (refreshSeed !== null) {
      const seed: RefreshSeed = {
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        clientId: row.client_id,
        grantId: row.grant_id,
        familyId: refreshSeed.familyId,
        tokenId: refreshSeed.tokenId,
        tokenHash: refreshSeed.tokenHash,
        scopes: row.scopes,
      };
      await insertRefreshToken(client, seed);
    }
    return fromRow(row);
  });
}

/**
 * RFC 6749 section 10.5: a replayed authorization code revokes every
 * outstanding refresh token issued under its grant. Phase 2a wrote this
 * ahead of minting any refresh tokens (so it affected zero rows); Phase 2b
 * now mints one per code exchange (consumeAuthorizationCode above), so a
 * replay revokes a real, non-empty family by grant_id.
 */
export async function revokeRefreshTokenFamilyForGrant(
  authPool: Pool,
  tenantId: string,
  grantId: string,
): Promise<void> {
  await withTenantScope(authPool, tenantId, async (client: TenantScopedClient) => {
    // Same lock, same namespace, same key (grant_id) as oauth-refresh.ts's
    // rotateRefreshToken/revokeRefreshFamily -- see that file's header for
    // why grant_id closes the rotate-vs-revoke write-skew window here too.
    await client.query(
      `SELECT pg_advisory_xact_lock(${OAUTH_REFRESH_LOCK_NAMESPACE}, hashtext($1))`,
      [grantId],
    );
    await client.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = now()
        WHERE grant_id = $1 AND revoked_at IS NULL`,
      [grantId],
    );
  });
}
