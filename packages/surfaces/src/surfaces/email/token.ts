import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Email has no native interactive identity, so the approve and hold links carry
 * a signed, expiring, single-decision token. The token binds the proposal, the
 * tenant, the intended decision, and the recipient. The hosted approval route
 * verifies it, then still runs the full identity plus policy plus audit pipeline.
 *
 * The token is NOT authorization on its own. It proves the link was issued by
 * Brain to a specific recipient for a specific decision. Authority to approve is
 * decided by the Policy gate at click time, same as every other surface.
 */
export interface TokenClaims {
  tenantId: string;
  proposalId: string;
  decision: "approved" | "rejected";
  /** Verified recipient email, used as the external actor id. */
  recipient: string;
  /** Expiry epoch seconds. Should match or precede proposal.expiresAt. */
  exp: number;
}

export interface EmailVerificationTokenClaims {
  purpose: "email_recipient_verification";
  tenantId: string;
  email: string;
  actorId: string;
  roles: string[];
  exp: number;
}

export function signToken(claims: TokenClaims, secret: string): string {
  const payload = base64url(JSON.stringify(claims));
  const sig = base64url(hmac(payload, secret));
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];

  const expected = base64url(hmac(payload, secret));
  if (!constantTimeEqual(sig, expected)) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export function signVerificationToken(
  claims: EmailVerificationTokenClaims,
  secret: string,
): string {
  const payload = base64url(JSON.stringify(claims));
  const sig = base64url(hmac(payload, secret));
  return `${payload}.${sig}`;
}

export function verifyVerificationToken(
  token: string,
  secret: string,
): EmailVerificationTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];

  const expected = base64url(hmac(payload, secret));
  if (!constantTimeEqual(sig, expected)) return null;

  let claims: EmailVerificationTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.purpose !== "email_recipient_verification") return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  if (
    typeof claims.tenantId !== "string" ||
    typeof claims.email !== "string" ||
    typeof claims.actorId !== "string" ||
    !Array.isArray(claims.roles) ||
    !claims.roles.every((role) => typeof role === "string")
  ) {
    return null;
  }
  return claims;
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
