/**
 * Publishes the public half of `AUTH_SIGN_KEY` at `GET /.well-known/jwks.json`.
 *
 * Reuses `jwksFromPrivate` (shared/src/auth/jwks.ts) against the same
 * `AUTH_SIGN_KEY` the `jwks` sidecar (tools/static-jwks/src/server.ts) already
 * publishes, so the `kid` served here is identical to what verifiers already
 * trust. `jwksFromPrivate` strips every private member before returning.
 *
 * The `Parameters<...>[0]` cast (rather than importing `jose`'s `JWK` type
 * directly) matches tools/static-jwks/src/server.ts: it keeps `jose` out of
 * this package's own dependency list, since `@brain/shared` already owns it.
 */

import { jwksFromPrivate } from "@brain/shared";

export type JwksDocument = ReturnType<typeof jwksFromPrivate>;

/** Parses `signKey` (the `AUTH_SIGN_KEY` private JWK JSON) and derives the public JWKS. */
export function buildJwks(signKey: string): { jwks: JwksDocument; kid: string } {
  const jwk = JSON.parse(signKey) as Parameters<typeof jwksFromPrivate>[0];
  const jwks = jwksFromPrivate(jwk);
  return { jwks, kid: jwks.keys[0]?.kid ?? "(none)" };
}
