import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  errorHandlerPlugin,
  newAgentId,
  newTenantId,
  requestIdPlugin,
  type Principal,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ExecutionDeps } from "./deps.js";
import type { AgentRegistrationRelayer } from "./registration-relayer.js";
import { RailRegistry } from "./rails/stubs.js";
import { registerExecutionRoutes } from "./routes.js";

const TENANT = newTenantId();
const OTHER_TENANT = newTenantId();
const AGENT_ID = newAgentId();

// A real EIP-712 signer so the route's (real, unmocked) viem
// recoverTypedDataAddress genuinely recovers this address for a matching
// signature and a DIFFERENT address for a mismatched one.
const TENANT_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const TENANT_ACCOUNT = privateKeyToAccount(TENANT_KEY);
const WRONG_KEY = ("0x" + "22".repeat(32)) as `0x${string}`;
const WRONG_ACCOUNT = privateKeyToAccount(WRONG_KEY);

// viem's real hashTypedData validates EIP-55 checksums, so every address in
// domain/message must be checksummed, not an arbitrary hex string.
const DOMAIN = {
  name: "Brain MCP Agent",
  version: "1",
  chainId: 84532,
  verifyingContract: getAddress("0x" + "00".repeat(19) + "c0"),
} as const;
const TYPES = {
  AgentRegistration: [
    { name: "agentId", type: "bytes32" },
    { name: "agentAddress", type: "address" },
    { name: "tenantId", type: "bytes32" },
    { name: "scopeHash", type: "bytes32" },
    { name: "behaviorHash", type: "bytes32" },
  ],
} as const;
const MESSAGE = {
  agentId: ("0x" + "aa".repeat(32)) as `0x${string}`,
  agentAddress: getAddress("0x" + "bb".repeat(20)),
  tenantId: ("0x" + "cc".repeat(32)) as `0x${string}`,
  scopeHash: ("0x" + "dd".repeat(32)) as `0x${string}`,
  behaviorHash: ("0x" + "00".repeat(32)) as `0x${string}`,
};

