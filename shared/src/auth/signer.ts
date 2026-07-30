/**
 * Brain JWT signer.
 *
 * Issues short-lived access tokens for authenticated principals. Used by the
 * SIWE auth route and any internal token-issuance path. The signing key is
 * supplied at construction time so this class has no env coupling — callers
 * are responsible for loading the key from config.
 */

import { SignJWT, importJWK, type JWK } from "jose";
import type { Principal } from "./principal.js";

export interface SignOptions {
  issuer: string;
  audience: string;
  key: JWK;
  algorithm: string;
}

export class JwtSigner {
  public constructor(private readonly opts: SignOptions) {}

  /**
   * `audience` overrides `opts.audience` for this one token. Used by the
   * OAuth authorization server (RFC 8707 `resource`): an MCP-bound token
   * mints `aud: ["brain-api", "https://mcp.brain.fi"]` rather than the plain
   * string every other minting path uses. `jose`'s audience check on verify
   * passes when ANY array entry matches, so existing single-string verifiers
   * are unaffected (see shared/src/auth/jwt.test.ts's array-audience test).
   */
  public async sign(principal: Principal, audience?: string | readonly string[]): Promise<string> {
    const key = await importJWK(this.opts.key, this.opts.algorithm);
    return new SignJWT({
      tenant_id: principal.tenantId,
      principal_type: principal.type,
      scopes: principal.scopes,
    })
      .setProtectedHeader({ alg: this.opts.algorithm })
      .setIssuedAt()
      .setIssuer(this.opts.issuer)
      .setAudience(audience !== undefined ? [...audience] : this.opts.audience)
      .setExpirationTime(principal.expiresAt)
      .setSubject(principal.id)
      .setJti(principal.tokenId)
      .sign(key);
  }
}
