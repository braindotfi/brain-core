import Fastify, { type FastifyInstance } from "fastify";
import type { Pool, QueryResult } from "pg";
import type { Redis } from "ioredis";
import { SiweMessage } from "siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeAgentScopeHash,
  errorHandlerPlugin,
  requestIdPlugin,
  JwtSigner,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import type { OnchainScopeChecker } from "@brain/mcp";
import {
  StubAgentRegistry,
  PostgresAgentRegistry,
  registerSiwxRoutes,
  type AgentRegistryLookup,
  type AgentResolution,
} from "./siwx.js";
import type { ResolvedWalletIdentity } from "../onboarding/wallet-identities.js";

function makeRedisStub(): Redis {
  const store = new Map<string, string>();
  return {
    setex: async (_k: string, _ttl: number, v: string) => {
      store.set(_k, v);
      return "OK";
    },
    getdel: async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    },
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DOMAIN = "api.brain.fi.test";

// HS256 lets us avoid generating an asymmetric key pair for tests. The
// signer just needs *some* key — the test asserts on the issued JWT's
// claims, not on the signature.
const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};

// Matches the chainId makeSignedMessage signs by default (8453) so existing
// fixtures verify unchanged; individual tests override either side to
// exercise the mismatch path.
const TEST_CHAIN_ID = 8453;

async function buildApp(
  registry: AgentRegistryLookup,
  opts?: {
    demoMode?: boolean;
    resolveWalletIdentity?: (address: string) => Promise<ResolvedWalletIdentity | null>;
    chainId?: number;
  },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  const signer = new JwtSigner({
    issuer: "https://auth.brain.fi.test",
    audience: "https://api.brain.fi.test",
    key: HS256_KEY,
    algorithm: "HS256",
  });
  await registerSiwxRoutes(app, {
    signer,
    domain: TEST_DOMAIN,
    registry,
    redis: makeRedisStub(),
    tokenTtlSeconds: 60,
    chainId: TEST_CHAIN_ID,
    ...opts,
  });
  return app;
}

async function makeSignedMessage(opts: {
  nonce: string;
  domain?: string;
  chainId?: number;
  privateKey?: `0x${string}`;
}): Promise<{ message: string; signature: string; address: string }> {
  const pk = opts.privateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const siwe = new SiweMessage({
    domain: opts.domain ?? TEST_DOMAIN,
    address: account.address,
    statement: "Sign in to Brain as an external agent",
    uri: `https://${opts.domain ?? TEST_DOMAIN}`,
    version: "1",
    chainId: opts.chainId ?? 8453,
    nonce: opts.nonce,
    issuedAt: new Date().toISOString(),
  });
  const message = siwe.prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature, address: account.address.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /auth/siwx/challenge", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(new StubAgentRegistry());
  });

  it("returns nonce + session_id + domain + chain_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx/challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body["nonce"]).toBe("string");
    expect((body["nonce"] as string).length).toBeGreaterThanOrEqual(8);
    expect(typeof body["session_id"]).toBe("string");
    expect(body["domain"]).toBe(TEST_DOMAIN);
    // Finding 5: without chain_id a client has to guess the EIP-4361
    // chainId the server pins (prod 84532 vs the example fixture's 8453).
    expect(body["chain_id"]).toBe(TEST_CHAIN_ID);
  });

  it("issues distinct nonces and session ids on each call", async () => {
    const r1 = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    const r2 = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    expect(r1["nonce"]).not.toBe(r2["nonce"]);
    expect(r1["session_id"]).not.toBe(r2["session_id"]);
  });
});

