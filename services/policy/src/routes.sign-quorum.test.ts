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
    scopes: ["policy:sign", "policy:read"] as Scope[],
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

const MINIMAL_VALID_CONTENT = {
  version: 1,
  rules: [{ id: "default-reject", applies_to: ["any"], when: {}, execute: "reject" }],
};

function fakePool(
  content: unknown = MINIMAL_VALID_CONTENT,
  tenantKind: "production" | "demo" = "demo",
): Pool {
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
      if (/SELECT kind FROM tenants/.test(text)) {
        return { rows: [{ kind: tenantKind }], rowCount: 1 };
      }
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
    ...(over.lintReject !== undefined ? { lintReject: over.lintReject } : {}),
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

  it("rejects production tenant activation without a confidence floor above 0.5", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        pool: fakePool(MINIMAL_VALID_CONTENT, "production"),
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

// ---------------------------------------------------------------------------
// H-18: activation blocks on ALL lintPolicy ERROR findings, not only the
// confidence-floor codes. Before this fix, a document could satisfy the
// confidence floor with one rule while another rule in the same document was
// an unbounded auto-executing "any" money mover -- every other ERROR finding
// the linter produces (auto_no_amount_cap, auto_no_counterparty_constraint,
// auto_no_verified_counterparty, no_approval_path_high_value,
// unsupported_currency, invalid_approval_role, auto_no_risk_bound,
// broad_any_auto) was computed and silently discarded at the only gate that
// matters.
// ---------------------------------------------------------------------------
const UNBOUNDED_WITH_FLOOR_ELSEWHERE = {
  version: 1,
  rules: [
    { id: "unbounded-mover", applies_to: ["any"], when: {}, execute: "auto" },
    {
      id: "floor-elsewhere",
      applies_to: ["agent_action"],
      when: { "agent.confidence.gte": 0.9 },
      execute: "reject",
    },
  ],
};

describe("POST /policy/:tenant_id/sign -- blocks on ALL ERROR lint findings (H-18)", () => {
  it("blocks an unbounded auto money-mover even though the document satisfies the confidence floor, when lint enforcement is on", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        pool: fakePool(UNBOUNDED_WITH_FLOOR_ELSEWHERE),
        lintReject: true,
      }),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("policy_rule_invalid");
    const codes = (res.json().error.details.findings as Array<{ code: string }>).map((f) => f.code);
    expect(codes).toContain("auto_no_amount_cap");
    expect(codes).not.toContain("confidence_floor_missing");
    await app.close();
  });

  it("activates the same document for a non-production tenant when lint enforcement is rolled back", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        pool: fakePool(UNBOUNDED_WITH_FLOOR_ELSEWHERE),
        lintReject: false,
      }),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json().activated).toBe(true);
    await app.close();
  });

  it("still blocks a production tenant even when lint enforcement is rolled back", async () => {
    const a = newAccount();
    const b = newAccount();
    const app = await buildApp(
      buildDeps(new Set([a.address.toLowerCase(), b.address.toLowerCase()]), {
        pool: fakePool(UNBOUNDED_WITH_FLOOR_ELSEWHERE, "production"),
        lintReject: false,
      }),
    );

    const res = await postSign(app, [
      { address: a.address, signature: await sign(a) },
      { address: b.address, signature: await sign(b) },
    ]);

    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe("POST /policy/:tenant_id/lint -- mirrors sign enforcement options (H-18)", () => {
  it("applies the production-tenant confidence-floor override, matching what sign would reject", async () => {
    const app = await buildApp(
      buildDeps(new Set(), { pool: fakePool(MINIMAL_VALID_CONTENT, "production") }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/policy/${TENANT}/lint`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ policy_content: MINIMAL_VALID_CONTENT }),
    });

    expect(res.statusCode).toBe(200);
    const finding = (res.json().findings as Array<{ code: string; severity: string }>).find(
      (f) => f.code === "confidence_floor_missing",
    );
    // Previously this endpoint only ever used deps.confidenceFloorReject
    // (false by default in this harness), so a production tenant would see
    // WARN here for a finding sign rejects as ERROR.
    expect(finding?.severity).toBe("ERROR");
    await app.close();
  });
});
