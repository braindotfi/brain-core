/**
 * Boot-time validation of `AUTH_ISSUER`.
 *
 * `AUTH_ISSUER` is `z.string().url()` (shared/src/config.ts), which accepts a
 * trailing slash (`https://auth.brain.fi/`). `metadata.ts` builds
 * `jwks_uri`/`authorization_endpoint`/`token_endpoint` by string-concatenating
 * a path onto `issuer`, so a trailing slash produces a double slash
 * (`https://auth.brain.fi//.well-known/jwks.json`) that 404s. Token
 * verification is unaffected (the signer and verifier both read the same
 * `AUTH_ISSUER` string), so the failure is discovery-only and otherwise
 * silent.
 *
 * This asserts instead of normalizing (unlike
 * services/api/src/well-known/oauth-protected-resource.ts:53's
 * `.replace(/\/+$/, "")`) because `issuer` doubles as the JWT `iss` claim: a
 * boot that silently rewrote it would make the deployed value diverge from
 * whatever an operator configured, which is worse than failing loud.
 */
export function assertValidIssuer(issuer: string): void {
  if (issuer.endsWith("/")) {
    throw new Error(
      `[auth] AUTH_ISSUER must not have a trailing slash (got "${issuer}"). ` +
        "A trailing slash makes the published jwks_uri and authorization_endpoint " +
        "404 (double slash) while token verification keeps working silently, " +
        `so drop it: "${issuer.replace(/\/+$/, "")}".`,
    );
  }
}
