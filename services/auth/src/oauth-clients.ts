/**
 * oauth_clients reads and writes. Deliberately NOT tenant scoped -- a DCR
 * client registers before any tenant is known (0001_oauth_clients_and_grants.sql).
 * The table's RLS policy is `current_user = 'brain_auth'`, not a tenant_id
 * predicate, so a plain query through the brain_auth-connected pool (no
 * withTenantScope) is already correctly scoped: Postgres evaluates the policy
 * against the connection's role, not any GUC this process would have to set.
 */

import type { Pool } from "pg";
import { newOauthClientId } from "@brain/shared";
import { isRegistrableRedirectUri } from "./redirect-uri.js";

export interface OauthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly disabledAt: Date | null;
}

interface OauthClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: string[];
  readonly disabled_at: Date | null;
}

/** Looks up a client by id. Returns null for unknown or disabled clients. */
export async function findActiveOauthClient(
  pool: Pool,
  clientId: string,
): Promise<OauthClient | null> {
  const { rows } = await pool.query<OauthClientRow>(
    `SELECT client_id, client_name, redirect_uris, disabled_at
       FROM oauth_clients WHERE client_id = $1 AND disabled_at IS NULL LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    disabledAt: row.disabled_at,
  };
}

/**
 * Operator-seeded client insert (scripts/ops/register-oauth-client.ts). No
 * DCR (`POST /register`) exists yet (Phase 3) -- every `redirect_uris` entry
 * must pass {@link isRegistrableRedirectUri}, mirroring the rule a real DCR
 * handler would enforce.
 */
export async function insertOauthClient(
  pool: Pool,
  input: { clientName: string; redirectUris: readonly string[] },
): Promise<{ clientId: string }> {
  const bad = input.redirectUris.find((u) => !isRegistrableRedirectUri(u));
  if (bad !== undefined) {
    throw new Error(`redirect_uri must be https:// or a loopback http:// literal, got: ${bad}`);
  }
  const clientId = newOauthClientId();
  await pool.query(
    `INSERT INTO oauth_clients
       (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
     VALUES ($1, $2, $3::text[], ARRAY['authorization_code'], ARRAY['code'], 'none')`,
    [clientId, input.clientName, [...input.redirectUris]],
  );
  return { clientId };
}
