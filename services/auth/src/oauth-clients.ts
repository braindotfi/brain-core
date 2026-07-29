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
  /** What this client is registered to do, e.g. `["authorization_code", "refresh_token"]`. Enforced at /token (Opus review, Phase 2b): a client without `refresh_token` here gets an access token only, never a refresh token. */
  readonly grantTypes: readonly string[];
  readonly disabledAt: Date | null;
}

interface OauthClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: string[];
  readonly grant_types: string[];
  readonly disabled_at: Date | null;
}

/** Looks up a client by id. Returns null for unknown or disabled clients. */
export async function findActiveOauthClient(
  pool: Pool,
  clientId: string,
): Promise<OauthClient | null> {
  const { rows } = await pool.query<OauthClientRow>(
    `SELECT client_id, client_name, redirect_uris, grant_types, disabled_at
       FROM oauth_clients WHERE client_id = $1 AND disabled_at IS NULL LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    disabledAt: row.disabled_at,
  };
}

/**
 * Operator-seeded client insert (scripts/ops/register-oauth-client.ts). No
 * DCR (`POST /register`) exists yet (Phase 3) -- every `redirect_uris` entry
 * must pass {@link isRegistrableRedirectUri}, mirroring the rule a real DCR
 * handler would enforce. Registers both `authorization_code` and
 * `refresh_token` -- a caller wanting a narrower (e.g. authorization_code
 * only, for a short-lived supervised integration) client should insert
 * directly rather than through this convenience helper.
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
     VALUES ($1, $2, $3::text[], ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], 'none')`,
    [clientId, input.clientName, [...input.redirectUris]],
  );
  return { clientId };
}

export interface RegisterOauthClientInput {
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  readonly tokenEndpointAuthMethod: string;
  readonly softwareId?: string | undefined;
  readonly softwareVersion?: string | undefined;
}

/**
 * RFC 7591 `POST /register` (Phase 3): persists exactly what
 * client-registration.ts validated -- unlike insertOauthClient above, this
 * does NOT hardcode grant_types/response_types, because DCR must store the
 * client's own (validated) registration, not the operator-seeding default.
 */
export async function registerOauthClient(
  pool: Pool,
  input: RegisterOauthClientInput,
): Promise<{ clientId: string; createdAt: Date }> {
  const clientId = newOauthClientId();
  const { rows } = await pool.query<{ created_at: Date }>(
    `INSERT INTO oauth_clients
       (client_id, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, software_id, software_version)
     VALUES ($1, $2, $3::text[], $4::text[], $5::text[], $6, $7, $8)
     RETURNING created_at`,
    [
      clientId,
      input.clientName,
      [...input.redirectUris],
      [...input.grantTypes],
      [...input.responseTypes],
      input.tokenEndpointAuthMethod,
      input.softwareId ?? null,
      input.softwareVersion ?? null,
    ],
  );
  const row = rows[0];
  // A zero-row RETURNING would otherwise surface as a raw TypeError (reading
  // .created_at of undefined) all the way to routes/register.ts's caller
  // (Opus review, Phase 3 follow-up) -- an explicit throw here is caught by
  // that route's try/catch and turned into a generic server_error instead.
  if (row === undefined) {
    throw new Error("oauth_clients insert returned no row");
  }
  return { clientId, createdAt: row.created_at };
}
