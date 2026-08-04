/**
 * Shared first-party service HMAC scheme.
 *
 * Proves a caller is a trusted first-party service (e.g. the Python
 * reasoning agents, or Raw's re-extraction workers), not just any bearer
 * token holder: `sha256=hex(hmac_sha256(secret, exact request body bytes))`.
 * Mirrored on the Python side (`brain_agents.auth.expected_signature` /
 * `verify_signature`) and the outbound Node signer
 * (`services/api/src/agents/sign-agent-request.ts`). Signing and verifying
 * must run over the exact same bytes -- callers are responsible for
 * capturing the raw request body (see `services/raw/src/server.ts`'s
 * `__rawBody` content-type parser stash) before any JSON re-serialization
 * could change byte-for-byte equality.
 *
 * Used to prove a caller-supplied `X-Brain-Write-Tenant` is trustworthy on
 * both `POST /raw/{raw_id}/parsed` (services/raw/src/routes/parsed.ts) and
 * `POST /execution/propose` (services/execution/src/routes.ts).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SERVICE_AUTH_PREFIX = "sha256=";

export function computeServiceAuthSignature(secret: string, rawBody: Buffer): string {
  return SERVICE_AUTH_PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time compare of a request-supplied HMAC signature against the one
 * computed over the raw body. Length-checked first so timingSafeEqual (which
 * throws on mismatched buffer lengths) never sees unequal-length input.
 * False whenever the raw body is unavailable or the header is
 * missing/malformed -- never throws, callers fall back to their own
 * un-elevated tenant on any doubt.
 */
export function verifyServiceAuthSignature(
  rawBody: Buffer | undefined,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (rawBody === undefined) return false;
  if (headerValue === undefined || !headerValue.startsWith(SERVICE_AUTH_PREFIX)) return false;
  const expected = computeServiceAuthSignature(secret, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(headerValue, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * The raw JSON content-type parser stashes the exact request bytes on the
 * parsed body as `__rawBody` so signature verification can run over the
 * same bytes the caller signed. Returns undefined for any other shape
 * (never throws -- an absent raw body just fails the HMAC check).
 */
export function extractRawBody(body: unknown): Buffer | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as Record<string, unknown>)["__rawBody"];
  return Buffer.isBuffer(candidate) ? candidate : undefined;
}
