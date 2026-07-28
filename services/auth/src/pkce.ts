/**
 * PKCE (RFC 7636), S256 only (OAUTH-AS-PLAN.md section 5.3).
 *
 * `code_challenge_method=plain` is rejected at /authorize (invalid_request)
 * and is unstorable by the DB CHECK constraint (0001_oauth_clients_and_grants.sql)
 * -- this module never accepts a "plain" path at all.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** RFC 7636 section 4.1: 43-128 characters from the unreserved URI set. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && CODE_VERIFIER_RE.test(verifier);
}

/** `code_challenge = base64url(sha256(code_verifier))`, unpadded (RFC 7636 section 4.2). */
export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Verifies a `code_verifier` at /token against the `code_challenge` stored on
 * the authorization code. `timingSafeEqual` per OAUTH-AS-PLAN.md section 5.3;
 * both inputs must first be checked for a well-formed verifier and a
 * non-empty stored challenge, or `timingSafeEqual` throws on length mismatch.
 */
export function verifyPkce(codeVerifier: unknown, codeChallenge: string): boolean {
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const derived = Buffer.from(deriveCodeChallenge(codeVerifier));
  const expected = Buffer.from(codeChallenge);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
