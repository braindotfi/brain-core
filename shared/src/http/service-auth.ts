/**
 * Shared first-party service HMAC scheme (v2).
 *
 * Proves a caller is a trusted first-party service (the Python reasoning
 * agents, or Raw's re-extraction workers), not just any bearer token
 * holder, AND binds the tenant a caller-supplied `X-Brain-Write-Tenant`
 * redirect targets so a captured signature cannot be replayed against a
 * different tenant (F4). Mirrored on the Python side
 * (`brain_agents.service_auth.compute_service_auth_signature_v2`) -- the
 * two implementations must agree byte-for-byte; see
 * `shared/src/http/service-auth.test.ts` /
 * `services/agents/tests/test_service_auth.py` for the pinned cross-
 * language vector.
 *
 * Used to prove a caller-supplied `X-Brain-Write-Tenant` is trustworthy on
 * both `POST /raw/{raw_id}/parsed` (services/raw/src/routes/parsed.ts) and
 * `POST /execution/propose` (services/execution/src/routes.ts). This is a
 * different concern from `X-Brain-Auth`
 * (services/api/src/agents/sign-agent-request.ts /
 * services/agents/brain_agents/auth.py), which authenticates the Brain api
 * as the caller of the agents service's own `/run/*` routes and carries no
 * tenant-redirect header, so it keeps its own (unrelated, unchanged) v1
 * body-only HMAC.
 *
 * Header contract (every trusted-service POST):
 *
 *   X-Brain-Service-Timestamp: <unix seconds, decimal string, generated
 *       fresh per request -- never cached or reused>
 *   X-Brain-Write-Tenant: <target tenant id, or omit the header entirely to
 *       write into the caller's own JWT tenant>
 *   X-Brain-Service-Auth: sha256v2=<hex HMAC-SHA256 of
 *       `${timestamp}.${writeTenant}.` (writeTenant = "" when the header is
 *       omitted) followed by the raw, exact request body bytes, keyed by the
 *       shared secret>
 *
 * A signature outside SERVICE_AUTH_REPLAY_WINDOW_SECONDS of "now" is
 * treated as unverified. Signing and verifying must run over the exact same
 * body bytes -- callers are responsible for capturing the raw request body
 * (see `services/raw/src/server.ts`'s and `services/execution/src/routes.ts`'s
 * `__rawBody` content-type parser stash) before any JSON re-serialization
 * could change byte-for-byte equality.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SERVICE_AUTH_PREFIX_V2 = "sha256v2=";
export const SERVICE_AUTH_REPLAY_WINDOW_SECONDS = 300;

/**
 * `${timestamp}.${writeTenant}.` (writeTenant = "" for "no redirect
 * requested") followed by the raw request body bytes, HMAC-SHA256'd with the
 * shared secret. Binding the timestamp and tenant into the signed material
 * (not just the body) is exactly what closes F4: a captured signature can no
 * longer be replayed with a different X-Brain-Write-Tenant, because changing
 * that value invalidates the signature.
 */
export function computeServiceAuthSignatureV2(
  secret: string,
  timestamp: string,
  writeTenant: string,
  rawBody: Buffer,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.${writeTenant}.`, "utf8");
  hmac.update(rawBody);
  return SERVICE_AUTH_PREFIX_V2 + hmac.digest("hex");
}

/**
 * Constant-time compare of a request-supplied HMAC signature against the one
 * computed over the timestamp, write-tenant, and raw body. Length-checked
 * first so timingSafeEqual (which throws on mismatched buffer lengths) never
 * sees unequal-length input. Also enforces the bounded replay window. False
 * (never throws) whenever the raw body is unavailable, the signature or
 * timestamp header is missing/malformed, the timestamp is outside the
 * replay window, or the signature does not match -- the caller always falls
 * back to the untrusted JWT-tenant write on any doubt.
 */
export function verifyServiceAuthSignatureV2(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  writeTenant: string,
  secret: string,
): boolean {
  if (rawBody === undefined) return false;
  if (signatureHeader === undefined || !signatureHeader.startsWith(SERVICE_AUTH_PREFIX_V2)) {
    return false;
  }
  if (timestampHeader === undefined || !/^[0-9]{1,15}$/.test(timestampHeader)) return false;
  const timestampSeconds = Number(timestampHeader);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SERVICE_AUTH_REPLAY_WINDOW_SECONDS) return false;
  const expected = computeServiceAuthSignatureV2(secret, timestampHeader, writeTenant, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
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

/** A Fastify request header value is `string | string[] | undefined`; take the first. */
export function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
