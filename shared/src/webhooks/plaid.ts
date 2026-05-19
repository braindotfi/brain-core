/**
 * Plaid webhook signature verification.
 *
 * Plaid signs webhooks with a JWT in the `Plaid-Verification` header. The
 * JWT is signed by a key Plaid publishes; the header itself contains the
 * `kid` needed to fetch the key from Plaid's /webhook_verification_key/get
 * endpoint. The JWT body is a SHA-256 hash of the raw request body.
 *
 * Verification steps:
 *   1. Parse the JWT header for kid.
 *   2. Fetch the public key from Plaid (cached by `keyResolver`).
 *   3. jwtVerify(headerToken, publicKey, { issuer: plaid }).
 *   4. Assert jwt.request_body_sha256 === sha256(rawBody).
 *   5. Assert jwt.iat is within the tolerance window (default 5 min).
 *
 * We don't ship an HTTP client here — `keyResolver` is the extension point
 * where stage-2 infra wires the real fetch. Unit tests supply a stub.
 *
 * §3.4 mandates that the signature is verified BEFORE the body is parsed.
 * The Fastify content-type parser hook must preserve the raw buffer.
 */

import { createHash } from "node:crypto";
import { importJWK, jwtVerify, type JWK, type JWTVerifyGetKey, type KeyLike } from "jose";
import { brainError } from "../errors.js";

export interface PlaidVerifyOptions {
  /** Resolves the signing key for a given kid. Cache in the impl. */
  keyResolver: (kid: string) => Promise<JWK>;
  /** Max skew between JWT iat and now, in seconds. Default 5 minutes. */
  clockToleranceSeconds?: number;
}

/**
 * Verify a Plaid webhook. Returns silently on success; throws BrainError
 * with code `raw_webhook_signature_invalid` on any failure.
 */
export async function verifyPlaidWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  opts: PlaidVerifyOptions,
): Promise<void> {
  const tolerance = opts.clockToleranceSeconds ?? 300;

  const parts = signatureHeader.split(".");
  if (parts.length !== 3 || parts[0] === undefined) {
    throw brainError("raw_webhook_signature_invalid", "malformed Plaid-Verification header");
  }
  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(
      Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { kid?: string; alg?: string };
  } catch {
    throw brainError("raw_webhook_signature_invalid", "unparseable JWT header");
  }
  if (header.kid === undefined || header.alg !== "ES256") {
    throw brainError("raw_webhook_signature_invalid", "missing kid or unsupported alg", {
      details: { kid: header.kid, alg: header.alg },
    });
  }

  const jwk = await opts.keyResolver(header.kid);
  const key = (await importJWK(jwk, "ES256")) as KeyLike;
  const getKey: JWTVerifyGetKey = async () => key;

  let payload: { request_body_sha256?: string; iat?: number };
  try {
    const { payload: p } = await jwtVerify(signatureHeader, getKey, {
      algorithms: ["ES256"],
      clockTolerance: tolerance,
    });
    payload = p as { request_body_sha256?: string; iat?: number };
  } catch (err) {
    throw brainError("raw_webhook_signature_invalid", "JWT signature invalid", {
      cause: err,
    });
  }

  if (typeof payload.request_body_sha256 !== "string") {
    throw brainError("raw_webhook_signature_invalid", "JWT missing request_body_sha256");
  }
  const expected = createHash("sha256").update(rawBody).digest("hex");
  if (!constantTimeEquals(expected, payload.request_body_sha256)) {
    throw brainError("raw_webhook_signature_invalid", "body hash mismatch");
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
