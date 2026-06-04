/**
 * JWKS helpers for the asymmetric (RS256) auth path.
 *
 * Production signs JWTs with a private JWK (`AUTH_SIGN_KEY`, consumed by
 * {@link JwtSigner}) and verifies them via a JWKS endpoint ({@link JwtVerifier}
 * → `createRemoteJWKSet`). The public half of `AUTH_SIGN_KEY` is what the JWKS
 * endpoint must serve. These helpers derive that public JWK from the private
 * one (so a single secret drives signing AND the published key set) and
 * generate a fresh signing key for an operator standing up the static-JWKS
 * sidecar (tools/static-jwks).
 */

import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";

/** Private JWK members that must never appear in the published public key. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;
/** Public members carried through, by key type (RSA: n/e; EC: crv/x/y; OKP: crv/x). */
const PUBLIC_JWK_MEMBERS = ["kty", "crv", "x", "y", "n", "e", "kid", "alg", "use"] as const;

/**
 * Strip the private components from a JWK, yielding the publishable public key.
 * Throws for symmetric keys (`oct`) — they have no public half and must never
 * back a JWKS endpoint.
 */
export function toPublicJwk(jwk: JWK): JWK {
  if (jwk.kty === "oct" || jwk.kty === undefined) {
    throw new Error(`toPublicJwk: cannot derive a public key from kty=${String(jwk.kty)}`);
  }
  const pub: Record<string, unknown> = {};
  for (const m of PUBLIC_JWK_MEMBERS) {
    if (jwk[m] !== undefined) pub[m] = jwk[m];
  }
  // Defence in depth: never let a private member through even if added later.
  for (const m of PRIVATE_JWK_MEMBERS) delete pub[m];
  if (pub["use"] === undefined) pub["use"] = "sig";
  // Safe: `kty` is guaranteed present (copied above; the guard rejects keys
  // without one). Go through `unknown` because TS can't see that invariant.
  return pub as unknown as JWK;
}

/** Build a JWKS document (the `{ keys: [...] }` shape) from a private signing JWK. */
export function jwksFromPrivate(jwk: JWK): { keys: JWK[] } {
  return { keys: [toPublicJwk(jwk)] };
}

/**
 * Generate a fresh signing key for `AUTH_SIGN_KEY`. Returns the PRIVATE JWK
 * (with `alg`, `use: "sig"`, and a thumbprint `kid`). The operator sets this as
 * `AUTH_SIGN_KEY`; the sidecar publishes `toPublicJwk` of it. RS256 by default —
 * the algorithm the verifier and the SIWX signer use.
 */
export async function generateSignKeyJwk(alg = "RS256"): Promise<JWK> {
  const { privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.alg = alg;
  jwk.use = "sig";
  jwk.kid = await calculateJwkThumbprint(jwk);
  return jwk;
}
