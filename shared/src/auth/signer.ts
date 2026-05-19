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

  public async sign(principal: Principal): Promise<string> {
    const key = await importJWK(this.opts.key, this.opts.algorithm);
    return new SignJWT({
      tenant_id: principal.tenantId,
      principal_type: principal.type,
      scopes: principal.scopes,
    })
      .setProtectedHeader({ alg: this.opts.algorithm })
      .setIssuedAt()
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setExpirationTime(principal.expiresAt)
      .setSubject(principal.id)
      .setJti(principal.tokenId)
      .sign(key);
  }
}
