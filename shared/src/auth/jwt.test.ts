import { SignJWT, generateKeyPair, importJWK, exportJWK, type CryptoKey } from "jose";
import { describe, expect, it, vi } from "vitest";
import { isBrainError } from "../errors.js";
import { newAgentApiKeyId, newAgentId, newTenantId, newTokenId, newUserId } from "../ids.js";
import { InMemoryRevocationStore } from "./revocation.js";
import { projectPrincipal, verifyWithKey } from "./jwt.js";

/**
 * Mint a token with an ephemeral keypair and verify it back. Keeps the unit
 * test fully hermetic — no JWKS endpoint required.
 */
async function makeKeyed(): Promise<{
  sign: (claims: Record<string, unknown>, opts?: { exp?: number }) => Promise<string>;
  getKey: () => Promise<CryptoKey>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return {
    sign: async (claims, opts) => {
      const exp = opts?.exp ?? Math.floor(Date.now() / 1000) + 60;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
        .setIssuer("https://auth.brain.fi")
        .setAudience("brain-api")
        .setIssuedAt()
        .setExpirationTime(exp)
        .setJti("token_01HQ7K3TESTTESTTESTTESTTST")
        .sign(privateKey);
    },
    getKey: async () => publicKey,
  };
}

const BASE_OPTS = {
  jwksUrl: "https://auth.brain.fi/.well-known/jwks.json",
  issuer: "https://auth.brain.fi",
  audience: "brain-api",
  clockToleranceSeconds: 5,
  legacyAgentJwtNotAfter: undefined,
};

describe("projectPrincipal", () => {
  function baseClaims(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      sub: newUserId(),
      jti: newTokenId(),
      exp: Math.floor(Date.now() / 1000) + 60,
      tenant_id: newTenantId(),
      principal_type: "user",
      scopes: ["wiki:read"],
      ...overrides,
    };
  }

  it("projects a well-formed user payload", () => {
    const claims = baseClaims();
    const p = projectPrincipal(claims);
    expect(p.type).toBe("user");
    expect(p.tenantId).toBe(claims.tenant_id);
    expect(p.scopes).toEqual(["wiki:read"]);
  });

  it("accepts agent principal_type with agent_ sub prefix", () => {
    const claims = baseClaims({ sub: newAgentId(), principal_type: "agent" });
    const p = projectPrincipal(claims);
    expect(p.type).toBe("agent");
  });

  it("projects a valid exchange credential id", () => {
    const credentialId = newAgentApiKeyId();
    const claims = baseClaims({
      sub: newAgentId(),
      principal_type: "agent",
      credential_id: credentialId,
    });
    expect(projectPrincipal(claims).credentialId).toBe(credentialId);
  });

  it("rejects a malformed exchange credential id", () => {
    expect(() => projectPrincipal(baseClaims({ credential_id: "akey_wrong_kind" }))).toThrow();
  });

  it("rejects exchange credential attribution on a non-agent principal", () => {
    expect(() => projectPrincipal(baseClaims({ credential_id: newAgentApiKeyId() }))).toThrow();
  });

  it("rejects missing sub", () => {
    expect(() => projectPrincipal(baseClaims({ sub: undefined }))).toThrow();
  });
  it("rejects missing jti", () => {
    expect(() => projectPrincipal(baseClaims({ jti: undefined }))).toThrow();
  });
  it("rejects missing exp", () => {
    expect(() => projectPrincipal(baseClaims({ exp: undefined }))).toThrow();
  });
  it("rejects malformed tenant_id", () => {
    expect(() => projectPrincipal(baseClaims({ tenant_id: "not-a-tnt" }))).toThrow();
  });
  it("rejects unknown principal_type", () => {
    expect(() => projectPrincipal(baseClaims({ principal_type: "vendor" }))).toThrow();
  });
  it("rejects sub prefix that disagrees with principal_type", () => {
    const claims = baseClaims({ sub: newAgentId(), principal_type: "user" });
    expect(() => projectPrincipal(claims)).toThrow();
  });
  it("rejects non-array scopes", () => {
    expect(() => projectPrincipal(baseClaims({ scopes: "wiki:read" }))).toThrow();
  });
  it("rejects unknown scope strings", () => {
    expect(() => projectPrincipal(baseClaims({ scopes: ["wiki:read", "bogus:verb"] }))).toThrow();
  });
});