describe("POST /auth/siwx — happy path", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(new StubAgentRegistry());
  });

  it("verifies a valid signature, returns access_token + principal", async () => {
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;

    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
      principal: {
        id: string;
        type: string;
        tenantId: string;
        scopes: string[];
      };
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(60);
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token.split(".")).toHaveLength(3); // JWS
    expect(body.principal.type).toBe("agent");
    expect(body.principal.scopes).toEqual([
      "ledger:read",
      "wiki:read",
      "raw:write",
      "payment_intent:propose",
      "execution:propose",
    ]);
  });

  it("derives stable stub ids from the signing address", async () => {
    const pk = generatePrivateKey();
    const issue = async (): Promise<{ id: string; tenantId: string }> => {
      const challenge = (
        await app.inject({
          method: "POST",
          url: "/auth/siwx/challenge",
        })
      ).json() as Record<string, string>;
      const signed = await makeSignedMessage({
        nonce: challenge["nonce"] ?? "",
        privateKey: pk,
      });
      const res = await app.inject({
        method: "POST",
        url: "/auth/siwx",
        payload: {
          message: signed.message,
          signature: signed.signature,
          session_id: challenge["session_id"],
        },
      });
      const body = res.json() as {
        principal: { id: string; tenantId: string };
      };
      return body.principal;
    };
    const a = await issue();
    const b = await issue();
    expect(a.id).toBe(b.id);
    expect(a.tenantId).toBe(b.tenantId);
  });
});

