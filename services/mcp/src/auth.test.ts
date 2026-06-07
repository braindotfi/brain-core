import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type * as BrainShared from "@brain/shared";

// Must be declared before the module under test is imported so the mock
// intercepts the withTenantScope call inside McpAuthVerifier.loadAgent.
vi.mock("@brain/shared", async (importActual) => {
  const actual = await importActual<typeof BrainShared>();
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (_pool: unknown, _tenantId: unknown, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: vi.fn() }),
    ),
  };
});

import { withTenantScope } from "@brain/shared";
import { McpAuthVerifier, type AgentRecord, type OnchainScopeChecker } from "./auth.js";
import type { Principal } from "@brain/shared";

const TENANT = "tnt_01j9z9q9q9q9q9q9q9q9q9q9q9";
const SCOPE_HASH_HEX = "abcd1234";
const SCOPE_HASH_BUF = Buffer.from(SCOPE_HASH_HEX, "hex");

function makePool(): Pool {
  return {} as Pool;
}

function makeChecker(hash: string | null): OnchainScopeChecker {
  return { getOnchainScopeHash: vi.fn(async () => hash) };
}

function principal(): Principal {
  return {
    id: "agent_01j9z9q9q9q9q9q9q9q9q9q9q0",
    type: "agent",
    tenantId: TENANT,
    scopes: ["execution:propose"] as unknown as Principal["scopes"],
    tokenId: "tok_01j9z9q9q9q9q9q9q9q9q9q9q9",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function activeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_01j9z9q9q9q9q9q9q9q9q9q9q0",
    tenant_id: TENANT,
    state: "active",
    scope_hash: SCOPE_HASH_BUF,
    onchain_address: "0xdeadbeef",
    role: "payment",
    ...overrides,
  };
}

function stubTenantScope(agent: AgentRecord | null) {
  vi.mocked(withTenantScope).mockImplementationOnce(async (_pool, _tenantId, fn) => {
    const client = {
      query: vi.fn(async () => ({ rows: agent !== null ? [agent] : [] })),
    };
    return fn(client as never);
  });
}

describe("McpAuthVerifier", () => {
  it("rejects agents with scope_hash = null", async () => {
    stubTenantScope(activeAgent({ scope_hash: null }));
    const verifier = new McpAuthVerifier(makePool(), makeChecker(SCOPE_HASH_HEX));
    await expect(verifier.verify(principal())).rejects.toMatchObject({
      code: "agent_scope_hash_missing",
    });
  });

  it("rejects when agent is not registered on-chain (onchain returns null)", async () => {
    stubTenantScope(activeAgent());
    const verifier = new McpAuthVerifier(makePool(), makeChecker(null));
    await expect(verifier.verify(principal())).rejects.toMatchObject({
      code: "agent_scope_hash_mismatch",
    });
  });

  it("rejects when on-chain hash differs from DB hash", async () => {
    stubTenantScope(activeAgent());
    const verifier = new McpAuthVerifier(makePool(), makeChecker("deadbeef00"));
    await expect(verifier.verify(principal())).rejects.toMatchObject({
      code: "agent_scope_hash_mismatch",
    });
  });

  it("passes when hashes match", async () => {
    stubTenantScope(activeAgent());
    const verifier = new McpAuthVerifier(makePool(), makeChecker(SCOPE_HASH_HEX));
    const result = await verifier.verify(principal());
    expect(result.ctx.tenantId).toBe(TENANT);
  });

  it("rejects when agent is not active", async () => {
    stubTenantScope(activeAgent({ state: "pending_onchain" }));
    const verifier = new McpAuthVerifier(makePool(), makeChecker(SCOPE_HASH_HEX));
    await expect(verifier.verify(principal())).rejects.toMatchObject({
      code: "agent_not_registered",
    });
  });

  it("rejects when the agent's tenant_id does not match the JWT tenant (cross-tenant)", async () => {
    // Defense-in-depth: even if a cross-tenant agent row were resolved, its
    // tenant_id must equal the caller's JWT tenant or the call is refused before
    // any tool runs. (The on-chain scope check is never even reached.)
    stubTenantScope(activeAgent({ tenant_id: "tnt_someone_else" }));
    const verifier = new McpAuthVerifier(makePool(), makeChecker(SCOPE_HASH_HEX));
    await expect(verifier.verify(principal())).rejects.toMatchObject({
      code: "auth_tenant_mismatch",
    });
  });

  describe("clearCache (scope-rotation seam)", () => {
    // Two distinct agent ids so per-agent invalidation can be observed not
    // disturbing the other entry.
    const AGENT_A = "agent_01j9z9q9q9q9q9q9q9q9q9q9aa";
    const AGENT_B = "agent_01j9z9q9q9q9q9q9q9q9q9q9bb";

    function principalFor(id: string): Principal {
      return { ...principal(), id };
    }

    // Route every loadAgent() to a record matching the principal's id.
    function stubLoadAgentForBoth(): void {
      vi.mocked(withTenantScope).mockImplementation(async (_pool, _tenantId, fn) => {
        const client = {
          query: vi.fn(async (_sql: string, params: unknown[] = []) => {
            const agentId = params[0] as string;
            const row =
              agentId === AGENT_A || agentId === AGENT_B ? activeAgent({ id: agentId }) : null;
            return { rows: row !== null ? [row] : [] };
          }),
        };
        return fn(client as never);
      });
    }

    it("cache hit on second verify (no second on-chain read within TTL)", async () => {
      stubLoadAgentForBoth();
      const checker = makeChecker(SCOPE_HASH_HEX);
      const verifier = new McpAuthVerifier(makePool(), checker);
      await verifier.verify(principalFor(AGENT_A));
      await verifier.verify(principalFor(AGENT_A));
      expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(1);
    });

    it("clearCache(agentId) drops only that agent's entry", async () => {
      stubLoadAgentForBoth();
      const checker = makeChecker(SCOPE_HASH_HEX);
      const verifier = new McpAuthVerifier(makePool(), checker);
      await verifier.verify(principalFor(AGENT_A));
      await verifier.verify(principalFor(AGENT_B));
      expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(2);

      verifier.clearCache(AGENT_A);

      await verifier.verify(principalFor(AGENT_A)); // miss — must re-check on-chain
      await verifier.verify(principalFor(AGENT_B)); // hit — must NOT re-check
      expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(3);
    });

    it("clearCache() with no argument flushes every entry", async () => {
      stubLoadAgentForBoth();
      const checker = makeChecker(SCOPE_HASH_HEX);
      const verifier = new McpAuthVerifier(makePool(), checker);
      await verifier.verify(principalFor(AGENT_A));
      await verifier.verify(principalFor(AGENT_B));
      expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(2);

      verifier.clearCache();

      await verifier.verify(principalFor(AGENT_A));
      await verifier.verify(principalFor(AGENT_B));
      expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(4);
    });
  });
});
