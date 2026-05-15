/**
 * Brain JWT verifier.
 *
 * §3.1: Bearer JWT on every endpoint except the three documented exceptions.
 * Tokens are signed by Brain's auth service and verified via JWKS. This module
 * verifies a token and returns a typed Principal; it does not authorize.
 * Authorization (scope checks, tenant checks) happens at the endpoint level.
 *
 * Expected payload (§3.1):
 *   {
 *     "iss":            "https://auth.brain.fi",
 *     "sub":            "user_..." | "agent_..." | "partner_...",
 *     "tenant_id":      "tnt_...",
 *     "principal_type": "user" | "agent" | "api_partner",
 *     "scopes":         ["raw:write", ...],
 *     "exp":            <epoch seconds>,
 *     "jti":            "token_..."
 *   }
 */

import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { brainError } from "../errors.js";
import { isBrainId, parseBrainId } from "../ids.js";
import type { Principal, PrincipalType } from "./principal.js";
import type { RevocationStore } from "./revocation.js";
import { VALID_SCOPES, type Scope } from "./scopes.js";

export interface VerifyOptions {
  /** JWKS endpoint URL (§3.1 auth service). */
  jwksUrl: string;
  /**
   * Raw HS256 secret. When set, tokens are verified with this secret instead of
   * fetching from jwksUrl. Use only in dev/test — production must use asymmetric JWKS.
   */
  secret?: string;
  issuer: string;
  audience: string;
  /** Seconds of clock skew tolerance when checking exp/iat. */
  clockToleranceSeconds: number;
  /** Optional revocation check. Supply for production; omit only in tests. */
  revocation?: RevocationStore;
}

export class JwtVerifier {
  private readonly jwks: JWTVerifyGetKey;

  public constructor(private readonly opts: VerifyOptions) {
    if (opts.secret !== undefined && opts.secret !== "") {
      const keyBytes = new TextEncoder().encode(opts.secret);
      this.jwks = async () => keyBytes;
    } else {
      this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
    }
  }

  public async verify(token: string): Promise<Principal> {
    return verifyWithKey(token, this.jwks, this.opts);
  }
}

/**
 * Verification core. Split out so unit tests can pass a static key resolver
 * instead of hitting a live JWKS endpoint.
 */
export async function verifyWithKey(
  token: string,
  key: JWTVerifyGetKey,
  opts: VerifyOptions,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    const { payload: p } = await jwtVerify(token, key, {
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSeconds,
      requiredClaims: ["sub", "exp", "jti"],
    });
    payload = p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/exp|expired/i.test(msg)) {
      throw brainError("auth_token_expired", "JWT expired", { cause: err });
    }
    throw brainError("auth_token_invalid", "JWT verification failed", {
      cause: err,
      details: { reason: msg },
    });
  }

  const principal = projectPrincipal(payload);

  if (opts.revocation !== undefined) {
    const revoked = await opts.revocation.isRevoked(principal.tokenId);
    if (revoked) {
      throw brainError("auth_token_invalid", "JWT has been revoked", {
        details: { jti: principal.tokenId },
      });
    }
  }

  return principal;
}

/**
 * Strictly project the claims we recognize into a Principal. Throws
 * auth_token_invalid on any missing or malformed claim — a token that
 * passed signature verification but is semantically wrong is still invalid.
 */
export function projectPrincipal(payload: JWTPayload): Principal {
  const sub = payload.sub;
  const jti = payload.jti;
  const exp = payload.exp;
  const tenantId = (payload["tenant_id"] ?? "") as unknown;
  const principalType = (payload["principal_type"] ?? "") as unknown;
  const scopesRaw = (payload["scopes"] ?? []) as unknown;

  if (typeof sub !== "string" || sub === "") {
    throw brainError("auth_token_invalid", "missing sub claim");
  }
  if (typeof jti !== "string" || jti === "") {
    throw brainError("auth_token_invalid", "missing jti claim");
  }
  if (typeof exp !== "number") {
    throw brainError("auth_token_invalid", "missing exp claim");
  }
  if (typeof tenantId !== "string" || !isBrainId(tenantId, "tnt")) {
    throw brainError("auth_token_invalid", "malformed tenant_id claim", {
      details: { tenant_id: tenantId },
    });
  }
  if (!isPrincipalType(principalType)) {
    throw brainError("auth_token_invalid", "malformed principal_type claim", {
      details: { principal_type: principalType },
    });
  }
  // Sub prefix must match principal_type.
  const parsed = parseBrainId(sub);
  if (parsed === null || expectedSubPrefix(principalType) !== parsed.prefix) {
    throw brainError("auth_token_invalid", "sub prefix does not match principal_type", {
      details: { sub, principal_type: principalType },
    });
  }
  if (!Array.isArray(scopesRaw) || !scopesRaw.every((s) => typeof s === "string")) {
    throw brainError("auth_token_invalid", "scopes claim must be string array");
  }
  for (const s of scopesRaw) {
    if (!VALID_SCOPES.has(s as Scope)) {
      throw brainError("auth_token_invalid", "unknown scope in token", {
        details: { scope: s },
      });
    }
  }

  return {
    id: sub,
    type: principalType,
    tenantId,
    scopes: scopesRaw as Scope[],
    tokenId: jti,
    expiresAt: exp,
  };
}

function isPrincipalType(v: unknown): v is PrincipalType {
  return v === "user" || v === "agent" || v === "api_partner";
}

function expectedSubPrefix(type: PrincipalType): string {
  switch (type) {
    case "user":
      return "user";
    case "agent":
      return "agent";
    case "api_partner":
      return "partner";
  }
}