describe("POST /auth/siwx — Phase D human wallet login", () => {
  async function signIn(
    app: FastifyInstance,
  ): Promise<{ id: string; type: string; tenantId: string; scopes: string[] }> {
    const challenge = (
      await app.inject({ method: "POST", url: "/auth/siwx/challenge" })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({ nonce: challenge["nonce"] ?? "" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(200);
    return (
      res.json() as { principal: { id: string; type: string; tenantId: string; scopes: string[] } }
    ).principal;
  }

  it("mints an owner JWT (user, management scopes — no propose/execute) for a human-linked wallet", async () => {
    const app = await buildApp(new StubAgentRegistry(), {
      resolveWalletIdentity: async () => ({
        tenantId: "tnt_01J0000000000000000000000Z",
        principalType: "human",
        principalId: "user_01J0000000000000000000000A",
      }),
    });
    const principal = await signIn(app);
    expect(principal.type).toBe("user");
    expect(principal.id).toBe("user_01J0000000000000000000000A");
    expect(principal.tenantId).toBe("tnt_01J0000000000000000000000Z");
    expect(principal.scopes).toContain("payment_intent:approve");
    for (const forbidden of [
      "payment_intent:propose",
      "payment_intent:execute",
      "execution:propose",
    ]) {
      expect(principal.scopes).not.toContain(forbidden);
    }
    await app.close();
  });

  it("falls through to the agent path when the wallet is not a human link", async () => {
    const app = await buildApp(new StubAgentRegistry(), {
      resolveWalletIdentity: async () => null,
    });
    const principal = await signIn(app);
    expect(principal.type).toBe("agent");
    await app.close();
  });
});

describe("POST /auth/siwx — chainId pinning", () => {
  it("rejects a message signed for the wrong chainId", async () => {
    const app = await buildApp(new StubAgentRegistry(), { chainId: 8453 });
    const challenge = (
      await app.inject({ method: "POST", url: "/auth/siwx/challenge" })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
      chainId: 84532, // Base Sepolia, not the 8453 the route is configured for.
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth_siwx_invalid");
    await app.close();
  });

  it("still verifies a message signed for the configured chainId", async () => {
    const app = await buildApp(new StubAgentRegistry(), { chainId: 84532 });
    const challenge = (
      await app.inject({ method: "POST", url: "/auth/siwx/challenge" })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
      chainId: 84532,
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /auth/siwx — error paths", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(new StubAgentRegistry());
  });

  it("returns 400 when message is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: { signature: "0xabc" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
  });

  it("rejects an expired/missing session_id with auth_siwx_invalid", async () => {
    const signed = await makeSignedMessage({ nonce: "abcdefgh" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: "token_not_a_real_session",
      },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth_siwx_invalid");
  });

  it("consumes the nonce so replay returns auth_siwx_invalid", async () => {
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
    });
    const first = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { error: { code: string } }).error.code).toBe("auth_siwx_invalid");
  });

  it("rejects a signature that doesn't match the message (wrong nonce)", async () => {
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    // Sign a message with a different nonce than the server stored.
    const signed = await makeSignedMessage({ nonce: "completelydifferent" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth_siwx_invalid");
  });
});

describe("POST /auth/siwx — demo mode", () => {
  it("issues a demo agent token without signature verification when demoMode=true", async () => {
    const app = await buildApp(new StubAgentRegistry(), { demoMode: true });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
      principal: { id: string; type: string; tenantId: string; scopes: string[] };
    };
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.access_token).toBe("string");
    expect(body.principal.type).toBe("agent");
    expect(body.principal.id).toBe("agent_01DEMX00000000000000000000");
    expect(body.principal.tenantId).toBe("tnt_01DEMX00000000000000000000");
    expect(body.principal.scopes).toContain("ledger:read");
  });

  it("issues distinct token ids on each demo call", async () => {
    const app = await buildApp(new StubAgentRegistry(), { demoMode: true });
    const r1 = (await app.inject({ method: "POST", url: "/auth/siwx", payload: {} })).json() as {
      access_token: string;
    };
    const r2 = (await app.inject({ method: "POST", url: "/auth/siwx", payload: {} })).json() as {
      access_token: string;
    };
    // JTI is embedded in the JWT — tokens must not be identical.
    expect(r1.access_token).not.toBe(r2.access_token);
  });
});

describe("PostgresAgentRegistry", () => {
  function makePool(rows: unknown[]): Pool {
    return {
      query: vi.fn().mockResolvedValue({ rows } as unknown as QueryResult),
    } as unknown as Pool;
  }

  // Scope-hash acceptance is on-chain preferred (see
  // assertScopeHashAcceptable in @brain/mcp): an agent not registered
  // on-chain must carry the canonical hash for its role, so most fixtures
  // below use the real canonical hash + a checker that reports "not
  // on-chain" (null). Tests of the on-chain-registered branch pass a
  // checker that returns a matching (or mismatching) hash instead.
  function canonicalHashHex(role: string): string {
    return computeAgentScopeHash(scopesForAgentRole(role)).slice(2);
  }
  function canonicalHashBuffer(role: string): Buffer {
    return Buffer.from(canonicalHashHex(role), "hex");
  }
  function notOnchain(): OnchainScopeChecker {
    return { getOnchainScopeHash: async () => null };
  }
  function onchainReturning(hash: string | null): OnchainScopeChecker {
    return { getOnchainScopeHash: async () => hash };
  }

  it("returns null when no agent row is found", async () => {
    const registry = new PostgresAgentRegistry(makePool([]), notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result).toBeNull();
  });

  it("returns AgentResolution with scopes for reconciliation role", async () => {
    const pool = makePool([
      {
        id: "agent_01RECON000000000000000000",
        tenant_id: "tnt_01RECON00000000000000000",
        role: "reconciliation",
        scope_hash: canonicalHashBuffer("reconciliation"),
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("agent_01RECON000000000000000000");
    expect(result?.tenantId).toBe("tnt_01RECON00000000000000000");
    expect(result?.scopes).toContain("ledger:read");
    expect(result?.scopes).toContain("execution:propose");
    expect(result?.scopes).not.toContain("raw:read");
    expect(result?.scopes).not.toContain("payment_intent:propose");
  });

  it("decodes scope_hash Buffer to 0x-prefixed hex string (on-chain registered, hashes match)", async () => {
    const hashBytes = Buffer.from("aa".repeat(32), "hex");
    const pool = makePool([
      {
        id: "agent_01HASH0000000000000000000",
        tenant_id: "tnt_01HASH000000000000000000",
        role: "payment",
        scope_hash: hashBytes,
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, onchainReturning("aa".repeat(32)));
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result?.scopeHash).toBe("0x" + "aa".repeat(32));
  });

  it("rejects (does not resolve) when scope_hash column is null", async () => {
    // Prior behavior minted a token with a zero scope hash for a
    // never-attested agent; assertScopeHashAcceptable now fails closed
    // instead of letting an unattested agent authenticate.
    const pool = makePool([
      {
        id: "agent_01ZERO0000000000000000000",
        tenant_id: "tnt_01ZERO000000000000000000",
        role: "anomaly",
        scope_hash: null,
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    await expect(
      registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    ).rejects.toMatchObject({ code: "agent_scope_hash_missing" });
  });

  it("issues payment scopes for payment role", async () => {
    const pool = makePool([
      {
        id: "agent_01PAY00000000000000000000",
        tenant_id: "tnt_01PAY0000000000000000000",
        role: "payment",
        scope_hash: canonicalHashBuffer("payment"),
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result?.scopes).toContain("payment_intent:propose");
    expect(result?.scopes).not.toContain("raw:read");
    expect(result?.scopes).not.toContain("raw:write");
  });

  it.each(["dispute", "fraud_anomaly", "vendor_risk"] as const)(
    "issues catalog-bound raw:read scopes for %s role",
    async (role) => {
      const pool = makePool([
        {
          id: "agent_01RAW00000000000000000000",
          tenant_id: "tnt_01RAW0000000000000000000",
          role,
          scope_hash: canonicalHashBuffer(role),
          state: "active",
        },
      ]);
      const registry = new PostgresAgentRegistry(pool, notOnchain());
      const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result?.scopes).toContain("ledger:read");
      expect(result?.scopes).toContain("wiki:read");
      expect(result?.scopes).toContain("raw:read");
      expect(result?.scopes).toContain("execution:propose");
      expect(result?.scopes).not.toContain("raw:write");
    },
  );

  it("issues read-only scopes for unknown role", async () => {
    const pool = makePool([
      {
        id: "agent_01DEV00000000000000000000",
        tenant_id: "tnt_01DEV0000000000000000000",
        role: "unknown_future_role",
        scope_hash: canonicalHashBuffer("unknown_future_role"),
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result?.scopes).toContain("audit:read");
    expect(result?.scopes).not.toContain("raw:read");
    expect(result?.scopes).not.toContain("execution:propose");
  });

  it("H-3 regression: default `partner` role does NOT include payment_intent:execute", async () => {
    // Batch 10 H-3: the partner role used to silently carry execute power,
    // which meant a partner address registered on-chain could move money via
    // a leaked SIWX token alone. The default partner now stops at approve;
    // execute requires the explicit partner_execute role.
    const pool = makePool([
      {
        id: "agent_01PART0000000000000000000",
        tenant_id: "tnt_01PART000000000000000000",
        role: "partner",
        scope_hash: canonicalHashBuffer("partner"),
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result?.scopes).toContain("payment_intent:propose");
    expect(result?.scopes).toContain("payment_intent:approve");
    expect(result?.scopes).not.toContain("payment_intent:execute");
    // Read scopes still present for the integration use case.
    expect(result?.scopes).toContain("ledger:read");
    expect(result?.scopes).toContain("audit:read");
  });

  it("H-3: explicit `partner_execute` role carries payment_intent:execute", async () => {
    // The opt-in path. Operators have to register an agent with this exact
    // role string for the execute scope to mint; the on-chain scope-hash
    // check then binds the elevated scope set to a specific registration.
    const pool = makePool([
      {
        id: "agent_01PEXE0000000000000000000",
        tenant_id: "tnt_01PEXE000000000000000000",
        role: "partner_execute",
        scope_hash: canonicalHashBuffer("partner_execute"),
        state: "active",
      },
    ]);
    const registry = new PostgresAgentRegistry(pool, notOnchain());
    const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(result?.scopes).toContain("payment_intent:execute");
    expect(result?.scopes).toContain("payment_intent:approve");
    expect(result?.scopes).toContain("payment_intent:propose");
  });

  describe("assertScopeHashAcceptable integration (drift + golden-agent cases)", () => {
    it("accepts an on-chain-registered agent whose DB hash matches chain but NOT the role derivation (golden-agent case)", async () => {
      // agent_01KTB9KXM267ZEEBAMYMNSYE6X: registered on-chain under the old
      // seed-golden-path SHA-256(tenantId:payment) formula. Chain and DB
      // agree with each other, so it must keep authenticating even though it
      // disagrees with computeAgentScopeHash(scopesForAgentRole("payment")).
      const oldFormulaHash = Buffer.from("11".repeat(32), "hex");
      const pool = makePool([
        {
          id: "agent_01KTB9KXM267ZEEBAMYMNSYE6X",
          tenant_id: "tnt_00000000010000000000000000",
          role: "payment",
          scope_hash: oldFormulaHash,
          state: "active",
        },
      ]);
      const registry = new PostgresAgentRegistry(pool, onchainReturning("11".repeat(32)));
      const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result?.agentId).toBe("agent_01KTB9KXM267ZEEBAMYMNSYE6X");
    });

    it("rejects an on-chain-registered agent whose DB hash disagrees with chain", async () => {
      const pool = makePool([
        {
          id: "agent_01DRIFT00000000000000000",
          tenant_id: "tnt_01DRIFT000000000000000000",
          role: "payment",
          scope_hash: Buffer.from("22".repeat(32), "hex"),
          state: "active",
        },
      ]);
      const registry = new PostgresAgentRegistry(pool, onchainReturning("33".repeat(32)));
      await expect(
        registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      ).rejects.toMatchObject({ code: "agent_scope_hash_mismatch" });
    });

    it("rejects an unregistered agent whose DB hash is non-canonical", async () => {
      const pool = makePool([
        {
          id: "agent_01NONCANON000000000000000",
          tenant_id: "tnt_01NONCANON00000000000000",
          role: "payment",
          scope_hash: Buffer.from("44".repeat(32), "hex"),
          state: "active",
        },
      ]);
      const registry = new PostgresAgentRegistry(pool, notOnchain());
      await expect(
        registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      ).rejects.toMatchObject({ code: "agent_scope_hash_mismatch" });
    });

    it("accepts an unregistered agent with the canonical hash", async () => {
      const pool = makePool([
        {
          id: "agent_01CANON00000000000000000",
          tenant_id: "tnt_01CANON0000000000000000000",
          role: "payment",
          scope_hash: canonicalHashBuffer("payment"),
          state: "active",
        },
      ]);
      const registry = new PostgresAgentRegistry(pool, notOnchain());
      const result = await registry.resolveByAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result?.agentId).toBe("agent_01CANON00000000000000000");
    });
  });
});

describe("POST /auth/siwx — registry resolution", () => {
  it("returns agent_not_found when the registry rejects the address", async () => {
    class RejectingRegistry implements AgentRegistryLookup {
      public async resolveByAddress(): Promise<AgentResolution | null> {
        return null;
      }
    }
    const app = await buildApp(new RejectingRegistry());
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/siwx",
      payload: {
        message: signed.message,
        signature: signed.signature,
        session_id: challenge["session_id"],
      },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("agent_not_found");
  });

  it("uses the resolved scopes verbatim on the issued JWT", async () => {
    class CustomScopeRegistry implements AgentRegistryLookup {
      public async resolveByAddress(): Promise<AgentResolution> {
        return {
          agentId: "agent_test_xyz",
          tenantId: "tnt_test_xyz",
          scopes: ["ledger:read", "wiki:read"],
          scopeHash: "0x" + "ab".repeat(32),
        };
      }
    }
    const app = await buildApp(new CustomScopeRegistry());
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx/challenge",
      })
    ).json() as Record<string, string>;
    const signed = await makeSignedMessage({
      nonce: challenge["nonce"] ?? "",
    });
    const body = (
      await app.inject({
        method: "POST",
        url: "/auth/siwx",
        payload: {
          message: signed.message,
          signature: signed.signature,
          session_id: challenge["session_id"],
        },
      })
    ).json() as { principal: { id: string; scopes: string[] } };
    expect(body.principal.id).toBe("agent_test_xyz");
    expect(body.principal.scopes).toEqual(["ledger:read", "wiki:read"]);
  });
});
