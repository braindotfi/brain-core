/**
 * AS browser session cookie + CSRF (AUTH-PATHS-PLAN.md section 5).
 *
 * Stateless -- no session table. The whole cookie is
 * `mintHmacToken`/`verifyHmacToken` (@brain/shared) with a distinct `aud` for
 * domain separation, so it cannot be replayed against a different HMAC
 * consumer sharing AUTH_COOKIE_SECRET (the CSRF carrier below, or a future
 * pending-authorization blob).
 *
 * `__Host-` prefix requires Secure, Path=/, and no Domain attribute -- the
 * cookie helpers below hardcode exactly that shape.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { mintHmacToken, verifyHmacToken, type VerifyHmacTokenResult } from "@brain/shared";

export const SESSION_COOKIE_NAME = "__Host-brain_as";
export const SESSION_TTL_SECONDS = 15 * 60;
const SESSION_AUD = "auth.session";

/**
 * Pre-authentication CSRF carrier for /login, /set-password, and
 * /forgot-password. Those three pages render BEFORE an authenticated session
 * cookie exists (set-password explicitly must never create one), so there is
 * no session cookie yet to derive a CSRF token from the way AUTH-PATHS-PLAN.md
 * section 5 describes for the (not-yet-built) post-login /authorize/consent
 * page. This is the same primitive, minted anonymously and short-lived,
 * purely so deriveCsrfToken has a cookie signature to key off -- stateless,
 * matching section 5's "zero storage" requirement.
 */
export const CSRF_COOKIE_NAME = "__Host-brain_as_csrf";
const CSRF_CARRIER_TTL_SECONDS = 10 * 60;
const CSRF_CARRIER_AUD = "auth.csrf_carrier";

export interface SessionClaims {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly amr: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

export interface MintedSession {
  readonly cookieValue: string;
  readonly expiresAt: Date;
}

/**
 * No `member_id` claim (finding 8): authentication (this function) and
 * authority (authority.ts's `resolveAuthority`) are deliberately separate
 * questions -- see this module's header and authority.ts's header. Login
 * previously stamped `member_id: cred.userId` (a `users.id`) directly, with
 * no `members` lookup, under a claim NAME that implies validation it never
 * did: a user with no member row, a deactivated one, or a `viewer` still got
 * a cookie asserting `member_id`. The session already carries `tenant_id`
 * and `user_id`; a future `/authorize` calls `resolveAuthority(pool, {
 * tenantId, userId })` fresh at that time rather than trusting a claim
 * minted minutes or hours earlier from a session that may since have been
 * deactivated.
 */
export function mintSessionCookie(
  secret: string,
  claims: { tenantId: string; userId: string; amr: readonly string[] },
  nowMs = Date.now(),
): MintedSession {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionClaims = {
    tenant_id: claims.tenantId,
    user_id: claims.userId,
    amr: claims.amr,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  const minted = mintHmacToken({
    secret,
    aud: SESSION_AUD,
    payload,
    ttlSeconds: SESSION_TTL_SECONDS,
    nowMs,
  });
  return { cookieValue: minted.token, expiresAt: minted.expiresAt };
}

export function verifySessionCookie(
  secret: string,
  cookieValue: string,
  nowMs = Date.now(),
): VerifyHmacTokenResult<SessionClaims> {
  return verifyHmacToken<SessionClaims>({ token: cookieValue, secret, aud: SESSION_AUD, nowMs });
}

/** Mints the anonymous, empty-payload CSRF carrier cookie for a pre-auth form render. */
export function mintCsrfCarrier(secret: string, nowMs = Date.now()): MintedSession {
  const minted = mintHmacToken({
    secret,
    aud: CSRF_CARRIER_AUD,
    payload: {},
    ttlSeconds: CSRF_CARRIER_TTL_SECONDS,
    nowMs,
  });
  return { cookieValue: minted.token, expiresAt: minted.expiresAt };
}

export function verifyCsrfCarrier(
  secret: string,
  cookieValue: string,
  nowMs = Date.now(),
): VerifyHmacTokenResult<Record<string, never>> {
  return verifyHmacToken({ token: cookieValue, secret, aud: CSRF_CARRIER_AUD, nowMs });
}

/**
 * `csrf = base64url(HMAC(secret, cookie_signature + "|csrf"))`
 * (AUTH-PATHS-PLAN.md section 5). Works for any of the HMAC-token cookies
 * above -- it only reads the token's third (signature) segment, never the
 * envelope contents, so it needs no DB and rotates automatically whenever the
 * carrier cookie is re-minted.
 */
export function deriveCsrfToken(secret: string, cookieValue: string): string {
  const signature = cookieValue.split(".")[2] ?? "";
  return createHmac("sha256", secret).update(`${signature}|csrf`).digest("base64url");
}

export function verifyCsrfToken(secret: string, cookieValue: string, provided: string): boolean {
  const expected = Buffer.from(deriveCsrfToken(secret, cookieValue));
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface CookieAttributes {
  readonly maxAgeSeconds: number;
}

/** Serializes a `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. */
export function serializeHostCookie(name: string, value: string, attrs: CookieAttributes): string {
  return [
    `${name}=${value}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${attrs.maxAgeSeconds}`,
  ].join("; ");
}

/** Serializes an immediate-expiry cookie clear for the given `__Host-` cookie name. */
export function clearHostCookie(name: string): string {
  return [`${name}=`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"].join("; ");
}

/** Parses a `Cookie:` request header into a name -> value map. Tolerant of malformed input. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header.length === 0) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) continue;
    out[name] = value;
  }
  return out;
}
