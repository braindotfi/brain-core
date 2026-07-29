/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata.
 *
 * Served at `GET /.well-known/oauth-authorization-server`. `issuer` and
 * `jwks_uri` are derived from `AUTH_ISSUER` only. `jwks_uri` must NEVER be
 * built from `AUTH_JWKS_URL`, that is the in-network fetch URL
 * (`http://jwks:8085/...` in prod); publishing it would be a total failure
 * (OAUTH-AS-PLAN.md section 2). Taking only `issuer` as input here makes that
 * bug structurally impossible: there is no `AUTH_JWKS_URL` parameter to leak.
 */

import { AGENT_PERMITTED_SCOPES } from "@brain/shared";

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly scopes_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly revocation_endpoint: string;
  readonly revocation_endpoint_auth_methods_supported: readonly string[];
}

export const WELL_KNOWN_AS_PATH = "/.well-known/oauth-authorization-server";
export const WELL_KNOWN_JWKS_PATH = "/.well-known/jwks.json";

/** `issuer` must be `AUTH_ISSUER` exactly: no trailing slash, no path. */
export function buildAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}${WELL_KNOWN_JWKS_PATH}`,
    // Reused, not re-listed (shared/src/auth/scopes.ts:105). This is the
    // single source of truth an OAuth-minted token's consent can ever reach.
    scopes_supported: [...AGENT_PERMITTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. The DB layer (Phase 2a) makes "plain" unstorable too.
    code_challenge_methods_supported: ["S256"],
    // Public clients only: PKCE plus exact redirect-URI matching authenticates.
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint: `${issuer}/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
  };
}
