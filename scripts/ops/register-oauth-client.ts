/**
 * register-oauth-client -- seeds one `oauth_clients` row so the Phase 2a
 * increment 3 authorization-code and refresh-token flows can both be
 * exercised before Dynamic Client Registration exists (Phase 3, RFC 7591).
 * Both grant types are registered because grant_types is enforced at
 * the token endpoint: a client seeded without refresh_token is refused
 * unauthorized_client on refresh.
 * `token_endpoint_auth_method`
 * is always `none`: every OAuth client at this AS is a public client
 * authenticated by PKCE plus exact redirect-URI matching, never a stored
 * secret (OAUTH-AS-PLAN.md section 5.7).
 *
 * Every `--redirect-uri` must be `https://` or a loopback `http://127.0.0.1`
 * or `http://[::1]` literal, per RFC 8252 section 7.3 -- the identical rule
 * services/auth/src/redirect-uri.ts's `isRegistrableRedirectUri` enforces at
 * request time (duplicated here, not imported: a script under scripts/ can
 * only resolve root-level dependencies -- pg and @brain/shared, like
 * scripts/ops/register-prod-agent.ts already relies on for viem -- not a
 * sibling service's own node_modules).
 *
 * Run (from repo root):
 *   pnpm exec tsx scripts/ops/register-oauth-client.ts \
 *     --name "Claude Code" \
 *     --redirect-uri https://claude.ai/api/mcp/auth_callback
 *
 * Required env: DATABASE_URL, or BRAIN_AUTH_DB_URL for a real least-privilege
 * connection (brain_auth's RLS policy on oauth_clients keys on `current_user`,
 * so either role can insert this table).
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";
import { newOauthClientId } from "@brain/shared";

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps brackets for an IPv6 literal ("[::1]", not "::1").
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Mirrors services/auth/src/redirect-uri.ts's isRegistrableRedirectUri exactly -- see file header. */
function isRegistrableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash !== "") return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

function usageAndExit(message: string): never {
  console.error(message);
  console.error(
    'Usage: register-oauth-client --name "<client name>" --redirect-uri <uri> [--redirect-uri <uri> ...]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      "redirect-uri": { type: "string", multiple: true },
    },
  });

  const clientName = values.name;
  const redirectUris = values["redirect-uri"];
  if (clientName === undefined || clientName.trim() === "") {
    usageAndExit("--name is required");
  }
  if (redirectUris === undefined || redirectUris.length === 0) {
    usageAndExit("at least one --redirect-uri is required");
  }
  const badUri = redirectUris.find((u) => !isRegistrableRedirectUri(u));
  if (badUri !== undefined) {
    usageAndExit(`--redirect-uri must be https:// or a loopback http:// literal, got: ${badUri}`);
  }

  const connectionString = process.env.BRAIN_AUTH_DB_URL ?? process.env.DATABASE_URL;
  if (connectionString === undefined) {
    usageAndExit("DATABASE_URL or BRAIN_AUTH_DB_URL must be set");
  }

  const pool = new Pool({ connectionString });
  try {
    const clientId = newOauthClientId();
    await pool.query(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
       VALUES ($1, $2, $3::text[], ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], 'none')`,
      [clientId, clientName, redirectUris],
    );
    console.log(`Registered OAuth client: ${clientId}`);
    console.log(`  client_name:   ${clientName}`);
    console.log(`  redirect_uris: ${redirectUris.join(", ")}`);
    console.log("  token_endpoint_auth_method: none (public client, PKCE required)");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
