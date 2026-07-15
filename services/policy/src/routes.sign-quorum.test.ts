import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { errorHandlerPlugin, requestIdPlugin, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { registerPolicyRoutes } from "./routes.js";
import { buildTypedData } from "./signing.js";
import type { PolicyDeps } from "./deps.js";

const TENANT = "tnt_01TEST00000000000000000000";
const POLICY_ID = "pol_01TEST0000000000000000000";
const REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const CHAIN_ID = 84532;
const CONTENT_HASH = Buffer.alloc(32, 7);

type Account = ReturnType<typeof privateKeyToAccount>;

function newAccount(): Account {
  return privateKeyToAccount(generatePrivateKey());
}

async function sign(account: Account): Promise<`0x${string}`> {
  const typed = buildTypedData({
    tenantId: TENANT,
    version: 1,
    policyHashHex: CONTENT_HASH.toString("hex"),
    chainId: CHAIN_ID,
    verifyingContract: REGISTRY,
  });
  type SignArgs = Parameters<typeof account.signTypedData>[0];
  return account.signTypedData({
    domain: typed.domain as SignArgs["domain"],
    types: typed.types as unknown as SignArgs["types"],
    primaryType: typed.primaryType,
    message: typed.message as SignArgs["message"],
  });
}

function principal(): Principal {
  return {
    id: "user_01TEST000000000000000000",
    type: "user",
    tenantId: TENANT,
    scopes: ["policy:sign"] as Scope[],
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function fakePool(content: unknown = { version: 1, rules: [] }): Pool {
  const pending = {
    id: POLICY_ID,
    tenant_id: TENANT,
    version: 1,
    content,
    content_hash: CONTENT_HASH,
    signers: null,
    state: "pending_signatures",
    quorum_required: 2,
    activated_at: null,
    deactivated_at: null,
    created_by: "user_01TEST000000000000000000",
    created_at: new Date(),
  };
  const activated = { ...pending, state: "active", activated_at: new Date() };
  const client = {
    query: async (text: string) => {
      if (/SELECT \* FROM policies WHERE id/.test(text)) return { rows: [pending], rowCount: 1 };
      if (/SET signers/.test(text)) return { rows: [], rowCount: 1 };
      if (/state = 'deactivated'/.test(text)) return { rows: [], rowCount: 0 };
      if (/RETURNING \*/.test(text)) return { rows: [activated], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function buildDeps(authorized: Set<string>, over: Partial<PolicyDeps> = {}): PolicyDeps {
  return {
    pool: over.pool ?? fakePool(),
    audit: { emit: vi.fn(async () => undefined) } as unknown as PolicyDeps["audit"],
    chainId: CHAIN_ID,
    policyRegistryAddress: REGISTRY,
    isAuthorizedSigner: async (_tenant: string, address: string) =>
      authorized.has(address.toLowerCase()),
    ...(over.confidenceFloorReject !== undefined
      ? { confidenceFloorReject: over.confidenceFloorReject }
      : {}),
  };
}

async function buildApp(deps: PolicyDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = principal();
  });
  await registerPolicyRoutes(app, deps);
  return app;
}

function postSign(
  app: FastifyInstance,
  signatures: Array<{ address: `0x${string}`; signature: `0x${string}` }>,
) {
  return app.inject({
    method: "POST",
    url: `/policy/${TENANT}/sign`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ policy_id: POLICY_ID, signatures }),
  });
}

describe("POST /policy/:tenant_id/sign — quorum binding (security)", () => {
  it("rejects forged quorum from signers absent from the on-chain allowlist", async () => {
    // Two cryptographically-valid signatures from freshly-generated keys that
    // are NOT authorized tenant signers. Without the allowlist check these meet
    // quorum_required=2 and forge an active policy.
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(buildDeps(new Set()));

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe("policy_signature_invalid");
    await app.close();
  });

  it("rejects a duplicate signer padding quorum with the same key twice", async () => {
    const a = newAccount();
    const app = await buildApp(buildDeps(new Set([a.address.toLowerCase()])));
    const sigA = await sign(a);

    const res = await postSign(app, [
      { address: a.address, signature: sigA },
      { address: a.address, signature: sigA },
    ]);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe("policy_signature_invalid");
    await app.close();
  });

  it("activates when quorum-many distinct authorized signers sign", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()])),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json().activated).toBe(true);
    expect(res.json().warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "confidence_floor_missing" })]),
    );
    await app.close();
  });

  it("rejects activation when confidence floor reject mode is enabled", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        confidenceFloorReject: true,
      }),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("policy_rule_invalid");
    expect(res.json().error.details.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "confidence_floor_missing", severity: "ERROR" }),
      ]),
    );
    await app.close();
  });

  it("activates without warning when the confidence floor is above 0.5", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        pool: fakePool({
          version: 1,
          rules: [
            {
              id: "reject-low-confidence",
              applies_to: ["any"],
              when: { "agent.confidence.gte": 0.51 },
              execute: "reject",
            },
          ],
        }),
      }),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json().activated).toBe(true);
    expect(res.json().warnings).toEqual([]);
    await app.close();
  });
});