function principal(tenantId: string, scopes: string[]): Principal {
  return {
    id: "user_owner",
    type: "user",
    tenantId,
    scopes: scopes as unknown as Principal["scopes"],
    tokenId: "tok_test",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

interface AgentFixture {
  id: string;
  tenant_id: string;
  state: string;
  attestation_mode: string;
  onchain_address: string | null;
  scope_hash: Buffer | null;
}

/** A tenant-aware fake pool: query results depend on the tenant_id most
 *  recently bound via `SELECT set_config('app.tenant_id', ...)`, mirroring
 *  what real RLS enforces -- an agent belonging to a different tenant is
 *  invisible, exactly as `withTenantScope` intends. */
function makeAgentPool(fixture: AgentFixture | null): {
  pool: Pool;
  updateCalls: () => number;
} {
  let currentTenant: string | null = null;
  let row: AgentFixture | null = fixture;
  let updateCalls = 0;
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        // withTenantScope's 2-arg form issues exactly one
        // SELECT set_config('app.tenant_id', $1, true) with values=[tenantId].
        currentTenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT * FROM agents WHERE id")) {
        const id = values[0];
        if (row !== null && row.id === id && row.tenant_id === currentTenant) {
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE agents") && sql.includes("tenant_signer_address")) {
        const [id, tenantSignerAddress, tenantSignature] = values as [string, string, string];
        if (
          row !== null &&
          row.id === id &&
          row.tenant_id === currentTenant &&
          row.state === "pending_onchain" &&
          row.attestation_mode === "tenant_signed"
        ) {
          updateCalls += 1;
          row = {
            ...row,
            // storeTenantAttestationSignature stores these, but state stays
            // pending_onchain until the background worker confirms on-chain.
          };
          return {
            rows: [
              {
                ...row,
                tenant_signer_address: tenantSignerAddress,
                tenant_signature: tenantSignature,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    updateCalls: () => updateCalls,
  };
}

function buildRelayer(): AgentRegistrationRelayer {
  return {
    configured: true,
    supportedModes: ["tenant_signed"],
    submitRegistration: vi.fn(),
    buildAttestationPayload: vi.fn(() => ({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "AgentRegistration",
      message: MESSAGE,
      digest: "0xdigest",
    })),
  };
}

async function buildApp(
  pool: Pool,
  opts: { designatedSigner: string | null; relayer?: AgentRegistrationRelayer },
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = principal(TENANT, ["policy:write"]);
  });
  const deps: ExecutionDeps = {
    pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as ExecutionDeps["audit"],
    rails: new RailRegistry([]),
    relayer: opts.relayer ?? buildRelayer(),
    resolveTenantOnchainSigner: vi.fn(async () => opts.designatedSigner),
    evaluatePolicy: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["evaluatePolicy"],
    evaluatePaymentIntent: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: (() => {
      throw new Error("unused");
    }) as unknown as ExecutionDeps["resolveRole"],
  };
  await app.register(async (child) => registerExecutionRoutes(child, deps));
  return app;
}

const pendingFixture: AgentFixture = {
  id: AGENT_ID,
  tenant_id: TENANT,
  state: "pending_onchain",
  attestation_mode: "tenant_signed",
  onchain_address: MESSAGE.agentAddress,
  scope_hash: Buffer.from(MESSAGE.scopeHash.slice(2), "hex"),
};

describe("POST /agents/:agent_id/attestation - RFC 0002 Phase C, increment 4", () => {
  it("stores a signature that recovers to the designated signer (202)", async () => {
    const signature = await TENANT_ACCOUNT.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "AgentRegistration",
      message: MESSAGE,
    });
    const { pool, updateCalls } = makeAgentPool(pendingFixture);
    const app = await buildApp(pool, { designatedSigner: TENANT_ACCOUNT.address });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { tenant_signer_address: string }).tenant_signer_address).toBe(
      TENANT_ACCOUNT.address.toLowerCase(),
    );
    expect(updateCalls()).toBe(1);
    await app.close();
  });

  it("rejects a signature that does not recover to the designated signer, and does not store it", async () => {
    const signature = await WRONG_ACCOUNT.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "AgentRegistration",
      message: MESSAGE,
    });
    const { pool, updateCalls } = makeAgentPool(pendingFixture);
    const app = await buildApp(pool, { designatedSigner: TENANT_ACCOUNT.address });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "agent_attestation_signature_invalid",
    );
    expect(updateCalls()).toBe(0);
    await app.close();
  });

  it("rejects when the tenant has no designated signer to verify against", async () => {
    const { pool, updateCalls } = makeAgentPool(pendingFixture);
    const app = await buildApp(pool, { designatedSigner: null });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature: "0xdeadbeef" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "tenant_signer_not_designated",
    );
    expect(updateCalls()).toBe(0);
    await app.close();
  });

  it("rejects a malformed signature before touching the relayer or the DB", async () => {
    const { pool, updateCalls } = makeAgentPool(pendingFixture);
    const app = await buildApp(pool, { designatedSigner: TENANT_ACCOUNT.address });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature: "not-hex" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request_body_invalid");
    expect(updateCalls()).toBe(0);
    await app.close();
  });

  it("rejects an agent that is not pending_onchain / tenant_signed", async () => {
    const { pool } = makeAgentPool({ ...pendingFixture, state: "active" });
    const app = await buildApp(pool, { designatedSigner: TENANT_ACCOUNT.address });
    const signature = await TENANT_ACCOUNT.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "AgentRegistration",
      message: MESSAGE,
    });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "agent_proposal_invalid_state",
    );
    await app.close();
  });

  it("cross-tenant: cannot attest an agent belonging to a different tenant", async () => {
    const otherTenantsAgent: AgentFixture = { ...pendingFixture, tenant_id: OTHER_TENANT };
    const { pool, updateCalls } = makeAgentPool(otherTenantsAgent);
    const app = await buildApp(pool, { designatedSigner: TENANT_ACCOUNT.address });
    const signature = await TENANT_ACCOUNT.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "AgentRegistration",
      message: MESSAGE,
    });
    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/attestation`,
      payload: { signature },
    });
    // The caller's principal is scoped to TENANT; the agent row only exists
    // under OTHER_TENANT, so the tenant-scoped read finds nothing.
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "execution_agent_not_registered",
    );
    expect(updateCalls()).toBe(0);
    await app.close();
  });
});