describe("verifyWithKey", () => {
  it("accepts a freshly signed token", async () => {
    const { sign, getKey } = await makeKeyed();
    const tenant = newTenantId();
    const token = await sign({
      sub: newUserId(),
      tenant_id: tenant,
      principal_type: "user",
      scopes: ["wiki:read", "raw:write"],
    });

    const principal = await verifyWithKey(token, async () => getKey(), BASE_OPTS);
    expect(principal.type).toBe("user");
    expect(principal.tenantId).toBe(tenant);
    expect(principal.scopes).toContain("wiki:read");
  });

  it("throws auth_token_expired when exp has passed", async () => {
    const { sign, getKey } = await makeKeyed();
    const tenant = newTenantId();
    const token = await sign(
      {
        sub: newUserId(),
        tenant_id: tenant,
        principal_type: "user",
        scopes: ["wiki:read"],
      },
      { exp: Math.floor(Date.now() / 1000) - 120 }, // past
    );

    try {
      await verifyWithKey(token, async () => getKey(), BASE_OPTS);
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("auth_token_expired");
    }
  });

  it("throws auth_token_invalid on signature mismatch", async () => {
    const { sign } = await makeKeyed();
    const { publicKey: wrongPub } = await generateKeyPair("RS256");
    const tenant = newTenantId();
    const token = await sign({
      sub: newUserId(),
      tenant_id: tenant,
      principal_type: "user",
      scopes: ["wiki:read"],
    });

    try {
      await verifyWithKey(token, async () => wrongPub, BASE_OPTS);
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("auth_token_invalid");
    }
  });

  it("throws auth_token_invalid when jti is revoked", async () => {
    const { sign, getKey } = await makeKeyed();
    const revocation = new InMemoryRevocationStore();
    const tenant = newTenantId();
    const token = await sign({
      sub: newUserId(),
      tenant_id: tenant,
      principal_type: "user",
      scopes: ["wiki:read"],
    });

    // Revoke the jti baked into makeKeyed()'s signer.
    await revocation.revoke("token_01HQ7K3TESTTESTTESTTESTTST", Math.floor(Date.now() / 1000) + 60);

    try {
      await verifyWithKey(token, async () => getKey(), {
        ...BASE_OPTS,
        revocation,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("auth_token_invalid");
    }
  });

  it.each([
    { label: "immediately before", offsetMs: -1, accepted: true },
    { label: "exactly at", offsetMs: 0, accepted: false },
    { label: "after", offsetMs: 1, accepted: false },
  ])("enforces the legacy agent JWT cutoff $label the boundary", async (entry) => {
    const { sign, getKey } = await makeKeyed();
    const cutoff = new Date(Date.now() + 30_000);
    const token = await sign({
      sub: newAgentId(),
      tenant_id: newTenantId(),
      principal_type: "agent",
      scopes: ["raw:write"],
    });
    const verification = verifyWithKey(token, async () => getKey(), {
      ...BASE_OPTS,
      legacyAgentJwtNotAfter: cutoff,
      now: () => new Date(cutoff.getTime() + entry.offsetMs),
    });

    if (entry.accepted) {
      await expect(verification).resolves.toMatchObject({ type: "agent" });
    } else {
      await expect(verification).rejects.toMatchObject({
        code: "auth_token_invalid",
        details: { reason: "legacy_agent_jwt_cutoff_reached" },
      });
    }
  });

  it("accepts credential-bound agent JWTs after the legacy cutoff", async () => {
    const { sign, getKey } = await makeKeyed();
    const cutoff = new Date(Date.now() - 1_000);
    const credentialId = newAgentApiKeyId();
    const token = await sign({
      sub: newAgentId(),
      tenant_id: newTenantId(),
      principal_type: "agent",
      scopes: ["raw:write"],
      credential_id: credentialId,
    });

    await expect(
      verifyWithKey(token, async () => getKey(), {
        ...BASE_OPTS,
        legacyAgentJwtNotAfter: cutoff,
        now: () => new Date(cutoff.getTime() + 1),
      }),
    ).resolves.toMatchObject({ type: "agent", credentialId });
  });
});

// RFC 8707 `resource`: the OAuth authorization server mints
// aud: ["brain-api", "https://mcp.brain.fi"] for MCP-bound tokens
// (OAUTH-AS-PLAN.md section 3). `jose`'s audience check must still accept
// this against every existing single-string verifier.
describe("verifyWithKey with an array aud claim (RFC 8707 resource)", () => {
  it("accepts a token whose aud is an array containing the configured audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const tenant = newTenantId();
    const token = await new SignJWT({
      tenant_id: tenant,
      principal_type: "agent",
      scopes: ["ledger:read"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer("https://auth.brain.fi")
      .setAudience(["brain-api", "https://mcp.brain.fi"])
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .setSubject(newAgentId())
      .setJti(newTokenId())
      .sign(privateKey);

    const principal = await verifyWithKey(token, async () => publicKey, BASE_OPTS);
    expect(principal.type).toBe("agent");
    expect(principal.tenantId).toBe(tenant);
  });
});

describe("verifyWithKey with additive accepted audiences", () => {
  it("accepts an API-resource token while retaining the legacy audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({
      tenant_id: newTenantId(),
      principal_type: "agent",
      scopes: ["raw:write"],
      credential_id: newAgentApiKeyId(),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer("https://auth.brain.fi")
      .setAudience("https://api.brain.fi/")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .setSubject(newAgentId())
      .setJti(newTokenId())
      .sign(privateKey);

    const principal = await verifyWithKey(token, async () => publicKey, {
      ...BASE_OPTS,
      audience: ["brain-api", "https://api.brain.fi/"],
    });
    expect(principal.credentialId).toMatch(/^agkey_/);
  });
});

// Cover the JwtVerifier constructor path at least once (returns a class
// wrapping createRemoteJWKSet — can't verify live without a network).
describe("JwtVerifier construction", () => {
  it("constructs without throwing for a well-formed JWKS URL", async () => {
    const mod = await import("./jwt.js");
    expect(() => new mod.JwtVerifier(BASE_OPTS)).not.toThrow();
  });
});

// Suppress eslint unused imports in this unit test: exportJWK/importJWK are
// intentionally not used but kept for parity with related keys tests.
void exportJWK;
void importJWK;
void vi;
