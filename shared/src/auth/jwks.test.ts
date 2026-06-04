import { createLocalJWKSet, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { newTenantId, newTokenId, newUserId } from "../ids.js";
import type { Principal } from "./principal.js";
import { JwtSigner } from "./signer.js";
import { verifyWithKey } from "./jwt.js";
import { generateSignKeyJwk, jwksFromPrivate, toPublicJwk } from "./jwks.js";

const OPTS = {
  jwksUrl: "",
  issuer: "https://auth.brain.fi",
  audience: "brain-api",
  clockToleranceSeconds: 5,
};

function principal(): Principal {
  return {
    id: newUserId(),
    type: "user",
    tenantId: newTenantId(),
    scopes: ["wiki:read"],
    tokenId: newTokenId(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("jwks helpers", () => {
  it("toPublicJwk strips every private member and keeps the public ones", async () => {
    const priv = await generateSignKeyJwk();
    expect(priv.d).toBeDefined(); // sanity: the generated key really is private
    const pub = toPublicJwk(priv) as unknown as Record<string, unknown>;
    for (const m of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
      expect(pub[m]).toBeUndefined();
    }
    expect(pub["kty"]).toBe(priv.kty);
    expect(pub["kid"]).toBe(priv.kid);
    expect(pub["use"]).toBe("sig");
    expect(pub["n"]).toBeDefined(); // RSA modulus survives
  });

  it("toPublicJwk refuses symmetric keys (no public half)", () => {
    expect(() => toPublicJwk({ kty: "oct", k: "c2VjcmV0" } as JWK)).toThrow();
  });

  it("round-trips: a token signed with AUTH_SIGN_KEY verifies against the derived JWKS", async () => {
    const priv = await generateSignKeyJwk();
    const signer = new JwtSigner({
      issuer: OPTS.issuer,
      audience: OPTS.audience,
      key: priv,
      algorithm: priv.alg ?? "RS256",
    });
    const p = principal();
    const token = await signer.sign(p);

    const jwks = createLocalJWKSet(jwksFromPrivate(priv));
    const verified = await verifyWithKey(token, jwks, OPTS);

    expect(verified.id).toBe(p.id);
    expect(verified.tenantId).toBe(p.tenantId);
    expect(verified.type).toBe("user");
    expect(verified.scopes).toEqual(["wiki:read"]);
  });

  it("rejects a token signed by a different key against the JWKS", async () => {
    const served = await generateSignKeyJwk();
    const attacker = await generateSignKeyJwk();
    const signer = new JwtSigner({
      issuer: OPTS.issuer,
      audience: OPTS.audience,
      key: attacker,
      algorithm: attacker.alg ?? "RS256",
    });
    const token = await signer.sign(principal());

    const jwks = createLocalJWKSet(jwksFromPrivate(served));
    await expect(verifyWithKey(token, jwks, OPTS)).rejects.toThrow();
  });
});
